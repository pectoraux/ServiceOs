/**
 * ServiceOS /approvals SQL store (WORK-008, module internal).
 *
 * Authoritative persistence for the approval-request ledger and the
 * approval-decision ledger, executed through the persistence
 * boundary's `TransactionalExecutor` (parameterized SQL only; this
 * file never imports `pg`). Load-bearing invariants:
 *
 * 1. MANDATORY TENANT PREDICATES on every query.
 *
 * 2. THE SERIALIZED TERMINAL ARBITRATION (activation invariant 6):
 *    `decide` is ONE serialized critical section — the keyed
 *    advisory lock first, the request-state advisory lock second
 *    (deadlock-free order every decision writer follows). Inside the
 *    section: the keyed idempotency re-check (same key + identical
 *    decision input converges; divergent fails closed), then the
 *    request's DURABLE state arbitrates: `pending` records the
 *    decision row and flips the request exactly once (a guarded
 *    UPDATE ... WHERE status = 'pending'); an already-terminal request
 *    converges on the recorded terminal decision when the verdict
 *    matches and fails closed `approval-decision-conflict` when it
 *    diverges (the loser of a simultaneous approve/reject race —
 *    deterministic terminal arbitration, never a second terminal
 *    decision). The unique (tenant, request_id) index is the
 *    schema-level backstop: at most one decision row per request can
 *    EVER exist.
 *
 * 3. CONVERGENCE with `ON CONFLICT DO NOTHING` (any unique violation):
 *    a suppressed insert is re-read INSIDE the same healthy
 *    transaction and converges — content hash compared — or fails
 *    closed with the typed store rule.
 *
 * 4. THE AUTHORITY STATE IS WRITTEN ONLY HERE: no UPDATE of
 *    `approval_requests` exists outside `decide`'s guarded flip (and
 *    the flip rewrites the record hash over the new row core, keeping
 *    the row tamper-evident across its state change). Decision rows
 *    are IMMUTABLE (append-only; no update path exists).
 *
 * 5. READ-SIDE INTEGRITY: every read maps rows defensively and
 *    recomputes the record hashes; divergence fails closed
 *    `*-record-tampered`.
 */
import type { TransactionalExecutor, SqlExecutor } from '../../platform/persistence/index.js';
import type { ApprovalDecisionKind, ApprovalRequestStatus } from './contract.js';
import {
  computeApprovalDecisionRecordHash,
  computeApprovalRequestRecordHash,
} from './content.js';
import {
  ApprovalStoreConflictError,
  ApprovalStoreMissingError,
  ApprovalStoreRuleError,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type ApprovalStore,
  type CreateApprovalRequestStoreInput,
  type DecideApprovalStoreInput,
} from './store.js';

// ---------------------------------------------------------------------------
// Row shapes and columns
// ---------------------------------------------------------------------------

interface RequestRow {
  id: string;
  tenant_id: string;
  service_work_id: string;
  work_attempt_id: string | null;
  policy_key: string;
  policy_decision_id: string;
  subject: unknown;
  status: string;
  idempotency_key: string;
  content_hash: string;
  record_hash: string;
  requested_by: string;
  requested_at: Date | string;
  decision_id: string | null;
}

interface DecisionRow {
  id: string;
  tenant_id: string;
  request_id: string;
  service_work_id: string;
  decision: string;
  reason: string | null;
  idempotency_key: string;
  content_hash: string;
  record_hash: string;
  decided_by: string;
  decided_at: Date | string;
}

const REQUEST_COLUMNS =
  'id, tenant_id, service_work_id, work_attempt_id, policy_key, policy_decision_id, subject, status, idempotency_key, content_hash, record_hash, requested_by, requested_at, decision_id';
const DECISION_COLUMNS =
  'id, tenant_id, request_id, service_work_id, decision, reason, idempotency_key, content_hash, record_hash, decided_by, decided_at';

const REQUEST_STATUSES: readonly string[] = ['pending', 'approved', 'rejected'];
const DECISION_KINDS: readonly string[] = ['approve', 'reject'];

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function failTampered(rule: 'approval-request-record-tampered' | 'approval-decision-record-tampered', detail: string): never {
  throw new ApprovalStoreRuleError(detail, rule);
}

// ---------------------------------------------------------------------------
// Mapping (defensive re-validation + hash verification)
// ---------------------------------------------------------------------------

function mapRequest(row: RequestRow): ApprovalRequestRecord {
  if (!REQUEST_STATUSES.includes(row.status)) {
    failTampered('approval-request-record-tampered', `request status "${row.status}" is out of enumeration`);
  }
  const record: ApprovalRequestRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    serviceWorkId: row.service_work_id,
    workAttemptId: row.work_attempt_id,
    policyKey: row.policy_key,
    policyDecisionId: row.policy_decision_id,
    subject: row.subject,
    status: row.status as ApprovalRequestStatus,
    idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash,
    recordHash: row.record_hash,
    requestedBy: row.requested_by,
    requestedAt: toDate(row.requested_at),
    decisionId: row.decision_id,
  };
  // Read-side integrity: the record hash is recomputed over the full
  // CURRENT row core; divergence is tampering.
  if (computeApprovalRequestRecordHash(record) !== record.recordHash) {
    failTampered(
      'approval-request-record-tampered',
      `approval request ${record.id} record no longer matches its recorded integrity hash`,
    );
  }
  return record;
}

function mapDecision(row: DecisionRow): ApprovalDecisionRecord {
  if (!DECISION_KINDS.includes(row.decision)) {
    failTampered('approval-decision-record-tampered', `decision verdict "${row.decision}" is out of enumeration`);
  }
  const record: ApprovalDecisionRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    requestId: row.request_id,
    serviceWorkId: row.service_work_id,
    decision: row.decision as ApprovalDecisionKind,
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash,
    recordHash: row.record_hash,
    decidedBy: row.decided_by,
    decidedAt: toDate(row.decided_at),
  };
  if (computeApprovalDecisionRecordHash(record) !== record.recordHash) {
    failTampered(
      'approval-decision-record-tampered',
      `approval decision ${record.id} record no longer matches its recorded integrity hash`,
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Lookup helpers (tenant-predicated)
// ---------------------------------------------------------------------------

async function findRequestRowById(tx: SqlExecutor, tenantId: string, requestId: string): Promise<RequestRow | null> {
  const result = await tx.query(
    `SELECT ${REQUEST_COLUMNS} FROM approval_requests WHERE tenant_id = $1 AND id = $2`,
    [tenantId, requestId],
  );
  return (result.rows[0] as unknown as RequestRow | undefined) ?? null;
}

async function findRequestRowByKey(tx: SqlExecutor, tenantId: string, idempotencyKey: string): Promise<RequestRow | null> {
  const result = await tx.query(
    `SELECT ${REQUEST_COLUMNS} FROM approval_requests WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return (result.rows[0] as unknown as RequestRow | undefined) ?? null;
}

async function listRequestRows(
  tx: SqlExecutor,
  tenantId: string,
  filter?: { serviceWorkId?: string; workAttemptId?: string; status?: ApprovalRequestStatus; requestedBy?: string },
): Promise<RequestRow[]> {
  const where: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (filter?.serviceWorkId !== undefined) {
    params.push(filter.serviceWorkId);
    where.push(`service_work_id = $${params.length}`);
  }
  if (filter?.workAttemptId !== undefined) {
    params.push(filter.workAttemptId);
    where.push(`work_attempt_id = $${params.length}`);
  }
  if (filter?.status !== undefined) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter?.requestedBy !== undefined) {
    params.push(filter.requestedBy);
    where.push(`requested_by = $${params.length}`);
  }
  const result = await tx.query(
    `SELECT ${REQUEST_COLUMNS} FROM approval_requests WHERE ${where.join(' AND ')} ORDER BY requested_at, id`,
    params,
  );
  return result.rows as unknown as RequestRow[];
}

async function findDecisionRowById(tx: SqlExecutor, tenantId: string, decisionId: string): Promise<DecisionRow | null> {
  const result = await tx.query(
    `SELECT ${DECISION_COLUMNS} FROM approval_decisions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, decisionId],
  );
  return (result.rows[0] as unknown as DecisionRow | undefined) ?? null;
}

async function findDecisionRowByKey(tx: SqlExecutor, tenantId: string, idempotencyKey: string): Promise<DecisionRow | null> {
  const result = await tx.query(
    `SELECT ${DECISION_COLUMNS} FROM approval_decisions WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return (result.rows[0] as unknown as DecisionRow | undefined) ?? null;
}

async function findDecisionRowByRequest(tx: SqlExecutor, tenantId: string, requestId: string): Promise<DecisionRow | null> {
  const result = await tx.query(
    `SELECT ${DECISION_COLUMNS} FROM approval_decisions WHERE tenant_id = $1 AND request_id = $2`,
    [tenantId, requestId],
  );
  return (result.rows[0] as unknown as DecisionRow | undefined) ?? null;
}

async function listDecisionRows(
  tx: SqlExecutor,
  tenantId: string,
  filter?: { serviceWorkId?: string; requestId?: string; decidedBy?: string; decision?: ApprovalDecisionKind },
): Promise<DecisionRow[]> {
  const where: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (filter?.serviceWorkId !== undefined) {
    params.push(filter.serviceWorkId);
    where.push(`service_work_id = $${params.length}`);
  }
  if (filter?.requestId !== undefined) {
    params.push(filter.requestId);
    where.push(`request_id = $${params.length}`);
  }
  if (filter?.decidedBy !== undefined) {
    params.push(filter.decidedBy);
    where.push(`decided_by = $${params.length}`);
  }
  if (filter?.decision !== undefined) {
    params.push(filter.decision);
    where.push(`decision = $${params.length}`);
  }
  const result = await tx.query(
    `SELECT ${DECISION_COLUMNS} FROM approval_decisions WHERE ${where.join(' AND ')} ORDER BY decided_at, id`,
    params,
  );
  return result.rows as unknown as DecisionRow[];
}

function requestConflict(idempotencyKey: string): ApprovalStoreRuleError {
  return new ApprovalStoreRuleError(
    `approval request idempotency key "${idempotencyKey}" was already bound to different content`,
    'approval-request-input-conflict',
  );
}

function decisionInputConflict(idempotencyKey: string): ApprovalStoreRuleError {
  return new ApprovalStoreRuleError(
    `approval decision idempotency key "${idempotencyKey}" was already used for a different decision input`,
    'approval-decision-input-conflict',
  );
}

function decisionConflict(requestId: string, recorded: ApprovalDecisionRecord, attempted: ApprovalDecisionKind): ApprovalStoreRuleError {
  return new ApprovalStoreRuleError(
    `approval request ${requestId} is already terminally ${recorded.decision === 'approve' ? 'approved' : 'rejected'} (decision ${recorded.id} by ${recorded.decidedBy}); a divergent "${attempted}" decision fails closed — one terminal decision per request (the durable record arbitrates)`,
    'approval-decision-conflict',
  );
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createSqlApprovalStore(executor: TransactionalExecutor): ApprovalStore {
  return {
    async createRequest(input: CreateApprovalRequestStoreInput): Promise<{ request: ApprovalRequestRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Fast converge path: the keyed logical identity decides first.
        const existing = await findRequestRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (existing !== null) {
          if (existing.content_hash !== input.contentHash) {
            throw requestConflict(input.idempotencyKey);
          }
          return { request: mapRequest(existing), converged: true };
        }
        // Serialize this logical registration (keyed lock only: request
        // creation shares no state domain with decisions — a decide
        // names a request id that either exists durably or fails
        // approval-request-missing).
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `approval-request-key:${input.tenantId}:${input.idempotencyKey}`,
        ]);
        // POST-LOCK IDEMPOTENCY RE-CHECK (the authoritative one): a
        // racing same-key creation may have committed while this
        // transaction waited (READ COMMITTED takes a fresh snapshot per
        // statement).
        const raced = await findRequestRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (raced !== null) {
          if (raced.content_hash !== input.contentHash) {
            throw requestConflict(input.idempotencyKey);
          }
          return { request: mapRequest(raced), converged: true };
        }
        const record: ApprovalRequestRecord = {
          id: '',
          tenantId: input.tenantId,
          serviceWorkId: input.serviceWorkId,
          workAttemptId: input.workAttemptId,
          policyKey: input.policyKey,
          policyDecisionId: input.policyDecisionId,
          subject: input.subject,
          status: 'pending',
          idempotencyKey: input.idempotencyKey,
          contentHash: input.contentHash,
          recordHash: '',
          requestedBy: input.requestedBy,
          requestedAt: input.now,
          decisionId: null,
        };
        const recordHash = computeApprovalRequestRecordHash(record);
        // ON CONFLICT DO NOTHING (any unique violation): a concurrent
        // creator committed first; this transaction stays healthy for
        // the convergence re-read below.
        const inserted = await tx.query(
          `INSERT INTO approval_requests
             (tenant_id, service_work_id, work_attempt_id, policy_key, policy_decision_id, subject,
              status, idempotency_key, content_hash, record_hash, requested_by, requested_at, decision_id)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, NULL)
           ON CONFLICT DO NOTHING
           RETURNING ${REQUEST_COLUMNS}`,
          [
            input.tenantId,
            input.serviceWorkId,
            input.workAttemptId,
            input.policyKey,
            input.policyDecisionId,
            JSON.stringify(input.subject),
            'pending',
            input.idempotencyKey,
            input.contentHash,
            recordHash,
            input.requestedBy,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          const row = inserted.rows[0] as unknown as RequestRow;
          // The placeholder id was hashed as ''; the RETURNING row
          // carries the hash the INSERT stored — mapping verifies it
          // end to end.
          return { request: mapRequest(row), converged: false };
        }
        // A concurrent registration committed first: converge when the
        // key matches, fail closed otherwise.
        const byKey = await findRequestRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (byKey === null) {
          throw new ApprovalStoreConflictError('createRequest violated a uniqueness constraint', 'approval_requests_identity');
        }
        if (byKey.content_hash !== input.contentHash) {
          throw requestConflict(input.idempotencyKey);
        }
        return { request: mapRequest(byKey), converged: true };
      });
    },

    async findRequest(tenantId: string, requestId: string): Promise<ApprovalRequestRecord | null> {
      const result = await executor.query(
        `SELECT ${REQUEST_COLUMNS} FROM approval_requests WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requestId],
      );
      const row = result.rows[0] as unknown as RequestRow | undefined;
      return row === undefined ? null : mapRequest(row);
    },

    async findRequestByKey(tenantId: string, idempotencyKey: string): Promise<ApprovalRequestRecord | null> {
      const result = await executor.query(
        `SELECT ${REQUEST_COLUMNS} FROM approval_requests WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      const row = result.rows[0] as unknown as RequestRow | undefined;
      return row === undefined ? null : mapRequest(row);
    },

    async listRequests(
      tenantId: string,
      filter?: { serviceWorkId?: string; workAttemptId?: string; status?: ApprovalRequestStatus; requestedBy?: string },
    ): Promise<ApprovalRequestRecord[]> {
      const rows = await listRequestRows(executor, tenantId, filter);
      return rows.map((row) => mapRequest(row));
    },

    async decide(input: DecideApprovalStoreInput): Promise<{
      request: ApprovalRequestRecord;
      decision: ApprovalDecisionRecord;
      converged: boolean;
    }> {
      return executor.withTransaction(async (tx) => {
        // THE serialized terminal arbitration. Deadlock-free lock
        // order (every decision writer): the keyed lock first, the
        // request-state lock second.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `approval-decision-key:${input.tenantId}:${input.idempotencyKey}`,
        ]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `approval-request:${input.tenantId}:${input.requestId}`,
        ]);
        // POST-LOCK KEYED RE-CHECK: an identical re-run of the same
        // logical decision converges; a same-key run over a DIFFERENT
        // decision input fails closed.
        const existingByKey = await findDecisionRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (existingByKey !== null) {
          if (existingByKey.content_hash !== input.contentHash) {
            throw decisionInputConflict(input.idempotencyKey);
          }
          const request = await requireRequestRow(tx, input.tenantId, input.requestId);
          return { request: mapRequest(request), decision: mapDecision(existingByKey), converged: true };
        }
        // The request's DURABLE state arbitrates (read AFTER the
        // locks: READ COMMITTED takes a fresh snapshot per statement —
        // every decision serialized before this point is visible).
        const requestRow = await requireRequestRow(tx, input.tenantId, input.requestId);
        if (requestRow.status !== 'pending') {
          // TERMINAL ARBITRATION: the durable terminal decision is the
          // authority. A matching verdict re-observes it (converges,
          // any key); a divergent verdict fails closed — the loser of
          // a simultaneous approve/reject race.
          const terminal = await findDecisionRowByRequest(tx, input.tenantId, input.requestId);
          if (terminal === null) {
            throw new ApprovalStoreConflictError(
              `approval request ${input.requestId} is terminal ("${requestRow.status}") but has no decision row`,
              'approval_decisions_request_terminal',
            );
          }
          if (terminal.decision !== input.decision) {
            throw decisionConflict(input.requestId, mapDecision(terminal), input.decision);
          }
          return { request: mapRequest(requestRow), decision: mapDecision(terminal), converged: true };
        }
        // Record the immutable decision row (ON CONFLICT DO NOTHING:
        // any unique violation — keyed identity or the one-terminal-
        // decision backstop — is re-read and converges or fails
        // closed below).
        const decisionRecord: ApprovalDecisionRecord = {
          id: '',
          tenantId: input.tenantId,
          requestId: input.requestId,
          serviceWorkId: requestRow.service_work_id,
          decision: input.decision,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          contentHash: input.contentHash,
          recordHash: '',
          decidedBy: input.decidedBy,
          decidedAt: input.now,
        };
        const decisionRecordHash = computeApprovalDecisionRecordHash(decisionRecord);
        const insertedDecision = await tx.query(
          `INSERT INTO approval_decisions
             (tenant_id, request_id, service_work_id, decision, reason, idempotency_key, content_hash, record_hash, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING
           RETURNING ${DECISION_COLUMNS}`,
          [
            input.tenantId,
            input.requestId,
            requestRow.service_work_id,
            input.decision,
            input.reason,
            input.idempotencyKey,
            input.contentHash,
            decisionRecordHash,
            input.decidedBy,
            input.now,
          ],
        );
        let decisionRow: DecisionRow;
        let converged = false;
        if (insertedDecision.rows.length > 0) {
          decisionRow = insertedDecision.rows[0] as unknown as DecisionRow;
        } else {
          // A racing decision committed first: keyed convergence or
          // the terminal backstop decides.
          const racedKey = await findDecisionRowByKey(tx, input.tenantId, input.idempotencyKey);
          if (racedKey !== null) {
            if (racedKey.content_hash !== input.contentHash) {
              throw decisionInputConflict(input.idempotencyKey);
            }
            decisionRow = racedKey;
            converged = true;
          } else {
            const racedTerminal = await findDecisionRowByRequest(tx, input.tenantId, input.requestId);
            if (racedTerminal === null) {
              throw new ApprovalStoreConflictError(
                'decide violated a uniqueness constraint',
                'approval_decisions_identity',
              );
            }
            if (racedTerminal.decision !== input.decision) {
              throw decisionConflict(input.requestId, mapDecision(racedTerminal), input.decision);
            }
            decisionRow = racedTerminal;
            converged = true;
          }
        }
        // THE GUARDED STATE FLIP: pending -> terminal, exactly once.
        // The decision writer holds the request advisory lock, so the
        // guard is a backstop — but it keeps the state flip atomic
        // with the decision row even against any path that did not
        // take the lock.
        const newStatus = input.decision === 'approve' ? 'approved' : 'rejected';
        const updatedRequest: ApprovalRequestRecord = {
          id: requestRow.id,
          tenantId: requestRow.tenant_id,
          serviceWorkId: requestRow.service_work_id,
          workAttemptId: requestRow.work_attempt_id,
          policyKey: requestRow.policy_key,
          policyDecisionId: requestRow.policy_decision_id,
          subject: requestRow.subject,
          status: newStatus,
          idempotencyKey: requestRow.idempotency_key,
          contentHash: requestRow.content_hash,
          recordHash: '',
          requestedBy: requestRow.requested_by,
          requestedAt: toDate(requestRow.requested_at),
          decisionId: decisionRow.id,
        };
        const updatedRecordHash = computeApprovalRequestRecordHash(updatedRequest);
        const flipped = await tx.query(
          `UPDATE approval_requests
             SET status = $1, decision_id = $2, record_hash = $3
           WHERE tenant_id = $4 AND id = $5 AND status = 'pending'
           RETURNING ${REQUEST_COLUMNS}`,
          [newStatus, decisionRow.id, updatedRecordHash, input.tenantId, input.requestId],
        );
        if (flipped.rows.length > 0) {
          const row = flipped.rows[0] as unknown as RequestRow;
          return { request: mapRequest(row), decision: mapDecision(decisionRow), converged };
        }
        // The flip found the request already terminal (a racing
        // decision committed between the read and the flip): the
        // durable terminal decision arbitrates — converge on a
        // matching verdict, fail closed on divergence. The decision
        // row this transaction inserted is rolled back with it.
        const terminal = await findDecisionRowByRequest(tx, input.tenantId, input.requestId);
        if (terminal === null) {
          throw new ApprovalStoreConflictError(
            `approval request ${input.requestId} is terminal but has no decision row`,
            'approval_decisions_request_terminal',
          );
        }
        if (terminal.decision !== input.decision) {
          throw decisionConflict(input.requestId, mapDecision(terminal), input.decision);
        }
        const finalRequest = await requireRequestRow(tx, input.tenantId, input.requestId);
        return { request: mapRequest(finalRequest), decision: mapDecision(terminal), converged: true };
      });
    },

    async findDecision(tenantId: string, decisionId: string): Promise<ApprovalDecisionRecord | null> {
      const result = await executor.query(
        `SELECT ${DECISION_COLUMNS} FROM approval_decisions WHERE tenant_id = $1 AND id = $2`,
        [tenantId, decisionId],
      );
      const row = result.rows[0] as unknown as DecisionRow | undefined;
      return row === undefined ? null : mapDecision(row);
    },

    async findDecisionByKey(tenantId: string, idempotencyKey: string): Promise<ApprovalDecisionRecord | null> {
      const result = await executor.query(
        `SELECT ${DECISION_COLUMNS} FROM approval_decisions WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      const row = result.rows[0] as unknown as DecisionRow | undefined;
      return row === undefined ? null : mapDecision(row);
    },

    async findDecisionByRequest(tenantId: string, requestId: string): Promise<ApprovalDecisionRecord | null> {
      const result = await executor.query(
        `SELECT ${DECISION_COLUMNS} FROM approval_decisions WHERE tenant_id = $1 AND request_id = $2`,
        [tenantId, requestId],
      );
      const row = result.rows[0] as unknown as DecisionRow | undefined;
      return row === undefined ? null : mapDecision(row);
    },

    async listDecisions(
      tenantId: string,
      filter?: { serviceWorkId?: string; requestId?: string; decidedBy?: string; decision?: ApprovalDecisionKind },
    ): Promise<ApprovalDecisionRecord[]> {
      const rows = await listDecisionRows(executor, tenantId, filter);
      return rows.map((row) => mapDecision(row));
    },
  };
}

/** The request row must exist in the tenant; typed missing otherwise. */
async function requireRequestRow(tx: SqlExecutor, tenantId: string, requestId: string): Promise<RequestRow> {
  const row = await findRequestRowById(tx, tenantId, requestId);
  if (row === null) {
    throw new ApprovalStoreMissingError('request', requestId);
  }
  return row;
}
