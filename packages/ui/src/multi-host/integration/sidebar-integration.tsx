/**
 * Sidebar integration — connects the MultiHostSessionTree to the activation
 * controller and multi-host store.
 *
 * This module provides the bridge between sidebar UI interactions and the
 * activation system, handling session activation, status display, and
 * unread management.
 */

import React from 'react';
import type { HostId, HostSessionRef } from '../types';
import { useHosts, useTotalUnreadCount, useHostsWithActivity } from '../selectors';
import { MultiHostSessionTree, type MultiHostSessionTreeProps } from '../../components/session/multi-host/MultiHostSessionTree';
import type { SessionExtraStatus } from '../../components/session/multi-host/multi-host-sidebar-types';

// ---------------------------------------------------------------------------
// Sidebar integration options
// ---------------------------------------------------------------------------

export type SidebarIntegrationOptions = {
  /**
   * Callback invoked when the user clicks a session in the sidebar.
   * This should trigger the activation flow.
   */
  onActivateSession: (ref: HostSessionRef) => void | Promise<void>;

  /**
   * Optional: Get extra status overlays for a session.
   * This allows the integration layer to inject pending permission/question
   * state from the sync layer without the sidebar knowing about it.
   */
  getSessionExtras?: (hostId: HostId, sessionId: string) => SessionExtraStatus;
};

// ---------------------------------------------------------------------------
// Sidebar integration hook
// ---------------------------------------------------------------------------

/**
 * Hook that provides the data and callbacks needed to render the
 * MultiHostSessionTree with full activation support.
 *
 * Usage:
 * ```tsx
 * const { treeProps, totalUnread, activeHostIds } = useSidebarIntegration({
 *   onActivateSession: handleActivateSession,
 *   getSessionExtras: getExtraStatus,
 * });
 * ```
 */
// eslint-disable-next-line react-refresh/only-export-components -- Hooks and components are tightly coupled in this integration module
export function useSidebarIntegration(options: SidebarIntegrationOptions) {
  const { onActivateSession, getSessionExtras } = options;

  const hosts = useHosts();
  const totalUnread = useTotalUnreadCount();
  const activeHostIds = useHostsWithActivity();

  // Current active host/session from the runtime (injected via context or store)
  const [activeHostId, setActiveHostId] = React.useState<HostId | undefined>();
  const [activeSessionId, setActiveSessionId] = React.useState<string | undefined>();
  const [activationPendingRef, setActivationPendingRef] = React.useState<HostSessionRef | null>(null);

  // Derive session extras for all hosts
  const sessionExtras = React.useMemo(() => {
    if (!getSessionExtras) return undefined;

    const extras: Record<HostId, Record<string, SessionExtraStatus>> = {};
    for (const [hostId, hostState] of Object.entries(hosts)) {
      const hostExtras: Record<string, SessionExtraStatus> = {};
      for (const sessionId of Object.keys(hostState.sessions)) {
        hostExtras[sessionId] = getSessionExtras(hostId as HostId, sessionId);
      }
      extras[hostId as HostId] = hostExtras;
    }
    return extras;
  }, [hosts, getSessionExtras]);

  const handleActivateSession = React.useCallback(
    (ref: HostSessionRef) => {
      setActivationPendingRef(ref);
      onActivateSession(ref);
    },
    [onActivateSession],
  );

  const treeProps: MultiHostSessionTreeProps = React.useMemo(
    () => ({
      activeHostId,
      activeSessionId,
      activationPendingRef,
      sessionExtras,
      onActivateSession: handleActivateSession,
    }),
    [activeHostId, activeSessionId, activationPendingRef, sessionExtras, handleActivateSession],
  );

  return {
    /** Props to spread onto MultiHostSessionTree */
    treeProps,
    /** Total unread count across all hosts */
    totalUnread,
    /** List of hostIds with active (non-idle) sessions */
    activeHostIds,
    /** Set the currently active host (call when runtime switches host) */
    setActiveHostId,
    /** Set the currently active session (call when session is selected) */
    setActiveSessionId,
    /** Clear activation pending state (call after activation completes) */
    clearActivationPending: () => setActivationPendingRef(null),
  };
}

// ---------------------------------------------------------------------------
// Sidebar integration component
// ---------------------------------------------------------------------------

export type SidebarIntegrationProps = SidebarIntegrationOptions & {
  /** Optional className for the container */
  className?: string;
};

/**
 * Integrated sidebar component that wraps MultiHostSessionTree with
 * activation support and session extras.
 *
 * This is a convenience component that combines the hook and the tree
 * component for simple use cases.
 */
export function SidebarIntegration({
  onActivateSession,
  getSessionExtras,
  className,
}: SidebarIntegrationProps) {
  const { treeProps } = useSidebarIntegration({
    onActivateSession,
    getSessionExtras,
  });

  return <MultiHostSessionTree {...treeProps} className={className} />;
}
