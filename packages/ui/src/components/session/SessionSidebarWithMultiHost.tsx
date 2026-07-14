/**
 * SessionSidebarWithMultiHost — Wrapper that adds multi-host view switching
 * to the existing SessionSidebar.
 *
 * This component provides:
 * - View switcher for "Current Instance" vs "All Instances"
 * - Integration with the multi-host activation controller
 * - Proper lifecycle management
 */

import React from 'react';
import { cn } from '@/lib/utils';
import { useMultiHostIntegration } from '@/multi-host/integration';
import { MultiHostSessionTree } from './multi-host/MultiHostSessionTree';
import { useHosts, useTotalUnreadCount, useHostsWithActivity } from '@/multi-host/selectors';
import type { HostId, HostSessionRef } from '@/multi-host';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionSidebarViewMode = 'current' | 'all';

export type SessionSidebarWithMultiHostProps = {
  /** The underlying SessionSidebar component to render in 'current' mode. */
  children: React.ReactNode;
  /** Current active host ID. */
  activeHostId?: HostId;
  /** Current active session ID. */
  activeSessionId?: string;
  /** Callback when a session is activated in the multi-host tree. */
  onActivateSession?: (ref: HostSessionRef) => void;
  /** Optional className for the container. */
  className?: string;
};

// ---------------------------------------------------------------------------
// Hook: useMultiHostSidebarState
// ---------------------------------------------------------------------------

function useMultiHostSidebarState() {
  const hosts = useHosts();
  const totalUnread = useTotalUnreadCount();
  const activeHostIds = useHostsWithActivity();
  const hasMultipleHosts = Object.keys(hosts).length > 1;

  return {
    hosts,
    totalUnread,
    activeHostIds,
    hasMultipleHosts,
  };
}

// ---------------------------------------------------------------------------
// Component: ViewSwitcher
// ---------------------------------------------------------------------------

type ViewSwitcherProps = {
  mode: SessionSidebarViewMode;
  onModeChange: (mode: SessionSidebarViewMode) => void;
  hasMultipleHosts: boolean;
  totalUnread: number;
  className?: string;
};

function ViewSwitcher({
  mode,
  onModeChange,
  hasMultipleHosts,
  totalUnread,
  className,
}: ViewSwitcherProps) {
  if (!hasMultipleHosts) {
    return null;
  }

  return (
    <div className={cn('flex items-center gap-1 px-2 py-1', className)}>
      <button
        type="button"
        onClick={() => onModeChange('current')}
        className={cn(
          'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
          mode === 'current'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        Current Instance
      </button>
      <button
        type="button"
        onClick={() => onModeChange('all')}
        className={cn(
          'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
          mode === 'all'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        All Instances
        {totalUnread > 0 && (
          <span className="ml-1 inline-flex items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-bold text-destructive-foreground">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component: SessionSidebarWithMultiHost
// ---------------------------------------------------------------------------

export function SessionSidebarWithMultiHost({
  children,
  activeHostId,
  activeSessionId,
  onActivateSession,
  className,
}: SessionSidebarWithMultiHostProps) {
  const [viewMode, setViewMode] = React.useState<SessionSidebarViewMode>('current');
  const { hasMultipleHosts, totalUnread } = useMultiHostSidebarState();
  const integration = useMultiHostIntegration();

  // Default activation handler that uses the integration's activation wiring
  const handleActivateSession = React.useCallback(
    (ref: HostSessionRef) => {
      if (onActivateSession) {
        onActivateSession(ref);
      } else {
        // Use the integration's activation wiring
        integration.activation.activateSession(ref);
      }
    },
    [onActivateSession, integration.activation],
  );

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* View switcher - only shown when there are multiple hosts */}
      <ViewSwitcher
        mode={viewMode}
        onModeChange={setViewMode}
        hasMultipleHosts={hasMultipleHosts}
        totalUnread={totalUnread}
      />

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {viewMode === 'current' ? (
          // Current instance view - render the original sidebar
          <div className="h-full">{children}</div>
        ) : (
          // All instances view - render the multi-host tree
          <MultiHostSessionTree
            activeHostId={activeHostId}
            activeSessionId={activeSessionId}
            onActivateSession={handleActivateSession}
            className="h-full"
          />
        )}
      </div>
    </div>
  );
}
