/**
 * Desktop hosts change notifier — lightweight event bus for immediate
 * reconciliation after host CRUD operations.
 *
 * Called automatically by desktopHostsSet() after a successful write.
 * Subscribers (e.g., the multi-host integration provider) can trigger
 * immediate re-sync instead of waiting for the 60s polling interval.
 */

type Listener = () => void;

const listeners: Set<Listener> = new Set();

/**
 * Notify all subscribers that the persisted desktop hosts have changed.
 * Called automatically by desktopHostsSet() on success.
 */
export function notifyDesktopHostsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Listener error — don't break the notification chain
    }
  }
}

/**
 * Subscribe to desktop hosts change notifications.
 * Returns an unsubscribe function.
 */
export function subscribeDesktopHostsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
