/**
 * ServiceOS /workflow store port (WORK-004).
 *
 * The persistence contract for the append-only Service Work transition
 * ledger and the SLA orchestration-hook deadline records. The authoritative
 * implementation is the SQL store executed through the persistence
 * boundary's `TransactionalExecutor` (client-pinned transactions); tests
 * inject a faithful in-memory implementation of this same port.
 *
 * Store contract semantics (mirrored by every implementation):
 *
 * - THE TRANSITION BOUNDARY IS THIS PORT'S MUTATION SURFACE. `applyTransition`
 *   is the ONLY operation in ServiceOS that writes `work_service_works.status`
 *   (the /workflow authority per the authority matrix; /work persists the
 *   record as created ('draft') and never transitions it — enforced
 *   structurally by the workflow boundary checks). The status write happens
 *   inside the SAME serialized transaction as the ledger insert, holding the
 *   work-row lock: a transition and its audit record commit atomically or
 *   not at all.
 *
 * - MANDATORY TENANT PREDICATES. Every lookup and list carries the tenant
 *   parameter in its signature and its query; a row in another tenant is
 *   indistinguishable from a missing row (lock #15/#16).
 *
 * - TRANSITION IDENTITY IS IDEMPOTENT (AC-4). `applyTransition` converges on
 *   the durable transition identified by (tenant, idempotency key) when the
 *   submission input matches the recorded input hash; a divergent
 *   re-submission of the same key fails closed (`transition-input-conflict`).
 *   A keyed retry therefore re-observes the original transition even after
 *   the work has progressed further.
 *
 * - ILLEGAL CONCURRENT MOVEMENT FAILS DETERMINISTICALLY (AC-2 +
 *   concurrency proof). The work row is locked (`SELECT … FOR UPDATE` /
 *   synchronous critical section) before the current status is compared with
 *   the module's expected `from`: when a competing transition committed
 *   first, the loser fails closed with `transition-conflict` — concurrent
 *   transitions from the same state converge (keyed) or one fails
 *   deterministically (unkeyed).
 *
 * - TRANSITION PRECONDITIONS ARE EVALUATED AUTHORITATIVELY IN TRANSACTION.
 *   The dependency gate for `draft -> ready` runs under the work-row lock
 *   AND the same per-tenant dependency advisory lock /work's
 *   `addDependency` serializes on, so racing dependency mutations and gate
 *   evaluations cannot interleave; an unmet dependency fails closed
 *   (`precondition-dependencies`). The policy gate is evaluated module-side
 *   through the /policies public contract (deny never reaches this port);
 *   only its decision provenance is persisted here.
 *
 * - THE LEDGER IS APPEND-ONLY AND TAMPER-EVIDENT (AC-5). Transition rows are
 *   never updated or deleted. Every read recomputes the persisted input hash
 *   and record integrity hash from the stored fields and fails closed with
 *   `transition-record-tampered` on divergence — after-the-fact mutation of
 *   a recorded transition is detected on read.
 *
 * - SLA DEADLINE HOOK DATA IS UPSERT SEMANTICS, NEVER A STATE MACHINE. One
 *   deadline per (work, state); re-setting a deadline is the deliberate
 *   extension path for orchestration. Keyed creations converge;
 *   same-key divergent inputs fail closed (`sla-deadline-conflict`). No
 *   operation here mutates work state: breach evaluation (`listSlaBreaches`)
 *   is a deterministic read; enforcement still flows through
 *   `applyTransition`.
 */
import type { WorkStatus } from '../work/index.js';

/** Atomic store-level rule violation (mirrors a guarded SQL transaction). */
export type WorkflowStoreRule =
  | 'transition-conflict'
  | 'transition-input-conflict'
  | 'precondition-dependencies'
  | 'transition-record-tampered'
  | 'sla-deadline-conflict';

export class WorkflowStoreRuleError extends Error {
  constructor(message: string, readonly rule: WorkflowStoreRule) {
    super(message);
    this.name = 'WorkflowStoreRuleError';
  }
}

/** Single-row target absent (scoped by the tenant predicate). */
export class WorkflowStoreMissingError extends Error {
  constructor(message: string, readonly what: 'work' | 'transition') {
    super(message);
    this.name = 'WorkflowStoreMissingError';
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Policy-gate provenance pinned into the durable transition record. */
export interface TransitionPolicyProvenance {
  /** The /policies policy key the gate consulted (public contract input). */
  readonly policyKey: string;
  /** The durable, revision-bound policy decision record that allowed it. */
  readonly decisionId: string;
}

/** Preconditions evaluated for one transition, pinned at decision time. */
export interface TransitionPreconditions {
  /** Dependency gate (the draft -> ready readiness precondition). */
  readonly dependencies: {
    /** Was the gate evaluated for this transition? */
    readonly evaluated: boolean;
    /** Were all dependency works terminal-completed at decision time? */
    readonly satisfied: boolean;
  };
  /** Policy gate provenance, or null when no policy key gated the transition. */
  readonly policy: TransitionPolicyProvenance | null;
}

/**
 * One applied Service Work transition: the durable, attributable,
 * append-only audit record (AC-5). `fromState` is the status observed under
 * the work-row lock when the transition applied. `seq` is the strict
 * per-work ledger sequence (allocated under the same lock) — the ledger's
 * order is total per work even when timestamps collide.
 */
export interface TransitionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly workId: string;
  /** Strict per-work ledger sequence (1, 2, 3 …). */
  readonly seq: number;
  readonly fromState: WorkStatus;
  readonly toState: WorkStatus;
  readonly ruleId: string;
  readonly preconditions: TransitionPreconditions;
  /** Opaque business reason supplied by the submitting actor. */
  readonly reason: string | null;
  readonly transitionedBy: string;
  readonly idempotencyKey: string | null;
  /** Deterministic submission identity: sha256 over { workId, to, policyKey }. */
  readonly inputHash: string;
  /** Integrity hash over the canonical record core (tamper-evident reads). */
  readonly recordHash: string;
  readonly createdAt: Date;
}

/** SLA orchestration-hook deadline record (never a workflow mutation). */
export interface SlaDeadlineRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly workId: string;
  readonly state: WorkStatus;
  readonly deadlineAt: Date;
  readonly setBy: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One SLA breach: a work whose current-state deadline has passed. */
export interface SlaBreach {
  readonly workId: string;
  readonly workType: string;
  readonly state: WorkStatus;
  readonly deadlineAt: Date;
}

/** The work facts the transition authority derives decisions from. */
export interface WorkSnapshot {
  readonly workId: string;
  readonly workType: string;
  readonly status: WorkStatus;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ApplyTransitionInput {
  readonly tenantId: string;
  readonly workId: string;
  /** The current status the module observed (re-validated under the lock). */
  readonly expectedFrom: WorkStatus;
  readonly to: WorkStatus;
  /** The canonical rule id (deterministically derived; never caller-supplied). */
  readonly ruleId: string;
  /** True iff the dependency gate must be evaluated (draft -> ready). */
  readonly dependencyGateRequired: boolean;
  /** Policy-gate provenance (an allow decision), or null when ungated. */
  readonly policy: TransitionPolicyProvenance | null;
  readonly reason: string | null;
  readonly transitionedBy: string;
  /** Durable transition identity; null creates an unkeyed distinct transition. */
  readonly idempotencyKey: string | null;
  /** sha256 over the canonical submission core { workId, to, policyKey }. */
  readonly inputHash: string;
  /** Single clock read pinned into the record hash and the persisted row. */
  readonly now: Date;
}

export interface SetSlaDeadlineInput {
  readonly tenantId: string;
  readonly workId: string;
  readonly state: WorkStatus;
  readonly deadlineAt: Date;
  readonly setBy: string;
  readonly idempotencyKey: string | null;
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export interface WorkflowStore {
  /**
   * Atomically apply a validated transition: converge on the durable
   * transition for the same idempotency key (input-matched), lock the work
   * row, re-validate the expected current status, evaluate the dependency
   * gate in-transaction, insert the append-only transition record, and
   * update the work's status — one serialized unit.
   */
  applyTransition(input: ApplyTransitionInput): Promise<{ transition: TransitionRecord; converged: boolean }>;
  /** Tenant-predicated lookup; null when absent in this tenant. */
  findTransitionById(tenantId: string, transitionId: string): Promise<TransitionRecord | null>;
  /** Tenant-predicated idempotency-identity lookup. */
  findTransitionByIdempotencyKey(tenantId: string, key: string): Promise<TransitionRecord | null>;
  /** The transition ledger for one work (append-only, time-ordered). */
  listTransitions(tenantId: string, workId: string): Promise<TransitionRecord[]>;
  /** Work facts (status/work type) through the tenant predicate. */
  getWorkSnapshot(tenantId: string, workId: string): Promise<WorkSnapshot | null>;
  /**
   * Upsert the SLA deadline for (work, state). Keyed creations converge on
   * the existing logical creation; same-key divergent input fails closed.
   * Never mutates work state.
   */
  setSlaDeadline(input: SetSlaDeadlineInput): Promise<{ deadline: SlaDeadlineRecord; converged: boolean }>;
  /** Deadline for one (work, state), through the tenant predicate. */
  findSlaDeadline(tenantId: string, workId: string, state: WorkStatus): Promise<SlaDeadlineRecord | null>;
  /** Deadlines recorded for one work. */
  listSlaDeadlines(tenantId: string, workId: string): Promise<SlaDeadlineRecord[]>;
  /**
   * Deterministic breach evaluation: works whose CURRENT (necessarily
   * non-terminal) state has a deadline in the past. A read-only hook; the
   * EXPIRED enforcement transition still flows through applyTransition.
   */
  listSlaBreaches(tenantId: string, now: Date): Promise<SlaBreach[]>;
}
