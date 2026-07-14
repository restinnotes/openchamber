/**
 * Multi-runtime relay registry — public API.
 *
 * Import from '@/lib/relay/multi-runtime' to access the keyed relay
 * tunnel registry. Do not import internal files directly.
 */

// -- Types ------------------------------------------------------------------
export type {
  RelayRuntimeKey,
  RelayRuntimeDescriptor,
  RelayDescriptorAdapter,
  RelayRegistryEntryState,
  RelayRegistryEntryStatus,
  RelayStatusListener,
  RelayTunnelRegistry,
  RelayTunnelRegistryOptions,
  SafeRelayLogger,
} from './types';

export { toRuntimeKey } from './types';

// -- Descriptor adapter -----------------------------------------------------
export { createRelayDescriptor, fromHostTransport } from './relay-descriptor-adapter';

// -- Descriptor fingerprint -------------------------------------------------
export {
  computeFullFingerprint,
  computeDescriptorFingerprint,
  computeDescriptorFingerprintSync,
  safeFingerprintDebug,
} from './relay-descriptor-fingerprint';

// -- Safe logger ------------------------------------------------------------
export { createSafeRelayLogger, safeDescriptorDebug } from './relay-safe-logger';

// -- Entry ------------------------------------------------------------------
export {
  createEntry,
  stateFromClientStatus,
  isValidTransition,
  entryStatus,
  updateEntryFromClientStatus,
  isEntryActive,
  isEntryCreating,
  isEntryClosed,
  type RelayEntry,
} from './relay-entry';

// -- Ownership --------------------------------------------------------------
export {
  createOwnershipRecord,
  touchOwnership,
  isOwnershipIdle,
  acquireOwnership,
  releaseOwnership,
  type OwnershipRecord,
} from './relay-ownership';

// -- Registry ---------------------------------------------------------------
export { createRelayTunnelRegistry } from './relay-tunnel-registry';
