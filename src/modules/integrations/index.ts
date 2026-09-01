/**
 * ServiceOS module: /integrations (WORK-015 implementation).
 *
 * Provider-neutral external business-system ports/adapters
 * (architecture.md §6; integration-model.md "Integration port principle").
 *
 * Authority (authority matrix / Work Order frozen scope):
 * - THE CAPABILITY TAXONOMY AND ADAPTER SELECTION are owned here: the
 *   frozen provider-neutral capability classes (email, SMS, voice,
 *   business systems, payment, document storage, government portals —
 *   Zeck deliberately absent, it is the /zeck module's boundary, WORK-005)
 *   and the registry that selects ONE adapter behind ONE contract per
 *   class (AC-2). A module other than /integrations exporting the
 *   capability/registry authority is an architecture violation (checked
 *   structurally).
 * - PROVIDER SDKs NEVER ENTER BUSINESS MODULES (AC-6): provider-specific
 *   SDKs live only inside real provider adapters (none ship in this Work
 *   Order — the registry composes EMPTY and SEALED, the boundary stays
 *   closed, "premature external effects" are impossible); the boundary
 *   checks reject provider-SDK imports anywhere in the module tree.
 * - ADAPTERS TRANSLATE, THEY NEVER OWN STATE (integration-model.md
 *   "Adapter rule"): this module owns no durable state, no Service Work
 *   state, no interaction ledger (that is /interactions), and imports no
 *   other business module (checked structurally).
 * - PROVIDER OUTCOMES ARE OBSERVED RESULTS, NEVER EXCEPTIONS FROM HERE:
 *   the sink surfaces acceptances; provider failures throw from the
 *   adapter and are recorded as explicit observed dispatch failures by
 *   the /interactions authority. A provider success NEVER automatically
 *   completes Service Work (AC-4; the business outcome authority decides).
 * - NO ZECK/AI AUTHORITY (forbidden surface): nothing here selects
 *   models, routes AI, or duplicates Zeck's execution authority.
 */
import { defineModule } from '../../platform/module-registry/index.js';

// The provider-neutral capability contracts (the module's core public
// surface — the taxonomy is frozen code, never data).
export {
  CAPABILITY_CLASSES,
  isCapabilityClass,
  validateEffectParams,
} from './capabilities.js';
export type {
  BusinessSystemEffectParams,
  CapabilityClass,
  CapabilityParamsMap,
  DocumentStorageEffectParams,
  EmailEffectParams,
  GovernmentPortalEffectParams,
  PaymentEffectParams,
  SmsEffectParams,
  VoiceEffectParams,
} from './capabilities.js';

// The adapter registry, the dispatch sink and the adapter contracts.
export { createAdapterRegistry, createEffectSink } from './registry.js';
export type {
  AdapterRegistry,
  ExternalEffectAcceptance,
  ExternalEffectAdapter,
  ExternalEffectRequest,
  ExternalEffectSink,
} from './registry.js';

// The typed error surface (the module's own rule vocabulary).
export { IntegrationsError } from './errors.js';
export type { IntegrationsErrorCode } from './errors.js';

// Contract-conformant TEST DOUBLES (Work Order frozen scope: "adapter
// contracts and test doubles"). No real provider adapter ships here.
export { createInMemoryProviderAdapter } from './doubles.js';
export type { ProviderDoubleOptions, ProviderEffectLog, RecordedProviderEffect } from './doubles.js';

/**
 * Module manifest (registered in the composition root's module registry).
 * The manifest declares identity only; the contracts above are the
 * module's public surface.
 */
export default defineModule({
  name: 'integrations',
  version: '1.0.0',
  description: 'provider-neutral external business-system ports/adapters',
});
