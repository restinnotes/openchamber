import { describe, test, expect } from 'bun:test';
import { desktopHostsToDescriptors } from '../desktop-hosts-bridge';
import type { DesktopHost } from '@/lib/desktopHosts';
import type { HostId } from '../../types';

const hid = (s: string): HostId => s as HostId;

describe('desktopHostsToDescriptors', () => {
  test('converts direct host with apiUrl', () => {
    const hosts: DesktopHost[] = [
      {
        id: 'my-mac',
        label: 'My Mac',
        url: 'http://192.168.1.100:4096',
        apiUrl: 'http://192.168.1.100:4096',
      },
    ];

    const result = desktopHostsToDescriptors(hosts);
    expect(result.size).toBe(1);

    const descriptor = result.get(hid('host_my-mac'));
    expect(descriptor).toBeDefined();
    expect(descriptor!.hostId).toBe('host_my-mac');
    expect(descriptor!.label).toBe('My Mac');
    expect(descriptor!.transport.kind).toBe('direct');
    if (descriptor!.transport.kind === 'direct') {
      expect(descriptor!.transport.apiUrl).toBe('http://192.168.1.100:4096');
    }
  });

  test('converts relay host', () => {
    const hosts: DesktopHost[] = [
      {
        id: 'remote-server',
        label: 'Remote Server',
        url: 'relay://abc123',
        relay: {
          relayUrl: 'wss://relay.example.com',
          serverId: 'abc123',
          hostEncPubJwk: { kty: 'RSA', n: 'test', e: 'AQAB' },
        },
      },
    ];

    const result = desktopHostsToDescriptors(hosts);
    expect(result.size).toBe(1);

    const descriptor = result.get(hid('host_remote-server'));
    expect(descriptor).toBeDefined();
    expect(descriptor!.transport.kind).toBe('relay');
    if (descriptor!.transport.kind === 'relay') {
      expect(descriptor!.transport.relayServerId).toBe('abc123');
    }
  });

  test('converts local host without apiUrl', () => {
    const hosts: DesktopHost[] = [
      {
        id: 'local',
        label: 'Local',
        url: 'http://127.0.0.1:4096',
      },
    ];

    const result = desktopHostsToDescriptors(hosts);
    expect(result.size).toBe(1);

    const descriptor = result.get(hid('host_local'));
    expect(descriptor).toBeDefined();
    expect(descriptor!.transport.kind).toBe('local');
  });

  test('converts host with requestHeaders', () => {
    const hosts: DesktopHost[] = [
      {
        id: 'secured',
        label: 'Secured Host',
        url: 'http://10.0.0.1:4096',
        apiUrl: 'http://10.0.0.1:4096',
        requestHeaders: { 'X-Custom': 'value' },
      },
    ];

    const result = desktopHostsToDescriptors(hosts);
    const descriptor = result.get(hid('host_secured'));
    expect(descriptor).toBeDefined();
    if (descriptor!.transport.kind === 'direct') {
      expect(descriptor!.transport.requestHeaders).toEqual({ 'X-Custom': 'value' });
    }
  });

  test('handles multiple hosts', () => {
    const hosts: DesktopHost[] = [
      { id: 'a', label: 'Host A', url: 'http://a.example.com:4096', apiUrl: 'http://a.example.com:4096' },
      { id: 'b', label: 'Host B', url: 'http://b.example.com:4096', apiUrl: 'http://b.example.com:4096' },
      { id: 'c', label: 'Host C', url: 'relay://c', relay: { relayUrl: 'wss://relay', serverId: 'c', hostEncPubJwk: { kty: 'RSA', n: 'x', e: 'AQAB' } } },
    ];

    const result = desktopHostsToDescriptors(hosts);
    expect(result.size).toBe(3);
    expect(result.has(hid('host_a'))).toBe(true);
    expect(result.has(hid('host_b'))).toBe(true);
    expect(result.has(hid('host_c'))).toBe(true);
  });

  test('returns empty map for empty input', () => {
    const result = desktopHostsToDescriptors([]);
    expect(result.size).toBe(0);
  });

  test('hostIdFromExistingId produces stable IDs', () => {
    const hosts: DesktopHost[] = [
      { id: 'stable-id', label: 'Test', url: 'http://localhost:4096' },
    ];

    const result1 = desktopHostsToDescriptors(hosts);
    const result2 = desktopHostsToDescriptors(hosts);

    expect(result1.get(hid('host_stable-id'))?.hostId).toBe(result2.get(hid('host_stable-id'))?.hostId);
  });
});
