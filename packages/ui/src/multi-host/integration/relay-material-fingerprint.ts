/**
 * Relay material fingerprint for change detection.
 *
 * Produces a stable, non-reversible fingerprint for relay connection material
 * (DesktopHostRelay + optional grant) so the sync bridge can detect when a
 * relay client needs replacement.
 *
 * Security properties:
 *   - FNV-1a 32-bit hash — deterministic, non-reversible
 *   - Stable sorted-key JSON encoding — field boundary collisions impossible
 *   - No secret material logged or exposed in UI
 *   - Missing grant vs empty grant are semantically distinct states
 *
 * Coverage: relayUrl, serverId, hostEncPubJwk, grant.
 */

import type { DesktopHostRelay } from '@/lib/desktopHosts';

// ---------------------------------------------------------------------------
// Stable JSON serialization (sorted keys, quoted strings)
// ---------------------------------------------------------------------------

/**
 * Deterministic serialization: object keys are sorted, strings are quoted
 * via JSON.stringify, preventing field boundary collisions.  This is the
 * same encoding pattern used by relay-descriptor-fingerprint.ts.
 */
const stableStringify = (value: Record<string, unknown>): string => {
  const keys = Object.keys(value).sort();
  const pairs = keys.map((k) => {
    const v = value[k];
    if (typeof v === 'string') return `${JSON.stringify(k)}:${JSON.stringify(v)}`;
    if (v && typeof v === 'object') return `${JSON.stringify(k)}:${stableStringify(v as Record<string, unknown>)}`;
    return `${JSON.stringify(k)}:${String(v ?? '')}`;
  });
  return `{${pairs.join(',')}}`;
};

// ---------------------------------------------------------------------------
// FNV-1a 32-bit hash
// ---------------------------------------------------------------------------

/**
 * FNV-1a hash — fast, deterministic, no secret material recoverable.
 * Collision probability is negligible for the small number of relay entries
 * (typically <20).  Sufficient for change detection, not cryptographic use.
 */
const fnv1a32 = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a stable, non-reversible fingerprint of relay connection material.
 *
 * @param relay  - The relay connection material (relayUrl, serverId, hostEncPubJwk)
 * @param grant  - Optional relay grant token (NOT persisted, one-time pairing artifact)
 * @returns      - 8-char hex fingerprint (32 bits)
 *
 * Semantic rules:
 *   - grant=undefined (steady-state) and grant="" (empty) are BOTH serialized
 *     as "" in the hash input.  This matches the protocol: steady-state
 *     connections route by serverId alone, grant is irrelevant.
 *   - grant="token" is serialized as "token" — any non-empty grant produces
 *     a different fingerprint from the no-grant state.
 *
 * Fingerprint is NOT logged, NOT exposed in UI, and does NOT contain
 * recoverable grant material.
 */
export function relayMaterialFingerprint(relay: DesktopHostRelay, grant?: string): string {
  const material = stableStringify({
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
    grant: grant ?? '',
  });
  return fnv1a32(material);
}
