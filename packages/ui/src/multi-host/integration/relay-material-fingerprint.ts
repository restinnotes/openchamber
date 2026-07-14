/**
 * Relay material fingerprint for change detection.
 *
 * Produces a stable, non-reversible SHA-256 fingerprint for relay connection
 * material (DesktopHostRelay + optional grant) so the sync bridge can detect
 * when a relay client needs replacement.
 *
 * Security properties:
 *   - SHA-256 256-bit hash — cryptographic, non-reversible
 *   - Full 64-char hex digest used for equality comparison (no truncation)
 *   - Stable sorted-key JSON encoding — field boundary collisions impossible
 *   - No secret material logged or exposed in UI
 *   - Missing grant vs empty grant are semantically distinct states
 *
 * Coverage: relayUrl, serverId, hostEncPubJwk (trust anchor), grant.
 *
 * Reuses the SHA-256 and stable encoding patterns from
 * relay-descriptor-fingerprint.ts for consistency.
 */

import type { DesktopHostRelay } from '@/lib/desktopHosts';

// ---------------------------------------------------------------------------
// Stable JSON serialization (sorted keys, quoted strings)
// ---------------------------------------------------------------------------

/**
 * Deterministic serialization: object keys are sorted, strings are quoted
 * via JSON.stringify, preventing field boundary collisions.
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
// SHA-256 via Web Crypto (isomorphic)
// ---------------------------------------------------------------------------

const hexEncode = (bytes: Uint8Array): string => {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
};

/**
 * Hash a string with SHA-256 and return the full hex-encoded digest (64 chars).
 * Uses the Web Crypto API which is available in browsers, Electron (Node), and Bun.
 */
const sha256Hex = async (input: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const gc = globalThis as Record<string, unknown>;
  const cryptoObj = gc.crypto as { subtle?: SubtleCrypto } | undefined;
  const subtle = cryptoObj?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API not available');
  }
  const hash = await subtle.digest('SHA-256', data);
  return hexEncode(new Uint8Array(hash));
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a stable, non-reversible SHA-256 fingerprint of relay connection material.
 *
 * @param relay  - The relay connection material (relayUrl, serverId, hostEncPubJwk)
 * @param grant  - Optional relay grant token (NOT persisted, one-time pairing artifact)
 * @returns      - Promise resolving to 64-char hex SHA-256 digest
 *
 * Semantic rules:
 *   - grant=undefined (steady-state) and grant="" (empty) are BOTH serialized
 *     as "" in the hash input.  This matches the protocol: steady-state
 *     connections route by serverId alone, grant is irrelevant.
 *   - grant="token" is serialized as "token" — any non-empty grant produces
 *     a different fingerprint from the no-grant state.
 *
 * Comparison uses the FULL 64-char digest — no truncation for equality.
 * Debug display should truncate to first 8 chars via safeFingerprintDebug().
 *
 * Fingerprint is NOT logged, NOT exposed in UI, and does NOT contain
 * recoverable grant material.
 */
export async function relayMaterialFingerprint(
  relay: DesktopHostRelay,
  grant?: string,
): Promise<string> {
  const material = stableStringify({
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
    grant: grant ?? '',
  });
  return sha256Hex(material);
}

/**
 * Safe debug representation of a fingerprint.
 * Only returns the first 8 hex chars to avoid leaking material.
 */
export const safeFingerprintDebug = (fingerprint: string): string =>
  fingerprint.slice(0, 8);
