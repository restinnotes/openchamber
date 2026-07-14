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
 *   G. activateRelayTunnelAsync (async activation)
 *   H. grant chain (grant changes trigger fingerprint diff)
 *   I. fingerprint covers grant field
 *   J. lifecycle ownership (close vs deactivate)
 *   K. legacy alias safety
 *   L. adoptRelayTunnel ownership
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createRelayTunnelRegistry } from '../multi-runtime/relay-tunnel-registry';
import { computeDescriptorFingerprint } from '../multi-runtime/relay-descriptor-fingerprint';
import { toRuntimeKey } from '../multi-runtime/types';
import type { RelayRuntimeDescriptor } from '../multi-runtime/types';
import type { RelayTunnelClient } from '../tunnel-client';
import {
  activateRelayTunnel,
  activateRelayTunnelAsync,
  deactivateActiveRelayTunnel,
  getActiveRelayTunnel,
  setRelayTunnelRegistry,
  disposeRelayTunnels,
  adoptRelayTunnel,
  closeRelayTunnelForRuntime,
  closeActiveRelayTunnel,
} from '../runtime-tunnel';

// ---------------------------------------------------------------------------
// Mock factory — tracks call count per serverId
// ---------------------------------------------------------------------------

let factoryCalls: Map<string, number> = new Map();

const createMockClient = (id: string): RelayTunnelClient & { isClosed: boolean } => {
  let closed = false;
  const client = {
    fetch: async () => new Response(),
    subscribeStatus: () => () => {},
    close: () => { closed = true; },
    get isClosed() { return closed; },
    clientId: id,
  };
  return client as unknown as RelayTunnelClient & { isClosed: boolean };
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

  // ===================================================================
  // activateRelayTunnelAsync — async activation
  // ===================================================================

  describe('activateRelayTunnelAsync', () => {
    test('awaits registry.ensure and returns client (runtime-first)', async () => {
      const runtimeKey = toRuntimeKey('host_a');
      const descriptor = makeDescriptor('server-a');

      const client = await activateRelayTunnelAsync({ ...descriptor, runtimeKey });

      expect(client).not.toBeNull();
      expect(client).toBe(registry.get(runtimeKey));
      expect(getActiveRelayTunnel()).toBe(client);
      expect(factoryCalls.get('server-a')).toBe(1);
    });

    test('awaits registry.ensure and returns client (monitor-first)', async () => {
      const runtimeKey = toRuntimeKey('host_b');
      const descriptor = makeDescriptor('server-b');

      // Monitor creates first
      const monitorClient = await registry.ensure(runtimeKey, descriptor);

      // Async activation returns same client
      const client = await activateRelayTunnelAsync({ ...descriptor, runtimeKey });

      expect(client).toBe(monitorClient);
      expect(getActiveRelayTunnel()).toBe(client);
      expect(factoryCalls.get('server-b')).toBe(1);
    });

    test('same descriptor is a no-op (returns cached client)', async () => {
      const runtimeKey = toRuntimeKey('host_c');
      const descriptor = makeDescriptor('server-c');

      const clientA = await activateRelayTunnelAsync({ ...descriptor, runtimeKey });
      const clientB = await activateRelayTunnelAsync({ ...descriptor, runtimeKey });

      expect(clientA).toBe(clientB);
      expect(factoryCalls.get('server-c')).toBe(1);
    });

    test('different descriptor creates new client', async () => {
      const runtimeKey = toRuntimeKey('host_d');
      const descV1 = makeDescriptor('server-d', { relayUrl: 'wss://v1.relay.example.com' });
      const descV2 = makeDescriptor('server-d', { relayUrl: 'wss://v2.relay.example.com' });

      const clientV1 = await activateRelayTunnelAsync({ ...descV1, runtimeKey });
      const clientV2 = await activateRelayTunnelAsync({ ...descV2, runtimeKey });

      expect(clientV1).not.toBe(clientV2);
      expect(factoryCalls.get('server-d')).toBe(2);
    });

    test('registry failure propagates to caller', async () => {
      const failingRegistry = createRelayTunnelRegistry({
        createClient: () => { throw new Error('connection refused'); },
      });
      setRelayTunnelRegistry(failingRegistry);

      const runtimeKey = toRuntimeKey('host_e');
      const descriptor = makeDescriptor('server-e');

      await expect(activateRelayTunnelAsync({ ...descriptor, runtimeKey }))
        .rejects.toThrow('connection refused');

      // Restore original registry
      setRelayTunnelRegistry(registry);
      await failingRegistry.dispose();
    });
  });

  // ===================================================================
  // Grant chain — grant changes trigger fingerprint diff
  // ===================================================================

  describe('grant chain', () => {
    test('grant change triggers registry replace', async () => {
      const runtimeKey = toRuntimeKey('host_g');
      const descNoGrant = makeDescriptor('server-g');
      const descWithGrant = makeDescriptor('server-g', { grant: 'pairing-token-abc' });

      const clientNoGrant = await registry.ensure(runtimeKey, descNoGrant);

      // Grant appears → fingerprint changes → replace
      const clientWithGrant = await registry.replace(runtimeKey, descWithGrant);

      expect(clientWithGrant).not.toBe(clientNoGrant);
      expect(factoryCalls.get('server-g')).toBe(2);
    });

    test('grant removal triggers registry replace', async () => {
      const runtimeKey = toRuntimeKey('host_h');
      const descWithGrant = makeDescriptor('server-h', { grant: 'pairing-token-xyz' });
      const descNoGrant = makeDescriptor('server-h');

      const clientWithGrant = await registry.ensure(runtimeKey, descWithGrant);

      // Grant removed → fingerprint changes → replace
      const clientNoGrant = await registry.replace(runtimeKey, descNoGrant);

      expect(clientNoGrant).not.toBe(clientWithGrant);
      expect(factoryCalls.get('server-h')).toBe(2);
    });
  });

  // ===================================================================
  // Fingerprint covers grant field
  // ===================================================================

  describe('fingerprint grant coverage', () => {
    test('different grants produce different fingerprints', async () => {
      const descA = makeDescriptor('server-fp', { grant: 'grant-alpha' });
      const descB = makeDescriptor('server-fp', { grant: 'grant-beta' });

      const fpA = await computeDescriptorFingerprint(descA);
      const fpB = await computeDescriptorFingerprint(descB);

      expect(fpA).not.toBe(fpB);
    });

    test('no grant vs grant produces different fingerprints', async () => {
      const descNoGrant = makeDescriptor('server-fp2');
      const descWithGrant = makeDescriptor('server-fp2', { grant: 'grant-xyz' });

      const fpNoGrant = await computeDescriptorFingerprint(descNoGrant);
      const fpWithGrant = await computeDescriptorFingerprint(descWithGrant);

      expect(fpNoGrant).not.toBe(fpWithGrant);
    });

    test('same grant produces same fingerprint', async () => {
      const descA = makeDescriptor('server-fp3', { grant: 'grant-same' });
      const descB = makeDescriptor('server-fp3', { grant: 'grant-same' });

      const fpA = await computeDescriptorFingerprint(descA);
      const fpB = await computeDescriptorFingerprint(descB);

      expect(fpA).toBe(fpB);
    });
  });

  // ===================================================================
  // Lifecycle ownership — close vs deactivate
  // ===================================================================

  describe('lifecycle ownership', () => {
    test('deactivate clears ref, registry entry survives', async () => {
      const runtimeKey = toRuntimeKey('host_lc');
      const descriptor = makeDescriptor('server-lc');

      const client = await registry.ensure(runtimeKey, descriptor);
      activateRelayTunnel({ ...descriptor, runtimeKey });
      expect(getActiveRelayTunnel()).toBe(client);

      deactivateActiveRelayTunnel();

      expect(getActiveRelayTunnel()).toBeNull();
      expect(registry.has(runtimeKey)).toBe(true);
      expect(registry.get(runtimeKey)).toBe(client);
    });

    test('closeRelayTunnelForRuntime removes entry and clears ref', async () => {
      const runtimeKey = toRuntimeKey('host_lc2');
      const descriptor = makeDescriptor('server-lc2');

      const client = await registry.ensure(runtimeKey, descriptor);
      activateRelayTunnel({ ...descriptor, runtimeKey });
      expect(getActiveRelayTunnel()).toBe(client);

      await closeRelayTunnelForRuntime(runtimeKey);

      expect(getActiveRelayTunnel()).toBeNull();
      expect(registry.has(runtimeKey)).toBe(false);
      expect(registry.get(runtimeKey)).toBeFalsy();
    });

    test('disposeRelayTunnels closes all and clears ref', async () => {
      const keyA = toRuntimeKey('host_lc3');
      const keyB = toRuntimeKey('host_lc4');
      const descA = makeDescriptor('server-lc3');
      const descB = makeDescriptor('server-lc4');

      await registry.ensure(keyA, descA);
      const clientB = await registry.ensure(keyB, descB);
      activateRelayTunnel({ ...descB, runtimeKey: keyB });
      expect(getActiveRelayTunnel()).toBe(clientB);

      await disposeRelayTunnels();

      expect(getActiveRelayTunnel()).toBeNull();
    });
  });

  // ===================================================================
  // Legacy alias safety
  // ===================================================================

  describe('legacy alias safety', () => {
    test('closeActiveRelayTunnel only clears reference (does not close all)', async () => {
      const runtimeKey = toRuntimeKey('host_alias');
      const descriptor = makeDescriptor('server-alias');

      const client = await registry.ensure(runtimeKey, descriptor);
      activateRelayTunnel({ ...descriptor, runtimeKey });
      expect(getActiveRelayTunnel()).toBe(client);

      // Using deprecated alias
      closeActiveRelayTunnel();

      // Reference cleared
      expect(getActiveRelayTunnel()).toBeNull();

      // Registry entry NOT closed (alias only clears ref)
      expect(registry.has(runtimeKey)).toBe(true);
      expect(registry.get(runtimeKey)).toBe(client);
    });
  });

  // ===================================================================
  // adoptRelayTunnel ownership transfer
  // ===================================================================

  describe('adoptRelayTunnel ownership', () => {
    test('adopted client becomes active, previous client closed', () => {
      const descriptor = makeDescriptor('server-adopt');

      // First activation — get a mock client we can track
      const firstClient = createMockClient('first');
      adoptRelayTunnel(descriptor, firstClient);
      expect(getActiveRelayTunnel()).toBe(firstClient);

      // Adopt a different client (simulates probe tunnel handoff)
      const probeClient = createMockClient('probe');
      adoptRelayTunnel({ ...descriptor, runtimeKey: toRuntimeKey('host_adopt') }, probeClient);

      // Previous client closed, new client active
      expect(firstClient.isClosed).toBe(true);
      expect(getActiveRelayTunnel()).toBe(probeClient);
    });

    test('adopting same client twice is a no-op', () => {
      const descriptor = makeDescriptor('server-adopt2');
      const client = createMockClient('stable');

      adoptRelayTunnel(descriptor, client);
      expect(getActiveRelayTunnel()).toBe(client);

      // Adopt again — no double-close
      adoptRelayTunnel(descriptor, client);
      expect(getActiveRelayTunnel()).toBe(client);
      expect(client.isClosed).toBe(false);
    });
  });
});
