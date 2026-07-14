/**
 * Production-level tests for relay sharing, host lifecycle wiring,
 * and the desktop-hosts-bridge sync mechanics.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createRelayTunnelRegistry } from '@/lib/relay/multi-runtime/relay-tunnel-registry';
import { toRuntimeKey } from '@/lib/relay/multi-runtime/types';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import type { RelayRuntimeDescriptor } from '@/lib/relay/multi-runtime/types';
import { createCompositeTransportFactory } from '../composite-transport-factory';
import { createRelayMonitorTransport } from '../relay-monitor-transport';
import {
  storeRelayMaterial,
  getRelayMaterial,
  removeRelayMaterial,
  resolveRelayDescriptor,
  desktopHostsToDescriptors,
} from '../desktop-hosts-bridge';
import { createMultiHostSupervisor } from '../../monitor/multi-host-supervisor';
import type { HostDescriptor, HostId } from '../../types';
import type { DesktopHost } from '@/lib/desktopHosts';
import { useMultiHostStore } from '../../multi-host-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeClient(): RelayTunnelClient {
  let closed = false;
  const fakeWs = { send() {}, close() {}, readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null };
  return {
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    openWebSocket: () => fakeWs as ReturnType<RelayTunnelClient['openWebSocket']>,
    getStatus: () => ({ phase: 'connected' as const, reconnectAttempt: 0 }),
    subscribeStatus: () => () => {},
    close: () => { closed = true; },
    get closed() { return closed; },
  } as unknown as RelayTunnelClient;
}

function makeRelayDescriptor(serverId: string): RelayRuntimeDescriptor {
  return {
    relayUrl: `wss://relay-${serverId}.example.com/ws`,
    serverId,
    hostEncPubJwk: { kty: 'RSA', n: `modulus-${serverId}`, e: 'AQAB' },
  };
}

function makeRelayHost(id: string, serverId: string): HostDescriptor {
  return {
    hostId: `host_${id}` as HostId,
    label: `Relay ${id}`,
    transport: { kind: 'relay', relayServerId: serverId },
  };
}

function makeDirectHost(id: string, apiUrl: string): HostDescriptor {
  return {
    hostId: `host_${id}` as HostId,
    label: `Direct ${id}`,
    transport: { kind: 'direct', apiUrl },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Relay monitor transport via shared registry', () => {
  let registry: ReturnType<typeof createRelayTunnelRegistry>;
  let clientCalls: RelayRuntimeDescriptor[];

  beforeEach(() => {
    clientCalls = [];
    registry = createRelayTunnelRegistry({
      createClient: (descriptor) => {
        clientCalls.push(descriptor);
        return makeFakeClient();
      },
    });
  });

  afterEach(async () => {
    await registry.dispose();
  });

  test('relay transport gets client from shared registry', async () => {
    const descriptor = makeRelayHost('a', 'server-a');
    storeRelayMaterial(descriptor.hostId, {
      relayUrl: 'wss://relay-a.example.com/ws',
      serverId: 'server-a',
      hostEncPubJwk: { kty: 'RSA', n: 'modulus-a', e: 'AQAB' },
    });

    const factory = createRelayMonitorTransport({
      registry,
      resolveDescriptor: resolveRelayDescriptor,
    });

    const transport = factory(descriptor);
    // Make a request — should get client from registry
    await transport.request({ path: '/health' });

    expect(clientCalls.length).toBe(1);
    expect(clientCalls[0].serverId).toBe('server-a');
  });

  test('two calls for same runtimeKey reuse same client', async () => {
    const descriptor = makeRelayHost('a', 'server-a');
    storeRelayMaterial(descriptor.hostId, {
      relayUrl: 'wss://relay-a.example.com/ws',
      serverId: 'server-a',
      hostEncPubJwk: { kty: 'RSA', n: 'modulus-a', e: 'AQAB' },
    });

    const factory = createRelayMonitorTransport({
      registry,
      resolveDescriptor: resolveRelayDescriptor,
    });

    const transport = factory(descriptor);
    await transport.request({ path: '/health' });
    await transport.request({ path: '/sessions' });

    // Only one client created despite two requests
    expect(clientCalls.length).toBe(1);
  });

  test('monitor transport close does NOT close registry client', async () => {
    const descriptor = makeRelayHost('a', 'server-a');
    storeRelayMaterial(descriptor.hostId, {
      relayUrl: 'wss://relay-a.example.com/ws',
      serverId: 'server-a',
      hostEncPubJwk: { kty: 'RSA', n: 'modulus-a', e: 'AQAB' },
    });

    const factory = createRelayMonitorTransport({
      registry,
      resolveDescriptor: resolveRelayDescriptor,
    });

    const transport = factory(descriptor);
    await transport.request({ path: '/health' });

    // Close transport — client should still be alive
    transport.close();

    const client = registry.get(toRuntimeKey(descriptor.hostId));
    expect(client).toBeDefined();
    // Client is NOT closed by transport.close()
  });
});

describe('Composite transport factory', () => {
  let registry: ReturnType<typeof createRelayTunnelRegistry>;

  beforeEach(() => {
    registry = createRelayTunnelRegistry({
      createClient: () => makeFakeClient(),
    });
  });

  afterEach(async () => {
    await registry.dispose();
  });

  test('relay host uses relay transport', async () => {
    const descriptor = makeRelayHost('a', 'server-a');
    storeRelayMaterial(descriptor.hostId, {
      relayUrl: 'wss://relay-a.example.com/ws',
      serverId: 'server-a',
      hostEncPubJwk: { kty: 'RSA', n: 'modulus-a', e: 'AQAB' },
    });

    const factory = createCompositeTransportFactory({
      registry,
      resolveDescriptor: resolveRelayDescriptor,
    });

    const transport = factory(descriptor);
    // Should not throw — relay transport is available
    const response = await transport.request({ path: '/health' });
    expect(response.status).toBe(200);
  });

  test('direct host uses HTTP transport', async () => {
    const descriptor = makeDirectHost('b', 'http://10.0.0.1:4096');

    const factory = createCompositeTransportFactory({
      registry,
      resolveDescriptor: resolveRelayDescriptor,
    });

    const transport = factory(descriptor);
    // HTTP transport exists — verify it doesn't throw on construction
    expect(transport).toBeDefined();
    expect(transport.close).toBeDefined();
  });
});

describe('Monitor and runtime share same client via registry', () => {
  let registry: ReturnType<typeof createRelayTunnelRegistry>;

  beforeEach(() => {
    registry = createRelayTunnelRegistry({
      createClient: () => makeFakeClient(),
    });
  });

  afterEach(async () => {
    await registry.dispose();
  });

  test('same runtimeKey returns same client from registry', async () => {
    const descriptor = makeRelayDescriptor('server-a');
    const runtimeKey = toRuntimeKey('host_a');

    const client1 = await registry.ensure(runtimeKey, descriptor);
    const client2 = await registry.ensure(runtimeKey, descriptor);

    expect(client1).toBe(client2);
  });

  test('different runtimeKeys get different clients', async () => {
    const descA = makeRelayDescriptor('server-a');
    const descB = makeRelayDescriptor('server-b');

    const clientA = await registry.ensure(toRuntimeKey('host_a'), descA);
    const clientB = await registry.ensure(toRuntimeKey('host_b'), descB);

    expect(clientA).not.toBe(clientB);
  });

  test('relay A → relay B: A client not closed', async () => {
    const descA = makeRelayDescriptor('server-a');
    const descB = makeRelayDescriptor('server-b');

    const clientA = await registry.ensure(toRuntimeKey('host_a'), descA);
    await registry.ensure(toRuntimeKey('host_b'), descB);

    // clientA should still be in registry
    const retrieved = registry.get(toRuntimeKey('host_a'));
    expect(retrieved).toBe(clientA);
  });
});

describe('Two relay hosts monitored simultaneously', () => {
  let registry: ReturnType<typeof createRelayTunnelRegistry>;
  let clientCount: number;

  beforeEach(() => {
    clientCount = 0;
    registry = createRelayTunnelRegistry({
      createClient: () => {
        clientCount++;
        return makeFakeClient();
      },
    });
  });

  afterEach(async () => {
    await registry.dispose();
  });

  test('each relay host gets its own client', async () => {
    const descA = makeRelayDescriptor('server-a');
    const descB = makeRelayDescriptor('server-b');

    await registry.ensure(toRuntimeKey('host_a'), descA);
    await registry.ensure(toRuntimeKey('host_b'), descB);

    expect(clientCount).toBe(2);
    expect(registry.has(toRuntimeKey('host_a'))).toBe(true);
    expect(registry.has(toRuntimeKey('host_b'))).toBe(true);
  });

  test('closing one does not affect the other', async () => {
    const descA = makeRelayDescriptor('server-a');
    const descB = makeRelayDescriptor('server-b');

    await registry.ensure(toRuntimeKey('host_a'), descA);
    await registry.ensure(toRuntimeKey('host_b'), descB);

    await registry.close(toRuntimeKey('host_a'));

    expect(registry.has(toRuntimeKey('host_a'))).toBe(false);
    expect(registry.has(toRuntimeKey('host_b'))).toBe(true);
  });
});

describe('DesktopHostsToDescriptors conversion', () => {
  test('relay host with full material stores relay material', () => {
    const hosts: DesktopHost[] = [
      {
        id: 'relay-1',
        label: 'Remote Mac',
        url: 'relay://server-1',
        relay: {
          relayUrl: 'wss://relay.example.com/ws',
          serverId: 'server-1',
          hostEncPubJwk: { kty: 'RSA', n: 'mod1', e: 'AQAB' },
        },
      },
    ];

    const result = desktopHostsToDescriptors(hosts);
    const hostId = result.keys().next().value!;
    const material = getRelayMaterial(hostId);

    expect(material).not.toBeNull();
    expect(material!.serverId).toBe('server-1');
    expect(material!.relayUrl).toBe('wss://relay.example.com/ws');
  });

  test('resolveRelayDescriptor returns full descriptor', () => {
    const hosts: DesktopHost[] = [
      {
        id: 'relay-2',
        label: 'Relay Host',
        url: 'relay://server-2',
        relay: {
          relayUrl: 'wss://relay2.example.com/ws',
          serverId: 'server-2',
          hostEncPubJwk: { kty: 'RSA', n: 'mod2', e: 'AQAB' },
        },
      },
    ];

    const result = desktopHostsToDescriptors(hosts);
    const descriptor = result.values().next().value!;

    const resolved = resolveRelayDescriptor(descriptor);
    expect(resolved).not.toBeNull();
    expect(resolved!.serverId).toBe('server-2');
    expect(resolved!.relayUrl).toBe('wss://relay2.example.com/ws');
  });

  test('direct host resolveRelayDescriptor returns null', () => {
    const descriptor = makeDirectHost('d', 'http://10.0.0.1:4096');
    const resolved = resolveRelayDescriptor(descriptor);
    expect(resolved).toBeNull();
  });

  test('removeRelayMaterial cleans up', () => {
    const hosts: DesktopHost[] = [
      {
        id: 'relay-3',
        label: 'Temp',
        url: 'relay://s3',
        relay: {
          relayUrl: 'wss://r3/ws',
          serverId: 's3',
          hostEncPubJwk: { kty: 'RSA', n: 'm', e: 'AQAB' },
        },
      },
    ];

    const result = desktopHostsToDescriptors(hosts);
    const hostId = result.keys().next().value!;
    expect(getRelayMaterial(hostId)).not.toBeNull();

    removeRelayMaterial(hostId);
    expect(getRelayMaterial(hostId)).toBeNull();
  });
});

describe('Supervisor handles relay hosts with composite factory', () => {
  let registry: ReturnType<typeof createRelayTunnelRegistry>;

  beforeEach(() => {
    useMultiHostStore.setState({ hosts: {} });
    registry = createRelayTunnelRegistry({
      createClient: () => makeFakeClient(),
    });
  });

  afterEach(async () => {
    await registry.dispose();
  });

  test('startAll with relay hosts does not throw', () => {
    storeRelayMaterial('host_a' as HostId, {
      relayUrl: 'wss://relay-a/ws',
      serverId: 'a',
      hostEncPubJwk: { kty: 'RSA', n: 'a', e: 'AQAB' },
    });

    const supervisor = createMultiHostSupervisor({
      transportFactory: createCompositeTransportFactory({
        registry,
        resolveDescriptor: resolveRelayDescriptor,
      }),
    });

    const hosts = new Map<HostId, HostDescriptor>();
    hosts.set('host_a' as HostId, makeRelayHost('a', 'a'));

    // Should not throw — relay transport is handled
    supervisor.startAll(hosts);

    // Host should be registered in store
    expect(useMultiHostStore.getState().hosts['host_a']).toBeDefined();

    supervisor.dispose();
  });

  test('one relay host failure does not prevent others', () => {
    const failRegistry = createRelayTunnelRegistry({
      createClient: (d) => {
        if (d.serverId === 'fail') throw new Error('connection refused');
        return makeFakeClient();
      },
    });

    storeRelayMaterial('host_ok' as HostId, {
      relayUrl: 'wss://ok/ws', serverId: 'ok', hostEncPubJwk: { kty: 'RSA', n: 'ok', e: 'AQAB' },
    });
    storeRelayMaterial('host_fail' as HostId, {
      relayUrl: 'wss://fail/ws', serverId: 'fail', hostEncPubJwk: { kty: 'RSA', n: 'f', e: 'AQAB' },
    });

    const supervisor = createMultiHostSupervisor({
      transportFactory: createCompositeTransportFactory({
        registry: failRegistry,
        resolveDescriptor: resolveRelayDescriptor,
      }),
    });

    const hosts = new Map<HostId, HostDescriptor>();
    hosts.set('host_ok' as HostId, makeRelayHost('ok', 'ok'));
    hosts.set('host_fail' as HostId, makeRelayHost('fail', 'fail'));

    supervisor.startAll(hosts);

    // Both hosts should be registered in store
    expect(useMultiHostStore.getState().hosts['host_ok']).toBeDefined();
    expect(useMultiHostStore.getState().hosts['host_fail']).toBeDefined();

    supervisor.dispose();
    failRegistry.dispose();
  });
});
