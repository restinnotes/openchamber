/**
 * Desktop hosts bridge — converts persisted DesktopHost configs into
 * HostDescriptors that the multi-host supervisor can monitor.
 *
 * This module is the missing link between the Electron persistence layer
 * (desktopHostsGet) and the multi-host supervisor (startAll/startHost).
 */

import type { HostDescriptor, HostId, HostTransport } from '../types';
import { hostIdFromExistingId } from '../host-registry';
import { desktopHostsGet, type DesktopHost } from '@/lib/desktopHosts';

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single DesktopHost to a HostDescriptor.
 * Uses hostIdFromExistingId for stable HostId across restarts.
 */
function desktopHostToDescriptor(host: DesktopHost): HostDescriptor {
  const hostId = hostIdFromExistingId(host.id);

  let transport: HostTransport;
  if (host.relay) {
    // Relay host — the supervisor's default transport factory will throw
    // for relay, so we mark it but rely on the relay transport factory
    // if one is injected. For monitoring purposes, we still register it.
    transport = {
      kind: 'relay',
      relayServerId: host.relay.serverId,
      requestHeaders: host.requestHeaders,
    };
  } else if (host.apiUrl) {
    // Direct host with explicit API URL
    transport = {
      kind: 'direct',
      apiUrl: host.apiUrl,
      requestHeaders: host.requestHeaders,
    };
  } else {
    // Fallback: treat as local
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
 *
 * Relay hosts are included in the map but marked for skip-by-supervisor
 * when no relay transport factory is injected. The supervisor's default
 * transport factory throws for relay, so these hosts are registered in
 * the store (for sidebar display) but not monitored until a relay
 * transport factory is available.
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
      // Skip hosts that fail to convert (e.g., missing required fields)
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Load & sync
// ---------------------------------------------------------------------------

/**
 * Load persisted desktop hosts and return their descriptors.
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
