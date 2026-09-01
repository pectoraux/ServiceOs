/**
 * ServiceOS module: /workflow (WORK-004 implementation).
 *
 * The ONE deterministic Service Work business workflow authority
 * (architecture.md §6, §7, §9; architecture-lock #1: `/work` + `/workflow`
 * are the sole ServiceOS authority for Service Work identity and
 * business-work state transitions).
 *
 * Authority (authority matrix / Work Order frozen scope):
 * - SERVICE WORK STATE TRANSITIONS are owned here: `submitTransition` is the
 *   only surface that can move a Service Work's business state. It is
 *   validated by the frozen canonical transition table (architecture.md §7)
 *   encoded as CODE in `transitions.ts` — never data, never configuration,
 *   never vertical-specific (forbidden zone). Every applied transition
 *   persists an append-only, attributable, tamper-evident audit record
 *   atomically with the status write (transition persistence/audit
 *   integration). A module other than /workflow exporting transition-engine
 *   entry points, or any code path other than the workflow store writing
 *   `work_service_works.status`, is an architecture violation (checked
 *   structurally).
 * - ZECK RESULTS ARE INPUTS ONLY (AC-3; work-execution-model.md): this
 *   module never imports or consults Zeck/execution state; a foreign
 *   execution outcome NEVER directly mutates Service Work state. Business
 *   meaning is decided by an explicit transition submission through this
 *   authority ("a failed Zeck execution is an execution failure input, not
 *   automatically a business failure").
 * - POLICY GATES ARE CONSUMED, NEVER REIMPLEMENTED (authority matrix:
 *   "workflow/vertical duplicate policy engine" is the forbidden pattern):
 *   transition preconditions may be gated by a business policy evaluated
 *   through the /policies PUBLIC contract (`evaluatePolicy`); a deny
 *   decision fails the submission closed. This module holds no policy logic
 *   of its own.
 * - TRANSITION PRECONDITIONS (scope surface): the dependency gate
 *   (draft -> ready requires every dependency work terminal-completed) is
 *   evaluated authoritatively in the store transaction, under the same
 *   per-tenant dependency advisory lock /work serializes on; the policy gate
 *   runs before the store call and pins its decision provenance into the
 *   transition record. Attempt-outcome and evidence-based preconditions
 *   belong to later authorities (/zeck WORK-005, /evidence WORK-007) and are
 *   deliberately NOT evaluated here.
 * - TRANSITION IDENTITY IS IDEMPOTENT (AC-4): a keyed submission converges
 *   on the durable transition (input-matched); a divergent re-submission of
 *   the same key fails closed; a retry re-observes the original transition
 *   even after the work has progressed further.
 * - SLA / CONTINUATION ORCHESTRATION HOOKS (scope surface): read-side,
 *   deterministic hook surfaces only — `listContinuations` (the admissible
 *   continuations of the current state, consumed by future explicit
 *   continuation scheduling), `setSlaDeadline`/`listSlaDeadlines`/
 *   `listSlaBreaches` (deadline hook data + deterministic breach
 *   evaluation). No scheduler, timer or external call exists here; the
 *   EXPIRED enforcement transition still flows through the single
 *   transition authority (forbidden zone: direct external provider calls).
 * - AUTHORIZATION REMAINS SEPARATE: this module consumes the single
 *   authorization chain from /organizations exactly like /work and
 *   /policies; it never exports or reimplements authorization
 *   (forbidden zone: authorization replacement).
 */
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import { defineModule } from '../../platform/module-registry/index.js';
import type { Principal } from '../auth/index.js';
import type { PolicyDecisionRecord } from '../policies/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import { createSqlWorkflowStore } from './sql-store.js';
import { hashTransitionInput } from './provenance.js';
import {
  isLegalTransition,
  isTerminal,
  isWorkflowState,
  listLegalTransitions,
  transitionRuleId,
  type Continuation,
} from './transitions.js';
import type { WorkStatus } from '../work/index.js';
import {
  WorkflowStoreMissingError,
  WorkflowStoreRuleError,
  type ApplyTransitionInput,
  type SlaBreach,
  type SlaDeadlineRecord,
  type SetSlaDeadlineInput,
  type TransitionPolicyProvenance,
  type TransitionPreconditions,
  type TransitionRecord,
  type WorkSnapshot,
  type WorkflowStore,
  type WorkflowStoreRule,
} from './store.js';

// Store port (public contract): the authoritative SQL implementation runs
// through the persistence boundary; tests inject faithful in-memory
// implementations of the same port through this surface.
export { WorkflowStoreMissingError, WorkflowStoreRuleError, createSqlWorkflowStore };
export type {
  ApplyTransitionInput,
  SlaBreach,
  SlaDeadlineRecord,
  SetSlaDeadlineInput,
  TransitionPolicyProvenance,
  TransitionPreconditions,
  TransitionRecord,
  WorkSnapshot,
  WorkflowStore,
  WorkflowStoreRule,
};

// The frozen canonical transition table is /workflow-internal code exported
// through the module's public interface (the machine is part of the
// authority's public contract; the boundary checks forbid any other module
// from exporting transition-engine entry points).
export {
  CANONICAL_TRANSITIONS,
  RESUMABLE_STATES,
  TERMINAL_STATES,
  WORKFLOW_STATES,
  isLegalTransition,
  isTerminal,
  isWorkflowState,
  listLegalTransitions,
  transitionRuleId,
} from './transitions.js';
export type { Continuation } from './transitions.js';
// The Service Work state values (the transition boundary's value space) are
// /work's record contract, re-exported here for consumers of the workflow
// authority through the /work public interface.
export type { WorkStatus } from '../work/index.js';

// Deterministic provenance hashing (part of the transition-ledger contract).
export { canonicalJson, hashTransitionInput, hashTransitionRecord } from './provenance.js';
export type { TransitionSubmissionCore, TransitionRecordCore } from './provenance.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The tenancy authorization decision entry point consumed from
 * /organizations' public interface (injected by the composition root so the
 * authorization chain stays singular — never re-implemented here).
 */
export interface TenancyAuthorization {
  authorize(
    principalId: string,
    scope: { organizationId: string } | { tenantId: string },
    action: TenancyAction,
  ): Promise<AuthorizationDecision>;
}

/**
 * The policy-gate hook consumed from /policies' public interface (structural
 * subset of the policies module: `evaluatePolicy`). Injected by the
 * composition root; the workflow authority never reimplements policy logic.
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

export type WorkflowErrorCode =
  | 'INVALID_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  | 'WORK_NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'TRANSITION_CONFLICT'
  | 'TRANSITION_INPUT_CONFLICT'
  | 'PRECONDITION_DEPENDENCIES'
  | 'POLICY_DENIED'
  | 'POLICY_EVALUATION_FAILED'
  | 'TRANSITION_NOT_FOUND'
  | 'TRANSITION_RECORD_TAMPERED'
  | 'SLA_DEADLINE_CONFLICT';

export class WorkflowError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'WorkflowError';
  }
}

export interface WorkflowModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: WorkflowStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** The policy gate, consumed from /policies' public interface. */
  policies: PolicyGate;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface WorkflowModule {
  /**
   * THE transition surface (AC-1/AC-2/AC-3/AC-4/AC-5). Submit an authorized
   * business transition for one Service Work. The current state is read
   * through the work snapshot, validated against the frozen canonical
   * table, gated by the optional policy decision (deny fails closed), then
   * applied atomically: work-row lock, expected-state re-validation,
   * in-transaction dependency gate, append-only audit record, status write.
   * Idempotent by transition identity.
   */
  submitTransition(
    principal: Principal,
    tenantId: string,
    workId: string,
    input: {
      to: WorkStatus;
      policyKey?: string;
      idempotencyKey?: string;
      reason?: string;
    },
  ): Promise<{ transition: TransitionRecord; converged: boolean }>;
  /** Read one transition record (tamper-evident: hash verified on read). */
  getTransition(principal: Principal, tenantId: string, transitionId: string): Promise<TransitionRecord>;
  /** The append-only transition ledger for one work (audit surface). */
  listTransitions(principal: Principal, tenantId: string, workId: string): Promise<TransitionRecord[]>;
  /**
   * Continuation hook: the admissible continuations of the work's current
   * state, deterministically derived from the canonical table. Future
   * explicit continuation scheduling consumes this and still submits
   * through `submitTransition`.
   */
  listContinuations(principal: Principal, tenantId: string, workId: string): Promise<{
    workId: string;
    from: WorkStatus;
    continuations: readonly Continuation[];
  }>;
  /**
   * SLA hook: upsert the deadline for (work, state). Keyed creations
   * converge; same-key divergent input fails closed. Hook data only —
   * this never mutates work state.
   */
  setSlaDeadline(
    principal: Principal,
    tenantId: string,
    workId: string,
    input: { state: WorkStatus; deadlineAt: Date; idempotencyKey?: string },
  ): Promise<{ deadline: SlaDeadlineRecord; converged: boolean }>;
  /** SLA hook: deadlines recorded for one work. */
  listSlaDeadlines(principal: Principal, tenantId: string, workId: string): Promise<SlaDeadlineRecord[]>;
  /**
   * SLA hook: deterministic breach evaluation — works whose current
   * (non-terminal) state deadline has passed. The EXPIRED enforcement
   * transition is submitted explicitly through `submitTransition`.
   */
  listSlaBreaches(principal: Principal, tenantId: string): Promise<SlaBreach[]>;
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new WorkflowError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

function validateOptionalKey(value: string | undefined, what: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new WorkflowError('INVALID_INPUT', `${what} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

function validateOptionalReason(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 10000) {
    throw new WorkflowError('INVALID_INPUT', 'reason must be a string of at most 10000 characters');
  }
  return value.trim() === '' ? null : value.trim();
}

/** The policy action the workflow authority gates transitions with (reserved). */
const TRANSITION_POLICY_ACTION = 'workflow.transition';

/**
 * Namespaced idempotency key for the policy decision a gated transition
 * consults: keeps the /policies decision namespace collision-free across
 * consuming authorities.
 */
function policyIdempotencyKey(transitionKey: string | null): string | undefined {
  return transitionKey === null ? undefined : `workflow.transition:${transitionKey}`;
}

/** Map an authorization denial reason to the workflow error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): WorkflowError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new WorkflowError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new WorkflowError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new WorkflowError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new WorkflowError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new WorkflowError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new WorkflowError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new WorkflowError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

/** Map store errors to the public workflow error surface. */
function mapStoreError(error: unknown): never {
  if (error instanceof WorkflowStoreRuleError) {
    switch (error.rule) {
      case 'transition-conflict':
        throw new WorkflowError('TRANSITION_CONFLICT', error.message);
      case 'transition-input-conflict':
        throw new WorkflowError('TRANSITION_INPUT_CONFLICT', error.message);
      case 'precondition-dependencies':
        throw new WorkflowError('PRECONDITION_DEPENDENCIES', error.message);
      case 'transition-record-tampered':
        throw new WorkflowError('TRANSITION_RECORD_TAMPERED', error.message);
      case 'sla-deadline-conflict':
        throw new WorkflowError('SLA_DEADLINE_CONFLICT', error.message);
    }
  }
  if (error instanceof WorkflowStoreMissingError) {
    if (error.what === 'transition') {
      throw new WorkflowError('TRANSITION_NOT_FOUND', error.message);
    }
    throw new WorkflowError('WORK_NOT_FOUND', error.message);
  }
  throw error;
}

export function createWorkflowModule(options: WorkflowModuleOptions): WorkflowModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new WorkflowError('INVALID_INPUT', 'createWorkflowModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlWorkflowStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const policies = options.policies;
  const now = options.now ?? (() => new Date());

  /** Authorization BEFORE any domain data access (single chain). */
  async function requireTenantAccess(principal: Principal, tenantId: string, action: TenancyAction): Promise<void> {
    validateUuid(tenantId, 'tenantId');
    const decision = await tenancy.authorize(principal.id, { tenantId }, action);
    if (!decision.allowed) {
      throw denyToError(decision.reason, tenantId);
    }
  }

  return {
    async submitTransition(principal, tenantId, workId, input) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(workId, 'workId');
      if (typeof input.to !== 'string' || !isWorkflowState(input.to)) {
        throw new WorkflowError('INVALID_INPUT', 'to must be a canonical workflow state');
      }
      const to = input.to;
      const policyKey = validateOptionalKey(input.policyKey, 'policyKey');
      const idempotencyKey = validateOptionalKey(input.idempotencyKey, 'idempotencyKey');
      const reason = validateOptionalReason(input.reason);

      // Durable submission identity (convergence comparisons use this).
      const inputHash = hashTransitionInput({ workId, to, policyKey });

      // Keyed fast-path convergence: a retry re-observes the durable
      // transition BEFORE the current-state derivation — the work may have
      // progressed further, and the recorded transition is the authority.
      if (idempotencyKey !== null) {
        const existing = await store.findTransitionByIdempotencyKey(tenantId, idempotencyKey);
        if (existing !== null) {
          if (existing.inputHash !== inputHash) {
            throw new WorkflowError(
              'TRANSITION_INPUT_CONFLICT',
              `idempotency key "${idempotencyKey}" was already used for a different transition input`,
            );
          }
          return { transition: existing, converged: true };
        }
      }

      // Current-state derivation: the transition authority decides from the
      // work's durable status (never from a caller-supplied from-state).
      const snapshot: WorkSnapshot | null = await store.getWorkSnapshot(tenantId, workId);
      if (snapshot === null) {
        throw new WorkflowError('WORK_NOT_FOUND', `work ${workId} does not exist in this tenant`);
      }
      const from = snapshot.status;
      if (!isLegalTransition(from, to)) {
        throw new WorkflowError(
          'ILLEGAL_TRANSITION',
          `transition ${from} -> ${to} is not legal in the canonical Service Work workflow${
            isTerminal(from) ? ` (${from} is terminal: no outgoing transitions exist)` : ''
          }`,
        );
      }

      // Policy gate (consumed through /policies' public contract; deny fails
      // closed and never reaches the store). The decision is idempotent by
      // the namespaced transition key, so gated retries converge too.
      let policyProvenance: TransitionPolicyProvenance | null = null;
      if (policyKey !== null) {
        let decision: PolicyDecisionRecord;
        try {
          const outcome = await policies.evaluatePolicy(principal, {
            tenantId,
            policyKey,
            action: TRANSITION_POLICY_ACTION,
            attributes: { workType: snapshot.workType, from, to },
            idempotencyKey: policyIdempotencyKey(idempotencyKey),
          });
          decision = outcome.decision;
        } catch (error) {
          throw new WorkflowError(
            'POLICY_EVALUATION_FAILED',
            `the policy gate for key "${policyKey}" failed: ${(error as Error).message}`,
          );
        }
        if (decision.outcome !== 'allow') {
          throw new WorkflowError(
            'POLICY_DENIED',
            `the policy gate denied transition ${from} -> ${to} (decision ${decision.id}, deciding layer ${decision.decidingLayer})`,
          );
        }
        policyProvenance = { policyKey, decisionId: decision.id };
      }

      // Dependency gate scope: the readiness precondition of draft -> ready.
      const dependencyGateRequired = from === 'draft' && to === 'ready';

      const payload: ApplyTransitionInput = {
        tenantId,
        workId,
        expectedFrom: from,
        to,
        ruleId: transitionRuleId(from, to),
        dependencyGateRequired,
        policy: policyProvenance,
        reason,
        transitionedBy: principal.id,
        idempotencyKey,
        inputHash,
        now: now(),
      };
      try {
        return await store.applyTransition(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async getTransition(principal, tenantId, transitionId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(transitionId, 'transitionId');
      try {
        const transition = await store.findTransitionById(tenantId, transitionId);
        if (transition === null) {
          throw new WorkflowError('TRANSITION_NOT_FOUND', `transition ${transitionId} does not exist in this tenant`);
        }
        return transition;
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listTransitions(principal, tenantId, workId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(workId, 'workId');
      try {
        return await store.listTransitions(tenantId, workId);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listContinuations(principal, tenantId, workId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(workId, 'workId');
      const snapshot = await store.getWorkSnapshot(tenantId, workId);
      if (snapshot === null) {
        throw new WorkflowError('WORK_NOT_FOUND', `work ${workId} does not exist in this tenant`);
      }
      return { workId, from: snapshot.status, continuations: listLegalTransitions(snapshot.status) };
    },

    async setSlaDeadline(principal, tenantId, workId, input) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(workId, 'workId');
      if (typeof input.state !== 'string' || !isWorkflowState(input.state)) {
        throw new WorkflowError('INVALID_INPUT', 'state must be a canonical workflow state');
      }
      if (isTerminal(input.state)) {
        throw new WorkflowError(
          'INVALID_INPUT',
          `state "${input.state}" is terminal; SLA deadlines apply to non-terminal states only`,
        );
      }
      if (!(input.deadlineAt instanceof Date) || !Number.isFinite(input.deadlineAt.getTime())) {
        throw new WorkflowError('INVALID_INPUT', 'deadlineAt must be a finite Date');
      }
      const idempotencyKey = validateOptionalKey(input.idempotencyKey, 'idempotencyKey');
      try {
        return await store.setSlaDeadline({
          tenantId,
          workId,
          state: input.state,
          deadlineAt: input.deadlineAt,
          setBy: principal.id,
          idempotencyKey,
          now: now(),
        });
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listSlaDeadlines(principal, tenantId, workId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(workId, 'workId');
      return store.listSlaDeadlines(tenantId, workId);
    },

    async listSlaBreaches(principal, tenantId) {
      await requireTenantAccess(principal, tenantId, 'read');
      return store.listSlaBreaches(tenantId, now());
    },
  };
}

/**
 * Module manifest (registered in the composition root's module registry).
 * The manifest declares identity only; the business contract above is the
 * module's public surface.
 */
export default defineModule({
  name: 'workflow',
  version: '1.0.0',
  description: 'deterministic business workflow state machine and transitions',
});
