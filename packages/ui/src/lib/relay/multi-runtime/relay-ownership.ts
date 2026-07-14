/**
 * Relay ownership model.
 *
 * Implements host-lifetime ownership: each entry lives as long as its
 * remote host is registered in the multi-host store. Tunnel lifecycle
 * is NOT tied to:
 * - component mount/unmount
 * - sidebar open/close
 * - active host switching
 * - monitor start/stop
 *
 * Explicit close signals:
 * - host removal (registry.close(key))
 * - app shutdown (registry.closeAll() / registry.dispose())
 *
 * Reference counting is intentionally NOT used in v1. The complexity of
 * acquire/release + leak detection is not justified when the ownership
 * boundary is clear: one host = one tunnel = one entry.
 */

import type { RelayRuntimeKey } from './types';

// ---------------------------------------------------------------------------
// Ownership tracking
// ---------------------------------------------------------------------------

export interface OwnershipRecord {
  /** The runtime key that owns this entry. */
  runtimeKey: RelayRuntimeKey;
  /** When the entry was created (ms since epoch). */
  createdAt: number;
  /** Last time the entry was accessed (ensure/get). */
  lastAccessedAt: number;
  /** Number of active references (for future use; always 1 in host-lifetime model). */
  refCount: number;
}

/**
 * Create an ownership record for a new entry.
 */
export const createOwnershipRecord = (
  runtimeKey: RelayRuntimeKey,
  now: number,
): OwnershipRecord => ({
  runtimeKey,
  createdAt: now,
  lastAccessedAt: now,
  refCount: 1,
});

/**
 * Touch the ownership record to update last access time.
 */
export const touchOwnership = (record: OwnershipRecord, now: number): void => {
  record.lastAccessedAt = now;
};

/**
 * Check if an entry is idle (no recent access) based on a TTL.
 * Returns true if the entry has not been accessed within `ttlMs`.
 * Does NOT consider entries with refCount > 0 as idle.
 */
export const isOwnershipIdle = (
  record: OwnershipRecord,
  now: number,
  ttlMs: number,
): boolean => record.refCount === 0 && now - record.lastAccessedAt > ttlMs;

/**
 * Increment the reference count.
 * In host-lifetime model this is always 1, but the API supports
 * future reference-counting if needed.
 */
export const acquireOwnership = (record: OwnershipRecord): void => {
  record.refCount += 1;
};

/**
 * Decrement the reference count.
 * Returns true if the count reached zero.
 */
export const releaseOwnership = (record: OwnershipRecord): boolean => {
  if (record.refCount > 0) record.refCount -= 1;
  return record.refCount === 0;
};
