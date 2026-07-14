/**
 * Runtime tunnel registry wiring tests.
 *
 * Proves that the active runtime and monitor share the same RelayTunnelClient
 * via the shared RelayTunnelRegistry, regardless of activation order.
 *
 * Covers:
 *   A. runtime first → monitor second
 *   B. monitor first → runtime second
 *   C. Relay A/B isolation (two clients)
 *   D. deactivate doesn't close registry client
 *   E. host deletion closes client
 *   F. descriptor replace
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createRelayTunnelRegistry } from '../multi-runtime/relay-tunnel-registry';
import { toRuntimeKey } from '../multi-runtime/types';
import type { RelayRuntimeDescriptor } from '../multi-runtime/types';
import type { RelayTunnelClient } from '../tunnel-client';
import {
  activateRelayTunnel,
  deactivateActiveRelayTunnel,
  getActiveRelayTunnel,
  setRelayTunnelRegistry,
  disposeRelayTunnels,
  adoptRelayTunnel,
  closeRelayTunnelForRuntime,
} from '../runtime-tunnel';

// ---------------------------------------------------------------------------
// Mock factory — tracks call count per serverId
// ---------------------------------------------------------------------------

let factoryCalls: Map<string, number> = new Map();

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

const createCountingFactory = () => {
  factoryCalls = new Map();
  return (descriptor: RelayRuntimeDescriptor): RelayTunnelClient => {
    const count = factoryCalls.get(descriptor.serverId) ?? 0;
    factoryCalls.set(descriptor.serverId, count + 1);
    return createMockClient(`client-${descriptor.serverId}-${count}`);
  };
};

const makeDescriptor = (
  serverId: string,
  overrides?: Partial<RelayRuntimeDescriptor>,
): RelayRuntimeDescriptor => ({
  relayUrl: `wss://${serverId}.relay.example.com`,
  serverId,
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'test', y: 'test' },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runtime-tunnel registry wiring', () => {
  let registry: ReturnType<typeof createRelayTunnelRegistry>;

  beforeEach(() => {
    registry = createRelayTunnelRegistry({ createClient: createCountingFactory() });
    setRelayTunnelRegistry(registry);
  });

  afterEach(() => {
    void disposeRelayTunnels();
    setRelayTunnelRegistry(null);
    registry.dispose();
  });

  // ===================================================================
  // Order A: runtime first → monitor second
  // ===================================================================

  describe('Order A: runtime first → monitor second', () => {
    test('factory called once, runtime and monitor share same client', async () => {
      const runtimeKey = toRuntimeKey('host_a');
      const descriptor = makeDescriptor('server-a');

      // 1. Runtime activates (no registry entry yet → background ensure)
      const runtimeResult = activateRelayTunnel({ ...descriptor, runtimeKey });
      // Sync result is null (client being created in background)
      expect(runtimeResult).toBeNull();

      // 2. Monitor calls ensure (deduplicates with background ensure)
      const monitorClient = await registry.ensure(runtimeKey, descriptor);

      // 3. Factory called exactly once
      expect(factoryCalls.get('server-a')).toBe(1);

      // 4. getActiveRelayTunnel returns the registry client
      const activeClient = getActiveRelayTunnel();
      expect(activeClient).toBe(monitorClient);
      expect(activeClient).not.toBeNull();
    });
  });

  // ===================================================================
  // Order B: monitor first → runtime second
  // ===================================================================

  describe('Order B: monitor first → runtime second', () => {
    test('factory called once, runtime and monitor share same client', async () => {
      const runtimeKey = toRuntimeKey('host_b');
      const descriptor = makeDescriptor('server-b');

      // 1. Monitor calls ensure (creates client)
      const monitorClient = await registry.ensure(runtimeKey, descriptor);

      // 2. Runtime activates (registry.get returns existing client)
      const runtimeResult = activateRelayTunnel({ ...descriptor, runtimeKey });

      // 3. Factory called exactly once
      expect(factoryCalls.get('server-b')).toBe(1);

      // 4. Runtime gets the same client as the monitor
      expect(runtimeResult).toBe(monitorClient);

      // 5. getActiveRelayTunnel also returns it
      expect(getActiveRelayTunnel()).toBe(monitorClient);
    });
  });

  // ===================================================================
  // Relay A/B isolation
  // ===================================================================

  describe('Relay A/B isolation', () => {
    test('two relays get independent clients', async () => {
      const keyA = toRuntimeKey('host_a');
      const descA = makeDescriptor('server-a');
      const keyB = toRuntimeKey('host_b');
      const descB = makeDescriptor('server-b');

      const clientA = await registry.ensure(keyA, descA);
      const clientB = await registry.ensure(keyB, descB);

      // Each relay has its own client
      expect(clientA).not.toBe(clientB);
      expect(factoryCalls.get('server-a')).toBe(1);
      expect(factoryCalls.get('server-b')).toBe(1);

      // Activating relay A doesn't affect relay B
      activateRelayTunnel({ ...descA, runtimeKey: keyA });
      expect(getActiveRelayTunnel()).toBe(clientA);

      activateRelayTunnel({ ...descB, runtimeKey: keyB });
      expect(getActiveRelayTunnel()).toBe(clientB);
    });
  });

  // ===================================================================
  // Deactivate doesn't close registry client
  // ===================================================================

  describe('deactivateActiveRelayTunnel', () => {
    test('clears active reference but keeps registry client alive', async () => {
      const runtimeKey = toRuntimeKey('host_c');
      const descriptor = makeDescriptor('server-c');

      const client = await registry.ensure(runtimeKey, descriptor);
      activateRelayTunnel({ ...descriptor, runtimeKey });
      expect(getActiveRelayTunnel()).toBe(client);

      // Deactivate
      deactivateActiveRelayTunnel();

      // Active reference cleared
      expect(getActiveRelayTunnel()).toBeNull();

      // Registry client still alive
      expect(registry.has(runtimeKey)).toBe(true);
      expect(registry.get(runtimeKey)).toBe(client);
    });
  });

  // ===================================================================
  // Host deletion closes client
  // ===================================================================

  describe('closeRelayTunnelForRuntime', () => {
    test('closes registry entry and clears active reference', async () => {
      const runtimeKey = toRuntimeKey('host_d');
      const descriptor = makeDescriptor('server-d');

      const client = await registry.ensure(runtimeKey, descriptor);
      activateRelayTunnel({ ...descriptor, runtimeKey });
      expect(getActiveRelayTunnel()).toBe(client);

      // Delete host
      await closeRelayTunnelForRuntime(runtimeKey);

      // Active reference cleared
      expect(getActiveRelayTunnel()).toBeNull();

      // Registry entry removed
      expect(registry.has(runtimeKey)).toBe(false);
      expect(registry.get(runtimeKey)).toBeFalsy();
    });

    test('closing one host does not affect another', async () => {
      const keyA = toRuntimeKey('host_a');
      const descA = makeDescriptor('server-a');
      const keyB = toRuntimeKey('host_b');
      const descB = makeDescriptor('server-b');

      await registry.ensure(keyA, descA);
      const clientB = await registry.ensure(keyB, descB);

      // Delete host A
      await closeRelayTunnelForRuntime(keyA);

      // Host A gone (clientA no longer accessible via registry)
      expect(registry.has(keyA)).toBe(false);
      expect(registry.get(keyA)).toBeFalsy();

      // Host B untouched
      expect(registry.has(keyB)).toBe(true);
      expect(registry.get(keyB)).toBe(clientB);
    });
  });

  // ===================================================================
  // Legacy path (no runtimeKey) creates standalone client
  // ===================================================================

  describe('legacy path (no runtimeKey)', () => {
    test('creates standalone client without registry', () => {
      const descriptor = makeDescriptor('standalone');

      const client = activateRelayTunnel(descriptor);
      expect(client).not.toBeNull();
      expect(getActiveRelayTunnel()).toBe(client);

      // No registry entry created
      expect(factoryCalls.has('standalone')).toBe(false);
    });
  });

  // ===================================================================
  // adoptRelayTunnel
  // ===================================================================

  describe('adoptRelayTunnel', () => {
    test('adopts client as active reference', () => {
      const runtimeKey = toRuntimeKey('host_test');
      const descriptor = makeDescriptor('server-test');
      const mockClient = createMockClient('adopted');

      adoptRelayTunnel({ ...descriptor, runtimeKey }, mockClient);
      expect(getActiveRelayTunnel()).toBe(mockClient);
    });
  });

  // ===================================================================
  // disposeRelayTunnels (app teardown)
  // ===================================================================

  describe('disposeRelayTunnels', () => {
    test('clears active reference and disposes registry', async () => {
      const runtimeKey = toRuntimeKey('host_e');
      const descriptor = makeDescriptor('server-e');

      await registry.ensure(runtimeKey, descriptor);
      activateRelayTunnel({ ...descriptor, runtimeKey });

      await disposeRelayTunnels();

      // Active reference cleared
      expect(getActiveRelayTunnel()).toBeNull();
    });
  });

  // ===================================================================
  // Descriptor replace
  // ===================================================================

  describe('descriptor replace', () => {
    test('replace with same fingerprint is a no-op', async () => {
      const runtimeKey = toRuntimeKey('host_f');
      const descriptor = makeDescriptor('server-f');

      const clientBefore = await registry.ensure(runtimeKey, descriptor);
      const clientAfter = await registry.replace(runtimeKey, descriptor);

      // Same client returned (no replace happened)
      expect(clientAfter).toBe(clientBefore);
      expect(factoryCalls.get('server-f')).toBe(1);
    });

    test('replace with different descriptor creates new client', async () => {
      const runtimeKey = toRuntimeKey('host_g');
      const descV1 = makeDescriptor('server-g', { relayUrl: 'wss://v1.relay.example.com' });
      const descV2 = makeDescriptor('server-g', { relayUrl: 'wss://v2.relay.example.com' });

      const clientV1 = await registry.ensure(runtimeKey, descV1);
      const clientV2 = await registry.replace(runtimeKey, descV2);

      // New client created
      expect(clientV2).not.toBe(clientV1);
      expect(factoryCalls.get('server-g')).toBe(2);

      // Registry returns new client
      expect(registry.get(runtimeKey)).toBe(clientV2);
    });

    test('active runtime gets new client after replace', async () => {
      const runtimeKey = toRuntimeKey('host_h');
      const descV1 = makeDescriptor('server-h', { relayUrl: 'wss://v1.relay.example.com' });
      const descV2 = makeDescriptor('server-h', { relayUrl: 'wss://v2.relay.example.com' });

      const clientV1 = await registry.ensure(runtimeKey, descV1);
      activateRelayTunnel({ ...descV1, runtimeKey });
      expect(getActiveRelayTunnel()).toBe(clientV1);

      // Replace descriptor
      const clientV2 = await registry.replace(runtimeKey, descV2);

      // Active runtime now gets new client
      expect(getActiveRelayTunnel()).toBe(clientV2);
      expect(getActiveRelayTunnel()).not.toBe(clientV1);
    });

    test('replace one relay does not affect another', async () => {
      const keyA = toRuntimeKey('host_a');
      const descA = makeDescriptor('server-a', { relayUrl: 'wss://a.relay.example.com' });
      const keyB = toRuntimeKey('host_b');
      const descB = makeDescriptor('server-b', { relayUrl: 'wss://b.relay.example.com' });
      const descAUpdated = makeDescriptor('server-a', { relayUrl: 'wss://a-v2.relay.example.com' });

      const clientA = await registry.ensure(keyA, descA);
      const clientB = await registry.ensure(keyB, descB);

      // Replace A only
      await registry.replace(keyA, descAUpdated);

      // A has new client
      expect(registry.get(keyA)).not.toBe(clientA);

      // B untouched
      expect(registry.get(keyB)).toBe(clientB);
    });
  });
});
