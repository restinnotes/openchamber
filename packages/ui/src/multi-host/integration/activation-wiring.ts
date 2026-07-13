/**
 * Activation wiring — connects the activation controller to session management.
 *
 * This module creates and configures the HostActivationController with the
 * correct dependencies, linking it to the multi-host store and providing
 * the bridge between sidebar interactions and runtime activation.
 */

import type { HostDescriptor, HostId, HostSessionRef } from '../types';
import { useMultiHostStore } from '../multi-host-store';
import {
  createHostActivationController,
  type HostActivationController,
  type HostActivationControllerOptions,
  type RuntimeActivationAdapter,
  type ActivationState,
  type ActivationResult,
  createSafeActivationLogger,
} from '../activation';
import { selectHost } from '../selectors';

// ---------------------------------------------------------------------------
// Activation wiring options
// ---------------------------------------------------------------------------

export type ActivationWiringOptions = {
  /** The runtime activation adapter (dependency-injected bridge). */
  adapter: RuntimeActivationAdapter;
  /** Optional timeout for activation operations. Default: 30_000 ms. */
  timeoutMs?: number;
  /** Optional timeout for rollback operations. Default: 10_000 ms. */
  rollbackTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Activation wiring result
// ---------------------------------------------------------------------------

export type ActivationWiring = {
  /** Get the underlying activation controller. */
  getController(): HostActivationController;
  /** Activate a session (called from sidebar). */
  activateSession(ref: HostSessionRef): Promise<ActivationResult>;
  /** Cancel the current activation. */
  cancelCurrent(reason?: string): void;
  /** Get the current activation state. */
  getState(): ActivationState;
  /** Subscribe to activation state changes. */
  subscribe(listener: (state: ActivationState) => void): () => void;
  /** Dispose the activation controller. */
  dispose(): void;
};

/**
 * Create activation wiring that connects the activation controller to
 * session management.
 *
 * This is the main entry point for integrating the activation controller
 * into the app. It wires the controller to the multi-host store and
 * provides a clean API for sidebar interactions.
 */
export function createActivationWiring(
  options: ActivationWiringOptions,
): ActivationWiring {
  const { adapter, timeoutMs = 30_000, rollbackTimeoutMs = 10_000 } = options;

  // Create the activation controller with store integration
  const controllerOptions: HostActivationControllerOptions = {
    adapter,
    getHost: (hostId: HostId): HostDescriptor | undefined => {
      return selectHost(hostId)?.descriptor;
    },
    clearUnread: (ref: HostSessionRef): void => {
      useMultiHostStore.getState().clearSessionUnread(ref.hostId, ref.sessionId);
    },
    timeoutMs,
    rollbackTimeoutMs,
    logger: createSafeActivationLogger(),
  };

  const controller = createHostActivationController(controllerOptions);

  return {
    getController() {
      return controller;
    },

    activateSession(ref) {
      return controller.activateSession(ref);
    },

    cancelCurrent(reason) {
      controller.cancelCurrent(reason);
    },

    getState() {
      return controller.getState();
    },

    subscribe(listener) {
      return controller.subscribe(listener);
    },

    dispose() {
      controller.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton instance (app-level)
// ---------------------------------------------------------------------------

let _instance: ActivationWiring | null = null;

/**
 * Get or create the singleton activation wiring instance.
 * Call `disposeActivationWiring()` to tear down.
 */
export function getActivationWiring(
  options?: ActivationWiringOptions,
): ActivationWiring {
  if (!_instance) {
    if (!options) {
      throw new Error(
        'ActivationWiring not initialized. Call getActivationWiring(options) first.',
      );
    }
    _instance = createActivationWiring(options);
  }
  return _instance;
}

/**
 * Dispose the singleton activation wiring instance.
 */
export function disposeActivationWiring(): void {
  if (_instance) {
    _instance.dispose();
    _instance = null;
  }
}
