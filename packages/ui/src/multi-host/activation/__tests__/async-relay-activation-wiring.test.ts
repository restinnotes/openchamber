/**
 * Async relay activation wiring tests.
 *
 * Proves that:
 *   1. activateRelayTunnelAsync awaits registry.ensure() (blocks until ready)
 *   2. ensure reject → activation fails, active key not polluted
 *   3. ensure pending → activation doesn't succeed early
 *   4. active key doesn't get polluted on failure
 *   5. runtime-first and monitor-first both factory=1
 *
 * These tests exercise the core async activation chain without the full
 * Activation Controller, focusing on the relay-specific guarantees.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createRelayTunnelRegistry } from '@/lib/relay/multi-runtime/relay-tunnel-registry';
import { toRuntimeKey } from '@/lib/relay/multi-runtime/types';
import type { RelayRuntimeDescriptor, RelayRuntimeKey, RelayTunnelRegistry } from '@/lib/relay/multi-runtime/types';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import {
  activateRelayTunnelAsync,
  getActiveRelayTunnel,
  setRelayTunnelRegistry,
  disposeRelayTunnels,
} from '@/lib/relay/runtime-tunnel';

// ---------------------------------------------------------------------------
// Fixtures
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

const createTrackingFactory = () => {
  factoryCalls = new Map();
  return (descriptor: RelayRuntimeDescriptor): RelayTunnelClient => {
    const count = factoryCalls.get(descriptor.serverId) ?? 0;
    factoryCalls.set(descriptor.serverId, count + 1);
    return createMockClient(`client-${descriptor.serverId}-${count}`);
  };
};

const makeDescriptor = (serverId: string): RelayRuntimeDescriptor => ({
  relayUrl: `wss://${serverId}.relay.example.com`,
  serverId,
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'test', y: 'test' },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('async relay activation wiring', () => {
  let registry: RelayTunnelRegistry;

  beforeEach(() => {
    registry = createRelayTunnelRegistry({ createClient: createTrackingFactory() });
    setRelayTunnelRegistry(registry);
  });

  afterEach(() => {
    void disposeRelayTunnels();
    setRelayTunnelRegistry(null);
    registry.dispose();
  });

  // ===================================================================
  // 1. activateRelayTunnelAsync awaits registry.ensure (blocks until ready)
  // ===================================================================

  test('awaits ensure — returns ready client, not null', async () => {
    const key = toRuntimeKey('host_await');
    const desc = makeDescriptor('server-await');

    const client = await activateRelayTunnelAsync({ ...desc, runtimeKey: key });

    // Client is ready (not null, not pending)
    expect(client).not.toBeNull();
    expect(client).toBe(registry.get(key));
    expect(getActiveRelayTunnel()).toBe(client);
    expect(factoryCalls.get('server-await')).toBe(1);
  });

  // ===================================================================
  // 2. ensure pending — activation blocks until client ready
  // ===================================================================

  test('blocks until ensure resolves — activation completes after registry', async () => {
    let ensureResolveFn: (() => void) | null = null as (() => void) | null;
    const blockingRegistry = createRelayTunnelRegistry({
      createClient: () => createMockClient('blocking'),
    });
    const originalEnsure = blockingRegistry.ensure.bind(blockingRegistry) as (
      key: RelayRuntimeKey,
      descriptor: RelayRuntimeDescriptor,
    ) => Promise<RelayTunnelClient>;
    blockingRegistry.ensure = ((key: RelayRuntimeKey, descriptor: RelayRuntimeDescriptor) =>
      new Promise<RelayTunnelClient>((resolve) => {
        ensureResolveFn = () => {
          void originalEnsure(key, descriptor).then(resolve);
        };
      })) as typeof blockingRegistry.ensure;
    setRelayTunnelRegistry(blockingRegistry);

    const key = toRuntimeKey('host_blocking');
    const desc = makeDescriptor('server-blocking');

    let activationCompleted = false;
    const activationPromise = activateRelayTunnelAsync({ ...desc, runtimeKey: key }).then(() => {
      activationCompleted = true;
    });

    // Wait a tick — activation should NOT have completed
    await new Promise((r) => setTimeout(r, 10));
    expect(activationCompleted).toBe(false);

    // Release the block
    ensureResolveFn?.();
    await activationPromise;
    expect(activationCompleted).toBe(true);

    blockingRegistry.dispose();
  });

  // ===================================================================
  // 3. ensure reject — activation fails and rolls back
  // ===================================================================

  test('ensure reject — activation fails, active key not polluted', async () => {
    const failingRegistry = createRelayTunnelRegistry({
      createClient: () => { throw new Error('connection refused'); },
    });
    setRelayTunnelRegistry(failingRegistry);

    const key = toRuntimeKey('host_fail');
    const desc = makeDescriptor('server-fail');

    await expect(activateRelayTunnelAsync({ ...desc, runtimeKey: key }))
      .rejects.toThrow('connection refused');

    // Active key not polluted — no stale reference
    expect(getActiveRelayTunnel()).toBeNull();

    failingRegistry.dispose();
  });

  // ===================================================================
  // 4. active key doesn't get polluted on partial failure
  // ===================================================================

  test('failed activation does not leave active key pointing to failed client', async () => {
    let callCount = 0;
    const mixedRegistry = createRelayTunnelRegistry({
      createClient: () => {
        callCount++;
        if (callCount === 1) throw new Error('first attempt fails');
        return createMockClient('recovered');
      },
    });
    setRelayTunnelRegistry(mixedRegistry);

    // First activation fails
    const key1 = toRuntimeKey('host_pollution_1');
    const desc1 = makeDescriptor('server-pollution');
    try {
      await activateRelayTunnelAsync({ ...desc1, runtimeKey: key1 });
    } catch {
      // Expected
    }

    // Active key should be null after failure
    expect(getActiveRelayTunnel()).toBeNull();

    // Second activation with a different key succeeds (clean key)
    const key2 = toRuntimeKey('host_pollution_2');
    const client = await activateRelayTunnelAsync({ ...desc1, runtimeKey: key2 });
    expect(getActiveRelayTunnel()).toBe(client);
    expect(client).not.toBeNull();
    expect(mixedRegistry.get(key2)).toBe(client);

    mixedRegistry.dispose();
  });

  // ===================================================================
  // 5. runtime-first and monitor-first both factory=1
  // ===================================================================

  test('both activation orders produce exactly one client', async () => {
    // Order A: runtime first → monitor second
    const keyA = toRuntimeKey('host_dedup_a');
    const descA = makeDescriptor('server-dedup-a');
    const clientA = await activateRelayTunnelAsync({ ...descA, runtimeKey: keyA });
    const monitorA = await registry.ensure(keyA, descA);
    expect(clientA).toBe(monitorA);
    expect(factoryCalls.get('server-dedup-a')).toBe(1);

    // Order B: monitor first → runtime second
    const keyB = toRuntimeKey('host_dedup_b');
    const descB = makeDescriptor('server-dedup-b');
    const monitorB = await registry.ensure(keyB, descB);
    const clientB = await activateRelayTunnelAsync({ ...descB, runtimeKey: keyB });
    expect(clientB).toBe(monitorB);
    expect(factoryCalls.get('server-dedup-b')).toBe(1);
  });
});
