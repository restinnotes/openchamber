/**
 * Composite transport factory — routes host descriptors to the appropriate
 * transport implementation based on transport.kind.
 *
 * - local/direct/ssh: HTTP transport (existing)
 * - relay: Relay monitor transport backed by shared registry
 */

import type { HostDescriptor } from '../types';
import type { RelayTunnelRegistry } from '@/lib/relay/multi-runtime/types';
import type { HostMonitorTransport } from '../monitor/types';
import type { RelayDescriptorResolver } from './relay-monitor-transport';
import { createRelayMonitorTransport } from './relay-monitor-transport';

// Re-export the HTTP transport from supervisor-lifecycle for non-relay hosts
// We duplicate the minimal HTTP transport logic here to avoid a circular import
// dependency on supervisor-lifecycle.ts.

function createHttpTransport(
  baseUrl: string,
  requestHeaders?: Record<string, string>,
): HostMonitorTransport {
  const base = baseUrl.replace(/\/$/, '');

  return {
    async request(fetchReq) {
      const url = `${base}${fetchReq.path}`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...requestHeaders,
        ...fetchReq.headers,
      };

      const response = await fetch(url, {
        method: fetchReq.method ?? 'GET',
        headers,
        body: fetchReq.body ? JSON.stringify(fetchReq.body) : undefined,
        signal: fetchReq.signal,
      });

      const data = await response.json().catch(() => null);

      return {
        status: response.status,
        data,
        headers: response.headers,
      };
    },

    async openEventStream({ signal, lastEventId }) {
      const url = `${base}/api/events`;
      const params = new URLSearchParams();
      if (lastEventId) params.set('lastEventId', lastEventId);
      const fullUrl = params.toString() ? `${url}?${params}` : url;

      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        ...requestHeaders,
      };

      const response = await fetch(fullUrl, { headers, signal });

      if (!response.ok) {
        throw new Error(`Event stream failed: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Event stream: no readable stream');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              let currentDirectory = '';
              let currentPayload: Record<string, unknown> | null = null;

              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  const eventType = line.slice(7).trim();
                  if (eventType === 'message' && currentPayload) {
                    yield {
                      directory: currentDirectory,
                      payload: currentPayload as import('../monitor/types').MonitorEventFrame['payload'],
                    };
                    currentPayload = null;
                  }
                } else if (line.startsWith('data: ')) {
                  try {
                    currentPayload = JSON.parse(line.slice(6));
                  } catch {
                    // Skip malformed data
                  }
                } else if (line.startsWith('directory: ')) {
                  currentDirectory = line.slice(11).trim();
                } else if (line === '') {
                  if (currentPayload) {
                    yield {
                      directory: currentDirectory,
                      payload: currentPayload as import('../monitor/types').MonitorEventFrame['payload'],
                    };
                    currentPayload = null;
                    currentDirectory = '';
                  }
                }
              }
            }
          } finally {
            reader.releaseLock();
          }
        },
      };
    },

    close() {
      // HTTP transport has no persistent resources
    },
  };
}

// ---------------------------------------------------------------------------
// Composite factory
// ---------------------------------------------------------------------------

export type CompositeTransportFactoryOptions = {
  registry: RelayTunnelRegistry;
  resolveDescriptor: RelayDescriptorResolver;
};

/**
 * Create a transport factory that handles all transport kinds.
 * For relay hosts, uses the shared RelayTunnelRegistry.
 * For non-relay hosts, uses HTTP transport.
 */
export function createCompositeTransportFactory(
  options: CompositeTransportFactoryOptions,
): (descriptor: HostDescriptor) => HostMonitorTransport {
  const relayTransportFactory = createRelayMonitorTransport(options);

  return (descriptor: HostDescriptor): HostMonitorTransport => {
    if (descriptor.transport.kind === 'relay') {
      return relayTransportFactory(descriptor);
    }

    // Non-relay: HTTP transport
    switch (descriptor.transport.kind) {
      case 'local':
      case 'direct': {
        const baseUrl = descriptor.transport.apiUrl ?? 'http://127.0.0.1:4096';
        return createHttpTransport(baseUrl, descriptor.transport.requestHeaders);
      }
      case 'ssh': {
        const sshUrl = `http://${descriptor.transport.sshEndpoint}`;
        return createHttpTransport(sshUrl, descriptor.transport.requestHeaders);
      }
      default: {
        const _exhaustive: never = descriptor.transport;
        throw new Error(`Unknown transport kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  };
}
