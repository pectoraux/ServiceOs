/**
 * ServiceOS module: /work (WORK-003 implementation).
 *
 * Service Work identity, lifecycle records, attempts, dependencies and
 * durable idempotency primitives (architecture.md §6, §8;
 * work-execution-model.md).
 *
 * Authority (authority-matrix):
 * - Service Work IDENTITY is owned here: create/read/attempt/dependency
 *   contracts. Other modules (including /workflow) consume work identities
 *   through this public interface; a workflow module creating a second work
 *   store is an architecture violation.
 * - Service Work STATE TRANSITIONS belong to /workflow (WORK-004): this
 *   module persists the work state RECORD (created as `draft` and never
 *   changed here — the migration's closed enumeration and the structural
 *   boundary checks enforce that /work cannot implement the transition
 *   engine).
 * - WorkAttempt is the ServiceOS durable work-attempt identity, DISTINCT
 *   from ServiceWork and from external/Zeck executions (AC-2): no Zeck
 *   reference, lifecycle or credential exists anywhere in this module. AI
 *   execution linkage belongs to the /zeck integration boundary (WORK-005).
 * - Tenancy is resolved server-side through the ONE authorization chain:
 *   every operation calls /organizations' `authorize` BEFORE any store
 *   access (read action for reads, write action for mutations); denials
 *   never touch domain data. This module never re-implements a permission
 *   decision.
 *
 * Retry protocol (work-execution-model.md, AC-4): attempt creation is
 * idempotent by durable identity — a pre-dispatch retry with the same key
 * re-observes the original attempt; after dispatch a retry creates a
 * DISTINCT attempt that supersedes the prior one. A late result from a
 * superseded attempt can never mutate current-work state (AC-5).
 */
import type { TransactionalExecutor } from '../../platform/persistence/index.js';
import { defineModule } from '../../platform/module-registry/index.js';
import type { Principal } from '../auth/index.js';
import type { AuthorizationDecision, AuthorizationDenyReason, TenancyAction } from '../organizations/index.js';
import { createSqlWorkStore } from './sql-store.js';
import {
  WorkStoreMissingError,
  WorkStoreRuleError,
  type AddDependencyInput,
  type AttemptOutcome,
  type AttemptStatus,
  type CreateAttemptInput,
  type CreateWorkInput,
  type DispatchAttemptInput,
  type RecordAttemptResultInput,
  type WorkAttemptRecord,
  type WorkDependencyRecord,
  type WorkRecord,
  type WorkStatus,
  type WorkStore,
  type WorkStoreRule,
} from './store.js';

// Store port (public contract): the authoritative SQL implementation runs
// through the persistence boundary; tests inject faithful in-memory
// implementations of the same port through this surface.
export { WorkStoreMissingError, WorkStoreRuleError, createSqlWorkStore };
export type {
  AddDependencyInput,
  AttemptOutcome,
  AttemptStatus,
  CreateAttemptInput,
  CreateWorkInput,
  DispatchAttemptInput,
  RecordAttemptResultInput,
  WorkAttemptRecord,
  WorkDependencyRecord,
  WorkRecord,
  WorkStatus,
  WorkStore,
  WorkStoreRule,
};

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

export type WorkErrorCode =
  | 'INVALID_INPUT'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'ORGANIZATION_SUSPENDED'
  | 'TENANT_FORBIDDEN'
  | 'ROLE_FORBIDDEN'
  | 'WORK_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'SELF_DEPENDENCY'
  | 'DEPENDENCY_CYCLE'
  | 'ATTEMPT_SUPERSEDED'
  | 'ATTEMPT_RESULT_CONFLICT';

export class WorkError extends Error {
  constructor(
    readonly code: WorkErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'WorkError';
  }
}

export interface WorkModuleOptions {
  /** Production wiring: transaction-capable persistence executor. */
  executor?: TransactionalExecutor;
  /** Test seam: inject a faithful in-memory store instead (tests only). */
  store?: WorkStore;
  /** The single authorization chain, injected by the composition root. */
  tenancy: TenancyAuthorization;
  /** Clock injection for deterministic proofs. */
  now?: () => Date;
}

export interface WorkModule {
  /**
   * Create a ServiceWork with durable tenant-bound identity (AC-1). Same
   * logical work (tenant + idempotency key) converges on one durable
   * identity; concurrent creators receive the same work.
   */
  createWork(
    principal: Principal,
    input: { tenantId: string; workType: string; title: string; idempotencyKey?: string },
  ): Promise<{ work: WorkRecord; converged: boolean }>;
  getWork(principal: Principal, tenantId: string, workId: string): Promise<WorkRecord>;
  listWorks(principal: Principal, tenantId: string): Promise<WorkRecord[]>;
  /**
   * Add a durable same-tenant dependency edge (AC-3). Duplicate edges
   * converge; self-dependencies and cycles fail closed.
   */
  addDependency(
    principal: Principal,
    tenantId: string,
    workId: string,
    dependsOnWorkId: string,
  ): Promise<{ dependency: WorkDependencyRecord; converged: boolean }>;
  listDependencies(principal: Principal, tenantId: string, workId: string): Promise<WorkDependencyRecord[]>;
  /**
   * Create a WorkAttempt (AC-2/AC-4). Pre-dispatch retries with the same
   * idempotency key converge on the original durable attempt; a post-dispatch
   * retry creates a distinct attempt that supersedes the current one.
   */
  createAttempt(
    principal: Principal,
    tenantId: string,
    workId: string,
    input?: { idempotencyKey?: string },
  ): Promise<{ attempt: WorkAttemptRecord; converged: boolean }>;
  listAttempts(principal: Principal, tenantId: string, workId: string): Promise<WorkAttemptRecord[]>;
  /**
   * Record the attempt dispatch boundary (closes the pre-dispatch
   * convergence window). Idempotent for an already-dispatched attempt;
   * a superseded attempt can never re-enter dispatch (AC-5).
   */
  dispatchAttempt(principal: Principal, tenantId: string, attemptId: string): Promise<{ attempt: WorkAttemptRecord; converged: boolean }>;
  /**
   * Record an observed attempt result. Idempotent for identical
   * re-deliveries; divergent results and superseded attempts fail closed
   * (AC-5: a late prior attempt never mutates current-work state). This
   * operation never mutates Service Work state.
   */
  recordAttemptResult(
    principal: Principal,
    tenantId: string,
    attemptId: string,
    input: { outcome: AttemptOutcome; result?: string },
  ): Promise<{ attempt: WorkAttemptRecord; converged: boolean }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new WorkError('INVALID_INPUT', `${what} must be a UUID`);
  }
}

function validateText(value: string, what: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new WorkError('INVALID_INPUT', `${what} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function validateOptionalKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new WorkError('INVALID_INPUT', 'idempotencyKey must be a non-empty string of at most 200 characters');
  }
  return value.trim();
}

/** Map an authorization denial reason to the work-module error surface. */
function denyToError(reason: AuthorizationDenyReason | undefined, tenantId: string): WorkError {
  switch (reason) {
    case 'TENANT_NOT_FOUND':
      return new WorkError('TENANT_NOT_FOUND', `service tenant ${tenantId} does not exist`);
    case 'TENANT_SUSPENDED':
      return new WorkError('TENANT_SUSPENDED', `service tenant ${tenantId} is suspended`);
    case 'ORGANIZATION_NOT_FOUND':
      return new WorkError('TENANT_NOT_FOUND', `the tenant's organization no longer exists`);
    case 'ORGANIZATION_SUSPENDED':
      return new WorkError('ORGANIZATION_SUSPENDED', 'the owning organization is suspended');
    case 'MEMBERSHIP_FORBIDDEN':
      return new WorkError('TENANT_FORBIDDEN', 'the principal has no active membership granting this tenant');
    case 'ROLE_FORBIDDEN':
      return new WorkError('ROLE_FORBIDDEN', 'the principal role does not grant the required capability');
    default:
      return new WorkError('TENANT_FORBIDDEN', 'authorization denied');
  }
}

export function createWorkModule(options: WorkModuleOptions): WorkModule {
  if ((options.executor === undefined) === (options.store === undefined)) {
    throw new WorkError('INVALID_INPUT', 'createWorkModule requires exactly one of executor or store');
  }
  const store = options.store ?? createSqlWorkStore(options.executor as TransactionalExecutor);
  const tenancy = options.tenancy;
  const now = options.now ?? (() => new Date());

  /** Authorization BEFORE any domain data access (single chain). */
  async function requireTenantAccess(principal: Principal, tenantId: string, action: TenancyAction): Promise<void> {
    validateUuid(tenantId, 'tenantId');
    const decision = await tenancy.authorize(principal.id, { tenantId }, action);
    if (!decision.allowed) {
      throw denyToError(decision.reason, tenantId);
    }
  }

  /** Map store errors to the public work error surface. */
  function mapStoreError(error: unknown): never {
    if (error instanceof WorkStoreRuleError) {
      switch (error.rule) {
        case 'dependency-cycle':
          throw new WorkError('DEPENDENCY_CYCLE', error.message);
        case 'self-dependency':
          throw new WorkError('SELF_DEPENDENCY', error.message);
        case 'attempt-superseded':
          throw new WorkError('ATTEMPT_SUPERSEDED', error.message);
        case 'attempt-result-conflict':
          throw new WorkError('ATTEMPT_RESULT_CONFLICT', error.message);
      }
    }
    if (error instanceof WorkStoreMissingError) {
      if (error.what === 'attempt') {
        throw new WorkError('ATTEMPT_NOT_FOUND', error.message);
      }
      throw new WorkError('WORK_NOT_FOUND', error.message);
    }
    throw error;
  }

  return {
    async createWork(principal, input) {
      await requireTenantAccess(principal, input.tenantId, 'write');
      const workType = validateText(input.workType, 'workType', 200);
      const title = validateText(input.title, 'title', 200);
      const idempotencyKey = validateOptionalKey(input.idempotencyKey);
      const payload: CreateWorkInput = {
        tenantId: input.tenantId,
        workType,
        title,
        createdBy: principal.id,
        idempotencyKey,
        now: now(),
      };
      try {
        return await store.createWork(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async getWork(principal, tenantId, workId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(workId, 'workId');
      const work = await store.findWorkById(tenantId, workId);
      if (work === null) {
        throw new WorkError('WORK_NOT_FOUND', `work ${workId} does not exist in this tenant`);
      }
      return work;
    },

    async listWorks(principal, tenantId) {
      await requireTenantAccess(principal, tenantId, 'read');
      return store.listWorks(tenantId);
    },

    async addDependency(principal, tenantId, workId, dependsOnWorkId) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(workId, 'workId');
      validateUuid(dependsOnWorkId, 'dependsOnWorkId');
      const payload: AddDependencyInput = {
        tenantId,
        workId,
        dependsOnWorkId,
        createdBy: principal.id,
        now: now(),
      };
      try {
        return await store.addDependency(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listDependencies(principal, tenantId, workId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(workId, 'workId');
      return store.listDependencies(tenantId, workId);
    },

    async createAttempt(principal, tenantId, workId, input) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(workId, 'workId');
      const idempotencyKey = validateOptionalKey(input?.idempotencyKey);
      const payload: CreateAttemptInput = {
        tenantId,
        workId,
        idempotencyKey,
        createdBy: principal.id,
        now: now(),
      };
      try {
        return await store.createAttempt(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async listAttempts(principal, tenantId, workId) {
      await requireTenantAccess(principal, tenantId, 'read');
      validateUuid(workId, 'workId');
      return store.listAttempts(tenantId, workId);
    },

    async dispatchAttempt(principal, tenantId, attemptId) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(attemptId, 'attemptId');
      const payload: DispatchAttemptInput = { tenantId, attemptId, now: now() };
      try {
        return await store.dispatchAttempt(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },

    async recordAttemptResult(principal, tenantId, attemptId, input) {
      await requireTenantAccess(principal, tenantId, 'write');
      validateUuid(attemptId, 'attemptId');
      if (input.outcome !== 'completed' && input.outcome !== 'failed') {
        throw new WorkError('INVALID_INPUT', 'outcome must be "completed" or "failed"');
      }
      if (input.result !== undefined && (typeof input.result !== 'string' || input.result.length > 10000)) {
        throw new WorkError('INVALID_INPUT', 'result must be a string of at most 10000 characters');
      }
      const payload: RecordAttemptResultInput = {
        tenantId,
        attemptId,
        outcome: input.outcome,
        result: input.result ?? null,
        now: now(),
      };
      try {
        return await store.recordAttemptResult(payload);
      } catch (error) {
        return mapStoreError(error);
      }
    },
  };
}

/**
 * Module manifest (registered in the composition root's module registry).
 * The manifest declares identity only; the business contract above is the
 * module's public surface.
 */
export default defineModule({
  name: 'work',
  version: '1.0.0',
  description: 'Service Work identity, lifecycle, dependencies, attempts and outcomes',
});
