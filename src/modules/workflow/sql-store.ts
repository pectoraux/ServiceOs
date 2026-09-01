/**
 * ServiceOS /workflow SQL store (WORK-004, module internal).
 *
 * Authoritative persistence for the append-only Service Work transition
 * ledger and the SLA orchestration-hook deadlines, executed through the
 * persistence boundary's `TransactionalExecutor` (parameterized SQL only;
 * this file never imports `pg`). Load-bearing invariants:
 *
 * 1. THE TRANSITION BOUNDARY. This store is the ONLY code in ServiceOS that
 *    writes `work_service_works.status` (the /workflow authority per the
 *    authority matrix; enforced structurally by the workflow boundary
 *    checks). The status write happens inside the same client-pinned
 *    transaction as the ledger insert, holding the work-row FOR UPDATE lock:
 *    a transition and its audit record commit atomically or not at all.
 *    EVERY statement of that critical section — the keyed convergence
 *    lookup, the work-row `FOR UPDATE`, the dependency gate (under the
 *    per-tenant advisory lock), the ledger sequence allocation, the ledger
 *    insert and the status write — runs on the ONE pinned transaction
 *    client (`tx`), never on the pooled executor: the `query` helper below
 *    takes its executor EXPLICITLY, and every call site inside
 *    `withTransaction` passes `tx`. A statement routed to the pool inside
 *    the transaction would run on a different connection, autocommitted,
 *    outside the transaction (its locks released at statement end, its
 *    writes invisible to the rollback) — silently voiding the atomicity
 *    and serialization guarantees this store claims. The transaction-scope
 *    proofs (in-env tripwire executor; live single-pinned-client pool;
 *    live forced-commit rollback) fail if ANY statement escapes.
 *    Reads of work rows (snapshot, SLA breach join) are the transition
 *    boundary's own substrate and always carry the mandatory tenant
 *    predicate.
 *
 * 2. MANDATORY TENANT PREDICATES: every lookup/list/join selects through
 *    `tenant_id = $…`. Removing a predicate must fail the tenant-isolation
 *    discrimination tests.
 *
 * 3. CONVERGENCE, NOT DUPLICATION: `applyTransition` converges on the
 *    durable transition identified by (tenant, idempotency key) — keyed
 *    lookups run inside the transaction, and the insert uses
 *    `ON CONFLICT … DO NOTHING` against the tenant-scoped partial unique
 *    index so a concurrent creator of the same logical transition keeps a
 *    healthy transaction and converges by re-reading (a raised 23505 would
 *    abort it with 25P02 — the WORK-014 lesson).
 *
 * 4. SERIALIZED TRANSITION APPLICATION: the work row is locked
 *    (`SELECT … FOR UPDATE`) BEFORE the expected-status comparison, so two
 *    competing transitions from the same state serialize; the loser fails
 *    closed with rule `transition-conflict` (deterministically — never a
 *    lost update or a double mutation). The dependency gate additionally
 *    takes the SAME per-tenant advisory lock /work's `addDependency`
 *    serializes on (`pg_advisory_xact_lock(hashtext(tenantId))`), so gate
 *    evaluation and dependency mutation cannot interleave.
 *
 * 5. TAMPER-EVIDENT READS: `mapTransition` recomputes the persisted input
 *    hash and record integrity hash from the stored fields and fails closed
 *    with rule `transition-record-tampered` when they diverge — the ledger
 *    is append-only and after-the-fact mutation is detected on read.
 *
 * 6. SLA DEADLINES ARE HOOK DATA: `setSlaDeadline` upserts per (work,
 *    state) with keyed convergence; `listSlaBreaches` joins deadlines with
 *    the works' CURRENT state (the state CHECK already excludes terminal
 *    states). Nothing here mutates work state — enforcement flows through
 *    `applyTransition` only.
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { StoreConflictError } from '../auth/index.js';
import type { WorkStatus } from '../work/index.js';
import {
  canonicalJson,
  computeTransitionRecordHash,
  hashTransitionInput,
  hashTransitionRecord,
} from './provenance.js';
import {
  WorkflowStoreMissingError,
  WorkflowStoreRuleError,
  type ApplyTransitionInput,
  type SlaBreach,
  type SlaDeadlineRecord,
  type SetSlaDeadlineInput,
  type TransitionPreconditions,
  type TransitionRecord,
  type WorkSnapshot,
  type WorkflowStore,
} from './store.js';

interface TransitionRow {
  id: string;
  tenant_id: string;
  work_id: string;
  seq: number;
  from_state: string;
  to_state: string;
  rule_id: string;
  preconditions: unknown;
  reason: string | null;
  transitioned_by: string;
  idempotency_key: string | null;
  input_hash: string;
  record_hash: string;
  created_at: Date | string;
}

interface SlaDeadlineRow {
  id: string;
  tenant_id: string;
  work_id: string;
  state: string;
  deadline_at: Date | string;
  set_by: string;
  idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BreachRow {
  work_id: string;
  work_type: string;
  state: string;
  deadline_at: Date | string;
}

const TRANSITION_COLUMNS =
  'id, tenant_id, work_id, seq, from_state, to_state, rule_id, preconditions, reason, transitioned_by, idempotency_key, input_hash, record_hash, created_at';
const SLA_COLUMNS = 'id, tenant_id, work_id, state, deadline_at, set_by, idempotency_key, created_at, updated_at';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function isStatus(value: string): value is WorkStatus {
  return (
    value === 'draft' ||
    value === 'ready' ||
    value === 'accepted' ||
    value === 'in_progress' ||
    value === 'waiting_information' ||
    value === 'waiting_approval' ||
    value === 'blocked' ||
    value === 'verifying' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'failed' ||
    value === 'expired'
  );
}

/** Guarded status mapping: out-of-enumeration rows fail closed. */
function toStatus(value: string, context: string): WorkStatus {
  if (!isStatus(value)) {
    throw new WorkflowStoreRuleError(`${context} has an out-of-enumeration state "${value}"`, 'transition-record-tampered');
  }
  return value;
}

function mapPreconditions(raw: unknown): TransitionPreconditions {
  if (typeof raw !== 'object' || raw === null) {
    throw new WorkflowStoreRuleError('transition preconditions column is not an object', 'transition-record-tampered');
  }
  const candidate = raw as Record<string, unknown>;
  const dependencies = candidate.dependencies as Record<string, unknown> | undefined;
  const policy = candidate.policy as Record<string, unknown> | null | undefined;
  if (typeof dependencies !== 'object' || dependencies === null) {
    throw new WorkflowStoreRuleError('transition preconditions dependencies is not an object', 'transition-record-tampered');
  }
  if (typeof dependencies.evaluated !== 'boolean' || typeof dependencies.satisfied !== 'boolean') {
    throw new WorkflowStoreRuleError('transition preconditions dependencies has an invalid shape', 'transition-record-tampered');
  }
  let policyProvenance: TransitionPreconditions['policy'] = null;
  if (policy !== null && policy !== undefined) {
    if (typeof policy.policyKey !== 'string' || typeof policy.decisionId !== 'string') {
      throw new WorkflowStoreRuleError('transition preconditions policy has an invalid shape', 'transition-record-tampered');
    }
    policyProvenance = { policyKey: policy.policyKey, decisionId: policy.decisionId };
  }
  return {
    dependencies: { evaluated: dependencies.evaluated, satisfied: dependencies.satisfied },
    policy: policyProvenance,
  };
}

function mapTransition(row: TransitionRow): TransitionRecord {
  const fromState = toStatus(row.from_state, `transition ${row.id} from_state`);
  const toState = toStatus(row.to_state, `transition ${row.id} to_state`);
  const preconditions = mapPreconditions(row.preconditions);
  const transition: TransitionRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    workId: row.work_id,
    seq: row.seq,
    fromState,
    toState,
    ruleId: row.rule_id,
    preconditions,
    reason: row.reason,
    transitionedBy: row.transitioned_by,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    recordHash: row.record_hash,
    createdAt: toDate(row.created_at),
  };
  // Integrity verification: every read recomputes the persisted hashes from
  // the stored fields. Any after-the-fact mutation of the recorded
  // transition (states, rule, provenance, actor, attribution) is detected.
  const recomputedInputHash = hashTransitionInput({
    workId: transition.workId,
    to: transition.toState,
    policyKey: preconditions.policy?.policyKey ?? null,
  });
  if (recomputedInputHash !== transition.inputHash) {
    throw new WorkflowStoreRuleError(
      `transition ${transition.id} record no longer matches its recorded input hash`,
      'transition-record-tampered',
    );
  }
  if (computeTransitionRecordHash(transition) !== transition.recordHash) {
    throw new WorkflowStoreRuleError(
      `transition ${transition.id} record no longer matches its recorded integrity hash`,
      'transition-record-tampered',
    );
  }
  return transition;
}

function mapSlaDeadline(row: SlaDeadlineRow): SlaDeadlineRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workId: row.work_id,
    state: toStatus(row.state, `sla deadline ${row.id} state`),
    deadlineAt: toDate(row.deadline_at),
    setBy: row.set_by,
    idempotencyKey: row.idempotency_key,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/** Map a driver unique-violation to the shared conflict error. */
function mapStoreError(error: unknown, context: string): unknown {
  if (
    error instanceof StoreConflictError ||
    error instanceof WorkflowStoreRuleError ||
    error instanceof WorkflowStoreMissingError
  ) {
    return error;
  }
  const candidate = error as { code?: string; constraint?: string };
  if (typeof candidate?.code === 'string' && candidate.code === '23505') {
    return new StoreConflictError(`${context} violated a uniqueness constraint`, candidate.constraint ?? 'unknown');
  }
  return error;
}

export function createSqlWorkflowStore(executor: TransactionalExecutor): WorkflowStore {
  /**
   * Parameterized statement helper. The FIRST parameter is the executor the
   * statement runs on, passed EXPLICITLY at every call site: read paths pass
   * `executor` (the pool); every statement inside `withTransaction` passes
   * `tx` (the pinned client). This is a load-bearing convention — a
   * closure-captured executor (the PR #28 review defect class) silently
   * routes critical-section statements to a different connection,
   * autocommitted, outside the transaction. The transaction-scope proofs
   * (in-env tripwire executor; live single-pinned-client pool; live
   * forced-commit rollback) fail the build if a statement escapes.
   */
  async function query(
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

  async function findTransitionRowById(
    exec: SqlExecutor,
    tenantId: string,
    transitionId: string,
  ): Promise<TransitionRow | null> {
    const rows = await exec.query(
      `SELECT ${TRANSITION_COLUMNS} FROM workflow_transitions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, transitionId],
    );
    const row = rows.rows[0] as unknown as TransitionRow | undefined;
    return row === undefined ? null : row;
  }

  async function findTransitionRowByKey(
    exec: SqlExecutor,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<TransitionRow | null> {
    const rows = await exec.query(
      `SELECT ${TRANSITION_COLUMNS} FROM workflow_transitions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    const row = rows.rows[0] as unknown as TransitionRow | undefined;
    return row === undefined ? null : row;
  }

  /** Converge a keyed re-submission on the durable transition, or fail closed. */
  function convergeOrConflict(row: TransitionRow, input: ApplyTransitionInput): { transition: TransitionRecord; converged: boolean } {
    const transition = mapTransition(row);
    if (transition.inputHash !== input.inputHash) {
      throw new WorkflowStoreRuleError(
        `idempotency key "${input.idempotencyKey}" was already used for a different transition input`,
        'transition-input-conflict',
      );
    }
    return { transition, converged: true };
  }

  return {
    async applyTransition(input: ApplyTransitionInput): Promise<{ transition: TransitionRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Keyed convergence first: a retry re-observes the durable
        // transition without touching the work row (the recorded from/to
        // are authoritative; the work may have progressed further).
        if (input.idempotencyKey !== null) {
          const existing = await findTransitionRowByKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            return convergeOrConflict(existing, input);
          }
        }

        // Serialize transition application for this work: the row lock is
        // held through status validation, the gate, the ledger insert and
        // the status write (one atomic unit).
        const workRows = await query(
          tx,
          `SELECT id, work_type, status FROM work_service_works WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.workId],
          'applyTransition',
        );
        const workRow = workRows[0] as unknown as { id: string; work_type: string; status: string } | undefined;
        if (workRow === undefined) {
          throw new WorkflowStoreMissingError(`work ${input.workId} does not exist in this tenant`, 'work');
        }
        if (workRow.status !== input.expectedFrom) {
          // The row lock was WAITED ON: a competing transition may have
          // committed while this transaction waited (its keyed lookup above
          // ran before that commit and missed it). Re-check keyed
          // convergence NOW — under READ COMMITTED this statement sees the
          // newly committed row — before failing closed.
          if (input.idempotencyKey !== null) {
            const raced = await findTransitionRowByKey(tx, input.tenantId, input.idempotencyKey);
            if (raced !== null) {
              return convergeOrConflict(raced, input);
            }
          }
          throw new WorkflowStoreRuleError(
            `work ${input.workId} is in state "${workRow.status}", not the expected "${input.expectedFrom}"; a competing transition committed first or the work already moved`,
            'transition-conflict',
          );
        }

        // Dependency gate (the draft -> ready readiness precondition),
        // evaluated AUTHORITATIVELY in transaction. The advisory lock is
        // the same per-tenant dependency lock /work's addDependency takes,
        // so a racing dependency add cannot interleave with the gate.
        let dependencies: TransitionPreconditions['dependencies'] = { evaluated: false, satisfied: true };
        if (input.dependencyGateRequired) {
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.tenantId]);
          const unmet = await query(
            tx,
            `SELECT count(*) AS unmet
             FROM work_dependencies d
             JOIN work_service_works w ON w.id = d.depends_on_work_id AND w.tenant_id = d.tenant_id
             WHERE d.tenant_id = $1 AND d.work_id = $2 AND w.status <> 'completed'`,
            [input.tenantId, input.workId],
            'applyTransition',
          );
          const unmetCount = Number((unmet[0] as { unmet: number | string } | undefined)?.unmet ?? 0);
          if (unmetCount > 0) {
            throw new WorkflowStoreRuleError(
              `work ${input.workId} has ${unmetCount} dependency work(s) that are not completed; it cannot become ready`,
              'precondition-dependencies',
            );
          }
          dependencies = { evaluated: true, satisfied: true };
        }

        const preconditions: TransitionPreconditions = { dependencies, policy: input.policy };

        // Strict per-work ledger sequence, allocated under the work-row
        // lock (race-free; the schema UNIQUE is the backstop).
        const sequence = await query(
          tx,
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM workflow_transitions WHERE tenant_id = $1 AND work_id = $2`,
          [input.tenantId, input.workId],
          'applyTransition',
        );
        const seq = Number((sequence[0] as { next: number | string } | undefined)?.next ?? 1);

        const recordHash = hashTransitionRecord({
          tenantId: input.tenantId,
          workId: input.workId,
          seq,
          fromState: input.expectedFrom,
          toState: input.to,
          ruleId: input.ruleId,
          preconditions,
          reason: input.reason,
          transitionedBy: input.transitionedBy,
          idempotencyKey: input.idempotencyKey,
          inputHash: input.inputHash,
          createdAt: input.now.toISOString(),
        });

        // Append the audit record, then write the status (same transaction,
        // same lock). ON CONFLICT DO NOTHING against the tenant-scoped
        // keyed partial unique index lets a concurrent keyed creator keep a
        // healthy transaction and converge by re-reading below.
        const inserted = await query(
          tx,
          `INSERT INTO workflow_transitions
             (tenant_id, work_id, seq, from_state, to_state, rule_id, preconditions, reason, transitioned_by, idempotency_key, input_hash, record_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING ${TRANSITION_COLUMNS}`,
          [
            input.tenantId,
            input.workId,
            seq,
            input.expectedFrom,
            input.to,
            input.ruleId,
            canonicalJson(preconditions),
            input.reason,
            input.transitionedBy,
            input.idempotencyKey,
            input.inputHash,
            recordHash,
            input.now,
          ],
          'applyTransition',
        );
        if (inserted.length > 0) {
          const transition = mapTransition(inserted[0] as unknown as TransitionRow);
          // The transition boundary write: the only status UPDATE in
          // ServiceOS, inside the same serialized unit as its audit record.
          await tx.query(
            `UPDATE work_service_works SET status = $1, updated_at = $2 WHERE tenant_id = $3 AND id = $4`,
            [input.to, input.now, input.tenantId, input.workId],
          );
          return { transition, converged: false };
        }

        // A concurrent keyed creator committed first: converge on its row.
        if (input.idempotencyKey !== null) {
          const existing = await findTransitionRowByKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            return convergeOrConflict(existing, input);
          }
        }
        throw new StoreConflictError(
          'applyTransition violated a uniqueness constraint',
          'workflow_transitions_tenant_idempotency_key',
        );
      });
    },

    async findTransitionById(tenantId: string, transitionId: string): Promise<TransitionRecord | null> {
      const row = await findTransitionRowById(executor, tenantId, transitionId);
      return row === null ? null : mapTransition(row);
    },

    async findTransitionByIdempotencyKey(tenantId: string, key: string): Promise<TransitionRecord | null> {
      const row = await findTransitionRowByKey(executor, tenantId, key);
      return row === null ? null : mapTransition(row);
    },

    async listTransitions(tenantId: string, workId: string): Promise<TransitionRecord[]> {
      const rows = await query(
        executor,
        `SELECT ${TRANSITION_COLUMNS} FROM workflow_transitions WHERE tenant_id = $1 AND work_id = $2
         ORDER BY seq ASC`,
        [tenantId, workId],
        'listTransitions',
      );
      return rows.map((row) => mapTransition(row as unknown as TransitionRow));
    },

    async getWorkSnapshot(tenantId: string, workId: string): Promise<WorkSnapshot | null> {
      const rows = await query(
        executor,
        `SELECT id, work_type, status FROM work_service_works WHERE tenant_id = $1 AND id = $2`,
        [tenantId, workId],
        'getWorkSnapshot',
      );
      const row = rows[0] as unknown as { id: string; work_type: string; status: string } | undefined;
      if (row === undefined) return null;
      return { workId: row.id, workType: row.work_type, status: toStatus(row.status, `work ${workId} status`) };
    },

    async setSlaDeadline(input: SetSlaDeadlineInput): Promise<{ deadline: SlaDeadlineRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Keyed convergence: the same logical creation re-observes the
        // durable deadline (a divergent same-key input fails closed).
        if (input.idempotencyKey !== null) {
          const rows = await tx.query(
            `SELECT ${SLA_COLUMNS} FROM workflow_sla_deadlines WHERE tenant_id = $1 AND idempotency_key = $2`,
            [input.tenantId, input.idempotencyKey],
          );
          const existing = rows.rows[0] as unknown as SlaDeadlineRow | undefined;
          if (existing !== undefined) {
            const deadline = mapSlaDeadline(existing);
            if (
              deadline.workId !== input.workId ||
              deadline.state !== input.state ||
              deadline.deadlineAt.getTime() !== input.deadlineAt.getTime()
            ) {
              throw new WorkflowStoreRuleError(
                `idempotency key "${input.idempotencyKey}" was already used for a different SLA deadline input`,
                'sla-deadline-conflict',
              );
            }
            return { deadline, converged: true };
          }
        }
        // The work must exist in this tenant (fail closed).
        const workRows = await tx.query(
          `SELECT id FROM work_service_works WHERE tenant_id = $1 AND id = $2`,
          [input.tenantId, input.workId],
        );
        if (workRows.rows.length === 0) {
          throw new WorkflowStoreMissingError(`work ${input.workId} does not exist in this tenant`, 'work');
        }
        // Upsert per (work, state): re-setting a deadline is the deliberate
        // extension path for orchestration (latest set wins, provenance
        // moves to the latest setter). A same-key race onto a DIFFERENT
        // (work, state) violates the tenant-scoped keyed partial unique
        // index (the pre-check above missed the concurrently committed
        // winner): fail closed with the typed rule. The raised 23505
        // aborts this transaction — correct here, the caller re-submits
        // and converges through the pre-check.
        let rows: Record<string, unknown>[];
        try {
          rows = await query(
            tx,
            `INSERT INTO workflow_sla_deadlines (tenant_id, work_id, state, deadline_at, set_by, idempotency_key, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
             ON CONFLICT (work_id, state) DO UPDATE
               SET deadline_at = EXCLUDED.deadline_at,
                   set_by = EXCLUDED.set_by,
                   idempotency_key = EXCLUDED.idempotency_key,
                   updated_at = EXCLUDED.updated_at
             RETURNING ${SLA_COLUMNS}`,
            [input.tenantId, input.workId, input.state, input.deadlineAt, input.setBy, input.idempotencyKey, input.now],
            'setSlaDeadline',
          );
        } catch (error) {
          if (
            error instanceof StoreConflictError &&
            error.constraint === 'workflow_sla_deadlines_tenant_idempotency_key'
          ) {
            throw new WorkflowStoreRuleError(
              `idempotency key "${input.idempotencyKey}" was already used for a different SLA deadline input`,
              'sla-deadline-conflict',
            );
          }
          throw error;
        }
        return { deadline: mapSlaDeadline(rows[0] as unknown as SlaDeadlineRow), converged: false };
      });
    },

    async findSlaDeadline(tenantId: string, workId: string, state: WorkStatus): Promise<SlaDeadlineRecord | null> {
      const rows = await query(
        executor,
        `SELECT ${SLA_COLUMNS} FROM workflow_sla_deadlines WHERE tenant_id = $1 AND work_id = $2 AND state = $3`,
        [tenantId, workId, state],
        'findSlaDeadline',
      );
      const row = rows[0] as unknown as SlaDeadlineRow | undefined;
      return row === undefined ? null : mapSlaDeadline(row);
    },

    async listSlaDeadlines(tenantId: string, workId: string): Promise<SlaDeadlineRecord[]> {
      const rows = await query(
        executor,
        `SELECT ${SLA_COLUMNS} FROM workflow_sla_deadlines WHERE tenant_id = $1 AND work_id = $2
         ORDER BY state ASC`,
        [tenantId, workId],
        'listSlaDeadlines',
      );
      return rows.map((row) => mapSlaDeadline(row as unknown as SlaDeadlineRow));
    },

    async listSlaBreaches(tenantId: string, now: Date): Promise<SlaBreach[]> {
      // A deadline row only exists for non-terminal states (schema CHECK);
      // joining on w.status = d.state therefore yields exactly the works
      // whose CURRENT state deadline has passed — a deterministic read.
      const rows = await query(
        executor,
        `SELECT w.id AS work_id, w.work_type AS work_type, w.status AS state, d.deadline_at AS deadline_at
         FROM work_service_works w
         JOIN workflow_sla_deadlines d
           ON d.tenant_id = w.tenant_id AND d.work_id = w.id AND d.state = w.status
         WHERE w.tenant_id = $1 AND d.deadline_at < $2
         ORDER BY d.deadline_at ASC, w.id ASC`,
        [tenantId, now],
        'listSlaBreaches',
      );
      return rows.map((row) => {
        const breach = row as unknown as BreachRow;
        return {
          workId: breach.work_id,
          workType: breach.work_type,
          state: toStatus(breach.state, `sla breach state`),
          deadlineAt: toDate(breach.deadline_at),
        };
      });
    },
  };
}
