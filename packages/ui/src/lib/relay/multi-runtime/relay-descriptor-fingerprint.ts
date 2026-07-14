/**
 * Relay descriptor fingerprint.
 *
 * Produces a stable, non-reversible fingerprint for a `RelayRuntimeDescriptor`
 * so the registry can detect descriptor changes that require client replacement.
 *
 * Security properties:
 * - SHA-256 hash — non-reversible
 * - Truncated output — not useful for brute-force
 * - No secret material logged (only first 8 hex chars in debug)
 * - Deterministic: same inputs → same fingerprint
 */

import type { RelayRuntimeDescriptor } from './types';

// ---------------------------------------------------------------------------
// Stable JSON serialization (sorted keys)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization: sorts object keys alphabetically
 * so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same string.
 */
const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${pairs.join(',')}}`;
  }
  return String(value);
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
 * Hash a string with SHA-256 and return the hex-encoded digest.
 * Uses the Web Crypto API which is available in browsers, Node, and Bun.
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
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Full hex fingerprint (64 chars) for a relay descriptor.
 * Includes relayUrl, serverId, hostEncPubJwk, and grant.
 * The hostEncPubJwk is stably serialized (sorted keys).
 */
export const computeFullFingerprint = async (descriptor: RelayRuntimeDescriptor): Promise<string> => {
  const material = stableStringify({
    relayUrl: descriptor.relayUrl,
    serverId: descriptor.serverId,
    hostEncPubJwk: descriptor.hostEncPubJwk,
    grant: descriptor.grant ?? '',
  });
  return sha256Hex(material);
};

/**
 * Truncated fingerprint for comparison (16 hex chars = 64 bits).
 * Collision probability is negligible for the small number of registry entries.
 */
export const computeDescriptorFingerprint = async (descriptor: RelayRuntimeDescriptor): Promise<string> =>
  (await computeFullFingerprint(descriptor)).slice(0, 16);

/**
 * Synchronous fingerprint for when you already have the full hash.
 * Falls back to a simple stable hash for environments without async.
 */
export const computeDescriptorFingerprintSync = (descriptor: RelayRuntimeDescriptor): string => {
  const material = stableStringify({
    relayUrl: descriptor.relayUrl,
    serverId: descriptor.serverId,
    hostEncPubJwk: descriptor.hostEncPubJwk,
    grant: descriptor.grant ?? '',
  });
  // Simple FNV-1a for sync use — sufficient for entry identity comparison.
  // Not cryptographic; use computeDescriptorFingerprint for security-critical paths.
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * Safe debug representation of a fingerprint.
 * Only returns the first 8 hex chars to avoid leaking material.
 */
export const safeFingerprintDebug = (fingerprint: string): string =>
  fingerprint.slice(0, 8);
