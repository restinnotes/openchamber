/**
 * Relay monitor transport — HostMonitorTransport backed by the shared
 * RelayTunnelRegistry.
 *
 * The registry is the single owner of RelayTunnelClient lifecycle.
 * This transport obtains a client via registry.ensure() and wraps it
 * in the HostMonitorTransport interface. The monitor does NOT close
 * the client on stop — only host deletion or app teardown does.
 */

import type { HostDescriptor } from '../types';
import type { RelayTunnelRegistry, RelayRuntimeDescriptor } from '@/lib/relay/multi-runtime/types';
import { toRuntimeKey } from '@/lib/relay/multi-runtime/types';
import type { HostMonitorTransport, MonitorEventFrame, MonitorFetchRequest, MonitorFetchResponse } from '../monitor/types';

// ---------------------------------------------------------------------------
// Relay → RelayRuntimeDescriptor conversion
// ---------------------------------------------------------------------------

/**
 * Convert a HostDescriptor with relay transport to a RelayRuntimeDescriptor
 * suitable for the registry. Requires the full relay connection material
 * (relayUrl, hostEncPubJwk) which must be provided by the caller.
 */
export type RelayDescriptorResolver = (
  descriptor: HostDescriptor,
) => RelayRuntimeDescriptor | null;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type RelayMonitorTransportOptions = {
  registry: RelayTunnelRegistry;
  resolveDescriptor: RelayDescriptorResolver;
};

/**
 * Create a relay-backed HostMonitorTransport for a given host descriptor.
 *
 * The returned transport delegates all HTTP and SSE operations to the
 * shared RelayTunnelClient obtained from the registry. Multiple callers
 * (monitor, runtime) sharing the same runtimeKey get the same client.
 */
export function createRelayMonitorTransport(
  options: RelayMonitorTransportOptions,
): (descriptor: HostDescriptor) => HostMonitorTransport {
  const { registry, resolveDescriptor } = options;

  return (descriptor: HostDescriptor): HostMonitorTransport => {
    const runtimeKey = toRuntimeKey(descriptor.hostId);

    const getClient = () => {
      const relayDescriptor = resolveDescriptor(descriptor);
      if (!relayDescriptor) {
        throw new Error(
          `Relay descriptor not resolvable for host ${descriptor.hostId}. ` +
          'Ensure relay connection material (relayUrl, hostEncPubJwk) is available.',
        );
      }
      return registry.ensure(runtimeKey, relayDescriptor);
    };

    return {
      async request(fetchReq: MonitorFetchRequest): Promise<MonitorFetchResponse> {
        const client = await getClient();
        const url = new URL(fetchReq.path, 'https://relay.placeholder');
        const response = await client.fetch(url, {
          method: fetchReq.method ?? 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...descriptor.transport.requestHeaders,
            ...fetchReq.headers,
          },
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
        const client = await getClient();
        const params = new URLSearchParams();
        if (lastEventId) params.set('lastEventId', lastEventId);
        const path = params.toString()
          ? `/api/events?${params}`
          : '/api/events';

        const response = await client.fetch(path, {
          headers: { Accept: 'text/event-stream' },
          signal,
        });

        if (!response.ok) {
          throw new Error(`Relay event stream failed: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('Relay event stream: no readable stream');
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
                        payload: currentPayload as MonitorEventFrame['payload'],
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
                        payload: currentPayload as MonitorEventFrame['payload'],
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
        // Monitor transport close does NOT close the registry client.
        // The registry owns client lifecycle. Only host deletion or
        // app teardown calls registry.close() or registry.dispose().
      },
    };
  };
}
