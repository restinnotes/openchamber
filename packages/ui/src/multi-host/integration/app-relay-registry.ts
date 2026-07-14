/**
 * App-level relay tunnel registry singleton.
 *
 * This is the single shared RelayTunnelRegistry for the entire application.
 * Both the multi-host monitor and the active runtime use this registry to
 * obtain RelayTunnelClient instances, ensuring they share the same client
 * for the same runtime key.
 *
 * Lifecycle:
 * - Created on first getRelayTunnelRegistry() call
 * - Disposed on app teardown via disposeRelayTunnelRegistry()
 */

import { createRelayTunnelRegistry } from '@/lib/relay/multi-runtime/relay-tunnel-registry';
import type { RelayTunnelRegistry } from '@/lib/relay/multi-runtime/types';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';

let _registry: RelayTunnelRegistry | null = null;

/**
 * Get or create the singleton relay tunnel registry.
 * The registry uses the real createRelayTunnelClient factory.
 */
export function getRelayTunnelRegistry(): RelayTunnelRegistry {
  if (!_registry) {
    _registry = createRelayTunnelRegistry({
      createClient: (descriptor) =>
        createRelayTunnelClient({
          relayUrl: descriptor.relayUrl,
          serverId: descriptor.serverId,
          hostEncPubJwk: descriptor.hostEncPubJwk,
          ...(descriptor.grant ? { grant: descriptor.grant } : {}),
        }),
    });
  }
  return _registry;
}

/**
 * Dispose the singleton relay tunnel registry.
 * Closes all clients and prevents new client creation.
 */
export async function disposeRelayTunnelRegistry(): Promise<void> {
  if (_registry) {
    await _registry.dispose();
    _registry = null;
  }
}
