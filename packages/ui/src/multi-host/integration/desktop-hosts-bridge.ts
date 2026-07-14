/**
 * Desktop hosts bridge — converts persisted DesktopHost configs into
 * HostDescriptors that the multi-host supervisor can monitor.
 *
 * Also maintains a store of relay connection material (relayUrl, hostEncPubJwk)
 * that the relay monitor transport needs to create tunnel clients.
 *
 * Provides syncPersistedHosts() for runtime lifecycle synchronization:
 * diffs current supervisor state with persisted state and applies additions,
 * updates, and deletions. For relay hosts with changed connection material,
 * calls registry.replace() to swap the tunnel client.
 */

import type { HostDescriptor, HostId, HostTransport } from '../types';
import { hostIdFromExistingId } from '../host-registry';
import { desktopHostsGet, type DesktopHost, type DesktopHostRelay } from '@/lib/desktopHosts';
import type { RelayRuntimeDescriptor } from '@/lib/relay/multi-runtime/types';
import { toRuntimeKey } from '@/lib/relay/multi-runtime/types';
import { closeRelayTunnelForRuntime } from '@/lib/relay/runtime-tunnel';
import type { SupervisorLifecycle } from './supervisor-lifecycle';
import { useMultiHostStore } from '../multi-host-store';
import { getRelayTunnelRegistry } from './app-relay-registry';

// ---------------------------------------------------------------------------
// Relay material store
// ---------------------------------------------------------------------------

/**
 * In-memory store of relay connection material keyed by HostId.
 * This bridges the gap between HostDescriptor (which only has relayServerId)
 * and RelayRuntimeDescriptor (which needs relayUrl + hostEncPubJwk).
 */
const relayMaterialStore = new Map<HostId, DesktopHostRelay>();

/**
 * Store relay material for a host. Called during sync when a relay host
 * is loaded from persistence.
 */
export function storeRelayMaterial(hostId: HostId, relay: DesktopHostRelay): void {
  relayMaterialStore.set(hostId, relay);
}

/**
 * Get relay material for a host. Returns null if not a relay host or
 * material not available.
 */
export function getRelayMaterial(hostId: HostId): DesktopHostRelay | null {
  return relayMaterialStore.get(hostId) ?? null;
}

/**
 * Remove relay material for a host. Called during host deletion.
 */
export function removeRelayMaterial(hostId: HostId): void {
  relayMaterialStore.delete(hostId);
}

/**
 * Resolve a HostDescriptor with relay transport to a full RelayRuntimeDescriptor.
 * Returns null if the host is not a relay host or material is missing.
 */
export function resolveRelayDescriptor(descriptor: HostDescriptor): RelayRuntimeDescriptor | null {
  if (descriptor.transport.kind !== 'relay') return null;
  const material = relayMaterialStore.get(descriptor.hostId);
  if (!material) return null;
  return {
    relayUrl: material.relayUrl,
    serverId: material.serverId,
    hostEncPubJwk: material.hostEncPubJwk,
  };
}

// ---------------------------------------------------------------------------
// Relay material fingerprint (for change detection)
// ---------------------------------------------------------------------------

/**
 * Compute a lightweight fingerprint of relay connection material.
 * Used to detect when relay material has changed between sync cycles.
 * Does NOT log or expose sensitive descriptor values.
 */
function relayMaterialFingerprint(relay: DesktopHostRelay): string {
  return `${relay.relayUrl}|${relay.serverId}`;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single DesktopHost to a HostDescriptor.
 * Uses hostIdFromExistingId for stable HostId across restarts.
 * Also stores relay material if present.
 */
function desktopHostToDescriptor(host: DesktopHost): HostDescriptor {
  const hostId = hostIdFromExistingId(host.id);

  let transport: HostTransport;
  if (host.relay) {
    transport = {
      kind: 'relay',
      relayServerId: host.relay.serverId,
      requestHeaders: host.requestHeaders,
    };
    // Store full relay material for the relay monitor transport
    storeRelayMaterial(hostId, host.relay);
  } else if (host.apiUrl) {
    transport = {
      kind: 'direct',
      apiUrl: host.apiUrl,
      requestHeaders: host.requestHeaders,
    };
  } else {
    transport = {
      kind: 'local',
      apiUrl: host.url,
      requestHeaders: host.requestHeaders,
    };
  }

  return {
    hostId,
    label: host.label,
    transport,
  };
}

/**
 * Convert an array of DesktopHost configs into a Map<HostId, HostDescriptor>
 * suitable for supervisor.startAll().
 */
export function desktopHostsToDescriptors(
  hosts: DesktopHost[],
): Map<HostId, HostDescriptor> {
  const map = new Map<HostId, HostDescriptor>();
  for (const host of hosts) {
    try {
      const descriptor = desktopHostToDescriptor(host);
      map.set(descriptor.hostId, descriptor);
    } catch {
      // Skip hosts that fail to convert
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Load & sync
// ---------------------------------------------------------------------------

/**
 * Load persisted desktop hosts and return their descriptors.
 * Also stores relay material for relay hosts.
 * Returns empty map if not in desktop shell or on error.
 */
export async function loadPersistedHostDescriptors(): Promise<
  Map<HostId, HostDescriptor>
> {
  try {
    const config = await desktopHostsGet();
    return desktopHostsToDescriptors(config.hosts);
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Runtime lifecycle sync
// ---------------------------------------------------------------------------

/**
 * Track relay material fingerprints to detect changes between sync cycles.
 */
const previousRelayFingerprints = new Map<HostId, string>();

/**
 * Sync the supervisor/store state with the latest persisted desktop hosts.
 *
 * This function:
 * 1. Reads the latest persisted hosts
 * 2. Converts them to descriptors
 * 3. Diffs against the current supervisor state
 * 4. Applies additions, updates, and deletions
 * 5. For relay hosts with changed material, calls registry.replace()
 *
 * Safe to call concurrently — uses the latest persisted state each time.
 * Idempotent — repeated calls with the same state are no-ops.
 */
export async function syncPersistedHosts(
  supervisor: SupervisorLifecycle,
): Promise<void> {
  try {
    const persisted = await loadPersistedHostDescriptors();
    const currentStore = useMultiHostStore.getState();
    const currentHostIds = new Set(Object.keys(currentStore.hosts));

    // Phase 1: Add new hosts and update existing ones
    for (const [hostId, descriptor] of persisted) {
      const existing = currentStore.hosts[hostId];
      if (!existing) {
        // New host — register and start monitoring
        supervisor.startHost(hostId, descriptor);
      } else {
        // Existing host — check if descriptor changed
        const existingDescriptor = existing.descriptor;
        const descriptorChanged =
          existingDescriptor.label !== descriptor.label ||
          existingDescriptor.transport.kind !== descriptor.transport.kind ||
          JSON.stringify(existingDescriptor.transport) !== JSON.stringify(descriptor.transport);

        if (descriptorChanged) {
          // Descriptor changed — restart with new descriptor.
          // For relay hosts, also replace the registry client if material changed.
          if (descriptor.transport.kind === 'relay') {
            await replaceRelayClientIfNeeded(hostId, descriptor);
          }
          supervisor.restartHost(hostId, descriptor);
        }
      }
    }

    // Phase 2: Remove deleted hosts
    for (const hostId of currentHostIds) {
      if (!persisted.has(hostId as HostId)) {
        // Host was deleted from persistence — stop monitoring and clean up
        supervisor.stopHost(hostId as HostId);
        useMultiHostStore.getState().removeHost(hostId as HostId);
        // Close the registry entry for relay hosts to prevent leaked clients.
        const existingDescriptor = currentStore.hosts[hostId]?.descriptor;
        if (existingDescriptor?.transport.kind === 'relay') {
          await closeRelayTunnelForRuntime(toRuntimeKey(hostId as HostId));
        }
        removeRelayMaterial(hostId as HostId);
        previousRelayFingerprints.delete(hostId as HostId);
      }
    }
  } catch {
    // Sync is best-effort — don't throw on failures
  }
}

/**
 * For relay hosts, check if the relay connection material has changed
 * and replace the registry client if so. This ensures the active runtime
 * and monitor get the new client for the updated relay.
 *
 * Failure here is isolated — it does NOT break other hosts or the
 * restartHost call that follows.
 */
async function replaceRelayClientIfNeeded(
  hostId: HostId,
  newDescriptor: HostDescriptor,
): Promise<void> {
  if (newDescriptor.transport.kind !== 'relay') return;

  const newRelayDescriptor = resolveRelayDescriptor(newDescriptor);
  if (!newRelayDescriptor) return;

  const newFingerprint = relayMaterialFingerprint({
    relayUrl: newRelayDescriptor.relayUrl,
    serverId: newRelayDescriptor.serverId,
    hostEncPubJwk: newRelayDescriptor.hostEncPubJwk,
  });

  const oldFingerprint = previousRelayFingerprints.get(hostId);
  if (oldFingerprint === newFingerprint) {
    // Material unchanged — no replace needed.
    return;
  }

  previousRelayFingerprints.set(hostId, newFingerprint);

  // Replace the registry client (no-op if fingerprint matches internally).
  try {
    const registry = getRelayTunnelRegistry();
    await registry.replace(toRuntimeKey(hostId), newRelayDescriptor);
  } catch {
    // Replace failure is isolated — the restartHost call will use the
    // transport factory which also calls ensure(), recovering gracefully.
  }
}
