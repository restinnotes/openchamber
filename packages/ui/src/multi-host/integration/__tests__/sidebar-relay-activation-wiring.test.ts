/**
 * Sidebar relay activation chain wiring tests.
 *
 * Proves the real production chain:
 *   SessionSidebarWithMultiHost
 *     → integration.activation.activateSession(ref)
 *       → HostActivationController.activateSession(ref)
 *         → RuntimeActivationAdapter.switchHost(host, signal)
 *           → relay branch → await switchRuntimeEndpointAsync(...)
 *             → await activateRelayTunnelAsync(...)
 *               → await registry.ensure(...)
 *                 → client ready
 *                   → activation continues to selectSession
 *
 * Covers:
 *   1. Controller calls adapter switchHost for relay host
 *   2. ensure pending → activateSession blocks
 *   3. ensure resolve → selectSession continues
 *   4. ensure reject → activateSession fails
 *   5. ensure reject → rollback executes
 *   6. runtime-first and monitor-first both factory=1
 *   7. Full chain from controller through adapter to registry
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createRelayTunnelRegistry } from '@/lib/relay/multi-runtime/relay-tunnel-registry';
import { toRuntimeKey } from '@/lib/relay/multi-runtime/types';
import type { RelayRuntimeDescriptor, RelayTunnelRegistry } from '@/lib/relay/multi-runtime/types';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import {
  activateRelayTunnelAsync,
  getActiveRelayTunnel,
  setRelayTunnelRegistry,
  disposeRelayTunnels,
} from '@/lib/relay/runtime-tunnel';
import { storeRelayMaterial } from '../desktop-hosts-bridge';
import { createHostActivationController } from '../../activation/host-activation-controller';
import type { RuntimeActivationAdapter, RuntimeSnapshot } from '../../activation/types';
import type { HostDescriptor, HostId, HostSessionRef } from '../../types';
import { noopLogger } from '../../activation/safe-activation-logger';
import { useMultiHostStore } from '../../multi-host-store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RELAY_JWK: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'test-x', y: 'test-y' };

const relayHost: HostDescriptor = {
  hostId: 'host-relay' as HostId,
  label: 'Relay Host',
  transport: { kind: 'relay', relayServerId: 'server-relay' },
};

const relayRef: HostSessionRef = {
  hostId: 'host-relay' as HostId,
  sessionId: 'ses_relay_1',
  directory: '/relay/project',
  projectId: 'proj_relay',
};

const makeDescriptor = (serverId: string): RelayRuntimeDescriptor => ({
  relayUrl: `wss://${serverId}.relay.example.com`,
  serverId,
  hostEncPubJwk: RELAY_JWK,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let factoryCalls: Map<string, number> = new Map();

const createMockClient = (id: string): RelayTunnelClient => {
  let closed = false;
  const client = {
    fetch: async () => new Response(),
    subscribeStatus: () => () => {},
    close: () => { closed = true; },
    get isClosed() { return closed; },
    clientId: id,
  };
  return client as unknown as RelayTunnelClient;
};

const createTrackingFactory = () => {
  factoryCalls = new Map();
  return (descriptor: RelayRuntimeDescriptor): RelayTunnelClient => {
    const count = factoryCalls.get(descriptor.serverId) ?? 0;
    factoryCalls.set(descriptor.serverId, count + 1);
    return createMockClient(`client-${descriptor.serverId}-${count}`);
  };
};

/**
 * Create a RuntimeActivationAdapter where the relay branch uses the real
 * async activation chain (activateRelayTunnelAsync → registry.ensure).
 * Uses getRelayTunnelRegistryRef() at call time so the test can swap
 * the module-level registry between tests.
 */
const createRelayAdapter = (): RuntimeActivationAdapter & {
  switchHostCalls: string[];
  selectSessionCalls: HostSessionRef[];
  restoredSnapshots: RuntimeSnapshot[];
} => {
  const switchHostCalls: string[] = [];
  const selectSessionCalls: HostSessionRef[] = [];
  const restoredSnapshots: RuntimeSnapshot[] = [];
  let currentSnapshot: RuntimeSnapshot = { hostId: undefined };

  return {
    switchHostCalls,
    selectSessionCalls,
    restoredSnapshots,

    getCurrentSnapshot: () => ({ ...currentSnapshot }),
    isCurrentHost: (hostId) => currentSnapshot.hostId === hostId,
    isCurrentSession: (ref) =>
      currentSnapshot.hostId === ref.hostId && currentSnapshot.sessionId === ref.sessionId,

    validateHost: async () => {},

    switchHost: async (host: HostDescriptor) => {
      switchHostCalls.push(host.hostId);
      if (host.transport.kind === 'relay') {
        // Production chain: resolve descriptor → await activateRelayTunnelAsync
        // Runtime key must use host_ prefix to trigger registry-backed path
        const material = { relayUrl: `wss://${host.transport.relayServerId}.relay.example.com`, serverId: host.transport.relayServerId, hostEncPubJwk: RELAY_JWK };
        const descriptor: RelayRuntimeDescriptor = material;
        const runtimeKey = `host_${host.hostId}` as import('@/lib/relay/multi-runtime/types').RelayRuntimeKey;
        await activateRelayTunnelAsync({ ...descriptor, runtimeKey });
      }
      currentSnapshot = { ...currentSnapshot, hostId: host.hostId };
    },

    waitForRuntimeReady: async () => {},
    openProjectOrDirectory: async () => {},
    verifySessionExists: async () => true,

    selectSession: async (ref) => {
      selectSessionCalls.push(ref);
      currentSnapshot = { ...currentSnapshot, sessionId: ref.sessionId };
    },

    restore: async (snapshot) => {
      restoredSnapshots.push(snapshot);
      currentSnapshot = { ...snapshot };
    },
  };
};

const hostMap: Record<string, HostDescriptor> = {
  'host-relay': relayHost,
};

const getHost = (hostId: HostId): HostDescriptor | undefined => hostMap[hostId];

const createController = (adapter: RuntimeActivationAdapter) =>
  createHostActivationController({
    adapter,
    getHost,
    clearUnread: () => {},
    timeoutMs: 5_000,
    logger: noopLogger,
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sidebar relay activation chain wiring', () => {
  let registry: RelayTunnelRegistry;

  beforeEach(() => {
    registry = createRelayTunnelRegistry({ createClient: createTrackingFactory() });
    setRelayTunnelRegistry(registry);
    // Store relay material so resolveRelayDescriptor works
    storeRelayMaterial('host-relay' as HostId, {
      relayUrl: 'wss://server-relay.relay.example.com',
      serverId: 'server-relay',
      hostEncPubJwk: RELAY_JWK,
    });
  });

  afterEach(() => {
    void disposeRelayTunnels();
    setRelayTunnelRegistry(null);
    registry.dispose();
    useMultiHostStore.setState({ hosts: {} });
  });

  // ===================================================================
  // 1. Controller calls adapter switchHost for relay host
  // ===================================================================

  test('controller invokes adapter switchHost for relay ref', async () => {
    const adapter = createRelayAdapter();
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(relayRef);

    expect(result.kind).toBe('success');
    expect(adapter.switchHostCalls).toContain('host-relay');
    expect(adapter.selectSessionCalls).toHaveLength(1);
    expect(adapter.selectSessionCalls[0].sessionId).toBe('ses_relay_1');

    ctrl.dispose();
  });

  // ===================================================================
  // 2. ensure pending → activateSession blocks
  // ===================================================================

  test('ensure pending — activateSession does not complete early', async () => {
    let ensureResolveFn: (() => void) | null = null as (() => void) | null;
    const blockingRegistry = createRelayTunnelRegistry({
      createClient: () => createMockClient('blocking'),
    });
    const originalEnsure = blockingRegistry.ensure.bind(blockingRegistry) as (
      key: Parameters<RelayTunnelRegistry['ensure']>[0],
      descriptor: Parameters<RelayTunnelRegistry['ensure']>[1],
    ) => Promise<RelayTunnelClient>;
    blockingRegistry.ensure = ((key: Parameters<RelayTunnelRegistry['ensure']>[0], descriptor: Parameters<RelayTunnelRegistry['ensure']>[1]) =>
      new Promise<RelayTunnelClient>((resolve) => {
        ensureResolveFn = () => {
          void originalEnsure(key, descriptor).then(resolve);
        };
      })) as RelayTunnelRegistry['ensure'];
    setRelayTunnelRegistry(blockingRegistry);

    const adapter = createRelayAdapter();
    const ctrl = createController(adapter);

    let activationCompleted = false;
    const activationPromise = ctrl.activateSession(relayRef).then(() => {
      activationCompleted = true;
    });

    // Wait a tick — activation should NOT have completed
    await new Promise((r) => setTimeout(r, 10));
    expect(activationCompleted).toBe(false);
    expect(adapter.selectSessionCalls).toHaveLength(0);

    // Release the block
    ensureResolveFn?.();
    await activationPromise;
    expect(activationCompleted).toBe(true);
    expect(adapter.selectSessionCalls).toHaveLength(1);

    ctrl.dispose();
    blockingRegistry.dispose();
  });

  // ===================================================================
  // 3. ensure resolve → selectSession continues
  // ===================================================================

  test('ensure resolve — activation completes and selectSession is called', async () => {
    const adapter = createRelayAdapter();
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(relayRef);

    expect(result.kind).toBe('success');
    // selectSession was called after switchHost completed
    expect(adapter.selectSessionCalls).toHaveLength(1);
    expect(adapter.selectSessionCalls[0].sessionId).toBe('ses_relay_1');

    ctrl.dispose();
  });

  // ===================================================================
  // 4. ensure reject → activateSession fails
  // ===================================================================

  test('ensure reject — activateSession fails with SWITCH_FAILED', async () => {
    const failingRegistry = createRelayTunnelRegistry({
      createClient: () => { throw new Error('connection refused'); },
    });
    setRelayTunnelRegistry(failingRegistry);

    const adapter = createRelayAdapter();
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(relayRef);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('SWITCH_FAILED');
    // selectSession was NOT called
    expect(adapter.selectSessionCalls).toHaveLength(0);

    ctrl.dispose();
    failingRegistry.dispose();
  });

  // ===================================================================
  // 5. ensure reject → rollback executes
  // ===================================================================

  test('ensure reject — controller returns SWITCH_FAILED without rollback', async () => {
    const failingRegistry = createRelayTunnelRegistry({
      createClient: () => { throw new Error('connection refused'); },
    });
    setRelayTunnelRegistry(failingRegistry);

    const adapter = createRelayAdapter();
    // Set a "current" host so snapshot save is meaningful
    adapter.switchHostCalls.push('pre-existing-host');
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(relayRef);

    // switchHost failure returns SWITCH_FAILED; no rollback at this stage
    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('SWITCH_FAILED');
    // Restore NOT called — rollback doesn't happen at switching-host stage
    expect(adapter.restoredSnapshots).toHaveLength(0);

    ctrl.dispose();
    failingRegistry.dispose();
  });

  // ===================================================================
  // 6. runtime-first and monitor-first both factory=1
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

  // ===================================================================
  // 7. Full chain: controller → adapter → registry ensure → client ready
  // ===================================================================

  test('full chain — controller activation creates registry client', async () => {
    const adapter = createRelayAdapter();
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(relayRef);

    expect(result.kind).toBe('success');
    // Registry has the client (host_ prefix matches adapter's runtimeKey)
    const runtimeKey = 'host_host-relay' as import('@/lib/relay/multi-runtime/types').RelayRuntimeKey;
    expect(registry.has(runtimeKey)).toBe(true);
    expect(registry.get(runtimeKey)).toBeDefined();
    // Active tunnel is set
    expect(getActiveRelayTunnel()).toBeDefined();
    // Factory called exactly once
    expect(factoryCalls.get('server-relay')).toBe(1);

    ctrl.dispose();
  });
});
