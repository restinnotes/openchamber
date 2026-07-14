/**
 * Multi-runtime relay registry types.
 *
 * This module defines the public API surface for the keyed relay tunnel
 * registry. It does NOT re-declare any types from the frozen multi-host
 * layer or from the relay tunnel client — it composes them.
 */

import type { RelayTunnelClient } from '../tunnel-client';

// ---------------------------------------------------------------------------
// Runtime key — stable brand for registry lookup
// ---------------------------------------------------------------------------

/** Stable key for a relay tunnel entry. Derived from HostId. */
export type RelayRuntimeKey = string & { readonly __brand: 'RelayRuntimeKey' };

/** Create a RelayRuntimeKey from a HostId string. */
export const toRuntimeKey = (hostId: string): RelayRuntimeKey =>
  hostId as RelayRuntimeKey;

// ---------------------------------------------------------------------------
// Relay descriptor (internal, tunnel-client-shaped)
// ---------------------------------------------------------------------------

/**
 * Internal descriptor shape required by `createRelayTunnelClient`.
 * This is NOT the frozen HostTransportRelay — it is the resolved
 * connection material that the adapter produces.
 */
export interface RelayRuntimeDescriptor {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
}

// ---------------------------------------------------------------------------
// Descriptor adapter
// ---------------------------------------------------------------------------

/**
 * Converts a frozen `HostTransportRelay` (plus pairing material) into
 * the internal `RelayRuntimeDescriptor` needed by the tunnel client.
 */
export interface RelayDescriptorAdapter {
  fromHostTransport(transport: { relayServerId: string }): RelayRuntimeDescriptor;
}

// ---------------------------------------------------------------------------
// Registry entry status
// ---------------------------------------------------------------------------

export type RelayRegistryEntryState =
  | 'idle'
  | 'creating'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'closing'
  | 'closed';

export type RelayRegistryEntryStatus = {
  state: RelayRegistryEntryState;
  lastError?: string;
  generation: number;
};

// ---------------------------------------------------------------------------
// Status listener
// ---------------------------------------------------------------------------

export type RelayStatusListener = (status: RelayRegistryEntryStatus) => void;

// ---------------------------------------------------------------------------
// Safe logger interface
// ---------------------------------------------------------------------------

export interface SafeRelayLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Registry options
// ---------------------------------------------------------------------------

export interface RelayTunnelRegistryOptions {
  createClient: (descriptor: RelayRuntimeDescriptor) => RelayTunnelClient | Promise<RelayTunnelClient>;
  logger?: SafeRelayLogger;
  maxEntries?: number;
  idleTtlMs?: number;
  /** Injected clock for testing idle TTL. Defaults to Date.now. */
  clock?: () => number;
  /** Injected timer for testing. Defaults to global setTimeout/clearTimeout. */
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(id: unknown): void;
  };
}

// ---------------------------------------------------------------------------
// Registry interface
// ---------------------------------------------------------------------------

export interface RelayTunnelRegistry {
  /**
   * Get or create a tunnel client for the given runtime key.
   * Deduplicates concurrent calls with the same key.
   * If an entry exists with a different descriptor, implicitly replaces it.
   */
  ensure(runtimeKey: RelayRuntimeKey, descriptor: RelayRuntimeDescriptor): Promise<RelayTunnelClient>;

  /** Get the client for a runtime key without creating one. */
  get(runtimeKey: RelayRuntimeKey): RelayTunnelClient | undefined;

  /** Check if a runtime key has a registered entry. */
  has(runtimeKey: RelayRuntimeKey): boolean;

  /** Get the status of a runtime key's entry. */
  getStatus(runtimeKey: RelayRuntimeKey): RelayRegistryEntryStatus | undefined;

  /**
   * Replace the descriptor for a runtime key.
   * No-op if fingerprint is unchanged.
   * Closes old client and creates new one if changed.
   */
  replace(runtimeKey: RelayRuntimeKey, descriptor: RelayRuntimeDescriptor): Promise<RelayTunnelClient>;

  /** Close the tunnel client for a specific runtime key. */
  close(runtimeKey: RelayRuntimeKey): Promise<void>;

  /** Close all tunnel clients. */
  closeAll(): Promise<void>;

  /**
   * Subscribe to status changes for a runtime key.
   * Returns an unsubscribe function.
   */
  subscribe(runtimeKey: RelayRuntimeKey, listener: RelayStatusListener): () => void;

  /** Dispose the registry. No new clients after this. */
  dispose(): Promise<void>;
}
