/**
 * ServiceOS /evidence SQL store (WORK-007, module internal).
 *
 * Authoritative persistence for the business-evidence ledger and the
 * outcome-verification decision ledger, executed through the
 * persistence boundary's `TransactionalExecutor` (parameterized SQL
 * only; this file never imports `pg`). Load-bearing invariants:
 *
 * 1. MANDATORY TENANT PREDICATES on every query.
 *
 * 2. SERIALIZED CRITICAL SECTIONS under transaction-scope advisory
 *    locks, ALWAYS in the deadlock-free order (keyed lock first, the
 *    work's evidence-state lock second): evidence attach locks
 *    (tenant, idempotency key) + (tenant, work) evidence state;
 *    verification recording locks (tenant, idempotency key) + (tenant,
 *    work) evidence state — attaches and verifications of ONE work are
 *    mutually serialized, so a decision never observes a torn evidence
 *    state and an attach never slips between a decision's read and its
 *    write. The POST-LOCK IDEMPOTENCY RE-CHECK makes the keyed-conflict
 *    codes identical under a true race (the WORK-009 live-verification
 *    defect class).
 *
 * 3. CONVERGENCE with `ON CONFLICT DO NOTHING` (any unique violation):
 *    a suppressed insert is re-read INSIDE the same healthy transaction
 *    and converges — content hash compared — or fails closed with the
 *    typed store rule.
 *
 * 4. THE DECISION IS COMPUTED INSIDE THE CRITICAL SECTION: the module
 *    injects the PURE evaluator; the store calls it with the locked,
 *    committed evidence rows (the WORK-011 discipline: authority in
 *    index.ts, atomicity in the store).
 *
 * 5. IMMUTABLE LEDGERS (architecture-lock #4): evidence rows and
 *    verification rows are append-only — no UPDATE statement exists.
 *
 * 6. RECORD INTEGRITY: every read re-validates shapes defensively and
 *    recomputes BOTH persisted hashes; any divergence fails closed
 *    (`evidence-record-tampered` / `verification-record-tampered`).
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import {
  computeEvidenceContentHash,
  computeEvidenceRecordHash,
  computeVerificationRecordHash,
  computeVerificationContentHash,
} from './content.js';
import type { OutcomeEvaluation, OutcomeVerificationMode } from './contract.js';
import {
  EvidenceStoreMissingError,
  EvidenceStoreRuleError,
  EvidenceStoreConflictError,
  type AttachEvidenceStoreInput,
  type EvidenceRecord,
  type EvidenceStore,
  type OutcomeVerificationRecord,
  type RecordVerificationStoreInput,
} from './store.js';

// ---------------------------------------------------------------------------
// Row shapes and columns
// ---------------------------------------------------------------------------

interface EvidenceRow {
  id: string;
  tenant_id: string;
  service_work_id: string;
  work_attempt_id: string | null;
  requirement: string;
  provenance: unknown;
  payload: unknown;
  observed_at: Date | string;
  idempotency_key: string;
  content_hash: string;
  record_hash: string;
  attached_by: string;
  attached_at: Date | string;
}

interface VerificationRow {
  id: string;
  tenant_id: string;
  service_work_id: string;
  outcome_id: string;
  verification_mode: string;
  requirements: unknown;
  verdict: string;
  requirement_results: unknown;
  idempotency_key: string;
  content_hash: string;
  record_hash: string;
  decided_by: string;
  decided_at: Date | string;
}

const EVIDENCE_COLUMNS =
  'id, tenant_id, service_work_id, work_attempt_id, requirement, provenance, payload, observed_at, idempotency_key, content_hash, record_hash, attached_by, attached_at';
const VERIFICATION_COLUMNS =
  'id, tenant_id, service_work_id, outcome_id, verification_mode, requirements, verdict, requirement_results, idempotency_key, content_hash, record_hash, decided_by, decided_at';

const PROVENANCE_KINDS: readonly string[] = [
  'operator_attestation',
  'system_observation',
  'external_record',
  'customer_approval',
  'calculation',
];
const VERIFICATION_MODES: readonly string[] = ['deterministic', 'human_approval', 'external_record'];

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function failTampered(rule: 'evidence-record-tampered' | 'verification-record-tampered', detail: string): never {
  throw new EvidenceStoreRuleError(detail, rule);
}

// ---------------------------------------------------------------------------
// Mapping (defensive re-validation + hash verification)
// ---------------------------------------------------------------------------

function mapProvenance(raw: unknown): { readonly kind: string; readonly source: string; readonly refs: readonly string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    failTampered('evidence-record-tampered', 'column "provenance" is not an object');
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.kind !== 'string' || !PROVENANCE_KINDS.includes(candidate.kind)) {
    failTampered('evidence-record-tampered', `provenance kind "${String(candidate.kind)}" is out of enumeration`);
  }
  if (typeof candidate.source !== 'string' || candidate.source.trim() === '') {
    failTampered('evidence-record-tampered', 'provenance source is not a non-empty string');
  }
  if (!Array.isArray(candidate.refs)) {
    failTampered('evidence-record-tampered', 'provenance refs is not an array');
  }
  for (const entry of candidate.refs) {
    if (typeof entry !== 'string') {
      failTampered('evidence-record-tampered', 'provenance refs carries a non-string entry');
    }
  }
  return Object.freeze({ kind: candidate.kind, source: candidate.source, refs: Object.freeze([...candidate.refs] as string[]) });
}

function mapEvidence(row: EvidenceRow): EvidenceRecord {
  const record: EvidenceRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    serviceWorkId: row.service_work_id,
    workAttemptId: row.work_attempt_id,
    requirement: row.requirement,
    provenance: mapProvenance(row.provenance),
    payload: row.payload,
    observedAt: toDate(row.observed_at),
    idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash,
    recordHash: row.record_hash,
    attachedBy: row.attached_by,
    attachedAt: toDate(row.attached_at),
  };
  // Read-side integrity: both hashes are recomputed; divergence is tampering.
  if (
    computeEvidenceContentHash({
      tenantId: record.tenantId,
      serviceWorkId: record.serviceWorkId,
      workAttemptId: record.workAttemptId,
      requirement: record.requirement,
      provenance: record.provenance,
      payload: record.payload,
      observedAt: record.observedAt,
    }) !== record.contentHash
  ) {
    failTampered('evidence-record-tampered', `evidence record ${record.id} content no longer matches its recorded content hash`);
  }
  if (computeEvidenceRecordHash(record) !== record.recordHash) {
    failTampered('evidence-record-tampered', `evidence record ${record.id} record no longer matches its recorded integrity hash`);
  }
  return record;
}

function mapRequirements(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    failTampered('verification-record-tampered', 'column "requirements" is not an array');
  }
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      failTampered('verification-record-tampered', 'column "requirements" carries a non-string entry');
    }
  }
  return Object.freeze([...raw] as string[]);
}

function mapRequirementResults(raw: unknown): readonly {
  readonly requirement: string;
  readonly satisfied: boolean;
  readonly evidenceIds: readonly string[];
}[] {
  if (!Array.isArray(raw)) {
    failTampered('verification-record-tampered', 'column "requirement_results" is not an array');
  }
  const results: { requirement: string; satisfied: boolean; evidenceIds: readonly string[] }[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      failTampered('verification-record-tampered', 'each requirement result must be an object');
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.requirement !== 'string') {
      failTampered('verification-record-tampered', 'a requirement result carries a non-string requirement');
    }
    if (typeof candidate.satisfied !== 'boolean') {
      failTampered('verification-record-tampered', `requirement result "${candidate.requirement}" carries a non-boolean satisfied flag`);
    }
    if (!Array.isArray(candidate.evidenceIds)) {
      failTampered('verification-record-tampered', `requirement result "${candidate.requirement}" evidenceIds is not an array`);
    }
    for (const id of candidate.evidenceIds) {
      if (typeof id !== 'string') {
        failTampered('verification-record-tampered', `requirement result "${candidate.requirement}" evidenceIds carries a non-string entry`);
      }
    }
    results.push({
      requirement: candidate.requirement,
      satisfied: candidate.satisfied,
      evidenceIds: Object.freeze([...candidate.evidenceIds] as string[]),
    });
  }
  return Object.freeze(results);
}

function mapVerification(row: VerificationRow): OutcomeVerificationRecord {
  if (row.verdict !== 'satisfied' && row.verdict !== 'not_satisfied') {
    failTampered('verification-record-tampered', `verdict "${row.verdict}" is out of enumeration`);
  }
  if (!VERIFICATION_MODES.includes(row.verification_mode)) {
    failTampered('verification-record-tampered', `verification mode "${row.verification_mode}" is out of enumeration`);
  }
  const record: OutcomeVerificationRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    serviceWorkId: row.service_work_id,
    outcomeId: row.outcome_id,
    verificationMode: row.verification_mode as OutcomeVerificationMode,
    requirements: mapRequirements(row.requirements),
    verdict: row.verdict,
    requirementResults: mapRequirementResults(row.requirement_results),
    idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash,
    recordHash: row.record_hash,
    decidedBy: row.decided_by,
    decidedAt: toDate(row.decided_at),
  };
  if (computeVerificationRecordHash(record) !== record.recordHash) {
    failTampered('verification-record-tampered', `outcome verification ${record.id} record no longer matches its recorded integrity hash`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Lookup helpers (tenant-predicated)
// ---------------------------------------------------------------------------

async function findEvidenceRowById(tx: SqlExecutor, tenantId: string, evidenceId: string): Promise<EvidenceRow | null> {
  const result = await tx.query(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence_records WHERE tenant_id = $1 AND id = $2`,
    [tenantId, evidenceId],
  );
  return (result.rows[0] as unknown as EvidenceRow | undefined) ?? null;
}

async function findEvidenceRowByKey(tx: SqlExecutor, tenantId: string, idempotencyKey: string): Promise<EvidenceRow | null> {
  const result = await tx.query(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence_records WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return (result.rows[0] as unknown as EvidenceRow | undefined) ?? null;
}

async function findEvidenceRowByContent(
  tx: SqlExecutor,
  tenantId: string,
  serviceWorkId: string,
  contentHash: string,
): Promise<EvidenceRow | null> {
  const result = await tx.query(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence_records WHERE tenant_id = $1 AND service_work_id = $2 AND content_hash = $3`,
    [tenantId, serviceWorkId, contentHash],
  );
  return (result.rows[0] as unknown as EvidenceRow | undefined) ?? null;
}

async function listEvidenceRows(
  tx: SqlExecutor,
  tenantId: string,
  filter?: { serviceWorkId?: string; workAttemptId?: string; requirement?: string },
): Promise<EvidenceRow[]> {
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
  if (filter?.requirement !== undefined) {
    params.push(filter.requirement);
    where.push(`requirement = $${params.length}`);
  }
  const result = await tx.query(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence_records WHERE ${where.join(' AND ')} ORDER BY attached_at, id`,
    params,
  );
  return result.rows as unknown as EvidenceRow[];
}

async function findVerificationRowById(tx: SqlExecutor, tenantId: string, verificationId: string): Promise<VerificationRow | null> {
  const result = await tx.query(
    `SELECT ${VERIFICATION_COLUMNS} FROM evidence_outcome_verifications WHERE tenant_id = $1 AND id = $2`,
    [tenantId, verificationId],
  );
  return (result.rows[0] as unknown as VerificationRow | undefined) ?? null;
}

async function findVerificationRowByKey(tx: SqlExecutor, tenantId: string, idempotencyKey: string): Promise<VerificationRow | null> {
  const result = await tx.query(
    `SELECT ${VERIFICATION_COLUMNS} FROM evidence_outcome_verifications WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return (result.rows[0] as unknown as VerificationRow | undefined) ?? null;
}

function keyedEvidenceConflict(idempotencyKey: string): EvidenceStoreRuleError {
  return new EvidenceStoreRuleError(
    `evidence idempotency key "${idempotencyKey}" was already bound to different content`,
    'evidence-input-conflict',
  );
}

function verificationConflict(idempotencyKey: string): EvidenceStoreRuleError {
  return new EvidenceStoreRuleError(
    `verification idempotency key "${idempotencyKey}" already holds a decision over a different input; the evidence state or contract changed since that decision and a re-verification is a new logical decision (use a new idempotency key)`,
    'verification-input-conflict',
  );
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createSqlEvidenceStore(executor: TransactionalExecutor): EvidenceStore {
  return {
    async attachEvidence(input: AttachEvidenceStoreInput): Promise<{ evidence: EvidenceRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Fast converge path: an existing logical registration or an
        // existing content row (the same fact) decides immediately.
        const existingKey = await findEvidenceRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (existingKey !== null) {
          if (existingKey.content_hash !== input.contentHash) {
            throw keyedEvidenceConflict(input.idempotencyKey);
          }
          return { evidence: mapEvidence(existingKey), converged: true };
        }
        const existingContent = await findEvidenceRowByContent(tx, input.tenantId, input.serviceWorkId, input.contentHash);
        if (existingContent !== null) {
          return { evidence: mapEvidence(existingContent), converged: true };
        }
        // Serialize this logical registration AND the work's evidence
        // state (deadlock-free order: keyed lock first, state second).
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `evidence-key:${input.tenantId}:${input.idempotencyKey}`,
        ]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `evidence-state:${input.tenantId}:${input.serviceWorkId}`,
        ]);
        // POST-LOCK IDEMPOTENCY RE-CHECK (the authoritative one): a
        // racing same-key registration or a racing duplicate fact may
        // have committed while this transaction waited — invisible to
        // the pre-lock statement snapshot, decisive here (READ
        // COMMITTED takes a fresh snapshot per statement).
        const racedKey = await findEvidenceRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (racedKey !== null) {
          if (racedKey.content_hash !== input.contentHash) {
            throw keyedEvidenceConflict(input.idempotencyKey);
          }
          return { evidence: mapEvidence(racedKey), converged: true };
        }
        const racedContent = await findEvidenceRowByContent(tx, input.tenantId, input.serviceWorkId, input.contentHash);
        if (racedContent !== null) {
          return { evidence: mapEvidence(racedContent), converged: true };
        }
        // ON CONFLICT DO NOTHING (any unique violation): a concurrent
        // creator committed first; this transaction stays healthy for
        // the convergence re-read below.
        const inserted = await tx.query(
          `INSERT INTO evidence_records
             (tenant_id, service_work_id, work_attempt_id, requirement, provenance, payload, observed_at,
              idempotency_key, content_hash, record_hash, attached_by, attached_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)
           ON CONFLICT DO NOTHING
           RETURNING ${EVIDENCE_COLUMNS}`,
          [
            input.tenantId,
            input.serviceWorkId,
            input.workAttemptId,
            input.requirement,
            JSON.stringify(input.provenance),
            JSON.stringify(input.payload),
            input.observedAt,
            input.idempotencyKey,
            input.contentHash,
            computeEvidenceRecordHash({
              id: '',
              tenantId: input.tenantId,
              serviceWorkId: input.serviceWorkId,
              workAttemptId: input.workAttemptId,
              requirement: input.requirement,
              provenance: input.provenance,
              payload: input.payload,
              observedAt: input.observedAt,
              idempotencyKey: input.idempotencyKey,
              contentHash: input.contentHash,
              recordHash: '',
              attachedBy: input.attachedBy,
              attachedAt: input.now,
            }),
            input.attachedBy,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          const row = inserted.rows[0] as unknown as EvidenceRow;
          // The placeholder id was hashed as ''; the RETURNING row
          // carries the hash the INSERT stored — mapping verifies it
          // end to end.
          return { evidence: mapEvidence(row), converged: false };
        }
        // A concurrent registration committed first: converge when the
        // key or the content matches, fail closed otherwise.
        const byKey = await findEvidenceRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (byKey !== null) {
          if (byKey.content_hash !== input.contentHash) {
            throw keyedEvidenceConflict(input.idempotencyKey);
          }
          return { evidence: mapEvidence(byKey), converged: true };
        }
        const byContent = await findEvidenceRowByContent(tx, input.tenantId, input.serviceWorkId, input.contentHash);
        if (byContent !== null) {
          return { evidence: mapEvidence(byContent), converged: true };
        }
        throw new EvidenceStoreConflictError('attachEvidence violated a uniqueness constraint', 'evidence_records_identity');
      });
    },

    async findEvidence(tenantId: string, evidenceId: string): Promise<EvidenceRecord | null> {
      const result = await executor.query(
        `SELECT ${EVIDENCE_COLUMNS} FROM evidence_records WHERE tenant_id = $1 AND id = $2`,
        [tenantId, evidenceId],
      );
      const row = result.rows[0] as unknown as EvidenceRow | undefined;
      return row === undefined ? null : mapEvidence(row);
    },

    async findEvidenceByKey(tenantId: string, idempotencyKey: string): Promise<EvidenceRecord | null> {
      const result = await executor.query(
        `SELECT ${EVIDENCE_COLUMNS} FROM evidence_records WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      const row = result.rows[0] as unknown as EvidenceRow | undefined;
      return row === undefined ? null : mapEvidence(row);
    },

    async findEvidenceByContent(
      tenantId: string,
      serviceWorkId: string,
      contentHash: string,
    ): Promise<EvidenceRecord | null> {
      const result = await executor.query(
        `SELECT ${EVIDENCE_COLUMNS} FROM evidence_records WHERE tenant_id = $1 AND service_work_id = $2 AND content_hash = $3`,
        [tenantId, serviceWorkId, contentHash],
      );
      const row = result.rows[0] as unknown as EvidenceRow | undefined;
      return row === undefined ? null : mapEvidence(row);
    },

    async listEvidence(
      tenantId: string,
      filter?: { serviceWorkId?: string; workAttemptId?: string; requirement?: string },
    ): Promise<EvidenceRecord[]> {
      const rows = await listEvidenceRows(executor, tenantId, filter);
      return rows.map((row) => mapEvidence(row));
    },

    async recordVerification(
      input: RecordVerificationStoreInput,
    ): Promise<{ verification: OutcomeVerificationRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Serialize this logical decision AND the work's evidence state
        // (deadlock-free order: keyed lock first, state second). The
        // decision below is computed over exactly the state these
        // locks serialize: an attach cannot slip between the evidence
        // read and the decision write.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `evidence-verification-key:${input.tenantId}:${input.idempotencyKey}`,
        ]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `evidence-state:${input.tenantId}:${input.serviceWorkId}`,
        ]);
        // The committed evidence state, read AFTER the locks (READ
        // COMMITTED takes a fresh snapshot per statement: every
        // attach serialized before this point is visible).
        const evidenceRows = await listEvidenceRows(tx, input.tenantId, { serviceWorkId: input.serviceWorkId });
        const evidence = evidenceRows.map((row) => mapEvidence(row));
        // The module-owned PURE evaluator computes the decision INSIDE
        // the critical section (authority in index.ts, atomicity here).
        const evaluation: OutcomeEvaluation = input.evaluate(evidence);
        const contentHash = computeVerificationContentHash({
          tenantId: input.tenantId,
          serviceWorkId: input.serviceWorkId,
          outcomeId: input.outcomeId,
          verificationMode: input.verificationMode,
          requirements: input.requirements,
          evidenceSnapshot: evaluation.evidenceSnapshot,
        });
        // POST-LOCK KEYED RE-CHECK: an identical re-run of the same
        // logical decision converges; a same-key run over a CHANGED
        // input (evidence state or contract) fails closed.
        const existing = await findVerificationRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (existing !== null) {
          if (existing.content_hash !== contentHash) {
            throw verificationConflict(input.idempotencyKey);
          }
          return { verification: mapVerification(existing), converged: true };
        }
        const inserted = await tx.query(
          `INSERT INTO evidence_outcome_verifications
             (tenant_id, service_work_id, outcome_id, verification_mode, requirements, verdict, requirement_results,
              idempotency_key, content_hash, record_hash, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12)
           ON CONFLICT DO NOTHING
           RETURNING ${VERIFICATION_COLUMNS}`,
          [
            input.tenantId,
            input.serviceWorkId,
            input.outcomeId,
            input.verificationMode,
            JSON.stringify([...input.requirements]),
            evaluation.verdict,
            JSON.stringify(evaluation.requirementResults),
            input.idempotencyKey,
            contentHash,
            computeVerificationRecordHash({
              id: '',
              tenantId: input.tenantId,
              serviceWorkId: input.serviceWorkId,
              outcomeId: input.outcomeId,
              verificationMode: input.verificationMode,
              requirements: input.requirements,
              verdict: evaluation.verdict,
              requirementResults: evaluation.requirementResults,
              idempotencyKey: input.idempotencyKey,
              contentHash,
              recordHash: '',
              decidedBy: input.decidedBy,
              decidedAt: input.now,
            }),
            input.decidedBy,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          const row = inserted.rows[0] as unknown as VerificationRow;
          return { verification: mapVerification(row), converged: false };
        }
        // A racing same-key decision committed first: identical input
        // converges, divergent input fails closed.
        const raced = await findVerificationRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (raced === null) {
          throw new EvidenceStoreConflictError(
            'recordVerification violated a uniqueness constraint',
            'evidence_outcome_verifications_identity',
          );
        }
        if (raced.content_hash !== contentHash) {
          throw verificationConflict(input.idempotencyKey);
        }
        return { verification: mapVerification(raced), converged: true };
      });
    },

    async findVerification(tenantId: string, verificationId: string): Promise<OutcomeVerificationRecord | null> {
      const result = await executor.query(
        `SELECT ${VERIFICATION_COLUMNS} FROM evidence_outcome_verifications WHERE tenant_id = $1 AND id = $2`,
        [tenantId, verificationId],
      );
      const row = result.rows[0] as unknown as VerificationRow | undefined;
      return row === undefined ? null : mapVerification(row);
    },

    async findVerificationByKey(tenantId: string, idempotencyKey: string): Promise<OutcomeVerificationRecord | null> {
      const result = await executor.query(
        `SELECT ${VERIFICATION_COLUMNS} FROM evidence_outcome_verifications WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      const row = result.rows[0] as unknown as VerificationRow | undefined;
      return row === undefined ? null : mapVerification(row);
    },

    async listVerifications(
      tenantId: string,
      filter?: { serviceWorkId?: string; outcomeId?: string; verdict?: 'satisfied' | 'not_satisfied' },
    ): Promise<OutcomeVerificationRecord[]> {
      const where: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (filter?.serviceWorkId !== undefined) {
        params.push(filter.serviceWorkId);
        where.push(`service_work_id = $${params.length}`);
      }
      if (filter?.outcomeId !== undefined) {
        params.push(filter.outcomeId);
        where.push(`outcome_id = $${params.length}`);
      }
      if (filter?.verdict !== undefined) {
        params.push(filter.verdict);
        where.push(`verdict = $${params.length}`);
      }
      const result = await executor.query(
        `SELECT ${VERIFICATION_COLUMNS} FROM evidence_outcome_verifications WHERE ${where.join(' AND ')} ORDER BY decided_at, id`,
        params,
      );
      return (result.rows as unknown as VerificationRow[]).map((row) => mapVerification(row));
    },
  };
}
