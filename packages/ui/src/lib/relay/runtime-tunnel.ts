// Module-level singleton holding the active relay tunnel client, if the runtime
// is in relay mode. Kept in its own module so runtime-switch, runtime-fetch,
// runtime-url, and the event pipeline can all read it without an import cycle
// (runtime-switch <-> runtime-url).
//
// Registry-backed: when a RelayTunnelRegistry is available (set by the app
// provider), ALL relay tunnel clients are owned by the registry. The active
// runtime and monitor always share the same client for the same runtimeKey.
//
// API contract:
//   activateRelayTunnelAsync — async: awaits registry.ensure(), propagates
//     failure. For multi-host runtime switch (the primary activation path).
//   activateRelayTunnel — sync: legacy path for non-multi-host callers
//     (no runtimeKey). Creates standalone client. MUST NOT be used for
//     multi-host relay activation.
//   deactivateActiveRelayTunnel — clears active reference only, does NOT close
//     the registry client (monitor may still need it).
//   closeRelayTunnelForRuntime  — closes a specific registry entry (host deletion).
//   disposeRelayTunnels         — closes all registry entries (app teardown).

import { createRelayTunnelClient, type RelayTunnelClient } from './tunnel-client';
import type { RelayTunnelRegistry, RelayRuntimeKey } from './multi-runtime/types';

export interface RelayRuntimeDescriptor {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
  /** Stable registry key — when provided, the registry is the sole owner. */
  runtimeKey?: RelayRuntimeKey;
}

let activeTunnel: RelayTunnelClient | null = null;
let activeDescriptor: RelayRuntimeDescriptor | null = null;
let activeRuntimeKey: RelayRuntimeKey | null = null;
let _registry: RelayTunnelRegistry | null = null;

const descriptorsEqual = (a: RelayRuntimeDescriptor, b: RelayRuntimeDescriptor): boolean =>
  a.relayUrl === b.relayUrl &&
  a.serverId === b.serverId &&
  a.grant === b.grant &&
  JSON.stringify(a.hostEncPubJwk) === JSON.stringify(b.hostEncPubJwk);

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

/**
 * Inject the shared relay tunnel registry. Called once by the app provider
 * during mount. All relay tunnel clients are owned by the registry when set.
 */
export const setRelayTunnelRegistry = (registry: RelayTunnelRegistry | null): void => {
  _registry = registry;
};

/** Return the currently injected registry (or null). */
export const getRelayTunnelRegistryRef = (): RelayTunnelRegistry | null => _registry;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Check if a runtimeKey is a multi-host key (starts with 'host_').
 * Only multi-host keys participate in registry sharing.
 */
const isMultiHostKey = (key: string): boolean => key.startsWith('host_');

/**
 * Set the active relay references (tunnel, descriptor, key).
 * Centralizes the state update for both sync and async paths.
 */
const setActiveRelay = (
  tunnel: RelayTunnelClient | null,
  descriptor: RelayRuntimeDescriptor | null,
  runtimeKey: RelayRuntimeKey | null,
): void => {
  activeTunnel = tunnel;
  activeDescriptor = descriptor;
  activeRuntimeKey = runtimeKey;
};

// ---------------------------------------------------------------------------
// Public API — async (primary path for multi-host)
// ---------------------------------------------------------------------------

/**
 * Return the active relay tunnel client.
 *
 * When the registry is available and a runtimeKey is active, always reads
 * from the registry — this ensures we return the SHARED client that the
 * monitor also uses.
 */
export const getActiveRelayTunnel = (): RelayTunnelClient | null => {
  if (_registry && activeRuntimeKey) {
    const client = _registry.get(activeRuntimeKey);
    if (client) return client;
  }
  return activeTunnel;
};

export const isRelayModeActive = (): boolean => activeTunnel !== null;

/**
 * Activate relay mode — async version.
 *
 * Awaits registry.ensure() for multi-host keys, ensuring the client is
 * ready before the runtime switch continues. Failure propagates to the
 * caller (Activation Controller can roll back).
 *
 * For multi-host relay runtime switch — the PRIMARY activation path.
 */
export const activateRelayTunnelAsync = async (
  descriptor: RelayRuntimeDescriptor,
): Promise<RelayTunnelClient> => {
  // Same descriptor → no-op (reuse current).
  if (activeTunnel && activeDescriptor && descriptorsEqual(activeDescriptor, descriptor)) {
    return activeTunnel;
  }

  if (_registry && descriptor.runtimeKey && isMultiHostKey(descriptor.runtimeKey)) {
    // Registry-backed path: await ensure — client is ready when we return.
    setActiveRelay(null, descriptor, descriptor.runtimeKey);
    const client = await _registry.ensure(descriptor.runtimeKey, descriptor);
    // Only adopt if this runtimeKey is still the active one (no switch in between).
    if (activeRuntimeKey === descriptor.runtimeKey) {
      setActiveRelay(client, descriptor, descriptor.runtimeKey);
    }
    return client;
  }

  // Legacy path (no runtimeKey, non-multi-host key, or no registry):
  // standalone client.
  return activateRelayTunnel(descriptor) ?? createRelayTunnelClient(descriptor);
};

// ---------------------------------------------------------------------------
// Public API — sync (legacy, non-multi-host only)
// ---------------------------------------------------------------------------

/**
 * Activate relay mode — sync version (legacy).
 *
 * For multi-host keys, this uses a fast-path registry lookup if available,
 * but does NOT await ensure. Use activateRelayTunnelAsync() for the
 * primary multi-host runtime switch path.
 *
 * Non-multi-host keys (relay:..., mobile:..., etc.) create standalone clients.
 * These paths don't participate in registry sharing.
 */
export const activateRelayTunnel = (descriptor: RelayRuntimeDescriptor): RelayTunnelClient | null => {
  // Same descriptor → no-op (reuse current).
  if (activeTunnel && activeDescriptor && descriptorsEqual(activeDescriptor, descriptor)) {
    return activeTunnel;
  }

  if (_registry && descriptor.runtimeKey && isMultiHostKey(descriptor.runtimeKey)) {
    // Registry-backed path: fast lookup only (no await).
    setActiveRelay(null, descriptor, descriptor.runtimeKey);
    const existing = _registry.get(descriptor.runtimeKey);
    if (existing) {
      setActiveRelay(existing, descriptor, descriptor.runtimeKey);
      return existing;
    }
    // No existing client — caller should use activateRelayTunnelAsync() instead.
    // Return null to signal that the client is not ready yet.
    return null;
  }

  // Legacy path (no runtimeKey, non-multi-host key, or no registry):
  // standalone client.
  activeTunnel?.close();
  const client = createRelayTunnelClient(descriptor);
  setActiveRelay(client, descriptor, descriptor.runtimeKey ?? null);
  return client;
};

/**
 * Adopt an ALREADY-OPEN tunnel client (e.g. the connect flow's probe tunnel)
 * as the active runtime tunnel.
 *
 * Ownership transfer: the probe caller must NOT close this client after
 * calling adoptRelayTunnel. The active runtime (or registry) now owns it.
 *
 * When a runtimeKey is provided, the client becomes the active reference.
 * The registry does NOT manage this client unless it was obtained via
 * registry.ensure() — this is a direct adoption for probe/switch flows.
 */
export const adoptRelayTunnel = (descriptor: RelayRuntimeDescriptor, client: RelayTunnelClient): void => {
  if (activeTunnel === client) return;
  activeTunnel?.close();
  setActiveRelay(client, descriptor, descriptor.runtimeKey ?? null);
};

// ---------------------------------------------------------------------------
// Lifecycle operations (clearly separated)
// ---------------------------------------------------------------------------

/**
 * Deactivate the relay tunnel — clears the active reference only.
 * Does NOT close the registry client (the monitor may still need it).
 * Used when switching away from a relay host.
 */
export const deactivateActiveRelayTunnel = (): void => {
  setActiveRelay(null, null, null);
};

/**
 * Close the relay tunnel for a specific runtime key.
 * Used when a host is deleted — closes the registry entry so the client
 * is freed. If the deleted host was the active runtime, clears the
 * active reference too.
 */
export const closeRelayTunnelForRuntime = async (runtimeKey: RelayRuntimeKey): Promise<void> => {
  if (activeRuntimeKey === runtimeKey) {
    setActiveRelay(null, null, null);
  }
  if (_registry) {
    await _registry.close(runtimeKey);
  }
};

/**
 * Close ALL relay tunnels and dispose the registry reference.
 * Used on app teardown ONLY — never for individual host operations.
 */
export const disposeRelayTunnels = async (): Promise<void> => {
  setActiveRelay(null, null, null);
  if (_registry) {
    await _registry.dispose();
  }
};

// ---------------------------------------------------------------------------
// Backwards-compat aliases (deprecated — migrate to explicit names)
// ---------------------------------------------------------------------------

/** @deprecated Use deactivateActiveRelayTunnel — only clears reference. */
export const deactivateRelayTunnel = deactivateActiveRelayTunnel;

/**
 * @deprecated DANGEROUS — this was mapped to disposeRelayTunnels which closes
 * ALL hosts. Use deactivateActiveRelayTunnel (clear ref) or
 * closeRelayTunnelForRuntime (close one host) instead.
 * Kept only for backwards compatibility; will be removed.
 */
export const closeActiveRelayTunnel = deactivateActiveRelayTunnel;
