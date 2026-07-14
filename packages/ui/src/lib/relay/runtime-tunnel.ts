// Module-level singleton holding the active relay tunnel client, if the runtime
// is in relay mode. Kept in its own module so runtime-switch, runtime-fetch,
// runtime-url, and the event pipeline can all read it without an import cycle
// (runtime-switch <-> runtime-url).
//
// Registry-backed: when a RelayTunnelRegistry is available (set by the app
// provider), active tunnel lookup goes through the registry so the active
// runtime and monitor share the same client for the same runtimeKey. Falls
// back to standalone client creation when no registry is set.

import { createRelayTunnelClient, type RelayTunnelClient } from './tunnel-client';
import type { RelayTunnelRegistry, RelayRuntimeKey } from './multi-runtime/types';

export interface RelayRuntimeDescriptor {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
  /** Stable registry key — when provided, the registry is consulted first. */
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
 * during mount. All subsequent activateRelayTunnel / getActiveRelayTunnel
 * calls go through the registry when a runtimeKey is available.
 */
export const setRelayTunnelRegistry = (registry: RelayTunnelRegistry | null): void => {
  _registry = registry;
};

/** Return the currently injected registry (or null). */
export const getRelayTunnelRegistryRef = (): RelayTunnelRegistry | null => _registry;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const getActiveRelayTunnel = (): RelayTunnelClient | null => {
  // Prefer registry lookup when we have a runtimeKey — this returns the
  // SHARED client that the monitor also uses.
  if (_registry && activeRuntimeKey) {
    const client = _registry.get(activeRuntimeKey);
    if (client) return client;
  }
  return activeTunnel;
};

export const isRelayModeActive = (): boolean => activeTunnel !== null;

/**
 * Activates relay mode with the given descriptor, replacing any previous tunnel.
 *
 * When the descriptor carries a `runtimeKey` and a registry is available, the
 * registry is consulted first — if it already holds a client for that key
 * (e.g. created by the monitor probe), it is reused without a second
 * WebSocket connect. Falls back to standalone client creation when the
 * registry has no entry yet (the caller did not probe first).
 */
export const activateRelayTunnel = (descriptor: RelayRuntimeDescriptor): RelayTunnelClient => {
  if (activeTunnel && activeDescriptor && descriptorsEqual(activeDescriptor, descriptor)) {
    return activeTunnel;
  }

  // Try the registry first — the monitor may have already created a client.
  if (_registry && descriptor.runtimeKey) {
    const existing = _registry.get(descriptor.runtimeKey);
    if (existing) {
      activeTunnel?.close();
      activeDescriptor = descriptor;
      activeRuntimeKey = descriptor.runtimeKey;
      activeTunnel = existing;
      return activeTunnel;
    }
  }

  // Registry miss or no runtimeKey — fall back to standalone client.
  activeTunnel?.close();
  activeDescriptor = descriptor;
  activeRuntimeKey = descriptor.runtimeKey ?? null;
  activeTunnel = createRelayTunnelClient(descriptor);
  return activeTunnel;
};

/**
 * Adopts an ALREADY-OPEN tunnel client (e.g. the connect flow's probe tunnel)
 * as the active runtime tunnel, so the immediately following
 * `activateRelayTunnel` with an equal descriptor reuses it instead of paying a
 * second WebSocket connect + E2EE handshake. Replaces any previous tunnel.
 */
export const adoptRelayTunnel = (descriptor: RelayRuntimeDescriptor, client: RelayTunnelClient): void => {
  if (activeTunnel === client) return;
  activeTunnel?.close();
  activeDescriptor = descriptor;
  activeRuntimeKey = descriptor.runtimeKey ?? null;
  activeTunnel = client;
};

export const deactivateRelayTunnel = (): void => {
  // Only close the client when it was created locally (standalone).
  // When the client came from the registry, the registry owns its lifecycle.
  const fromRegistry = _registry && activeRuntimeKey && _registry.get(activeRuntimeKey) === activeTunnel;
  if (!fromRegistry) {
    activeTunnel?.close();
  }
  activeTunnel = null;
  activeDescriptor = null;
  activeRuntimeKey = null;
};

/**
 * Close the active relay tunnel regardless of origin (standalone or registry).
 * Used on host deletion or app teardown.
 */
export const closeActiveRelayTunnel = (): void => {
  activeTunnel?.close();
  activeTunnel = null;
  activeDescriptor = null;
  activeRuntimeKey = null;
};
