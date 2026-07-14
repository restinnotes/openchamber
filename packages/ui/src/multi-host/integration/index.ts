/**
 * Multi-host integration — public API barrel.
 *
 * Import from '@/multi-host/integration' to consume the integration layer
 * that wires the multi-host subsystems together.
 */

// -- Supervisor lifecycle ---------------------------------------------------
export {
  createSupervisorLifecycle,
  getSupervisorLifecycle,
  disposeSupervisorLifecycle,
  type SupervisorLifecycle,
  type SupervisorLifecycleOptions,
} from './supervisor-lifecycle';

// -- Runtime activation adapter ---------------------------------------------
export {
  createRuntimeActivationAdapter,
  type RuntimeActivationAdapterOptions,
} from './runtime-activation-adapter';

// -- Activation wiring ------------------------------------------------------
export {
  createActivationWiring,
  getActivationWiring,
  disposeActivationWiring,
  type ActivationWiring,
  type ActivationWiringOptions,
} from './activation-wiring';

// -- Sidebar integration ----------------------------------------------------
export {
  useSidebarIntegration,
  SidebarIntegration,
  type SidebarIntegrationOptions,
  type SidebarIntegrationProps,
} from './sidebar-integration';

// -- Multi-host integration context -----------------------------------------
export {
  useMultiHostIntegration,
  type MultiHostIntegrationContextValue,
} from './multi-host-integration-context';

// -- Multi-host integration provider ----------------------------------------
export {
  MultiHostIntegrationProvider,
  type MultiHostIntegrationProviderProps,
} from './multi-host-integration-provider';
