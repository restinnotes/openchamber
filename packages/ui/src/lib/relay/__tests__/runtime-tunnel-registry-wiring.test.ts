/**
 * Runtime tunnel registry wiring tests.
 *
 * Proves that the active runtime and monitor share the same RelayTunnelClient
 * via the shared RelayTunnelRegistry when both use the same runtimeKey.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createRelayTunnelRegistry } from '../multi-runtime/relay-tunnel-registry';
import { toRuntimeKey } from '../multi-runtime/types';
import type { RelayRuntimeDescriptor } from '../multi-runtime/types';
import type { RelayTunnelClient } from '../tunnel-client';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  getActiveRelayTunnel,
  setRelayTunnelRegistry,
  closeActiveRelayTunnel,
  adoptRelayTunnel,
} from '../runtime-tunnel';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

const createMockClient = (id: string): RelayTunnelClient => {
  let closed = false;
  return {
    fetch: async () => new Response(),
    subscribeStatus: () => () => {},
    close: () => { closed = true; },
    get isClosed() { return closed; },
    get clientId() { return id; },
  } as unknown as RelayTunnelClient;
};

let clientCounter = 0;

const createMockDescriptor = (overrides?: Partial<RelayRuntimeDescriptor>): RelayRuntimeDescriptor => ({
  relayUrl: `wss://relay-${++clientCounter}.example.com`,
  serverId: `server-${clientCounter}`,
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'test', y: 'test' },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runtime-tunnel registry wiring', () => {
  let registry: ReturnType<typeof createRelayTunnelRegistry>;

  beforeEach(() => {
    clientCounter = 0;
    registry = createRelayTunnelRegistry({
      createClient: (descriptor) =>
        createMockClient(`registry-${descriptor.serverId}`),
    });
    setRelayTunnelRegistry(registry);
  });

  afterEach(() => {
    closeActiveRelayTunnel();
    setRelayTunnelRegistry(null);
    registry.dispose();
  });

  test('activateRelayTunnel returns registry client when runtimeKey provided', async () => {
    const runtimeKey = toRuntimeKey('host_test');
    const descriptor = createMockDescriptor();

    // Pre-populate the registry (simulating monitor probe)
    const monitorClient = await registry.ensure(runtimeKey, descriptor);

    // Activate the relay tunnel with the same runtimeKey
    const activeClient = activateRelayTunnel({
      ...descriptor,
      runtimeKey,
    });

    // The active runtime should get the SAME client as the monitor
    expect(activeClient).toBe(monitorClient);
  });

  test('getActiveRelayTunnel returns registry client', async () => {
    const runtimeKey = toRuntimeKey('host_test');
    const descriptor = createMockDescriptor();

    // Pre-populate the registry
    const monitorClient = await registry.ensure(runtimeKey, descriptor);

    // Activate the relay tunnel
    activateRelayTunnel({
      ...descriptor,
      runtimeKey,
    });

    // getActiveRelayTunnel should return the registry client
    const activeClient = getActiveRelayTunnel();
    expect(activeClient).toBe(monitorClient);
  });

  test('deactivateRelayTunnel does not close registry client', async () => {
    const runtimeKey = toRuntimeKey('host_test');
    const descriptor = createMockDescriptor();

    // Pre-populate the registry
    const monitorClient = await registry.ensure(runtimeKey, descriptor);

    // Activate the relay tunnel
    activateRelayTunnel({
      ...descriptor,
      runtimeKey,
    });

    // Deactivate the relay tunnel
    deactivateRelayTunnel();

    // The registry client should still be usable by the monitor
    expect(registry.has(runtimeKey)).toBe(true);
    expect(registry.get(runtimeKey)).toBe(monitorClient);
  });

  test('activateRelayTunnel falls back to standalone client on registry miss', () => {
    const descriptor = createMockDescriptor();

    // No runtimeKey provided — should create standalone client
    const client = activateRelayTunnel(descriptor);

    expect(client).toBeDefined();
    expect(getActiveRelayTunnel()).toBe(client);
  });

  test('adoptRelayTunnel stores client for later registry lookup', () => {
    const runtimeKey = toRuntimeKey('host_test');
    const descriptor = createMockDescriptor();
    const mockClient = createMockClient('adopted');

    // Adopt the client
    adoptRelayTunnel({ ...descriptor, runtimeKey }, mockClient);

    // The active tunnel should be the adopted client
    expect(getActiveRelayTunnel()).toBe(mockClient);
  });
});
