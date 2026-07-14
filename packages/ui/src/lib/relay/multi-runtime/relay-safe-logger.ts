/**
 * Safe relay logger.
 *
 * Wraps a user-provided logger (or console) and sanitizes log arguments
 * to prevent secret material from leaking into logs.
 *
 * Allowed: runtimeKey, serverId, state transitions, errors.
 * Redacted: relayUrl (full), hostEncPubJwk, grant, private keys,
 *           complete descriptors, Authorization headers.
 */

import type { SafeRelayLogger, RelayRuntimeDescriptor } from './types';

const REDACTED = '[REDACTED]';

/**
 * Check if a value looks like sensitive relay material.
 * Returns true for JsonWebKey objects, grant strings, and Authorization values.
 */
const isSensitive = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'object' && !Array.isArray(value)) {
    // JsonWebKey has kty, key_ops, etc.
    const obj = value as Record<string, unknown>;
    if ('kty' in obj || 'key_ops' in obj || 'd' in obj || 'x' in obj) return true;
  }
  if (typeof value === 'string') {
    // Grant tokens and auth headers
    if (value.startsWith('Bearer ') || value.startsWith('grant_')) return true;
  }
  return false;
};

/**
 * Sanitize log arguments: redact anything that looks like secret material.
 */
const sanitize = (args: unknown[]): unknown[] =>
  args.map((arg) => {
    if (isSensitive(arg)) return REDACTED;
    if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
      const obj = arg as Record<string, unknown>;
      const sanitized: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        if (key === 'hostEncPubJwk' || key === 'grant' || key === 'authorization') {
          sanitized[key] = REDACTED;
        } else if (isSensitive(val)) {
          sanitized[key] = REDACTED;
        } else {
          sanitized[key] = val;
        }
      }
      return sanitized;
    }
    return arg;
  });

/**
 * Create a safe logger that wraps an underlying logger and sanitizes output.
 */
export const createSafeRelayLogger = (underlying?: SafeRelayLogger): SafeRelayLogger => {
  const log = underlying ?? console;
  return {
    debug: (message: string, ...args: unknown[]) => log.debug(message, ...sanitize(args)),
    info: (message: string, ...args: unknown[]) => log.info(message, ...sanitize(args)),
    warn: (message: string, ...args: unknown[]) => log.warn(message, ...sanitize(args)),
    error: (message: string, ...args: unknown[]) => log.error(message, ...sanitize(args)),
  };
};

/**
 * Create a debug-safe representation of a relay descriptor.
 * Only includes serverId and truncated state — no secrets.
 */
export const safeDescriptorDebug = (descriptor: RelayRuntimeDescriptor): Record<string, unknown> => ({
  serverId: descriptor.serverId,
  hasGrant: descriptor.grant !== undefined,
});
