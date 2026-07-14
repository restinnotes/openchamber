/**
 * Relay descriptor adapter.
 *
 * Converts the frozen `HostTransportRelay` type into the internal
 * `RelayRuntimeDescriptor` needed by `createRelayTunnelClient`.
 *
 * This adapter is deliberately decoupled from the frozen multi-host layer:
 * it accepts the raw connection material (relayUrl, hostEncPubJwk, grant)
 * alongside the transport metadata so the Integration PR can wire up
 * pairing-saved fields without modifying frozen types.
 */

import type { RelayRuntimeDescriptor } from './types';

/**
 * Build a `RelayRuntimeDescriptor` from a host's relay transport config
 * and pairing-saved material.
 *
 * @param relayServerId - The `relayServerId` from `HostTransportRelay`
 * @param relayUrl - WebSocket endpoint for the relay server
 * @param hostEncPubJwk - Host's ECDH encryption public key (from pairing)
 * @param grant - Optional relay grant token
 */
export const createRelayDescriptor = (
  relayServerId: string,
  relayUrl: string,
  hostEncPubJwk: JsonWebKey,
  grant?: string,
): RelayRuntimeDescriptor => ({
  relayUrl,
  serverId: relayServerId,
  hostEncPubJwk,
  ...(grant !== undefined ? { grant } : {}),
});

/**
 * Adapter that converts a `HostTransportRelay` (frozen type) into a
 * `RelayRuntimeDescriptor`.
 *
 * The frozen `HostTransportRelay` only carries `relayServerId`. The
 * full connection material (`relayUrl`, `hostEncPubJwk`, `grant`) must
 * be supplied by the Integration PR from pairing-saved remote instance data.
 *
 * This adapter is a pure mapping helper — it does NOT access any store
 * or do I/O.
 */
export const fromHostTransport = (
  transport: { relayServerId: string },
  connectionMaterial: {
    relayUrl: string;
    hostEncPubJwk: JsonWebKey;
    grant?: string;
  },
): RelayRuntimeDescriptor =>
  createRelayDescriptor(
    transport.relayServerId,
    connectionMaterial.relayUrl,
    connectionMaterial.hostEncPubJwk,
    connectionMaterial.grant,
  );
