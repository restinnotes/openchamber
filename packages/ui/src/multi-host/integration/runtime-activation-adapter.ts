/**
 * RuntimeActivationAdapter — bridges the activation controller to the runtime layer.
 *
 * This adapter implements the RuntimeActivationAdapter interface required by
 * HostActivationController. It provides the concrete implementations for
 * host switching, project opening, and session selection by delegating to
 * the runtime-switch layer and session management.
 *
 * The adapter is dependency-injected to avoid direct coupling between the
 * activation controller and the runtime implementation.
 */

import type { HostDescriptor, HostId, HostSessionRef } from '../types';
import type {
  RuntimeActivationAdapter,
  RuntimeSnapshot,
} from '../activation/types';

// ---------------------------------------------------------------------------
// Adapter options (dependencies injected from the runtime layer)
// ---------------------------------------------------------------------------

export type RuntimeActivationAdapterOptions = {
  /**
   * Get the current runtime snapshot (host, project, session).
   * This should return the currently active host/project/session state.
   */
  getCurrentSnapshot: () => RuntimeSnapshot;

  /**
   * Check if a given hostId is the currently active host.
   */
  isCurrentHost: (hostId: HostId) => boolean;

  /**
   * Check if a given session ref is the currently active session.
   */
  isCurrentSession: (ref: HostSessionRef) => boolean;

  /**
   * Validate that a host is reachable and ready.
   * Should throw if validation fails.
   */
  validateHost: (host: HostDescriptor, signal: AbortSignal) => Promise<void>;

  /**
   * Switch to a different host. This should:
   * 1. Disconnect from the current host
   * 2. Connect to the new host
   * 3. Wait for the connection to be established
   */
  switchHost: (host: HostDescriptor, signal: AbortSignal) => Promise<void>;

  /**
   * Wait for the runtime to be ready after switching.
   * This should wait for the event pipeline, session list, etc. to be ready.
   */
  waitForRuntimeReady: (host: HostDescriptor, signal: AbortSignal) => Promise<void>;

  /**
   * Open a project or directory in the runtime.
   */
  openProjectOrDirectory: (ref: HostSessionRef, signal: AbortSignal) => Promise<void>;

  /**
   * Verify that a session exists on the host.
   * Returns true if the session exists, false otherwise.
   */
  verifySessionExists: (ref: HostSessionRef, signal: AbortSignal) => Promise<boolean>;

  /**
   * Select a session in the runtime (make it active).
   */
  selectSession: (ref: HostSessionRef, signal: AbortSignal) => Promise<void>;

  /**
   * Restore the runtime to a previous snapshot (for rollback).
   */
  restore: (snapshot: RuntimeSnapshot, signal: AbortSignal) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * Create a RuntimeActivationAdapter from the provided options.
 *
 * This is a thin wrapper that delegates to the injected functions,
 * providing a clean interface for the activation controller.
 */
export function createRuntimeActivationAdapter(
  options: RuntimeActivationAdapterOptions,
): RuntimeActivationAdapter {
  return {
    getCurrentSnapshot: options.getCurrentSnapshot,
    isCurrentHost: options.isCurrentHost,
    isCurrentSession: options.isCurrentSession,
    validateHost: options.validateHost,
    switchHost: options.switchHost,
    waitForRuntimeReady: options.waitForRuntimeReady,
    openProjectOrDirectory: options.openProjectOrDirectory,
    verifySessionExists: options.verifySessionExists,
    selectSession: options.selectSession,
    restore: options.restore,
  };
}
