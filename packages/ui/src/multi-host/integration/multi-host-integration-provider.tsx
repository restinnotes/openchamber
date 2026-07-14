/**
 * MultiHostIntegrationProvider — Application-level provider that wires together
 * the multi-host subsystems (supervisor, activation, relay registry) with the
 * real runtime and session management.
 *
 * This provider should be mounted once at the app root level, above SessionSidebar
 * and any components that need multi-host functionality.
 */

import React from 'react';
import type { HostDescriptor, HostId, HostSessionRef } from '../types';
import {
  getSupervisorLifecycle,
  disposeSupervisorLifecycle,
} from './supervisor-lifecycle';
import {
  getActivationWiring,
  disposeActivationWiring,
} from './activation-wiring';
import { createRuntimeActivationAdapter } from './runtime-activation-adapter';
import type { RuntimeSnapshot } from '../activation/types';
import { getRuntimeKey, switchRuntimeEndpoint, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { MultiHostIntegrationContext, type MultiHostIntegrationContextValue } from './multi-host-integration-context';

// ---------------------------------------------------------------------------
// Provider props
// ---------------------------------------------------------------------------

export type MultiHostIntegrationProviderProps = {
  children: React.ReactNode;
  /** Optional: custom transport factory for supervisor. */
  transportFactory?: import('../monitor').TransportFactory;
  /** Optional: custom adapter factory for activation. */
  adapterFactory?: typeof createRuntimeActivationAdapter;
};

// ---------------------------------------------------------------------------
// Real RuntimeActivationAdapter implementation
// ---------------------------------------------------------------------------

function createRealRuntimeActivationAdapter() {
  return createRuntimeActivationAdapter({
    getCurrentSnapshot: (): RuntimeSnapshot => {
      const runtimeKey = getRuntimeKey();
      const currentDirectory = useDirectoryStore.getState().currentDirectory;
      const currentSessionId = useSessionUIStore.getState().currentSessionId;
      const activeProjectId = useProjectsStore.getState().activeProjectId;

      return {
        hostId: extractHostIdFromRuntimeKey(runtimeKey),
        runtimeKey,
        projectId: activeProjectId ?? undefined,
        directory: currentDirectory || undefined,
        sessionId: currentSessionId || undefined,
      };
    },

    isCurrentHost: (hostId: HostId): boolean => {
      const runtimeKey = getRuntimeKey();
      const currentHostId = extractHostIdFromRuntimeKey(runtimeKey);
      return currentHostId === hostId;
    },

    isCurrentSession: (ref: HostSessionRef): boolean => {
      const runtimeKey = getRuntimeKey();
      const currentHostId = extractHostIdFromRuntimeKey(runtimeKey);
      const currentSessionId = useSessionUIStore.getState().currentSessionId;
      return currentHostId === ref.hostId && currentSessionId === ref.sessionId;
    },

    validateHost: async (host: HostDescriptor, signal: AbortSignal): Promise<void> => {
      // Validate that the host is reachable
      // For local/direct hosts, try a health check
      if (host.transport.kind === 'local' || host.transport.kind === 'direct') {
        const baseUrl = host.transport.apiUrl ?? 'http://127.0.0.1:4096';
        const response = await fetch(`${baseUrl}/health`, {
          method: 'GET',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...host.transport.requestHeaders,
          },
        });
        if (!response.ok) {
          throw new Error(`Host validation failed: ${response.status}`);
        }
      }
      // For SSH/relay hosts, validation is handled by the transport layer
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signal is required by interface but not used in this implementation
    switchHost: async (host: HostDescriptor, _signal: AbortSignal): Promise<void> => {
      // Switch to the target host by updating the runtime endpoint
      if (host.transport.kind === 'local' || host.transport.kind === 'direct') {
        const apiUrl = host.transport.apiUrl ?? 'http://127.0.0.1:4096';
        switchRuntimeEndpoint({
          apiBaseUrl: apiUrl,
          clientToken: undefined,
          runtimeKey: `host:${host.hostId}`,
          requestHeaders: host.transport.requestHeaders,
          relay: null,
        });
      }
      // SSH and relay hosts are handled by their respective transport layers
    },

    waitForRuntimeReady: async (host: HostDescriptor, signal: AbortSignal): Promise<void> => {
      // Wait for the runtime to be ready after switching
      // Poll the health endpoint until it responds
      const baseUrl = host.transport.kind === 'local' || host.transport.kind === 'direct'
        ? (host.transport.apiUrl ?? 'http://127.0.0.1:4096')
        : undefined;

      if (!baseUrl) {
        // For SSH/relay, trust the transport layer
        return;
      }

      const maxAttempts = 30;
      const intervalMs = 1000;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal.aborted) {
          throw new Error('Runtime ready wait aborted');
        }

        try {
          const response = await fetch(`${baseUrl}/health`, {
            method: 'GET',
            signal,
            headers: { 'Content-Type': 'application/json' },
          });
          if (response.ok) {
            return;
          }
        } catch {
          // Not ready yet, continue polling
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }

      throw new Error('Runtime ready timeout');
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signal is required by interface but not used in this implementation
    openProjectOrDirectory: async (ref: HostSessionRef, _signal: AbortSignal): Promise<void> => {
      // Open the project/directory in the runtime
      const { setDirectory } = useDirectoryStore.getState();
      await setDirectory(ref.directory, { showOverlay: false });
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signal is required by interface but not used in this implementation
    verifySessionExists: async (ref: HostSessionRef, _signal: AbortSignal): Promise<boolean> => {
      // Verify that the session exists on the target host
      // This is a simplified check - in production, this would query the server
      try {
        const response = await opencodeClient.getSession(ref.sessionId);
        return response !== null;
      } catch {
        return false;
      }
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signal is required by interface but not used in this implementation
    selectSession: async (ref: HostSessionRef, _signal: AbortSignal): Promise<void> => {
      // Select the session in the UI
      const { setCurrentSession } = useSessionUIStore.getState();
      await setCurrentSession(ref.sessionId, ref.directory);
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signal is required by interface but not used in this implementation
    restore: async (snapshot: RuntimeSnapshot, _signal: AbortSignal): Promise<void> => {
      // Restore the runtime to a previous snapshot (for rollback)
      if (snapshot.directory) {
        const { setDirectory } = useDirectoryStore.getState();
        await setDirectory(snapshot.directory, { showOverlay: false });
      }
      if (snapshot.sessionId) {
        const { setCurrentSession } = useSessionUIStore.getState();
        await setCurrentSession(snapshot.sessionId, snapshot.directory);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: extract HostId from runtime key
// ---------------------------------------------------------------------------

function extractHostIdFromRuntimeKey(runtimeKey: string): HostId | undefined {
  // Runtime keys are formatted as "host:<hostId>" for remote hosts
  // or "local" for the local instance
  if (runtimeKey.startsWith('host:')) {
    return runtimeKey.slice(5) as HostId;
  }
  // For local instance, return undefined (no hostId)
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export function MultiHostIntegrationProvider({
  children,
  transportFactory,
  adapterFactory = createRuntimeActivationAdapter,
}: MultiHostIntegrationProviderProps) {
  const [isMultiHostEnabled, setIsMultiHostEnabled] = React.useState(false);

  // Initialize supervisor lifecycle (singleton)
  const supervisor = React.useMemo(() => {
    return getSupervisorLifecycle({ transportFactory });
  }, [transportFactory]);

  // Initialize activation wiring with real adapter
  const activation = React.useMemo(() => {
    const adapter = adapterFactory
      ? adapterFactory(createRealRuntimeActivationAdapter())
      : createRealRuntimeActivationAdapter();
    return getActivationWiring({ adapter });
  }, [adapterFactory]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      disposeActivationWiring();
      disposeSupervisorLifecycle();
    };
  }, []);

  // Subscribe to remote instance changes and sync with supervisor
  React.useEffect(() => {
    // For now, enable multi-host only when there are remote instances
    // In production, this would subscribe to the desktop hosts store
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      // When the runtime endpoint changes, check if we have multiple hosts
      // This is a simplified check - in production, this would query the hosts store
      setIsMultiHostEnabled(true);
    });

    return unsubscribe;
  }, []);

  const contextValue: MultiHostIntegrationContextValue = React.useMemo(() => ({
    supervisor,
    activation,
    isMultiHostEnabled,
  }), [supervisor, activation, isMultiHostEnabled]);

  return (
    <MultiHostIntegrationContext.Provider value={contextValue}>
      {children}
    </MultiHostIntegrationContext.Provider>
  );
}
