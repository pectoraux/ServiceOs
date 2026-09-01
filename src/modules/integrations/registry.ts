/**
 * ServiceOS /integrations adapter registry (WORK-015, module internal —
 * exported through the module's public interface).
 *
 * Provider-neutral adapter selection (AC-2: "Provider adapters are
 * selected behind one provider-neutral contract per capability class"):
 *
 * - ONE ADAPTER PER CAPABILITY CLASS at any time: registering a second
 *   adapter for a class fails closed (DUPLICATE_ADAPTER) — selection is by
 *   capability contract, never a provider name from a business module.
 * - SELECTION IS FAIL-CLOSED: resolving a class with no registered adapter
 *   throws ADAPTER_NOT_REGISTERED. An unregistered capability is an
 *   explicit composition gap, never a silent no-op (the dispatch surface
 *   stays closed until the owning Work Order registers real providers).
 * - THE REGISTRY SEALS AT COMPOSITION TIME: after `seal()`, any further
 *   registration fails closed (REGISTRY_SEALED). Business modules can
 *   never hot-register adapters; provider changes are a composition-root
 *   (operator) action.
 * - THIS WORK ORDER SHIPS NO REAL PROVIDER ADAPTERS: the production
 *   composition registers none and seals the registry — the external
 *   effect boundary exists and is exercised end-to-end through the
 *   contract-conformant test doubles (doubles.ts); real provider adapters
 *   arrive with the Work Order that owns provider configuration. "Premature
 *   external effects" are forbidden by this Work Order; a closed boundary
 *   cannot produce them.
 *
 * Adapters translate between an external system and a ServiceOS-owned
 * contract (integration-model.md "Adapter rule"); they never own Service
 * Work state and never import other business modules (enforced
 * structurally by the WORK-015 boundary checks).
 */
import { isCapabilityClass, type CapabilityClass } from './capabilities.js';
import { IntegrationsError } from './errors.js';

/**
 * One outbound external-effect request, provider-neutral. `params` is the
 * validated parameter contract of `capability` (validated at durable-intent
 * time by /interactions through `validateEffectParams`; a conformant
 * adapter re-validates on receipt — defense in depth).
 *
 * `identity` is the DURABLE INTERACTION IDENTITY: the provider-neutral
 * idempotency anchor of the external-side-effect protocol
 * (architecture.md §8: "Retries are idempotent by durable identity and
 * external-side-effect protocol"). A conformant adapter MUST treat two
 * dispatches carrying the same `interactionId` as the same logical effect
 * and converge (one provider-side effect, one stable provider reference)
 * — the property the test doubles demonstrate and the crash-recovery
 * protocol of /interactions depends on.
 */
export interface ExternalEffectRequest {
  readonly capability: CapabilityClass;
  readonly params: Readonly<Record<string, unknown>>;
  readonly identity: {
    /** The durable interaction record id (globally unique). */
    readonly interactionId: string;
    /** The owning service tenant. */
    readonly tenantId: string;
  };
}

/**
 * The provider's acceptance of one external-effect request. This is NOT a
 * business outcome: acceptance means the provider took the request; the
 * observed result (success/failure of the actual effect) arrives later and
 * is recorded through /interactions' `recordObservedResult`. A provider
 * success NEVER automatically completes Service Work (Work Order AC-4).
 */
export interface ExternalEffectAcceptance {
  /** The adapter's provider identity (observability only; never a selection key). */
  readonly provider: string;
  /** The provider's own request reference, when it issues one. */
  readonly providerReference: string | null;
  readonly acceptedAt: Date;
}

/**
 * The provider-neutral adapter contract ONE capability class's providers
 * implement. Adapters are registered per capability class; business
 * modules never see them (only the composition root and the /interactions
 * authority do).
 */
export interface ExternalEffectAdapter {
  readonly capability: CapabilityClass;
  readonly providerName: string;
  /**
   * Translate one ServiceOS-owned effect request to the external system.
   * Idempotent by `identity.interactionId` (see ExternalEffectRequest).
   * A provider failure MUST throw (it becomes an explicit observed
   * dispatch failure through /interactions); it must never report a
   * fabricated acceptance.
   */
  dispatchEffect(request: ExternalEffectRequest): Promise<ExternalEffectAcceptance>;
}

export interface AdapterRegistry {
  /** Register the adapter for its capability class (fails closed on duplicates). */
  register(adapter: ExternalEffectAdapter): void;
  /** Freeze the registry; later registrations fail closed. */
  seal(): void;
  readonly sealed: boolean;
  /** Resolve the class's adapter (fail closed when none is registered). */
  resolve(capability: CapabilityClass): ExternalEffectAdapter;
  /** Immutable registration snapshot (observability; no selection semantics). */
  describe(): readonly { capability: CapabilityClass; provider: string }[];
}

export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<CapabilityClass, ExternalEffectAdapter>();
  let sealed = false;
  return {
    register(adapter) {
      if (sealed) {
        throw new IntegrationsError(
          'REGISTRY_SEALED',
          `the adapter registry is sealed; registering "${adapter.providerName}" for ${adapter.capability} is a composition-root change`,
        );
      }
      if (!isCapabilityClass(adapter.capability)) {
        throw new IntegrationsError('INVALID_CAPABILITY', `"${String(adapter.capability)}" is not a frozen capability class`);
      }
      if (typeof adapter.providerName !== 'string' || adapter.providerName.trim() === '') {
        throw new IntegrationsError('INVALID_PARAMS', 'adapter.providerName must be a non-empty string');
      }
      if (typeof adapter.dispatchEffect !== 'function') {
        throw new IntegrationsError('INVALID_PARAMS', 'adapter.dispatchEffect must be a function');
      }
      if (adapters.has(adapter.capability)) {
        const existing = adapters.get(adapter.capability);
        if (existing === adapter) return;
        throw new IntegrationsError(
          'DUPLICATE_ADAPTER',
          `capability class ${adapter.capability} already has adapter "${existing?.providerName}"; one adapter per class is selected behind the class contract`,
        );
      }
      adapters.set(adapter.capability, adapter);
    },
    seal() {
      sealed = true;
    },
    get sealed() {
      return sealed;
    },
    resolve(capability) {
      if (!isCapabilityClass(capability)) {
        throw new IntegrationsError('INVALID_CAPABILITY', `"${String(capability)}" is not a frozen capability class`);
      }
      const adapter = adapters.get(capability);
      if (adapter === undefined) {
        throw new IntegrationsError(
          'ADAPTER_NOT_REGISTERED',
          `no adapter is registered for capability class ${capability}; dispatch fails closed until one is`,
        );
      }
      return adapter;
    },
    describe() {
      return [...adapters.entries()]
        .map(([capability, adapter]) => ({ capability, provider: adapter.providerName }))
        .sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0));
    },
  };
}

/**
 * THE dispatch sink consumed by the /interactions authority: resolves the
 * capability class's registered adapter and forwards the request. This is
 * the only bridge from the durable interaction boundary to provider
 * adapters; /interactions holds it as its single external-effect port.
 */
export interface ExternalEffectSink {
  dispatchEffect(request: ExternalEffectRequest): Promise<ExternalEffectAcceptance>;
}

export function createEffectSink(registry: AdapterRegistry): ExternalEffectSink {
  return {
    async dispatchEffect(request) {
      const adapter = registry.resolve(request.capability);
      return adapter.dispatchEffect(request);
    },
  };
}
