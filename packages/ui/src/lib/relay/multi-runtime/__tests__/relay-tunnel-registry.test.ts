/**
 * Unit tests for the relay tunnel registry.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RelayTunnelClient, RelayTunnelStatus } from '../../tunnel-client';
import type { RelayRuntimeDescriptor, RelayRegistryEntryStatus } from '../types';
import { toRuntimeKey } from '../types';
import { createRelayTunnelRegistry } from '../relay-tunnel-registry';
import { computeDescriptorFingerprint } from '../relay-descriptor-fingerprint';

const createFakeClient = (opts: { closeThrows?: boolean } = {}): RelayTunnelClient => {
  let status: RelayTunnelStatus = { state: 'connected' };
  let closed = false;
  const listeners = new Set<(s: RelayTunnelStatus) => void>();
  return {
    getStatus: () => status,
    subscribeStatus: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    close: () => {
      if (opts.closeThrows) throw new Error('close failed');
      if (closed) return;
      closed = true;
      status = { state: 'idle' };
      for (const fn of listeners) try { fn(status); } catch { /* */ }
    },
    fetch: async () => new Response('ok'),
    openWebSocket: () => { throw new Error('not implemented'); },
    _setStatus: (s: RelayTunnelStatus) => { status = s; for (const fn of listeners) try { fn(s); } catch { /* */ }; },
  } as RelayTunnelClient;
};

const makeDescriptor = (id: string): RelayRuntimeDescriptor => ({
  relayUrl: `wss://relay-${id}.example.com/ws`, serverId: id,
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: `x-${id}`, y: `y-${id}` } as JsonWebKey,
});

const makeDescriptorV2 = (id: string): RelayRuntimeDescriptor => ({
  relayUrl: `wss://relay-${id}-v2.example.com/ws`, serverId: `${id}-v2`,
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: `x-${id}-v2`, y: `y-${id}-v2` } as JsonWebKey,
});

const createFakeClock = (startMs = 1000) => {
  let ms = startMs;
  return { now: () => ms, advance: (d: number) => { ms += d; } };
};

describe('RelayTunnelRegistry', () => {
  let r: ReturnType<typeof createRelayTunnelRegistry>;
  const clock = createFakeClock();

  beforeEach(() => {
    r = createRelayTunnelRegistry({ createClient: () => createFakeClient(), clock: clock.now, maxEntries: 10 });
  });

  afterEach(async () => { await r.dispose(); });

  test('two runtimeKeys connect simultaneously', async () => {
    const [a, b] = await Promise.all([
      r.ensure(toRuntimeKey('a'), makeDescriptor('a')),
      r.ensure(toRuntimeKey('b'), makeDescriptor('b')),
    ]);
    expect(a).not.toBe(b);
    expect(r.has(toRuntimeKey('a'))).toBe(true);
    expect(r.has(toRuntimeKey('b'))).toBe(true);
  });

  test('same runtimeKey ensure returns same client', async () => {
    const k = toRuntimeKey('a');
    const d = makeDescriptor('a');
    const c1 = await r.ensure(k, d);
    const c2 = await r.ensure(k, d);
    expect(c1).toBe(c2);
  });

  test('same runtimeKey concurrent ensure creates only once', async () => {
    let n = 0;
    await r.dispose();
    r = createRelayTunnelRegistry({ createClient: () => { n++; return createFakeClient(); }, clock: clock.now });
    const k = toRuntimeKey('a');
    const [c1, c2, c3] = await Promise.all([r.ensure(k, makeDescriptor('a')), r.ensure(k, makeDescriptor('a')), r.ensure(k, makeDescriptor('a'))]);
    expect(n).toBe(1);
    expect(c1).toBe(c2);
    expect(c2).toBe(c3);
  });

  test('create failure allows re-ensure', async () => {
    let fail = true;
    await r.dispose();
    r = createRelayTunnelRegistry({ createClient: () => { if (fail) throw new Error('no'); return createFakeClient(); }, clock: clock.now });
    const k = toRuntimeKey('a');
    await expect(r.ensure(k, makeDescriptor('a'))).rejects.toThrow();
    fail = false;
    const c = await r.ensure(k, makeDescriptor('a'));
    expect(c).toBeDefined();
  });

  test('host A failure does not affect B', async () => {
    let failA = false;
    await r.dispose();
    r = createRelayTunnelRegistry({ createClient: (d) => { if (failA && d.serverId.startsWith('a')) throw new Error('A'); return createFakeClient(); }, clock: clock.now });
    failA = true;
    await expect(r.ensure(toRuntimeKey('a'), makeDescriptor('a'))).rejects.toThrow();
    failA = false;
    const b = await r.ensure(toRuntimeKey('b'), makeDescriptor('b'));
    expect(b).toBeDefined();
  });

  test('same descriptor does not rebuild', async () => {
    let n = 0;
    await r.dispose();
    r = createRelayTunnelRegistry({ createClient: () => { n++; return createFakeClient(); }, clock: clock.now });
    const k = toRuntimeKey('a');
    const c1 = await r.ensure(k, makeDescriptor('a'));
    const c2 = await r.ensure(k, makeDescriptor('a'));
    expect(c1).toBe(c2);
    expect(n).toBe(1);
  });

  test('different descriptor rebuilds only affected host', async () => {
    let nA = 0, nB = 0;
    await r.dispose();
    r = createRelayTunnelRegistry({ createClient: (d) => { if (d.serverId.startsWith('a')) nA++; if (d.serverId.startsWith('b')) nB++; return createFakeClient(); }, clock: clock.now });
    await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    await r.ensure(toRuntimeKey('b'), makeDescriptor('b'));
    expect(nA).toBe(1);
    expect(nB).toBe(1);
    await r.ensure(toRuntimeKey('a'), makeDescriptorV2('a'));
    expect(nA).toBe(2);
    expect(nB).toBe(1);
  });

  test('replace closes old client', async () => {
    const k = toRuntimeKey('a');
    const c1 = await r.ensure(k, makeDescriptor('a'));
    const c2 = await r.replace(k, makeDescriptorV2('a'));
    expect(c2).not.toBe(c1);
    expect(c1.getStatus().state).toBe('idle');
    expect(c2.getStatus().state).toBe('connected');
  });

  test('replace no-ops when fingerprint unchanged', async () => {
    const k = toRuntimeKey('a');
    const c1 = await r.ensure(k, makeDescriptor('a'));
    const c2 = await r.replace(k, makeDescriptor('a'));
    expect(c2).toBe(c1);
  });

  test('close only closes target host', async () => {
    const kA = toRuntimeKey('a'), kB = toRuntimeKey('b');
    const cA = await r.ensure(kA, makeDescriptor('a'));
    const cB = await r.ensure(kB, makeDescriptor('b'));
    await r.close(kA);
    expect(r.has(kA)).toBe(false);
    expect(r.has(kB)).toBe(true);
    expect(cA.getStatus().state).toBe('idle');
    expect(cB.getStatus().state).toBe('connected');
  });

  test('closeAll closes all', async () => {
    const cA = await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    const cB = await r.ensure(toRuntimeKey('b'), makeDescriptor('b'));
    await r.closeAll();
    expect(cA.getStatus().state).toBe('idle');
    expect(cB.getStatus().state).toBe('idle');
  });

  test('dispose prevents new creation', async () => {
    await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    await r.dispose();
    await expect(r.ensure(toRuntimeKey('a'), makeDescriptor('a'))).rejects.toThrow('disposed');
  });

  test('close then ensure creates new entry', async () => {
    const k = toRuntimeKey('a');
    const c1 = await r.ensure(k, makeDescriptor('a'));
    await r.close(k);
    const c2 = await r.ensure(k, makeDescriptor('a'));
    expect(c2).not.toBe(c1);
    expect(c2.getStatus().state).toBe('connected');
  });

  test('closeAll + ensure concurrent: no ghost clients', async () => {
    await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    await r.ensure(toRuntimeKey('b'), makeDescriptor('b'));
    const p = r.ensure(toRuntimeKey('c'), makeDescriptor('c'));
    await r.closeAll();
    try { await p; } catch { /* */ }
    expect(r.has(toRuntimeKey('a'))).toBe(false);
    expect(r.has(toRuntimeKey('b'))).toBe(false);
  });

  test('listeners notified on ensure', async () => {
    const s: RelayRegistryEntryStatus[] = [];
    const k = toRuntimeKey('a');
    r.subscribe(k, (st) => s.push(st));
    await r.ensure(k, makeDescriptor('a'));
    expect(s.some((st) => st.state === 'connected')).toBe(true);
  });

  test('unsubscribe stops notifications', async () => {
    const k = toRuntimeKey('a');
    const s: RelayRegistryEntryStatus[] = [];
    const unsub = r.subscribe(k, (st) => s.push(st));
    await r.ensure(k, makeDescriptor('a'));
    expect(s.some((st) => st.state === 'connected')).toBe(true);
    unsub();
    await r.replace(k, makeDescriptorV2('a'));
    // Only the initial notification should have been received
    expect(s.length).toBe(1);
  });

  test('client status proxied correctly', async () => {
    const k = toRuntimeKey('a');
    const s: RelayRegistryEntryStatus[] = [];
    r.subscribe(k, (st) => s.push(st));
    await r.ensure(k, makeDescriptor('a'));
    expect(s.some((st) => st.state === 'connected')).toBe(true);
    expect(r.getStatus(k)?.state).toBe('connected');
  });

  test('listener error does not affect registry', async () => {
    const k = toRuntimeKey('a');
    r.subscribe(k, () => { throw new Error('boom'); });
    const c = await r.ensure(k, makeDescriptor('a'));
    expect(c).toBeDefined();
    const c2 = await r.replace(k, makeDescriptorV2('a'));
    expect(c2).toBeDefined();
  });

  test('host-lifetime ownership: entry survives cycles', async () => {
    const k = toRuntimeKey('a');
    const d = makeDescriptor('a');
    const c1 = await r.ensure(k, d);
    clock.advance(1000);
    const c2 = await r.ensure(k, d);
    clock.advance(1000);
    const c3 = r.get(k);
    expect(c1).toBe(c2);
    expect(c2).toBe(c3);
  });

  test('active host switch does not close old client', async () => {
    const cA = await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    const cB = await r.ensure(toRuntimeKey('b'), makeDescriptor('b'));
    r.get(toRuntimeKey('b'));
    expect(cA.getStatus().state).toBe('connected');
    expect(cB.getStatus().state).toBe('connected');
  });

  test('monitor and active runtime get same client', async () => {
    const k = toRuntimeKey('a');
    const c = await r.ensure(k, makeDescriptor('a'));
    expect(r.get(k)).toBe(c);
  });

  test('secrets not logged', async () => {
    const logs: string[] = [];
    await r.dispose();
    r = createRelayTunnelRegistry({
      createClient: () => createFakeClient(), clock: clock.now,
      logger: { debug: (m) => logs.push(m), info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    for (const l of logs) {
      expect(l).not.toContain('wss://');
      expect(l).not.toContain('hostEncPubJwk');
    }
  });

  test('fingerprint not reversible', async () => {
    const d: RelayRuntimeDescriptor = { relayUrl: 'wss://r/x', serverId: 's', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } as JsonWebKey, grant: 'secret' };
    const fp = await computeDescriptorFingerprint(d);
    expect(fp.length <= 16).toBe(true);
    expect(fp).not.toContain('secret');
  });

  test('fingerprint stable', async () => {
    const d: RelayRuntimeDescriptor = { relayUrl: 'wss://r/x', serverId: 's', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } as JsonWebKey };
    expect(await computeDescriptorFingerprint(d)).toBe(await computeDescriptorFingerprint(d));
  });

  test('secret change triggers rebuild', async () => {
    let n = 0;
    await r.dispose();
    r = createRelayTunnelRegistry({ createClient: () => { n++; return createFakeClient(); }, clock: clock.now });
    const k = toRuntimeKey('a');
    await r.ensure(k, makeDescriptor('a'));
    expect(n).toBe(1);
    await r.ensure(k, makeDescriptorV2('a'));
    expect(n).toBe(2);
  });

  test('maxEntries throws', async () => {
    await r.dispose();
    r = createRelayTunnelRegistry({ createClient: () => createFakeClient(), clock: clock.now, maxEntries: 2 });
    await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    await r.ensure(toRuntimeKey('b'), makeDescriptor('b'));
    await expect(r.ensure(toRuntimeKey('c'), makeDescriptor('c'))).rejects.toThrow('max entries');
  });

  test('client.close error still cleans entry', async () => {
    await r.dispose();
    r = createRelayTunnelRegistry({ createClient: () => createFakeClient({ closeThrows: true }), clock: clock.now });
    await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    await r.close(toRuntimeKey('a'));
    expect(r.has(toRuntimeKey('a'))).toBe(false);
  });

  test('dispose cleans listeners', async () => {
    const sA: RelayRegistryEntryStatus[] = [];
    const sB: RelayRegistryEntryStatus[] = [];
    r.subscribe(toRuntimeKey('a'), (s) => sA.push(s));
    r.subscribe(toRuntimeKey('b'), (s) => sB.push(s));
    await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    await r.ensure(toRuntimeKey('b'), makeDescriptor('b'));
    await r.dispose();
    expect(sA.length).toBeGreaterThan(0);
    expect(sB.length).toBeGreaterThan(0);
  });

  test('replace A does not affect B', async () => {
    const cA1 = await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    const cB = await r.ensure(toRuntimeKey('b'), makeDescriptor('b'));
    const cA2 = await r.replace(toRuntimeKey('a'), makeDescriptorV2('a'));
    expect(cA2).not.toBe(cA1);
    expect(cB.getStatus().state).toBe('connected');
  });

  test('close A, B still available', async () => {
    await r.ensure(toRuntimeKey('a'), makeDescriptor('a'));
    const cB = await r.ensure(toRuntimeKey('b'), makeDescriptor('b'));
    await r.close(toRuntimeKey('a'));
    expect(r.has(toRuntimeKey('a'))).toBe(false);
    expect(r.get(toRuntimeKey('b'))).toBe(cB);
  });

  test('registry client not in serializable state', async () => {
    const k = toRuntimeKey('a');
    const c = await r.ensure(k, makeDescriptor('a'));
    expect(r.get(k)).toBe(c);
    expect(Object.keys(r)).not.toContain('clients');
  });
});

describe('Descriptor Fingerprint', () => {
  test('different serverIds → different fingerprints', async () => {
    const d1: RelayRuntimeDescriptor = { relayUrl: 'wss://r/ws', serverId: 'a', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey };
    const d2: RelayRuntimeDescriptor = { relayUrl: 'wss://r/ws', serverId: 'b', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey };
    expect(await computeDescriptorFingerprint(d1)).not.toBe(await computeDescriptorFingerprint(d2));
  });

  test('different relayUrls → different fingerprints', async () => {
    const d1: RelayRuntimeDescriptor = { relayUrl: 'wss://r1/ws', serverId: 'a', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey };
    const d2: RelayRuntimeDescriptor = { relayUrl: 'wss://r2/ws', serverId: 'a', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey };
    expect(await computeDescriptorFingerprint(d1)).not.toBe(await computeDescriptorFingerprint(d2));
  });

  test('different hostEncPubJwk → different fingerprints', async () => {
    const d1: RelayRuntimeDescriptor = { relayUrl: 'wss://r/ws', serverId: 'a', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } as JsonWebKey };
    const d2: RelayRuntimeDescriptor = { relayUrl: 'wss://r/ws', serverId: 'a', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'c', y: 'd' } as JsonWebKey };
    expect(await computeDescriptorFingerprint(d1)).not.toBe(await computeDescriptorFingerprint(d2));
  });

  test('grant changes fingerprint', async () => {
    const d1: RelayRuntimeDescriptor = { relayUrl: 'wss://r/ws', serverId: 'a', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey };
    const d2: RelayRuntimeDescriptor = { relayUrl: 'wss://r/ws', serverId: 'a', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey, grant: 'g' };
    expect(await computeDescriptorFingerprint(d1)).not.toBe(await computeDescriptorFingerprint(d2));
  });
});

describe('Descriptor Adapter', () => {
  test('fromHostTransport produces correct descriptor', async () => {
    const { fromHostTransport } = await import('../relay-descriptor-adapter');
    const d = fromHostTransport(
      { relayServerId: 'srv-1' },
      { relayUrl: 'wss://r/x', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey, grant: 'g' },
    );
    expect(d.serverId).toBe('srv-1');
    expect(d.relayUrl).toBe('wss://r/x');
    expect(d.grant).toBe('g');
  });

  test('fromHostTransport without grant omits it', async () => {
    const { fromHostTransport } = await import('../relay-descriptor-adapter');
    const d = fromHostTransport(
      { relayServerId: 's' },
      { relayUrl: 'wss://r/x', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey },
    );
    expect(d.grant === undefined).toBe(true);
  });
});

describe('Entry', () => {
  test('createEntry starts idle', async () => {
    const { createEntry } = await import('../relay-entry');
    const e = createEntry(toRuntimeKey('a'), 'fp', 1000);
    expect(e.state).toBe('idle');
    expect(e.generation).toBe(0);
    expect(e.descriptorFingerprint).toBe('fp');
  });

  test('stateFromClientStatus maps correctly', async () => {
    const { stateFromClientStatus } = await import('../relay-entry');
    expect(stateFromClientStatus({ state: 'idle' })).toBe('idle');
    expect(stateFromClientStatus({ state: 'connecting' })).toBe('creating');
    expect(stateFromClientStatus({ state: 'connected' })).toBe('connected');
    expect(stateFromClientStatus({ state: 'reconnecting' })).toBe('reconnecting');
    expect(stateFromClientStatus({ state: 'error' })).toBe('error');
  });
});
