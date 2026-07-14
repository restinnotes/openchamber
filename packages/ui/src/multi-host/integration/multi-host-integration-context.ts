/**
 * Hook for accessing the multi-host integration context.
 *
 * This hook must be used within a MultiHostIntegrationProvider.
 */

import React from 'react';
import type { SupervisorLifecycle } from './supervisor-lifecycle';
import type { ActivationWiring } from './activation-wiring';

// ---------------------------------------------------------------------------
// Context value type
// ---------------------------------------------------------------------------

export type MultiHostIntegrationContextValue = {
  supervisor: SupervisorLifecycle;
  activation: ActivationWiring;
  isMultiHostEnabled: boolean;
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const MultiHostIntegrationContext = React.createContext<MultiHostIntegrationContextValue | null>(null);

export const useMultiHostIntegration = (): MultiHostIntegrationContextValue => {
  const ctx = React.useContext(MultiHostIntegrationContext);
  if (!ctx) {
    throw new Error('useMultiHostIntegration must be used within MultiHostIntegrationProvider');
  }
  return ctx;
};

export { MultiHostIntegrationContext };
