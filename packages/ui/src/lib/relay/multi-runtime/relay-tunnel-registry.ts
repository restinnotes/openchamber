/**
 * Relay tunnel registry — keyed lifecycle manager for RelayTunnelClient instances.
 */

import type { RelayTunnelClient } from '../tunnel-client';
import {
  entryStatus,
  isEntryActive,
  isEntryClosed,
  isEntryCreating,
  type RelayEntry,
  createEntry,
  updateEntryFromClientStatus,
} from './relay-entry';
import { computeDescriptorFingerprint } from './relay-descriptor-fingerprint';
import { createSafeRelayLogger, safeDescriptorDebug } from './relay-safe-logger';
import type {
  RelayRegistryEntryStatus,
  RelayRuntimeDescriptor,
  RelayRuntimeKey,
  RelayStatusListener,
  RelayTunnelRegistry,
  RelayTunnelRegistryOptions,
} from './types';

export const createRelayTunnelRegistry = (
  options: RelayTunnelRegistryOptions,
): RelayTunnelRegistry => {
  const { createClient, maxEntries = 50 } = options;
  const logger = createSafeRelayLogger(options.logger);
  const clock = options.clock ?? (() => Date.now());

  const entries = new Map<RelayRuntimeKey, RelayEntry>();
  // Pending listeners for keys that don't have an entry yet
  const pendingListeners = new Map<RelayRuntimeKey, Set<RelayStatusListener>>();
  let disposed = false;

  const now = (): number => clock();

  const notifyListeners = (entry: RelayEntry): void => {
    const s = entryStatus(entry);
    for (const fn of entry.registryListeners) {
      try { fn(s); } catch { /* listener error */ }
    }
  };

  const cleanupEntry = (entry: RelayEntry): void => {
    entry.state = 'closed';
    entry.activeClient = null;
    entry.creatingPromise = null;
    entry.closingPromise = null;
    notifyListeners(entry);
    entry.registryListeners.clear();
    if (entry.statusUnsubscribe) {
      entry.statusUnsubscribe();
      entry.statusUnsubscribe = null;
    }
  };

  const removeEntry = (key: RelayRuntimeKey): void => {
    entries.delete(key);
  };

  const bindStatus = (entry: RelayEntry): void => {
    if (entry.statusUnsubscribe) { entry.statusUnsubscribe(); entry.statusUnsubscribe = null; }
    if (!entry.activeClient) return;
    entry.statusUnsubscribe = entry.activeClient.subscribeStatus((s) => updateEntryFromClientStatus(entry, s));
  };

  const closeEntry = async (key: RelayRuntimeKey, entry: RelayEntry): Promise<void> => {
    if (entry.state === 'closing' || entry.state === 'closed') return;
    entry.generation += 1;
    entry.creatingPromise = null;
    entry.state = 'closing';
    if (entry.activeClient) {
      try { entry.activeClient.close(); } catch { /* best-effort */ }
    }
    cleanupEntry(entry);
    removeEntry(key);
  };

  // -- ensure ---------------------------------------------------------------

  const ensure = async (
    runtimeKey: RelayRuntimeKey,
    descriptor: RelayRuntimeDescriptor,
  ): Promise<RelayTunnelClient> => {
    if (disposed) throw new Error('relay-registry: disposed');

    const fingerprint = await computeDescriptorFingerprint(descriptor);
    const existing = entries.get(runtimeKey);

    if (existing) {
      if (isEntryCreating(existing) && existing.creatingPromise) {
        if (existing.descriptorFingerprint === fingerprint) {
          return existing.creatingPromise;
        }
        await closeEntry(runtimeKey, existing);
      } else if (existing.activeClient && isEntryActive(existing)) {
        if (existing.descriptorFingerprint === fingerprint) {
          return existing.activeClient;
        }
        await closeEntry(runtimeKey, existing);
      } else if (isEntryClosed(existing)) {
        removeEntry(runtimeKey);
      } else if (existing.descriptorFingerprint !== fingerprint) {
        await closeEntry(runtimeKey, existing);
      }
    }

    if (entries.size >= maxEntries) {
      throw new Error(`relay-registry: max entries (${maxEntries}) reached`);
    }

    const entry = createEntry(runtimeKey, fingerprint, now());
    entry.state = 'creating';
    entries.set(runtimeKey, entry);

    // Adopt any pending listeners
    const pending = pendingListeners.get(runtimeKey);
    if (pending) {
      for (const fn of pending) entry.registryListeners.add(fn);
      pendingListeners.delete(runtimeKey);
    }

    const generation = entry.generation;
    logger.info('relay-registry: creating client', runtimeKey, safeDescriptorDebug(descriptor));

    let resolveClient!: (c: RelayTunnelClient) => void;
    let rejectClient!: (e: Error) => void;
    const promise = new Promise<RelayTunnelClient>((resolve, reject) => {
      resolveClient = resolve;
      rejectClient = reject;
    });
    entry.creatingPromise = promise;

    (async () => {
      try {
        const client = await createClient(descriptor);
        if (entry.generation !== generation || disposed || entry.state === 'closing' || entry.state === 'closed') {
          try { client.close(); } catch { /* best-effort */ }
          rejectClient(new Error('relay-registry: creation invalidated'));
          return;
        }
        entry.activeClient = client;
        entry.state = 'connected';
        entry.creatingPromise = null;
        bindStatus(entry);
        notifyListeners(entry);
        resolveClient(client);
      } catch (error) {
        logger.error('relay-registry: createClient failed', error);
        if (entry.generation === generation && !disposed) {
          entry.state = 'error';
          entry.creatingPromise = null;
          notifyListeners(entry);
        }
        rejectClient(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    return promise;
  };

  // -- get / has / getStatus ------------------------------------------------

  const get = (runtimeKey: RelayRuntimeKey): RelayTunnelClient | undefined => {
    if (disposed) return undefined;
    const entry = entries.get(runtimeKey);
    return entry?.activeClient ?? undefined;
  };

  const has = (runtimeKey: RelayRuntimeKey): boolean => {
    if (disposed) return false;
    const entry = entries.get(runtimeKey);
    return entry !== undefined && !isEntryClosed(entry);
  };

  const getStatus = (runtimeKey: RelayRuntimeKey): RelayRegistryEntryStatus | undefined => {
    if (disposed) return undefined;
    const entry = entries.get(runtimeKey);
    return entry ? entryStatus(entry) : undefined;
  };

  // -- replace --------------------------------------------------------------

  const replace = async (
    runtimeKey: RelayRuntimeKey,
    descriptor: RelayRuntimeDescriptor,
  ): Promise<RelayTunnelClient> => {
    if (disposed) throw new Error('relay-registry: disposed');
    const existing = entries.get(runtimeKey);
    if (!existing) return ensure(runtimeKey, descriptor);

    const newFingerprint = await computeDescriptorFingerprint(descriptor);
    if (existing.descriptorFingerprint === newFingerprint && existing.activeClient) {
      return existing.activeClient;
    }

    await closeEntry(runtimeKey, existing);
    return ensure(runtimeKey, descriptor);
  };

  // -- close / closeAll / dispose -------------------------------------------

  const close = async (runtimeKey: RelayRuntimeKey): Promise<void> => {
    const entry = entries.get(runtimeKey);
    if (entry) await closeEntry(runtimeKey, entry);
  };

  const closeAll = async (): Promise<void> => {
    const keys = [...entries.keys()];
    for (const key of keys) {
      const entry = entries.get(key);
      if (entry) await closeEntry(key, entry);
    }
  };

  const subscribe = (runtimeKey: RelayRuntimeKey, listener: RelayStatusListener): (() => void) => {
    if (disposed) return () => {};

    const entry = entries.get(runtimeKey);
    if (entry) {
      entry.registryListeners.add(listener);
      if (entry.activeClient) {
        try { listener(entryStatus(entry)); } catch { /* listener error */ }
      }
      return () => { entry.registryListeners.delete(listener); };
    }

    // No entry yet — track as pending for when ensure() creates the entry
    let pending = pendingListeners.get(runtimeKey);
    if (!pending) {
      pending = new Set();
      pendingListeners.set(runtimeKey, pending);
    }
    pending.add(listener);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      // Remove from pending if still pending
      pending?.delete(listener);
      if (pending && pending.size === 0) pendingListeners.delete(runtimeKey);
      // Also remove from entry if it was adopted
      const currentEntry = entries.get(runtimeKey);
      if (currentEntry) currentEntry.registryListeners.delete(listener);
    };
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    pendingListeners.clear();
    const keys = [...entries.keys()];
    for (const key of keys) {
      const entry = entries.get(key);
      if (entry) await closeEntry(key, entry);
    }
    entries.clear();
  };

  return { ensure, get, has, getStatus, replace, close, closeAll, subscribe, dispose };
};
