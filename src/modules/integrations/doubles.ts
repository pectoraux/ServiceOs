/**
 * ServiceOS /integrations contract-conformant TEST DOUBLES (WORK-015,
 * module internal — exported through the module's public interface).
 *
 * The Work Order's frozen scope explicitly includes "adapter contracts and
 * test doubles": these in-memory provider doubles implement the
 * provider-neutral adapter contract so the entire external-effect boundary
 * (durable intent, dispatch, observation, crash recovery, convergence) is
 * provable end-to-end WITHOUT any real provider SDK (AC-6 keeps those out
 * of the tree; no real provider adapters exist in this Work Order at all).
 *
 * The double's load-bearing behaviors — the contract conformance every
 * future real adapter must reproduce:
 *
 * - IDENTITY-IDEMPOTENT DISPATCH: a second dispatch carrying the same
 *   `identity.interactionId` converges — one recorded provider effect,
 *   one stable provider reference, the acceptance re-observed. This is
 *   the provider-side half of the external-side-effect protocol
 *   (architecture.md §8); the /interactions crash-recovery protocol
 *   depends on it ("recoverable without duplicate business effect").
 * - HONEST FAILURES: an injected failure throws BEFORE any effect is
 *   recorded (a failed dispatch is never a provider effect) — a real
 *   adapter must throw on provider failure, never fabricate acceptance.
 * - CONTRACT RE-VALIDATION: every dispatch re-validates the class's
 *   parameter contract (defense in depth against contract drift).
 * - DETERMINISTIC HOOKS: `beforeDispatch` injects interleaving points for
 *   concurrency proofs; failure injection is count- or predicate-based.
 */
import { validateEffectParams, type CapabilityClass } from './capabilities.js';
import { IntegrationsError } from './errors.js';
import type { ExternalEffectAcceptance, ExternalEffectAdapter, ExternalEffectRequest } from './registry.js';

export interface ProviderDoubleOptions {
  /** Adapter identity in acceptances (default: "in-memory-double"). */
  readonly providerName?: string;
  /** Provider reference prefix (default: "double-"). */
  readonly referencePrefix?: string;
  /** Deterministically fail the FIRST n dispatch attempts (throw before recording). */
  readonly failNextDispatches?: number;
  /** Deterministically fail dispatches matching a predicate (throw before recording). */
  readonly failMatching?: (request: ExternalEffectRequest) => boolean;
  /** Interleaving hook before the synchronous effect critical section. */
  readonly beforeDispatch?: (request: ExternalEffectRequest) => Promise<void>;
  /** Clock for acceptances (deterministic proofs). */
  readonly now?: () => Date;
}

/** One recorded provider-side effect (the provider's own ledger). */
export interface RecordedProviderEffect {
  readonly interactionId: string;
  readonly tenantId: string;
  readonly capability: CapabilityClass;
  readonly params: Readonly<Record<string, unknown>>;
  readonly providerReference: string;
  /** How many dispatch ATTEMPTS carried this identity (idempotent re-dispatch increments it without duplicating the effect). */
  attempts: number;
  readonly firstAcceptedAt: Date;
  lastAcceptedAt: Date;
}

/** The double's observable provider-side state (proof assertions). */
export interface ProviderEffectLog {
  list(): readonly RecordedProviderEffect[];
  /** Total recorded provider effects (one per distinct identity). */
  count(): number;
  /** Total dispatch attempts seen by this provider double. */
  countDispatchAttempts(): number;
  /** The effect produced for one interaction identity, when it exists. */
  find(interactionId: string): RecordedProviderEffect | null;
  /** The stable provider reference assigned to one identity. */
  referenceFor(interactionId: string): string | null;
}

/**
 * Build one in-memory provider adapter double for a capability class plus
 * its observable provider-side effect log.
 */
export function createInMemoryProviderAdapter(
  capability: CapabilityClass,
  options: ProviderDoubleOptions = {},
): { adapter: ExternalEffectAdapter; log: ProviderEffectLog } {
  const providerName = options.providerName ?? 'in-memory-double';
  const referencePrefix = options.referencePrefix ?? 'double-';
  const now = options.now ?? (() => new Date());
  const effects = new Map<string, RecordedProviderEffect>();
  let attempts = 0;
  let failBudget = options.failNextDispatches ?? 0;

  const adapter: ExternalEffectAdapter = {
    capability,
    providerName,
    async dispatchEffect(request) {
      if (request.capability !== capability) {
        throw new IntegrationsError(
          'INVALID_CAPABILITY',
          `${providerName} serves ${capability}; received a ${request.capability} request (adapter selection drifted)`,
        );
      }
      if (typeof request.identity?.interactionId !== 'string' || request.identity.interactionId === '') {
        throw new IntegrationsError('INVALID_PARAMS', 'effect request identity.interactionId is required');
      }
      if (typeof request.identity?.tenantId !== 'string' || request.identity.tenantId === '') {
        throw new IntegrationsError('INVALID_PARAMS', 'effect request identity.tenantId is required');
      }
      // Contract re-validation (defense in depth; the interaction authority
      // validated at intent time — drift between the two is a defect).
      const validated = validateEffectParams(capability, request.params);

      await options.beforeDispatch?.(request);

      attempts += 1;
      // Deterministic failure injection: BEFORE the critical section, so a
      // failed dispatch is never recorded as a provider effect.
      if (failBudget > 0 || options.failMatching?.(request) === true) {
        if (failBudget > 0) failBudget -= 1;
        throw new Error(`${providerName} dispatch failed (injected failure for ${request.identity.interactionId})`);
      }

      const existing = effects.get(request.identity.interactionId);
      if (existing !== undefined) {
        // IDENTITY-IDEMPOTENT CONVERGENCE: the same durable identity is the
        // same logical effect. No second provider effect; the acceptance
        // re-observes the stable reference.
        existing.attempts += 1;
        existing.lastAcceptedAt = now();
        return { provider: providerName, providerReference: existing.providerReference, acceptedAt: existing.firstAcceptedAt };
      }
      const effect: RecordedProviderEffect = {
        interactionId: request.identity.interactionId,
        tenantId: request.identity.tenantId,
        capability,
        params: validated,
        providerReference: `${referencePrefix}${request.identity.interactionId}`,
        attempts: 1,
        firstAcceptedAt: now(),
        lastAcceptedAt: now(),
      };
      effects.set(request.identity.interactionId, effect);
      return { provider: providerName, providerReference: effect.providerReference, acceptedAt: effect.firstAcceptedAt };
    },
  };

  const log: ProviderEffectLog = {
    list: () => [...effects.values()].sort((a, b) => (a.firstAcceptedAt < b.firstAcceptedAt ? -1 : 1)),
    count: () => effects.size,
    countDispatchAttempts: () => attempts,
    find: (interactionId) => effects.get(interactionId) ?? null,
    referenceFor: (interactionId) => effects.get(interactionId)?.providerReference ?? null,
  };

  return { adapter, log };
}
