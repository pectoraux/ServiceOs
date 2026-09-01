/**
 * ServiceOS /work store port (WORK-003).
 *
 * The persistence contract for ServiceWork, WorkAttempt and WorkDependency
 * records plus the durable idempotency primitives they rely on. The
 * authoritative implementation is the SQL store executed through the
 * persistence boundary's `TransactionalExecutor` (client-pinned
 * transactions); tests inject a faithful in-memory implementation of this
 * same port.
 *
 * Store contract semantics (mirrored by every implementation):
 *
 * - TENANT PREDICATES ARE MANDATORY. Every lookup and list carries the
 *   tenant parameter in its signature and its query; a row in another
 *   tenant is indistinguishable from a missing row (lock #15/#16; a
 *   missing read stays distinguishable from an empty result, lock #30).
 *
 * - CONVERGENCE, NOT DUPLICATION. `createWork` and `createAttempt` are
 *   idempotent by durable identity: the same logical creation (tenant +
 *   idempotency key) converges on ONE durable row — concurrent creators
 *   receive the same identity and `converged: true`. Two actors creating
 *   the same logical work must converge (Work Order concurrency proof).
 *
 * - RETRY PROTOCOL (architecture.md §8, work-execution-model.md): a retry
 *   creates a DISTINCT attempt identity once the original has been
 *   dispatched; while the live attempt for the key is still pre-dispatch,
 *   the original durable identity is safely re-observed (convergence
 *   window). Creating a new attempt ATOMICALLY supersedes the current one
 *   and moves the work's current-attempt pointer forward — never backward.
 *   At most one live (non-superseded) attempt exists per work, and at most
 *   one live attempt per (work, idempotency key).
 *
 * - SUPERSEDED-ATTEMPT PROTECTION (AC-5): `dispatchAttempt` and
 *   `recordAttemptResult` throw `WorkStoreRuleError` with rule
 *   `attempt-superseded` for a superseded attempt. A late prior attempt
 *   can never mutate current-work state.
 *
 * - DEPENDENCIES (AC-3): `addDependency` is atomic: same-tenant existence,
 *   duplicate-edge convergence, and cycle safety are evaluated inside one
 *   serialized unit, so two racing edges can never close a phantom cycle.
 *   Duplicate edge adds converge on the existing record; self-dependency
 *   and cycles fail closed with typed rule errors.
 *
 * - `recordAttemptResult` is idempotent for identical outcomes and fails
 *   with `attempt-result-conflict` for a divergent second result, so a
 *   duplicated result delivery cannot double-mutate the attempt record.
 *
 * - Inserts surface schema unique-constraint violations as
 *   `StoreConflictError` with the constraint name (the shared store-contract
 *   error from /auth's public surface).
 */
import { StoreConflictError } from '../auth/index.js';

/** Atomic store-level rule violation (mirrors a guarded SQL transaction). */
export type WorkStoreRule =
  | 'dependency-cycle'
  | 'self-dependency'
  | 'attempt-superseded'
  | 'attempt-result-conflict';

export class WorkStoreRuleError extends Error {
  constructor(message: string, readonly rule: WorkStoreRule) {
    super(message);
    this.name = 'WorkStoreRuleError';
  }
}

/** Single-row mutation target absent (scoped by the tenant predicate). */
export class WorkStoreMissingError extends Error {
  constructor(message: string, readonly what: 'work' | 'attempt') {
    super(message);
    this.name = 'WorkStoreMissingError';
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Service Work state record. /work persists identity; the only value it
 * ever WRITES is the initial `draft`. Business state transitions belong to
 * the /workflow authority (WORK-004) — the enumeration below is the canonical
 * machine from architecture.md §7, extended by WORK-004's migration through
 * its own authority; the structural boundary checks enforce that /work never
 * mutates the column and no module other than /workflow ever does.
 */
export type WorkStatus =
  | 'draft'
  | 'ready'
  | 'accepted'
  | 'in_progress'
  | 'waiting_information'
  | 'waiting_approval'
  | 'blocked'
  | 'verifying'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'expired';

/** Attempt bookkeeping record (protocol states, not business transitions). */
export type AttemptStatus = 'pending' | 'dispatched' | 'completed' | 'failed' | 'superseded';

/** Observed attempt outcome record; business meaning is /workflow's. */
export type AttemptOutcome = 'completed' | 'failed';

export interface WorkRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly workType: string;
  readonly title: string;
  readonly status: WorkStatus;
  readonly createdBy: string;
  readonly idempotencyKey: string | null;
  readonly currentAttemptId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkAttemptRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly workId: string;
  readonly attemptNo: number;
  readonly status: AttemptStatus;
  readonly idempotencyKey: string | null;
  readonly createdBy: string;
  /** The prior attempt this attempt replaced (forward-only chain). */
  readonly supersedesId: string | null;
  readonly supersededAt: Date | null;
  readonly dispatchedAt: Date | null;
  readonly outcome: AttemptOutcome | null;
  readonly result: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkDependencyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly workId: string;
  readonly dependsOnWorkId: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateWorkInput {
  readonly tenantId: string;
  readonly workType: string;
  readonly title: string;
  readonly createdBy: string;
  /** Durable idempotency identity; null creates an unkeyed distinct work. */
  readonly idempotencyKey: string | null;
  readonly now: Date;
}

export interface AddDependencyInput {
  readonly tenantId: string;
  readonly workId: string;
  readonly dependsOnWorkId: string;
  readonly createdBy: string;
  readonly now: Date;
}

export interface CreateAttemptInput {
  readonly tenantId: string;
  readonly workId: string;
  /**
   * Durable idempotency identity for this attempt creation. Pre-dispatch
   * retries with the same key converge on the original attempt; after
   * dispatch the retry supersedes it with a distinct identity.
   */
  readonly idempotencyKey: string | null;
  readonly createdBy: string;
  readonly now: Date;
}

export interface DispatchAttemptInput {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly now: Date;
}

export interface RecordAttemptResultInput {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly outcome: AttemptOutcome;
  /** Opaque result reference; business evidence linkage belongs to /evidence. */
  readonly result: string | null;
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export interface WorkStore {
  /**
   * Atomically create a ServiceWork. Same tenant + idempotency key converges
   * on the existing durable identity (`converged: true`); two concurrent
   * creators of the same logical work therefore receive the same identity.
   */
  createWork(input: CreateWorkInput): Promise<{ work: WorkRecord; converged: boolean }>;
  /** Tenant-predicated lookup; null when absent in this tenant. */
  findWorkById(tenantId: string, workId: string): Promise<WorkRecord | null>;
  /** Tenant-predicated list (mandatory tenant predicate in every impl). */
  listWorks(tenantId: string): Promise<WorkRecord[]>;
  /**
   * Atomically add a dependency edge. Duplicate edges converge on the
   * existing record; self-dependency and cycles fail closed
   * (`WorkStoreRuleError`); missing works fail closed
   * (`WorkStoreMissingError`). Cycle safety is evaluated inside one
   * serialized unit (advisory transaction lock in SQL; synchronous critical
   * section in memory) so racing edges cannot close a phantom cycle.
   */
  addDependency(input: AddDependencyInput): Promise<{ dependency: WorkDependencyRecord; converged: boolean }>;
  /** Dependencies recorded for one work, through the tenant predicate. */
  listDependencies(tenantId: string, workId: string): Promise<WorkDependencyRecord[]>;
  /**
   * Atomically create a WorkAttempt under the retry protocol: a pre-dispatch
   * live attempt for the same (work, key) is re-observed (`converged: true`);
   * otherwise a distinct attempt is created, the current attempt is
   * superseded, and the work's current-attempt pointer moves forward.
   */
  createAttempt(input: CreateAttemptInput): Promise<{ attempt: WorkAttemptRecord; converged: boolean }>;
  /** Tenant-predicated lookup; null when absent in this tenant. */
  findAttemptById(tenantId: string, attemptId: string): Promise<WorkAttemptRecord | null>;
  /** Attempts recorded for one work, through the tenant predicate. */
  listAttempts(tenantId: string, workId: string): Promise<WorkAttemptRecord[]>;
  /**
   * Record the dispatch boundary (closes the pre-dispatch convergence
   * window). Idempotent for an already-dispatched attempt; rejected for a
   * superseded attempt (rule `attempt-superseded`).
   */
  dispatchAttempt(input: DispatchAttemptInput): Promise<{ attempt: WorkAttemptRecord; converged: boolean }>;
  /**
   * Record an observed attempt result. Idempotent for an identical
   * re-delivery; rejected with `attempt-result-conflict` for a divergent
   * second result; rejected with `attempt-superseded` for a stale attempt —
   * a late prior attempt can never mutate current-work state (AC-5).
   * Never mutates Service Work state.
   */
  recordAttemptResult(input: RecordAttemptResultInput): Promise<{ attempt: WorkAttemptRecord; converged: boolean }>;
}
