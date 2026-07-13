/**
 * Integration tests for the multi-host integration layer.
 *
 * Tests the wiring between supervisor, activation controller, and sidebar
 * without relying on relay transport (which is BLOCKED).
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { useMultiHostStore } from '../../multi-host-store';
import { createSupervisorLifecycle } from '../supervisor-lifecycle';
import { createActivationWiring } from '../activation-wiring';
import type { HostDescriptor, HostId } from '../../types';
import type { RuntimeActivationAdapter, RuntimeSnapshot } from '../../activation/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTestHost(id: string): HostDescriptor {
  return {
    hostId: id as HostId,
    label: `Test Host ${id}`,
    transport: {
      kind: 'local',
      apiUrl: `http://127.0.0.1:409${id}`,
    },
  };
}

function createMockAdapter(): RuntimeActivationAdapter {
  let currentSnapshot: RuntimeSnapshot = {
    hostId: undefined,
    runtimeKey: 'local',
    projectId: undefined,
    directory: undefined,
    sessionId: undefined,
  };

  return {
    getCurrentSnapshot: () => currentSnapshot,
    isCurrentHost: (hostId) => currentSnapshot.hostId === hostId,
    isCurrentSession: (ref) =>
      currentSnapshot.hostId === ref.hostId && currentSnapshot.sessionId === ref.sessionId,
    validateHost: async () => {},
    switchHost: async (host) => {
      currentSnapshot = { ...currentSnapshot, hostId: host.hostId };
    },
    waitForRuntimeReady: async () => {},
    openProjectOrDirectory: async (ref) => {
      currentSnapshot = {
        ...currentSnapshot,
        projectId: ref.projectId,
        directory: ref.directory,
      };
    },
    verifySessionExists: async () => true,
    selectSession: async (ref) => {
      currentSnapshot = { ...currentSnapshot, sessionId: ref.sessionId };
    },
    restore: async (snapshot) => {
      currentSnapshot = snapshot;
    },
  };
}

// ---------------------------------------------------------------------------
// Supervisor lifecycle tests
// ---------------------------------------------------------------------------

describe('Supervisor lifecycle', () => {
  beforeEach(() => {
    useMultiHostStore.setState({ hosts: {} });
  });

  test('creates and disposes cleanly', () => {
    const lifecycle = createSupervisorLifecycle();
    expect(lifecycle.getSupervisor()).toBeDefined();
    lifecycle.dispose();
  });

  test('starts a host and registers in store', () => {
    const host = makeTestHost('1');

    // Mock transport factory to avoid real HTTP calls
    const mockTransportFactory = mock(() => ({
      request: async () => ({ status: 200, data: {} }),
      openEventStream: async () => ({
        async *[Symbol.asyncIterator]() {},
      }),
      close: () => {},
    }));

    const lifecycleWithMock = createSupervisorLifecycle({
      transportFactory: mockTransportFactory,
    });

    lifecycleWithMock.startHost(host.hostId, host);

    // Verify host is registered in store
    const state = useMultiHostStore.getState();
    expect(state.hosts[host.hostId]).toBeDefined();
    expect(state.hosts[host.hostId].descriptor.label).toBe('Test Host 1');

    lifecycleWithMock.dispose();
  });

  test('stops a host and cleans up', () => {
    const mockTransportFactory = mock(() => ({
      request: async () => ({ status: 200, data: {} }),
      openEventStream: async () => ({
        async *[Symbol.asyncIterator]() {},
      }),
      close: () => {},
    }));

    const lifecycle = createSupervisorLifecycle({
      transportFactory: mockTransportFactory,
    });

    const host = makeTestHost('1');
    lifecycle.startHost(host.hostId, host);
    lifecycle.stopHost(host.hostId);

    // Host is still tracked by supervisor (can be restarted)
    // but the monitor is stopped
    expect(lifecycle.getSupervisor().hasHost(host.hostId)).toBe(true);

    lifecycle.dispose();
  });
});

// ---------------------------------------------------------------------------
// Activation wiring tests
// ---------------------------------------------------------------------------

describe('Activation wiring', () => {
  beforeEach(() => {
    useMultiHostStore.setState({ hosts: {} });
  });

  test('creates and disposes cleanly', () => {
    const adapter = createMockAdapter();
    const wiring = createActivationWiring({ adapter });

    expect(wiring.getController()).toBeDefined();
    wiring.dispose();
  });

  test('returns initial idle state', () => {
    const adapter = createMockAdapter();
    const wiring = createActivationWiring({ adapter });

    const state = wiring.getState();
    expect(state.stage).toBe('idle');
    expect(state.requestId).toBeNull();
    expect(state.targetRef).toBeNull();

    wiring.dispose();
  });

  test('subscribes to state changes', () => {
    const adapter = createMockAdapter();
    const wiring = createActivationWiring({ adapter });

    const states: string[] = [];
    const unsubscribe = wiring.subscribe((state) => {
      states.push(state.stage);
    });

    // No state changes should have occurred yet
    expect(states).toHaveLength(0);

    unsubscribe();
    wiring.dispose();
  });
});

// ---------------------------------------------------------------------------
// Integration: Supervisor + Activation wiring
// ---------------------------------------------------------------------------

describe('Supervisor + Activation integration', () => {
  beforeEach(() => {
    useMultiHostStore.setState({ hosts: {} });
  });

  test('supervisor registers host, activation can read descriptor', () => {
    const mockTransportFactory = mock(() => ({
      request: async () => ({ status: 200, data: {} }),
      openEventStream: async () => ({
        async *[Symbol.asyncIterator]() {},
      }),
      close: () => {},
    }));

    const supervisorLifecycle = createSupervisorLifecycle({
      transportFactory: mockTransportFactory,
    });

    const adapter = createMockAdapter();
    const activationWiring = createActivationWiring({ adapter });

    const host = makeTestHost('1');
    supervisorLifecycle.startHost(host.hostId, host);

    // Verify host is in store
    const state = useMultiHostStore.getState();
    expect(state.hosts[host.hostId]).toBeDefined();

    // Activation controller should be able to read the host
    const activationState = activationWiring.getState();
    expect(activationState.stage).toBe('idle');

    supervisorLifecycle.dispose();
    activationWiring.dispose();
  });
});

// ---------------------------------------------------------------------------
// Store integration tests
// ---------------------------------------------------------------------------

describe('Multi-host store integration', () => {
  beforeEach(() => {
    useMultiHostStore.setState({ hosts: {} });
  });

  test('registerHost creates host state', () => {
    const host = makeTestHost('1');
    useMultiHostStore.getState().registerHost(host);

    const state = useMultiHostStore.getState();
    expect(state.hosts[host.hostId]).toBeDefined();
    expect(state.hosts[host.hostId].descriptor.label).toBe('Test Host 1');
    expect(state.hosts[host.hostId].connection.state).toBe('disconnected');
    expect(state.hosts[host.hostId].sessions).toEqual({});
    expect(state.hosts[host.hostId].statuses).toEqual({});
    expect(state.hosts[host.hostId].unreadBySession).toEqual({});
  });

  test('setConnectionState updates connection', () => {
    const host = makeTestHost('1');
    useMultiHostStore.getState().registerHost(host);
    useMultiHostStore.getState().setConnectionState(host.hostId, 'connected');

    const state = useMultiHostStore.getState();
    expect(state.hosts[host.hostId].connection.state).toBe('connected');
    expect(state.hosts[host.hostId].connection.connectedAt).toBeDefined();
  });

  test('replaceSessions updates sessions', () => {
    const host = makeTestHost('1');
    useMultiHostStore.getState().registerHost(host);

    const sessions = [
      { id: 'session-1', title: 'Session 1', directory: '/test' },
      { id: 'session-2', title: 'Session 2', directory: '/test' },
    ];

    useMultiHostStore.getState().replaceSessions(host.hostId, sessions);

    const state = useMultiHostStore.getState();
    expect(Object.keys(state.hosts[host.hostId].sessions)).toHaveLength(2);
    expect(state.hosts[host.hostId].sessions['session-1'].title).toBe('Session 1');
    expect(state.hosts[host.hostId].sessions['session-2'].title).toBe('Session 2');
  });

  test('replaceHostSnapshot preserves unread counts', () => {
    const host = makeTestHost('1');
    useMultiHostStore.getState().registerHost(host);

    // Set initial unread
    useMultiHostStore.getState().markSessionUnread(host.hostId, 'session-1', 5);

    // Replace with snapshot that doesn't include unread
    const snapshot = {
      descriptor: host,
      connection: { state: 'connected' as const },
      projects: [],
      sessions: {
        'session-1': { id: 'session-1', title: 'Session 1' },
        'session-2': { id: 'session-2', title: 'Session 2' },
      },
      statuses: {},
      unreadBySession: {},
    };

    useMultiHostStore.getState().replaceHostSnapshot(host.hostId, snapshot);

    const state = useMultiHostStore.getState();
    // Unread should be preserved for session-1
    expect(state.hosts[host.hostId].unreadBySession['session-1']).toBe(5);
    // session-2 should have no unread
    expect(state.hosts[host.hostId].unreadBySession['session-2']).toEqual(undefined);
  });

  test('removeHost cleans up all state', () => {
    const host = makeTestHost('1');
    useMultiHostStore.getState().registerHost(host);
    useMultiHostStore.getState().markSessionUnread(host.hostId, 'session-1', 5);
    useMultiHostStore.getState().setConnectionState(host.hostId, 'connected');

    useMultiHostStore.getState().removeHost(host.hostId);

    const state = useMultiHostStore.getState();
    expect(state.hosts[host.hostId]).toEqual(undefined);
  });
});
