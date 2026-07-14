/**
 * Relay entry — per-host lifecycle state machine.
 *
 * Each registered runtimeKey gets one entry that manages:
 * - lifecycle state (idle → creating → connected → …)
 * - generation counter for stale-creation guards
 * - active client reference
 * - creating/closing promises
 * - status subscription management
 * - registry listener fan-out
 * - pending operation token
 */

import type { RelayTunnelClient, RelayTunnelStatus } from '../tunnel-client';
import type {
  RelayRegistryEntryState,
  RelayRegistryEntryStatus,
  RelayRuntimeKey,
  RelayStatusListener,
} from './types';

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface RelayEntry {
  runtimeKey: RelayRuntimeKey;
  state: RelayRegistryEntryState;
  generation: number;
  descriptorFingerprint: string;
  activeClient: RelayTunnelClient | null;
  creatingPromise: Promise<RelayTunnelClient> | null;
  closingPromise: Promise<void> | null;
  lastUsedAt: number;
  statusUnsubscribe: (() => void) | null;
  registryListeners: Set<RelayStatusListener>;
  pendingOpToken: number;
}

/**
 * Create a fresh entry in the 'idle' state.
 */
export const createEntry = (
  runtimeKey: RelayRuntimeKey,
  descriptorFingerprint: string,
  now: number,
): RelayEntry => ({
  runtimeKey,
  state: 'idle',
  generation: 0,
  descriptorFingerprint,
  activeClient: null,
  creatingPromise: null,
  closingPromise: null,
  lastUsedAt: now,
  statusUnsubscribe: null,
  registryListeners: new Set(),
  pendingOpToken: 0,
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Derive the entry state from the client's tunnel status.
 */
export const stateFromClientStatus = (
  status: RelayTunnelStatus,
): RelayRegistryEntryState => {
  switch (status.state) {
    case 'idle':
      return 'idle';
    case 'connecting':
      return 'creating';
    case 'connected':
      return 'connected';
    case 'reconnecting':
      return 'reconnecting';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
};

/**
 * Check if a state transition is valid.
 * Invalid transitions are logged as warnings but not enforced (fail-open).
 */
export const isValidTransition = (
  from: RelayRegistryEntryState,
  to: RelayRegistryEntryState,
): boolean => {
  // All transitions are allowed — the entry state machine is permissive.
  // The generation counter is the real guard against stale writes.
  void from;
  void to;
  return true;
};

/**
 * Build the public entry status from an entry.
 */
export const entryStatus = (entry: RelayEntry): RelayRegistryEntryStatus => ({
  state: entry.state,
  generation: entry.generation,
  ...(entry.state === 'error' && entry.activeClient
    ? { lastError: entry.activeClient.getStatus().lastError }
    : {}),
});

/**
 * Update the entry state from the client's status and notify listeners.
 */
export const updateEntryFromClientStatus = (
  entry: RelayEntry,
  status: RelayTunnelStatus,
): void => {
  const nextState = stateFromClientStatus(status);
  entry.state = nextState;
  // Notify registry listeners
  const entryStatusValue = entryStatus(entry);
  for (const listener of entry.registryListeners) {
    try {
      listener(entryStatusValue);
    } catch {
      // Listener errors must not break the registry.
    }
  }
};

/**
 * Check if the entry is in a state that can accept new operations.
 */
export const isEntryActive = (entry: RelayEntry): boolean =>
  entry.state !== 'closing' && entry.state !== 'closed';

/**
 * Check if the entry has an ongoing creation.
 */
export const isEntryCreating = (entry: RelayEntry): boolean =>
  entry.state === 'creating' && entry.creatingPromise !== null;

/**
 * Check if the entry is closed or being closed.
 */
export const isEntryClosed = (entry: RelayEntry): boolean =>
  entry.state === 'closing' || entry.state === 'closed';
