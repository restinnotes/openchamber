/**
 * Supervisor lifecycle — mounts the MultiHostSupervisor to the app lifecycle.
 *
 * This module connects the supervisor to the remote instance registry,
 * managing host registration, deregistration, and reconnection on
 * descriptor changes.
 *
 * Non-relay transports are implemented here. Relay transport is injected
 * by the relay integration layer when available.
 */

import type { HostDescriptor, HostId } from '../types';
import {
  createMultiHostSupervisor,
  type MultiHostSupervisor,
  type MultiHostSupervisorOptions,
  type TransportFactory,
} from '../monitor';
import type { HostMonitorTransport, MonitorEventFrame } from '../monitor/types';

// ---------------------------------------------------------------------------
// Default transport factory (non-relay transports only)
// ---------------------------------------------------------------------------

/**
 * Creates a HostMonitorTransport for a given descriptor.
 * Supports 'local' and 'direct' transports. SSH and relay are
 * handled by specialized transport factories injected at integration time.
 */
function createDefaultTransport(descriptor: HostDescriptor): HostMonitorTransport {
  const { transport } = descriptor;

  switch (transport.kind) {
    case 'local':
    case 'direct': {
      const baseUrl = transport.apiUrl ?? 'http://127.0.0.1:4096';
      return createHttpTransport(baseUrl, transport.requestHeaders);
    }
    case 'ssh': {
      // SSH transport: connect via forwarded endpoint
      const sshUrl = `http://${transport.sshEndpoint}`;
      return createHttpTransport(sshUrl, transport.requestHeaders);
    }
    case 'relay':
      // Relay transport: throw until relay integration provides a factory
      throw new Error(
        `Relay transport not available. Ensure relay transport factory is injected. hostId=${descriptor.hostId}`,
      );
    default: {
      const _exhaustive: never = transport;
      throw new Error(`Unknown transport kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP transport implementation
// ---------------------------------------------------------------------------

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

      const response = await fetch(fullUrl, {
        headers,
        signal,
      });

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
                  // Empty line = end of event
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
      // HTTP transport has no persistent resources to clean up
    },
  };
}

// ---------------------------------------------------------------------------
// Supervisor lifecycle manager
// ---------------------------------------------------------------------------

export type SupervisorLifecycle = {
  /** Get the underlying supervisor instance. */
  getSupervisor(): MultiHostSupervisor;
  /** Start monitoring a host. */
  startHost(hostId: HostId, descriptor: HostDescriptor): void;
  /** Stop monitoring a host. */
  stopHost(hostId: HostId): void;
  /** Restart a host with an updated descriptor. */
  restartHost(hostId: HostId, descriptor?: HostDescriptor): void;
  /** Force an immediate refresh of a host. */
  refreshHost(hostId: HostId): void;
  /** Start monitoring all given hosts. */
  startAll(hosts: Map<HostId, HostDescriptor>): void;
  /** Stop all monitored hosts. */
  stopAll(): void;
  /** Dispose the lifecycle manager and all resources. */
  dispose(): void;
};

export type SupervisorLifecycleOptions = {
  /** Custom transport factory. If not provided, uses default HTTP transports. */
  transportFactory?: TransportFactory;
  /** Reconciliation interval in ms. Default: 120_000 (2 min). */
  reconciliationIntervalMs?: number;
};

/**
 * Create a supervisor lifecycle manager.
 *
 * This is the main entry point for integrating the multi-host supervisor
 * into the app lifecycle. It wraps the supervisor with default transports
 * and provides a clean API for host management.
 */
export function createSupervisorLifecycle(
  options: SupervisorLifecycleOptions = {},
): SupervisorLifecycle {
  const transportFactory = options.transportFactory ?? createDefaultTransport;

  const supervisorOptions: MultiHostSupervisorOptions = {
    transportFactory,
    ...(options.reconciliationIntervalMs !== undefined
      ? { reconciliationIntervalMs: options.reconciliationIntervalMs }
      : {}),
  };

  const supervisor = createMultiHostSupervisor(supervisorOptions);

  return {
    getSupervisor() {
      return supervisor;
    },

    startHost(hostId, descriptor) {
      supervisor.startHost(hostId, descriptor);
    },

    stopHost(hostId) {
      supervisor.stopHost(hostId);
    },

    restartHost(hostId, descriptor) {
      supervisor.restartHost(hostId, descriptor);
    },

    refreshHost(hostId) {
      supervisor.refreshHost(hostId);
    },

    startAll(hosts) {
      supervisor.startAll(hosts);
    },

    stopAll() {
      supervisor.stopAll();
    },

    dispose() {
      supervisor.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton instance (app-level)
// ---------------------------------------------------------------------------

let _instance: SupervisorLifecycle | null = null;

/**
 * Get or create the singleton supervisor lifecycle instance.
 * Call `disposeSupervisorLifecycle()` to tear down.
 */
export function getSupervisorLifecycle(
  options?: SupervisorLifecycleOptions,
): SupervisorLifecycle {
  if (!_instance) {
    _instance = createSupervisorLifecycle(options);
  }
  return _instance;
}

/**
 * Dispose the singleton supervisor lifecycle instance.
 */
export function disposeSupervisorLifecycle(): void {
  if (_instance) {
    _instance.dispose();
    _instance = null;
  }
}
