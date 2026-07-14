/**
 * Desktop hosts bridge — converts persisted DesktopHost configs into
 * HostDescriptors that the multi-host supervisor can monitor.
 *
 * Also maintains a store of relay connection material (relayUrl, hostEncPubJwk)
 * that the relay monitor transport needs to create tunnel clients.
 *
 * Provides syncPersistedHosts() for runtime lifecycle synchronization:
 * diffs current supervisor state with persisted state and applies additions,
 * updates, and deletions.
 */

import type { HostDescriptor, HostId, HostTransport } from '../types';
import { hostIdFromExistingId } from '../host-registry';
import { desktopHostsGet, type DesktopHost, type DesktopHostRelay } from '@/lib/desktopHosts';
import type { RelayRuntimeDescriptor } from '@/lib/relay/multi-runtime/types';
import type { SupervisorLifecycle } from './supervisor-lifecycle';
import { useMultiHostStore } from '../multi-host-store';

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
 * Sync the supervisor/store state with the latest persisted desktop hosts.
 *
 * This function:
 * 1. Reads the latest persisted hosts
 * 2. Converts them to descriptors
 * 3. Diffs against the current supervisor state
 * 4. Applies additions, updates, and deletions
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
          // Descriptor changed — restart with new descriptor
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
        removeRelayMaterial(hostId as HostId);
      }
    }
  } catch {
    // Sync is best-effort — don't throw on failures
  }
}
