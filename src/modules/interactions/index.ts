/**
 * ServiceOS module: /interactions (WORK-015 implementation).
 *
 * External communications and the provider-neutral interaction ledger
 * (architecture.md §6, §13; integration-model.md "Outbound effects").
 *
 * Authority (authority matrix / Work Order frozen scope):
 * - THE EXTERNAL INTERACTION LEDGER is owned here: `createInteraction`
 *   (durable intent), `dispatchInteraction` (dispatch),
 *   `recordObservedResult` (observed result) are the public surface every
 *   business side effect flows through. A module other than /interactions
 *   exporting interaction-ledger entry points is an architecture
 *   violation (checked structurally).
 * - THE BUSINESS SIDE-EFFECT INVARIANT IS THE MODULE'S SHAPE (the Work
 *   Order's critical chain, in order, with no step skipped):
 *     authorization (/organizations' single chain, first, at every
 *     surface — invariant 6: tenant authorization before adapter
 *     invocation)
 *       -> durable intent (createInteraction persists state `intended`
 *          BEFORE any side effect; an optional /policies gate denies
 *          closed before the intent row exists)
 *       -> dispatch (dispatchInteraction: atomic claim
 *          `intended -> dispatching`, adapter invocation through the
 *          injected provider-neutral sink, acceptance recorded as
 *          `dispatched`; provider failure recorded as an explicit observed
 *          dispatch failure)
 *       -> observe provider result (recordObservedResult: explicit,
 *          terminal, convergent)
 *       -> BUSINESS AUTHORITY DECIDES OUTCOME (never here: a provider
 *          success does not complete Service Work — AC-4; this module
 *          imports neither /work nor /workflow, writes no business state,
 *          and the workflow boundary checks reject any second status
 *          writer).
 * - ONE DISPATCH PER INTERACTION, CONVERGENT (AC-3): duplicate keyed
 *   intent creations converge on ONE logical interaction; concurrent
 *   dispatches of one interaction serialize on the claim CAS — exactly one
 *   adapter invocation, losers converge (dispatched) or fail closed with
 *   a typed, recoverable error; the adapter contract is idempotent by
 *   durable interaction identity, so crash recovery re-dispatches without
 *   duplicate business effect.
 * - CRASH RECOVERY IS EXPLICIT (verification requirement: "crash between
 *   durable intent and adapter call is recoverable without duplicate
 *   business effect"): a `dispatching` interaction left by a crashed
 *   dispatcher is listed by `listRecoverableDispatches` and recovered
 *   through `recoverInteraction` (re-claim + re-dispatch; the adapter
 *   converges by identity).
 * - FAILURES ARE EXPLICIT AND RECOVERABLE (AC-5): provider failures are
 *   durable observed-failure records (never exceptions from the dispatch
 *   surface, never silently dropped); the retry protocol creates a NEW
 *   interaction identity carrying `retryOf` lineage after an observed
 *   failure (the original observation is never rewritten).
 * - ADAPTERS STAY PROVIDER-NEUTRAL (AC-2): this module holds the
 *   /integrations dispatch sink (the composition root injects it — the
 *   registry maps capability class -> adapter); no provider SDK, provider
 *   name or provider selection ever appears in a business module
 *   (structurally rejected, AC-6).
 * - NO ZECK/AI AUTHORITY (forbidden surface): AI execution intents flow
 *   through the /zeck module (WORK-005); nothing here models, routes or
 *   executes AI.
 */
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import { defineModule } from '../../platform/module-registry/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import type { PolicyDecisionRecord } from '../policies/index.js';
import {
  IntegrationsError,
  isCapabilityClass,
  validateEffectParams,
  type CapabilityClass,
  type ExternalEffectSink,
} from '../integrations/index.js';
import { createSqlInteractionsStore } from './sql-store.js';
import { hashInteractionInput } from './provenance.js';
import {
  InteractionsStoreMissingError,
  InteractionsStoreRuleError,
  type ClaimDispatchInput,
  type CompleteDispatchInput,
  type CreateInteractionInput,
  type InteractionClaim,
  type InteractionDispatch,
  type InteractionFilter,
  type InteractionFailureStage,
  type InteractionObservation,
  type InteractionOutcome,
  type InteractionRecord,
  type InteractionState,
  type InteractionsStore,
  type InteractionsStoreRule,
  type PolicyProvenance,
  type ReclaimDispatchInput,
  type RecordDispatchFailureInput,
  type RecordObservationInput,
} from './store.js';

// Store port (public contract): the authoritative SQL implementation runs
// through the persistence boundary; tests inject faithful in-memory
// implementations of the same port through this surface.
export { createSqlInteractionsStore, InteractionsStoreMissingError, InteractionsStoreRuleError };
export type {
  ClaimDispatchInput,
  CompleteDispatchInput,
  CreateInteractionInput,
  ReclaimDispatchInput,
  InteractionClaim,
  InteractionDispatch,
  InteractionFilter,
  InteractionFailureStage,
  InteractionObservation,
  InteractionOutcome,
  InteractionRecord,
  InteractionState,
  InteractionsStore,
  InteractionsStoreRule,
  PolicyProvenance,
  RecordDispatchFailureInput,
  RecordObservationInput,
};

// Deterministic provenance hashing (part of the interaction-ledger contract).
export { canonicalJson, computeInteractionRecordHash, hashInteractionInput, hashObservation } from './provenance.js';
export type { HashableInteractionRecord, InteractionIntentCore, InteractionObservationCore, InteractionRecordCore } from './provenance.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The tenancy authorization decision entry point consumed from
 * /organizations' public interface (injected by the composition root so
 * the authorization chain stays singular — never re-implemented here).
 */
export interface TenancyAuthorization {
  authorize(
    principalId: string,
    scope: { organizationId: string } | { tenantId: string },
    action: TenancyAction,
  ): Promise<AuthorizationDecision>;
}

/**
 * The policy-gate hook consumed from /policies' public interface
 * (structural subset: `evaluatePolicy`). Injected by the composition
 * root; the interaction authority never reimplements policy logic
 * (authority matrix: "workflow/vertical duplicate policy engine" is the
 * forbidden pattern). The gate runs BEFORE the durable intent row exists
 * (integration-model.md: policy -> durable intent -> provider adapter).
 */
export interface PolicyGate {
  evaluatePolicy(
    principal: Principal,
    input: {
      tenantId: string;
      policyKey: string;
      action: string;
      attributes: Readonly<Record<string, string | number | boolean | null>>;
      idempotencyKey?: string;
    },
  ): Promise<{ decision: PolicyDecisionRecord; converged: boolean }>;
}

export type InteractionsErrorCode =
  | 'INVALID_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  | 'INTERACTION_NOT_FOUND'
  | 'INTERACTION_INPUT_CONFLICT'
  | 'DISPATCH_IN_PROGRESS'
  | 'INTERACTION_OBSERVED'
  | 'RECOVERY_NOT_AVAILABLE'
  | 'OBSERVATION_STATE_INVALID'
  | 'OBSERVATION_CONFLICT'
  | 'RETRY_TARGET_INVALID'
  | 'POLICY_DENIED'
  | 'POLICY_EVALUATION_FAILED'
  | 'ADAPTER_UNAVAILABLE'
  | 'INTERACTION_RECORD_TAMPERED';

export class InteractionsError extends Error {
  constructor(
    readonly code: InteractionsErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'InteractionsError';
  }
}

export interface InteractionsModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: InteractionsStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** The policy gate, consumed from /policies' public interface. */
  policies: PolicyGate;
  /**
   * The provider-neutral external-effect sink (the /integrations adapter
   * registry behind one contract per capability class). Required: the
   * boundary is closed (fail-closed ADAPTER_UNAVAILABLE) when no adapter
   * is registered for a class — never a silent no-op.
   */
  sink: ExternalEffectSink;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

/** The outcome of one dispatch attempt (never an exception for provider failures). */
export interface DispatchOutcome {
  /** The interaction record after the dispatch attempt (state `dispatched` or observed-failed). */
  readonly interaction: InteractionRecord;
  /** True when THIS call invoked the adapter (a twin dispatch or recovery converges without invoking it again). */
  readonly invoked: boolean;
  /** True when this call converged on an interaction another caller already dispatched. */
  readonly converged: boolean;
}

export interface InteractionsModule {
  /**
   * THE durable-intent surface (AC-1): persist the external effect intent
   * (state `intended`) BEFORE any side effect. Authorization first; an
   * optional policy gate (deny fails closed BEFORE the intent row
   * exists); provider-neutral params validated against the capability
   * class contract; idempotent by (tenant, idempotency key) — duplicate
   * keyed creations converge on ONE logical interaction (AC-3), divergent
   * re-submissions fail closed. `retryOfInteractionId` records the retry
   * lineage (valid only against an observed failure of this tenant).
   */
  createInteraction(
    principal: Principal,
    tenantId: string,
    input: {
      capability: CapabilityClass;
      params: unknown;
      correlation?: Readonly<Record<string, string>>;
      policyKey?: string;
      idempotencyKey?: string;
      retryOfInteractionId?: string;
    },
  ): Promise<{ interaction: InteractionRecord; converged: boolean }>;

  /**
   * THE dispatch surface: claim the interaction (atomic
   * `intended -> dispatching`), invoke the provider-neutral adapter, and
   * record the acceptance (`dispatched`) or the explicit dispatch failure
   * (observed/failed). Concurrent dispatches of one interaction: exactly
   * ONE adapter invocation — the loser converges (already dispatched)
   * or fails closed with DISPATCH_IN_PROGRESS (typed, recoverable);
   * re-dispatch of an OBSERVED interaction fails closed (the retry
   * protocol creates a new identity). Provider failures are RETURNED as
   * the record (explicit, durable), never thrown. Adapter-resolution
   * failures (no adapter registered for the class) throw
   * ADAPTER_UNAVAILABLE and leave the claim standing for recovery.
   */
  dispatchInteraction(principal: Principal, tenantId: string, interactionId: string): Promise<DispatchOutcome>;

  /**
   * THE crash-recovery surface: re-claim and re-dispatch a `dispatching`
   * interaction left by a crashed dispatcher. Safe by the adapter
   * contract's identity idempotency: the provider converges on ONE
   * logical effect even when the crash landed after the adapter call —
   * no duplicate business effect. Fails closed with
   * RECOVERY_NOT_AVAILABLE for interactions outside the crash window.
   */
  recoverInteraction(principal: Principal, tenantId: string, interactionId: string): Promise<DispatchOutcome>;

  /**
   * THE observed-result surface (AC-1): record the provider's observed
   * outcome on a dispatched interaction. Explicit, terminal, convergent:
   * an identical re-observation converges; a divergent re-observation
   * fails closed (duplicate mutation detected). A success NEVER
   * completes Service Work — the business authority decides separately.
   */
  recordObservedResult(
    principal: Principal,
    tenantId: string,
    interactionId: string,
    input: { outcome: InteractionOutcome; providerObservation?: unknown },
  ): Promise<{ interaction: InteractionRecord; converged: boolean }>;

  /** Read one interaction (tamper-evident: hash verified on read). */
  getInteraction(principal: Principal, tenantId: string, interactionId: string): Promise<InteractionRecord>;
  /** The interaction ledger for one tenant (append-order, filterable). */
  listInteractions(principal: Principal, tenantId: string, filter?: InteractionFilter): Promise<InteractionRecord[]>;
  /** The crash-recovery surface: `dispatching` interactions of this tenant. */
  listRecoverableDispatches(principal: Principal, tenantId: string): Promise<InteractionRecord[]>;
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InteractionsError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

function validateOptionalKey(value: string | undefined, what: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new InteractionsError('INVALID_INPUT', `${what} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

const CORRELATION_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_CORRELATION_ENTRIES = 10;

function validateCorrelation(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | null {
  if (value === undefined) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_CORRELATION_ENTRIES) {
    throw new InteractionsError('INVALID_INPUT', `correlation must carry at most ${MAX_CORRELATION_ENTRIES} entries`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!CORRELATION_KEY_PATTERN.test(key)) {
      throw new InteractionsError('INVALID_INPUT', `correlation key "${key}" must match [A-Za-z0-9_.-]{1,64}`);
    }
    if (typeof entry !== 'string' || entry.length > 256) {
      throw new InteractionsError('INVALID_INPUT', `correlation entry "${key}" must be a string of at most 256 characters`);
    }
    out[key] = entry;
  }
  return out;
}

/** Provider observation payload: any canonicalizable JSON value, bounded. */
function validateObservation(value: unknown, depth = 0): void {
  if (depth > 8) {
    throw new InteractionsError('INVALID_INPUT', 'providerObservation must not nest deeper than 8 levels');
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > 100_000) {
      throw new InteractionsError('INVALID_INPUT', 'providerObservation strings must stay under 100000 characters');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) {
      throw new InteractionsError('INVALID_INPUT', 'providerObservation arrays must stay under 1000 entries');
    }
    for (const entry of value) validateObservation(entry, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 1_000) {
      throw new InteractionsError('INVALID_INPUT', 'providerObservation objects must stay under 1000 entries');
    }
    for (const [, entry] of entries) validateObservation(entry, depth + 1);
    return;
  }
  throw new InteractionsError('INVALID_INPUT', 'providerObservation must be a JSON value (no undefined/functions)');
}

/** Map an authorization denial reason to the module error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): InteractionsError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new InteractionsError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new InteractionsError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new InteractionsError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new InteractionsError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new InteractionsError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new InteractionsError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new InteractionsError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

/** Map store errors to the public interaction error surface. */
function mapStoreError(error: unknown): never {
  if (error instanceof InteractionsStoreRuleError) {
    switch (error.rule) {
      case 'interaction-input-conflict':
        throw new InteractionsError('INTERACTION_INPUT_CONFLICT', error.message);
      case 'dispatch-claim-conflict':
        throw new InteractionsError('DISPATCH_IN_PROGRESS', error.message);
      case 'dispatch-completion-conflict':
        throw new InteractionsError('DISPATCH_IN_PROGRESS', error.message);
      case 'dispatch-reclaim-conflict':
        throw new InteractionsError('RECOVERY_NOT_AVAILABLE', error.message);
      case 'observation-state-invalid':
        throw new InteractionsError('OBSERVATION_STATE_INVALID', error.message);
      case 'observation-conflict':
        throw new InteractionsError('OBSERVATION_CONFLICT', error.message);
      case 'retry-target-invalid':
        throw new InteractionsError('RETRY_TARGET_INVALID', error.message);
      case 'interaction-record-tampered':
        throw new InteractionsError('INTERACTION_RECORD_TAMPERED', error.message);
    }
  }
  if (error instanceof InteractionsStoreMissingError) {
    if (error.what === 'retry-target') {
      throw new InteractionsError('RETRY_TARGET_INVALID', error.message);
    }
    throw new InteractionsError('INTERACTION_NOT_FOUND', error.message);
  }
  throw error;
}

/** The policy action the interaction authority gates intent creation with (reserved). */
const INTENT_POLICY_ACTION = 'interaction.create';

/**
 * Namespaced idempotency key for the policy decision a gated intent
 * consults: keeps the /policies decision namespace collision-free across
 * consuming authorities (the /workflow namespacing discipline).
 */
function policyIdempotencyKey(intentKey: string | null): string | undefined {
  return intentKey === null ? undefined : `interaction.intent:${intentKey}`;
}

/** Is this error a sink resolution failure (a composition gap, not a provider outcome)? */
function isAdapterUnavailable(error: unknown): boolean {
  return (
    error instanceof IntegrationsError &&
    (error.code === 'ADAPTER_NOT_REGISTERED' || error.code === 'INVALID_CAPABILITY')
  );
}

export function createInteractionsModule(options: InteractionsModuleOptions): InteractionsModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new InteractionsError('INVALID_INPUT', 'createInteractionsModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlInteractionsStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const policies = options.policies;
  const sink = options.sink;
  const now = options.now ?? (() => new Date());

  /** Authorization BEFORE any domain data access (single chain). */
  async function requireTenantAccess(principal: Principal, tenantId: string, action: TenancyAction): Promise<void> {
    validateUuid(tenantId, 'tenantId');
    const decision = await tenancy.authorize(principal.id, { tenantId }, action);
    if (!decision.allowed) {
      throw denyToError(decision.reason, tenantId);
    }
  }

  /**
   * The dispatch core shared by `dispatchInteraction` (claim from
   * `intended`) and `recoverInteraction` (re-claim from `dispatching`):
   * the claim is durable; the adapter is invoked through the
   * provider-neutral sink; the acceptance or the explicit failure is
   * recorded. Adapter-RESOLUTION failures propagate (the claim stands,
   * recoverable); provider failures are recorded outcomes (returned).
   */
  async function invokeAndRecord(
    principal: Principal,
    tenantId: string,
    interaction: InteractionRecord,
  ): Promise<DispatchOutcome> {
    let acceptance: Awaited<ReturnType<ExternalEffectSink['dispatchEffect']>>;
    try {
      acceptance = await sink.dispatchEffect({
        capability: interaction.capability,
        params: interaction.params as Readonly<Record<string, unknown>>,
        identity: { interactionId: interaction.id, tenantId },
      });
    } catch (error) {
      if (isAdapterUnavailable(error)) {
        // A composition gap, not a provider outcome: the claim stands
        // (state `dispatching`) and is recoverable once the adapter is
        // registered. Never fabricated as a provider failure.
        throw new InteractionsError(
          'ADAPTER_UNAVAILABLE',
          `no provider adapter is available for capability class ${interaction.capability}: ${(error as Error).message}`,
        );
      }
      // A provider/dispatch failure: explicit, durable, terminal for this
      // identity — the retry protocol creates a NEW interaction.
      const interaction2 = await store.recordDispatchFailure({
        tenantId,
        interactionId: interaction.id,
        dispatchedBy: principal.id,
        error: String((error as Error).message ?? error).slice(0, 2_000),
        now: now(),
      });
      return { interaction: interaction2, invoked: true, converged: false };
    }
    const interaction3 = await store.completeDispatch({
      tenantId,
      interactionId: interaction.id,
      provider: acceptance.provider,
      providerReference: acceptance.providerReference,
      dispatchedBy: principal.id,
      now: now(),
    });
    return { interaction: interaction3, invoked: true, converged: false };
  }

  return {
    async createInteraction(principal, tenantId, input) {
      await requireTenantAccess(principal, tenantId, 'write');
      if (input.capability === undefined || !isCapabilityClass(input.capability)) {
        throw new InteractionsError('INVALID_INPUT', 'capability must be a frozen provider-neutral capability class');
      }
      const capability = input.capability;
      // Provider-neutral contract validation (fail closed; the /integrations
      // class contract — never a provider SDK surface).
      let params: Readonly<Record<string, unknown>>;
      try {
        params = validateEffectParams(capability, input.params);
      } catch (error) {
        throw new InteractionsError('INVALID_INPUT', (error as Error).message);
      }
      const correlation = validateCorrelation(input.correlation);
      const policyKey = validateOptionalKey(input.policyKey, 'policyKey');
      const idempotencyKey = validateOptionalKey(input.idempotencyKey, 'idempotencyKey');
      const retryOfInteractionId = input.retryOfInteractionId;
      if (retryOfInteractionId !== undefined) {
        validateUuid(retryOfInteractionId, 'retryOfInteractionId');
      }
      const retryOf = retryOfInteractionId ?? null;

      // Durable intent identity (keyed convergence comparisons use this).
      const inputHash = hashInteractionInput({ capability, params, correlation: correlation ?? {}, retryOf, policyKey });

      // Policy gate BEFORE the durable intent row exists
      // (integration-model.md: policy -> durable intent -> adapter). A
      // deny fails closed with NO side effect, NO intent row and NO
      // adapter call; an allow pins the decision provenance into the
      // intent record. The decision is idempotent by the namespaced
      // intent key, so gated retries converge too.
      let policy: PolicyProvenance | null = null;
      if (policyKey !== null) {
        let decision: PolicyDecisionRecord;
        try {
          const outcome = await policies.evaluatePolicy(principal, {
            tenantId,
            policyKey,
            action: INTENT_POLICY_ACTION,
            attributes: { capability },
            idempotencyKey: policyIdempotencyKey(idempotencyKey),
          });
          decision = outcome.decision;
        } catch (error) {
          throw new InteractionsError(
            'POLICY_EVALUATION_FAILED',
            `the policy gate for key "${policyKey}" failed: ${(error as Error).message}`,
          );
        }
        if (decision.outcome !== 'allow') {
          throw new InteractionsError(
            'POLICY_DENIED',
            `the policy gate denied the ${capability} interaction intent (decision ${decision.id}, deciding layer ${decision.decidingLayer})`,
          );
        }
        policy = { policyKey, decisionId: decision.id };
      }

      const payload: CreateInteractionInput = {
        tenantId,
        capability,
        params,
        correlation,
        retryOfInteractionId: retryOf,
        policy,
        requestedBy: principal.id,
        idempotencyKey,
        inputHash,
        now: now(),
      };
      try {
        return await store.createInteraction(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async dispatchInteraction(principal, tenantId, interactionId) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(interactionId, 'interactionId');

      let interaction: InteractionRecord | null;
      try {
        interaction = await store.findInteractionById(tenantId, interactionId);
      } catch (error) {
        return mapStoreError(error);
      }
      if (interaction === null) {
        throw new InteractionsError('INTERACTION_NOT_FOUND', `interaction ${interactionId} does not exist in this tenant`);
      }

      switch (interaction.state) {
        case 'dispatched':
          // A twin already dispatched this interaction: converge on the
          // durable acceptance WITHOUT a second adapter invocation (AC-3).
          return { interaction, invoked: false, converged: true };
        case 'dispatching':
          // Another dispatcher holds the claim (or a crashed one left the
          // window open — the recovery surface owns that case).
          throw new InteractionsError(
            'DISPATCH_IN_PROGRESS',
            `interaction ${interactionId} is claimed for dispatch (since ${interaction.claim?.claimedAt.toISOString()}); concurrent dispatches converge on one adapter invocation, and a crashed claim is recovered through recoverInteraction`,
          );
        case 'observed':
          // Terminal: the retry protocol creates a NEW identity.
          throw new InteractionsError(
            'INTERACTION_OBSERVED',
            `interaction ${interactionId} already carries an observed result (outcome ${interaction.observation?.outcome}); retries create a new interaction identity with retryOf lineage`,
          );
        case 'intended':
          break;
      }

      try {
        await store.claimDispatch({ tenantId, interactionId, claimedBy: principal.id, now: now() });
      } catch (error) {
        // A twin claimed between the read and the claim: converge on the
        // durable state (the WORK-004 post-conflict re-check discipline).
        if (
          error instanceof InteractionsStoreRuleError &&
          (error.rule === 'dispatch-claim-conflict' || error.rule === 'dispatch-completion-conflict')
        ) {
          const raced = await store.findInteractionById(tenantId, interactionId);
          if (raced !== null) {
            if (raced.state === 'dispatched') {
              return { interaction: raced, invoked: false, converged: true };
            }
            if (raced.state === 'dispatching') {
              throw new InteractionsError('DISPATCH_IN_PROGRESS', error.message);
            }
            if (raced.state === 'observed' && raced.observation?.failureStage === 'dispatch') {
              // The twin's dispatch already failed: that outcome is the
              // durable record for this identity — surface it explicitly.
              return { interaction: raced, invoked: false, converged: true };
            }
          }
        }
        return mapStoreError(error);
      }

      const claimed: InteractionRecord = {
        ...interaction,
        state: 'dispatching',
        claim: { claimedBy: principal.id, claimedAt: now() },
      };
      try {
        return await invokeAndRecord(principal, tenantId, claimed);
      } catch (error) {
        if (error instanceof InteractionsError && error.code === 'ADAPTER_UNAVAILABLE') {
          throw error;
        }
        return mapStoreError(error);
      }
    },

    async recoverInteraction(principal, tenantId, interactionId) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(interactionId, 'interactionId');

      let interaction: InteractionRecord | null;
      try {
        interaction = await store.findInteractionById(tenantId, interactionId);
      } catch (error) {
        return mapStoreError(error);
      }
      if (interaction === null) {
        throw new InteractionsError('INTERACTION_NOT_FOUND', `interaction ${interactionId} does not exist in this tenant`);
      }
      if (interaction.state !== 'dispatching') {
        throw new InteractionsError(
          'RECOVERY_NOT_AVAILABLE',
          `interaction ${interactionId} is in state "${interaction.state}"; recovery applies to claimed-but-unsettled dispatches only (intended interactions dispatch directly; observed interactions are retried through a new identity)`,
        );
      }

      // Re-claim (the stale claim is refreshed; the adapter converges by
      // durable identity, so a re-dispatch cannot duplicate the effect).
      const reclaimed: InteractionRecord = {
        ...interaction,
        claim: { claimedBy: principal.id, claimedAt: now() },
      };
      try {
        await store.reclaimDispatch({ tenantId, interactionId, reclaimedBy: principal.id, now: now() });
      } catch (error) {
        return mapStoreError(error);
      }
      try {
        const outcome = await invokeAndRecord(principal, tenantId, reclaimed);
        // A concurrent recovery may have completed first: converge on the
        // durable record rather than surfacing a completion conflict.
        return outcome;
      } catch (error) {
        if (error instanceof InteractionsError && error.code === 'ADAPTER_UNAVAILABLE') {
          throw error;
        }
        if (
          error instanceof InteractionsStoreRuleError &&
          error.rule === 'dispatch-completion-conflict'
        ) {
          const settled = await store.findInteractionById(tenantId, interactionId);
          if (settled !== null && (settled.state === 'dispatched' || settled.state === 'observed')) {
            return { interaction: settled, invoked: false, converged: true };
          }
        }
        return mapStoreError(error);
      }
    },

    async recordObservedResult(principal, tenantId, interactionId, input) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(interactionId, 'interactionId');
      if (input.outcome !== 'succeeded' && input.outcome !== 'failed') {
        throw new InteractionsError('INVALID_INPUT', 'outcome must be "succeeded" or "failed"');
      }
      const observation = input.providerObservation ?? {};
      try {
        validateObservation(observation);
      } catch (error) {
        throw new InteractionsError('INVALID_INPUT', (error as Error).message);
      }
      try {
        return await store.recordObservation({
          tenantId,
          interactionId,
          outcome: input.outcome,
          providerObservation: observation,
          observedBy: principal.id,
          now: now(),
        });
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async getInteraction(principal, tenantId, interactionId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(interactionId, 'interactionId');
      try {
        const interaction = await store.findInteractionById(tenantId, interactionId);
        if (interaction === null) {
          throw new InteractionsError('INTERACTION_NOT_FOUND', `interaction ${interactionId} does not exist in this tenant`);
        }
        return interaction;
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listInteractions(principal, tenantId, filter) {
      await requireTenantAccess(principal, tenantId, 'read');
      if (filter !== undefined) {
        if (filter.state !== undefined && !['intended', 'dispatching', 'dispatched', 'observed'].includes(filter.state)) {
          throw new InteractionsError('INVALID_INPUT', 'filter.state is outside the interaction lifecycle');
        }
        if (filter.capability !== undefined && !isCapabilityClass(filter.capability)) {
          throw new InteractionsError('INVALID_INPUT', 'filter.capability is outside the frozen taxonomy');
        }
        if (filter.outcome !== undefined && !['succeeded', 'failed'].includes(filter.outcome)) {
          throw new InteractionsError('INVALID_INPUT', 'filter.outcome must be "succeeded" or "failed"');
        }
        if (filter.retryOfInteractionId !== undefined) {
          validateUuid(filter.retryOfInteractionId, 'filter.retryOfInteractionId');
        }
        if (filter.correlation !== undefined) {
          if (!CORRELATION_KEY_PATTERN.test(filter.correlation.key)) {
            throw new InteractionsError('INVALID_INPUT', 'filter.correlation.key must match [A-Za-z0-9_.-]{1,64}');
          }
        }
      }
      try {
        return await store.listInteractions(tenantId, filter);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listRecoverableDispatches(principal, tenantId) {
      await requireTenantAccess(principal, tenantId, 'read');
      try {
        return await store.listRecoverableDispatches(tenantId);
      } catch (error) {
        return mapStoreError(error);
      }
    },
  };
}

/**
 * Module manifest (registered in the composition root's module registry).
 * The manifest declares identity only; the contract above is the module's
 * public surface.
 */
export default defineModule({
  name: 'interactions',
  version: '1.0.0',
  description: 'external communications and provider-neutral interaction ledger',
});
