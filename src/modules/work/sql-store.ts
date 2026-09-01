/**
 * ServiceOS /work SQL store (WORK-003, module internal).
 *
 * Authoritative persistence for ServiceWork, WorkAttempt and
 * WorkDependency records, executed through the persistence boundary's
 * `TransactionalExecutor` (parameterized SQL only; this file never imports
 * `pg`). Load-bearing invariants:
 *
 * 1. MANDATORY TENANT PREDICATES: every lookup/list selects through
 *    `tenant_id = $…` (the isolated customer-domain boundary established by
 *    migration 0001). Removing a predicate must fail the tenant-isolation
 *    discrimination tests.
 *
 * 2. CONVERGENCE: `createWork`/`createAttempt` insert against partial unique
 *    indexes; a uniqueness conflict for the same logical identity is mapped
 *    to a converged re-read of the durable row, so concurrent creators
 *    converge on one identity instead of duplicating.
 *
 * 3. SERIALIZED ATTEMPT CREATION: `createAttempt` locks the work row
 *    (`SELECT … FOR UPDATE`) so attempt numbering, supersession and the
 *    forward-only current-attempt pointer are atomic under PostgreSQL
 *    concurrency. The partial unique indexes `work_attempts_one_live_per_work`
 *    and `work_attempts_live_idempotency_key` are schema-level backstops.
 *
 * 4. SERIALIZED DEPENDENCY MUTATION: `addDependency` takes a
 *    per-tenant transaction-scope advisory lock before the cycle check, so
 *    two racing edges (e.g. A→B and B→A added concurrently) serialize and
 *    the second one observes the committed first edge and fails closed —
 *    a phantom cycle can never be committed.
 *
 * 5. SUPERSEDED-ATTEMPT PROTECTION: `dispatchAttempt` and
 *    `recordAttemptResult` lock and validate the attempt row first; a
 *    superseded attempt is rejected with rule `attempt-superseded` and can
 *    never mutate work state. No statement in this file ever writes
 *    `work_service_works.status` (that column is /workflow authority; also
 *    enforced structurally).
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { StoreConflictError } from '../auth/index.js';
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
  type WorkStore,
  type WorkStatus,
} from './store.js';

interface WorkRow {
  id: string;
  tenant_id: string;
  work_type: string;
  title: string;
  status: string;
  created_by: string;
  idempotency_key: string | null;
  current_attempt_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AttemptRow {
  id: string;
  tenant_id: string;
  work_id: string;
  attempt_no: number;
  status: string;
  idempotency_key: string | null;
  created_by: string;
  supersedes_id: string | null;
  superseded_at: Date | string | null;
  dispatched_at: Date | string | null;
  outcome: string | null;
  result: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DependencyRow {
  id: string;
  tenant_id: string;
  work_id: string;
  depends_on_work_id: string;
  created_by: string;
  created_at: Date | string;
}

const WORK_COLUMNS =
  'id, tenant_id, work_type, title, status, created_by, idempotency_key, current_attempt_id, created_at, updated_at';
const ATTEMPT_COLUMNS =
  'id, tenant_id, work_id, attempt_no, status, idempotency_key, created_by, supersedes_id, superseded_at, dispatched_at, outcome, result, created_at, updated_at';
const DEPENDENCY_COLUMNS = 'id, tenant_id, work_id, depends_on_work_id, created_by, created_at';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapWork(row: WorkRow): WorkRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workType: row.work_type,
    title: row.title,
    status: (row.status === 'draft' ? 'draft' : 'draft') as WorkStatus,
    createdBy: row.created_by,
    idempotencyKey: row.idempotency_key,
    currentAttemptId: row.current_attempt_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapAttempt(row: AttemptRow): WorkAttemptRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workId: row.work_id,
    attemptNo: row.attempt_no,
    status: row.status as AttemptStatus,
    idempotencyKey: row.idempotency_key,
    createdBy: row.created_by,
    supersedesId: row.supersedes_id,
    supersededAt: row.superseded_at === null ? null : toDate(row.superseded_at),
    dispatchedAt: row.dispatched_at === null ? null : toDate(row.dispatched_at),
    outcome: (row.outcome === 'completed' || row.outcome === 'failed' ? row.outcome : null) as
      | AttemptOutcome
      | null,
    result: row.result,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapDependency(row: DependencyRow): WorkDependencyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workId: row.work_id,
    dependsOnWorkId: row.depends_on_work_id,
    createdBy: row.created_by,
    createdAt: toDate(row.created_at),
  };
}

function mapStoreError(error: unknown, context: string): unknown {
  if (
    error instanceof StoreConflictError ||
    error instanceof WorkStoreRuleError ||
    error instanceof WorkStoreMissingError
  ) {
    return error;
  }
  const candidate = error as { code?: string; constraint?: string };
  if (typeof candidate?.code === 'string' && candidate.code === '23505') {
    return new StoreConflictError(`${context} violated a uniqueness constraint`, candidate.constraint ?? 'unknown');
  }
  return error;
}

const UUID_INPUT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSqlWorkStore(executor: TransactionalExecutor): WorkStore {
  async function insertReturning(
    exec: SqlExecutor,
    sql: string,
    params: unknown[],
    context: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      const result = await exec.query(sql, params);
      return result.rows;
    } catch (error) {
      throw mapStoreError(error, context);
    }
  }

  async function findWorkRowById(exec: SqlExecutor, tenantId: string, workId: string): Promise<WorkRow | null> {
    const result = await exec.query(`SELECT ${WORK_COLUMNS} FROM work_service_works WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      workId,
    ]);
    const row = result.rows[0] as unknown as WorkRow | undefined;
    return row === undefined ? null : row;
  }

  async function findLiveAttemptForKey(exec: SqlExecutor, workId: string, key: string): Promise<AttemptRow | null> {
    const result = await exec.query(
      `SELECT ${ATTEMPT_COLUMNS} FROM work_attempts
       WHERE work_id = $1 AND idempotency_key = $2 AND superseded_at IS NULL`,
      [workId, key],
    );
    const row = result.rows[0] as unknown as AttemptRow | undefined;
    return row === undefined ? null : row;
  }

  return {
    async createWork(input: CreateWorkInput): Promise<{ work: WorkRecord; converged: boolean }> {
      try {
        const rows = await insertReturning(
          executor,
          `INSERT INTO work_service_works (tenant_id, work_type, title, status, created_by, idempotency_key, current_attempt_id, created_at, updated_at)
           VALUES ($1, $2, $3, 'draft', $4, $5, NULL, $6, $6)
           RETURNING ${WORK_COLUMNS}`,
          [input.tenantId, input.workType, input.title, input.createdBy, input.idempotencyKey, input.now],
          'createWork',
        );
        return { work: mapWork(rows[0] as unknown as WorkRow), converged: false };
      } catch (error) {
        const conflict = error instanceof StoreConflictError ? error : mapStoreError(error, 'createWork');
        if (
          conflict instanceof StoreConflictError &&
          conflict.constraint === 'work_service_works_tenant_idempotency_key' &&
          input.idempotencyKey !== null
        ) {
          // Convergence: the same logical work already exists durably (a
          // concurrent creator committed it). Re-read the durable identity.
          const result = await executor.query(
            `SELECT ${WORK_COLUMNS} FROM work_service_works WHERE tenant_id = $1 AND idempotency_key = $2`,
            [input.tenantId, input.idempotencyKey],
          );
          const row = result.rows[0] as unknown as WorkRow | undefined;
          if (row !== undefined) {
            return { work: mapWork(row), converged: true };
          }
        }
        throw conflict;
      }
    },

    async findWorkById(tenantId: string, workId: string): Promise<WorkRecord | null> {
      const row = await findWorkRowById(executor, tenantId, workId);
      return row === null ? null : mapWork(row);
    },

    async listWorks(tenantId: string): Promise<WorkRecord[]> {
      const result = await executor.query(
        `SELECT ${WORK_COLUMNS} FROM work_service_works WHERE tenant_id = $1 ORDER BY created_at ASC, id ASC`,
        [tenantId],
      );
      return result.rows.map((row) => mapWork(row as unknown as WorkRow));
    },

    async addDependency(input: AddDependencyInput): Promise<{ dependency: WorkDependencyRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        if (input.workId === input.dependsOnWorkId) {
          throw new WorkStoreRuleError('a work cannot depend on itself', 'self-dependency');
        }
        if (!UUID_INPUT.test(input.workId) || !UUID_INPUT.test(input.dependsOnWorkId)) {
          throw new WorkStoreMissingError('work does not exist in this tenant', 'work');
        }
        // Serialize dependency mutations for this tenant: the cycle check
        // below must observe every committed edge, so two racing edges
        // cannot close a phantom cycle. The lock is transaction-scoped and
        // released at COMMIT/ROLLBACK.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.tenantId]);
        // Same-tenant existence of both works (tenant-predicated).
        const endpoints = await tx.query(
          `SELECT id FROM work_service_works WHERE tenant_id = $1 AND id IN ($2, $3)`,
          [input.tenantId, input.workId, input.dependsOnWorkId],
        );
        if (endpoints.rows.length !== 2) {
          throw new WorkStoreMissingError(
            `dependency endpoints must both exist in tenant ${input.tenantId}`,
            'work',
          );
        }
        // Duplicate edge → converge on the durable record.
        const existing = await tx.query(
          `SELECT ${DEPENDENCY_COLUMNS} FROM work_dependencies WHERE work_id = $1 AND depends_on_work_id = $2`,
          [input.workId, input.dependsOnWorkId],
        );
        if (existing.rows.length > 0) {
          return { dependency: mapDependency(existing.rows[0] as unknown as DependencyRow), converged: true };
        }
        // Cycle check: does the prerequisite transitively depend on the
        // dependent? (Adding work -> dependsOn creates a cycle iff a path
        // dependsOn -> ... -> work already exists.)
        const cycle = await tx.query(
          `WITH RECURSIVE deps AS (
             SELECT depends_on_work_id AS node FROM work_dependencies WHERE work_id = $1
             UNION
             SELECT next.depends_on_work_id FROM work_dependencies next JOIN deps ON next.work_id = deps.node
           )
           SELECT 1 AS hit FROM deps WHERE node = $2 LIMIT 1`,
          [input.dependsOnWorkId, input.workId],
        );
        if (cycle.rows.length > 0) {
          throw new WorkStoreRuleError(
            `dependency ${input.workId} -> ${input.dependsOnWorkId} would close a cycle`,
            'dependency-cycle',
          );
        }
        const rows = await insertReturning(
          tx,
          `INSERT INTO work_dependencies (tenant_id, work_id, depends_on_work_id, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${DEPENDENCY_COLUMNS}`,
          [input.tenantId, input.workId, input.dependsOnWorkId, input.createdBy, input.now],
          'addDependency',
        );
        return { dependency: mapDependency(rows[0] as unknown as DependencyRow), converged: false };
      });
    },

    async listDependencies(tenantId: string, workId: string): Promise<WorkDependencyRecord[]> {
      const result = await executor.query(
        `SELECT ${DEPENDENCY_COLUMNS} FROM work_dependencies WHERE tenant_id = $1 AND work_id = $2
         ORDER BY created_at ASC, id ASC`,
        [tenantId, workId],
      );
      return result.rows.map((row) => mapDependency(row as unknown as DependencyRow));
    },

    async createAttempt(input: CreateAttemptInput): Promise<{ attempt: WorkAttemptRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Serialize attempt creation for this work: numbering, supersession
        // and the forward-only current-attempt pointer are atomic.
        const workRows = await tx.query(
          `SELECT ${WORK_COLUMNS} FROM work_service_works WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.workId],
        );
        const workRow = workRows.rows[0] as unknown as WorkRow | undefined;
        if (workRow === undefined) {
          throw new WorkStoreMissingError(`work ${input.workId} does not exist in this tenant`, 'work');
        }
        // Retry protocol: a live attempt for this key that has not been
        // dispatched is safely re-observed (pre-dispatch convergence window).
        if (input.idempotencyKey !== null) {
          const live = await findLiveAttemptForKey(tx, input.workId, input.idempotencyKey);
          if (live !== null && live.dispatched_at === null) {
            return { attempt: mapAttempt(live), converged: true };
          }
          // Dispatched (or no live attempt for the key): fall through and
          // create a DISTINCT attempt identity that supersedes the current.
        }
        const sequence = await tx.query(
          `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM work_attempts WHERE work_id = $1`,
          [input.workId],
        );
        const attemptNo = (sequence.rows[0] as { next: number }).next;
        const currentId = workRow.current_attempt_id;
        // Supersede the prior current attempt FIRST: the partial unique
        // indexes (one live attempt per work / per live key) are enforced
        // per statement, so the replacement must become the only live
        // attempt before it is inserted. Its results can no longer mutate
        // current-work state, and the current-attempt pointer only moves
        // forward (never back to a superseded attempt).
        if (currentId !== null) {
          await tx.query(
            `UPDATE work_attempts SET status = 'superseded', superseded_at = $1, updated_at = $1
             WHERE id = $2 AND superseded_at IS NULL`,
            [input.now, currentId],
          );
        }
        const inserted = await insertReturning(
          tx,
          `INSERT INTO work_attempts (tenant_id, work_id, attempt_no, status, idempotency_key, created_by, supersedes_id, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $7)
           RETURNING ${ATTEMPT_COLUMNS}`,
          [input.tenantId, input.workId, attemptNo, input.idempotencyKey, input.createdBy, currentId, input.now],
          'createAttempt',
        );
        const attempt = mapAttempt(inserted[0] as unknown as AttemptRow);
        await tx.query(`UPDATE work_service_works SET current_attempt_id = $1, updated_at = $2 WHERE id = $3`, [
          attempt.id,
          input.now,
          input.workId,
        ]);
        return { attempt, converged: false };
      });
    },

    async findAttemptById(tenantId: string, attemptId: string): Promise<WorkAttemptRecord | null> {
      const result = await executor.query(
        `SELECT ${ATTEMPT_COLUMNS} FROM work_attempts WHERE tenant_id = $1 AND id = $2`,
        [tenantId, attemptId],
      );
      const row = result.rows[0] as unknown as AttemptRow | undefined;
      return row === undefined ? null : mapAttempt(row);
    },

    async listAttempts(tenantId: string, workId: string): Promise<WorkAttemptRecord[]> {
      const result = await executor.query(
        `SELECT ${ATTEMPT_COLUMNS} FROM work_attempts WHERE tenant_id = $1 AND work_id = $2
         ORDER BY attempt_no ASC`,
        [tenantId, workId],
      );
      return result.rows.map((row) => mapAttempt(row as unknown as AttemptRow));
    },

    async dispatchAttempt(input: DispatchAttemptInput): Promise<{ attempt: WorkAttemptRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        const rows = await tx.query(
          `SELECT ${ATTEMPT_COLUMNS} FROM work_attempts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.attemptId],
        );
        const row = rows.rows[0] as unknown as AttemptRow | undefined;
        if (row === undefined) {
          throw new WorkStoreMissingError(`attempt ${input.attemptId} does not exist in this tenant`, 'attempt');
        }
        if (row.superseded_at !== null) {
          // A stale attempt can never (re-)enter dispatch under its identity.
          throw new WorkStoreRuleError(
            `attempt ${input.attemptId} is superseded and cannot be dispatched`,
            'attempt-superseded',
          );
        }
        if (row.dispatched_at !== null) {
          // Idempotent re-observation of the dispatch boundary.
          return { attempt: mapAttempt(row), converged: true };
        }
        const updated = await insertReturning(
          tx,
          `UPDATE work_attempts SET status = 'dispatched', dispatched_at = $1, updated_at = $1
           WHERE id = $2 AND superseded_at IS NULL AND dispatched_at IS NULL
           RETURNING ${ATTEMPT_COLUMNS}`,
          [input.now, input.attemptId],
          'dispatchAttempt',
        );
        return { attempt: mapAttempt(updated[0] as unknown as AttemptRow), converged: false };
      });
    },

    async recordAttemptResult(input: RecordAttemptResultInput): Promise<{ attempt: WorkAttemptRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        const rows = await tx.query(
          `SELECT ${ATTEMPT_COLUMNS} FROM work_attempts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.attemptId],
        );
        const row = rows.rows[0] as unknown as AttemptRow | undefined;
        if (row === undefined) {
          throw new WorkStoreMissingError(`attempt ${input.attemptId} does not exist in this tenant`, 'attempt');
        }
        if (row.superseded_at !== null) {
          // AC-5: a superseded (stale) attempt cannot mutate current-work
          // state — its late result is rejected, never applied.
          throw new WorkStoreRuleError(
            `attempt ${input.attemptId} is superseded; a late result cannot be recorded`,
            'attempt-superseded',
          );
        }
        if (row.outcome !== null) {
          if (row.outcome === input.outcome && row.result === input.result) {
            // Duplicated delivery of the same observed result: converge.
            return { attempt: mapAttempt(row), converged: true };
          }
          throw new WorkStoreRuleError(
            `attempt ${input.attemptId} already recorded a different result`,
            'attempt-result-conflict',
          );
        }
        const updated = await insertReturning(
          tx,
          `UPDATE work_attempts SET status = $1, outcome = $1, result = $2, updated_at = $3
           WHERE id = $4 AND superseded_at IS NULL AND outcome IS NULL
           RETURNING ${ATTEMPT_COLUMNS}`,
          [input.outcome, input.result, input.now, input.attemptId],
          'recordAttemptResult',
        );
        return { attempt: mapAttempt(updated[0] as unknown as AttemptRow), converged: false };
      });
    },
  };
}
