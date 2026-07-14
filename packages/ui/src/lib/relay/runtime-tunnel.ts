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
//   activateRelayTunnel  — when runtimeKey present, delegates to registry.ensure()
//                          (async background). Sync return is best-available.
//   deactivateActiveRelayTunnel — clears active reference only, does NOT close
//                                 the registry client (monitor may still need it).
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
// Private: background ensure
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: call registry.ensure() in the background and update the
 * active reference when the real client resolves. The sync return of the
 * calling function uses the best-available client at call time.
 */
const backgroundEnsure = (runtimeKey: RelayRuntimeKey, descriptor: RelayRuntimeDescriptor): void => {
  if (!_registry) return;
  void _registry.ensure(runtimeKey, descriptor).then(
    (client) => {
      // Only adopt if this runtimeKey is still the active one (no switch in between).
      if (activeRuntimeKey === runtimeKey) {
        activeTunnel = client;
      }
    },
    () => {
      // Background ensure failed — active reference remains whatever it was.
    },
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the active relay tunnel client.
 *
 * When the registry is available and a runtimeKey is active, always reads
 * from the registry — this ensures we return the SHARED client that the
 * monitor also uses, even if the background ensure hasn't completed yet.
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
 * Check if a runtimeKey is a multi-host key (starts with 'host_').
 * Only multi-host keys participate in registry sharing.
 */
const isMultiHostKey = (key: string): boolean => key.startsWith('host_');

/**
 * Activates relay mode with the given descriptor, replacing any previous tunnel.
 *
 * When the descriptor carries a `runtimeKey` that is a multi-host key
 * (starts with 'host_') and a registry is available, the registry is the
 * SOLE owner of the client:
 *   1. If registry.get(runtimeKey) returns an existing client, reuse it.
 *   2. Otherwise, fire-and-forget registry.ensure() in the background.
 *      The sync return is null; the background ensure updates the active
 *      reference when the real client resolves.
 *
 * Non-multi-host keys (relay:..., mobile:..., etc.) fall back to standalone
 * createRelayTunnelClient(). These paths don't participate in registry sharing.
 */
export const activateRelayTunnel = (descriptor: RelayRuntimeDescriptor): RelayTunnelClient | null => {
  // Same descriptor → no-op (reuse current).
  if (activeTunnel && activeDescriptor && descriptorsEqual(activeDescriptor, descriptor)) {
    return activeTunnel;
  }

  if (_registry && descriptor.runtimeKey && isMultiHostKey(descriptor.runtimeKey)) {
    // Registry-backed path: the registry is the sole owner.
    activeDescriptor = descriptor;
    activeRuntimeKey = descriptor.runtimeKey;

    // Fast path: registry already has a client for this key.
    const existing = _registry.get(descriptor.runtimeKey);
    if (existing) {
      activeTunnel = existing;
      return activeTunnel;
    }

    // Slow path: kick off background ensure. The sync return is null until
    // the client resolves; getActiveRelayTunnel() will return the real
    // client once background ensure completes.
    activeTunnel = null;
    backgroundEnsure(descriptor.runtimeKey, descriptor);
    return null;
  }

  // Legacy path (no runtimeKey, non-multi-host key, or no registry):
  // standalone client.
  activeTunnel?.close();
  activeDescriptor = descriptor;
  activeRuntimeKey = descriptor.runtimeKey ?? null;
  activeTunnel = createRelayTunnelClient(descriptor);
  return activeTunnel;
};

/**
 * Adopts an ALREADY-OPEN tunnel client (e.g. the connect flow's probe tunnel)
 * as the active runtime tunnel. When a runtimeKey is provided, registers
 * the client in the registry so subsequent ensure() calls reuse it.
 */
export const adoptRelayTunnel = (descriptor: RelayRuntimeDescriptor, client: RelayTunnelClient): void => {
  if (activeTunnel === client) return;
  activeTunnel?.close();
  activeDescriptor = descriptor;
  activeRuntimeKey = descriptor.runtimeKey ?? null;
  activeTunnel = client;
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
  activeTunnel = null;
  activeDescriptor = null;
  activeRuntimeKey = null;
};

/**
 * Close the relay tunnel for a specific runtime key.
 * Used when a host is deleted — closes the registry entry so the client
 * is freed. If the deleted host was the active runtime, clears the
 * active reference too.
 */
export const closeRelayTunnelForRuntime = async (runtimeKey: RelayRuntimeKey): Promise<void> => {
  if (activeRuntimeKey === runtimeKey) {
    activeTunnel = null;
    activeDescriptor = null;
    activeRuntimeKey = null;
  }
  if (_registry) {
    await _registry.close(runtimeKey);
  }
};

/**
 * Close ALL relay tunnels and dispose the registry reference.
 * Used on app teardown.
 */
export const disposeRelayTunnels = async (): Promise<void> => {
  activeTunnel = null;
  activeDescriptor = null;
  activeRuntimeKey = null;
  if (_registry) {
    await _registry.dispose();
  }
};

// ---------------------------------------------------------------------------
// Backwards-compat aliases (deprecated — prefer the explicit names above)
// ---------------------------------------------------------------------------

/** @deprecated Use deactivateActiveRelayTunnel */
export const deactivateRelayTunnel = deactivateActiveRelayTunnel;

/** @deprecated Use disposeRelayTunnels */
export const closeActiveRelayTunnel = disposeRelayTunnels;
