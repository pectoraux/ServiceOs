/**
 * ServiceOS /zeck SQL store (WORK-005, module internal).
 *
 * Authoritative persistence for execution intents (the business-side
 * linkage to foreign Zeck execution references) and the translated
 * callback delivery ledger, executed through the persistence boundary's
 * `TransactionalExecutor` (parameterized SQL only; this file never
 * imports `pg`). Load-bearing invariants:
 *
 * 1. MANDATORY TENANT PREDICATES on every query.
 *
 * 2. SERIALIZED CRITICAL SECTIONS under transaction-scope advisory
 *    locks: intent registration locks (tenant, idempotency key); the
 *    reference attach locks (tenant, intent); callback recording locks
 *    (tenant, event id). The POST-LOCK IDEMPOTENCY RE-CHECK makes the
 *    keyed-conflict codes identical under a true race (the WORK-009
 *    live-verification defect class).
 *
 * 3. CONVERGENCE with `ON CONFLICT DO NOTHING` (any unique violation):
 *    a suppressed insert is re-read INSIDE the same healthy transaction
 *    and converges — content/delivery hash compared — or fails closed
 *    with the typed store rule.
 *
 * 4. CROSS-WRITE SERIALIZATION ON THE INTENT ROW: the attach and the
 *    accepted-callback cursor touch both re-read the intent row
 *    `FOR UPDATE` and recompute the record hash over the LOCKED, FRESH
 *    row state (one clock read per write). Row-level locking serializes
 *    these two physical writers; the advisory locks arbitrate the
 *    logical identities. A stale-hash write can never occur.
 *
 * 5. NO SHADOW ZECK LIFECYCLE (architecture-lock #19): intents carry a
 *    foreign reference + ingestion cursor, never an execution status;
 *    events are immutable delivery observations. There is no execution
 *    state machine anywhere in this schema.
 *
 * 6. RECORD INTEGRITY: every read re-validates shapes defensively and
 *    recomputes BOTH persisted hashes; any divergence fails closed
 *    (`intent-record-tampered` / `event-record-tampered`).
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { computeEventRecordHash, computeIntentContentHash, computeIntentRecordHash } from './content.js';
import {
  ZeckStoreMissingError,
  ZeckStoreRuleError,
  ZeckStoreConflictError,
  type AttachReferenceInput,
  type CallbackDisposition,
  type CallbackRejectionCode,
  type RecordCallbackEventStoreInput,
  type RegisterIntentStoreInput,
  type ZeckCallbackEventRecord,
  type ZeckIntentRecord,
  type ZeckStore,
} from './store.js';
import type { ZeckResultObservation } from './contract.js';

// ---------------------------------------------------------------------------
// Row shapes and columns
// ---------------------------------------------------------------------------

interface IntentRow {
  id: string;
  tenant_id: string;
  service_work_id: string;
  work_attempt_id: string;
  objective: string;
  input_artifact_refs: unknown;
  business_context: unknown;
  required_capabilities: unknown;
  business_constraints: unknown;
  output_contract: unknown;
  idempotency_key: string;
  content_hash: string;
  record_hash: string;
  created_by: string;
  zeck_execution_id: string | null;
  zeck_application_ref: string | null;
  submitted_by: string | null;
  submitted_at: Date | string | null;
  last_seen_event_id: string | null;
  last_seen_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EventRow {
  id: string;
  tenant_id: string;
  event_id: string;
  event_type: string;
  zeck_execution_id: string | null;
  intent_id: string | null;
  disposition: string;
  rejection_code: string | null;
  observed: unknown;
  delivery_hash: string;
  record_hash: string;
  received_by: string;
  received_at: Date | string;
}

const INTENT_COLUMNS =
  'id, tenant_id, service_work_id, work_attempt_id, objective, input_artifact_refs, business_context, required_capabilities, business_constraints, output_contract, idempotency_key, content_hash, record_hash, created_by, zeck_execution_id, zeck_application_ref, submitted_by, submitted_at, last_seen_event_id, last_seen_at, created_at, updated_at';
const EVENT_COLUMNS =
  'id, tenant_id, event_id, event_type, zeck_execution_id, intent_id, disposition, rejection_code, observed, delivery_hash, record_hash, received_by, received_at';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function failTampered(rule: 'intent-record-tampered' | 'event-record-tampered', detail: string): never {
  throw new ZeckStoreRuleError(detail, rule);
}

// ---------------------------------------------------------------------------
// Mapping (defensive re-validation + hash verification)
// ---------------------------------------------------------------------------

function mapStringArray(raw: unknown, rule: 'intent-record-tampered', what: string): readonly string[] {
  if (!Array.isArray(raw)) {
    failTampered(rule, `column "${what}" is not an array`);
  }
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      failTampered(rule, `column "${what}" carries a non-string entry`);
    }
  }
  return Object.freeze([...raw] as string[]);
}

function mapRequiredCapabilities(raw: unknown, rule: 'intent-record-tampered'): readonly unknown[] {
  if (!Array.isArray(raw)) {
    failTampered(rule, 'column "required_capabilities" is not an array');
  }
  return Object.freeze([...raw]);
}

function mapStringMap(raw: unknown, rule: 'intent-record-tampered', what: string): Readonly<Record<string, string>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    failTampered(rule, `column "${what}" is not an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      failTampered(rule, `column "${what}" carries a non-string entry`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function mapIntent(row: IntentRow): ZeckIntentRecord {
  const record: ZeckIntentRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    serviceWorkId: row.service_work_id,
    workAttemptId: row.work_attempt_id,
    objective: row.objective,
    inputArtifactRefs: mapStringArray(row.input_artifact_refs, 'intent-record-tampered', 'input_artifact_refs'),
    businessContext: mapStringMap(row.business_context, 'intent-record-tampered', 'business_context'),
    requiredCapabilities: mapRequiredCapabilities(row.required_capabilities, 'intent-record-tampered'),
    businessConstraints: mapStringMap(row.business_constraints, 'intent-record-tampered', 'business_constraints'),
    outputContract: row.output_contract,
    idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash,
    recordHash: row.record_hash,
    createdBy: row.created_by,
    zeckExecutionId: row.zeck_execution_id,
    zeckApplicationRef: row.zeck_application_ref,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at === null ? null : toDate(row.submitted_at),
    lastSeenEventId: row.last_seen_event_id,
    lastSeenAt: row.last_seen_at === null ? null : toDate(row.last_seen_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  // Read-side integrity: both hashes are recomputed; divergence is tampering.
  if (computeIntentContentHash(record) !== record.contentHash) {
    failTampered('intent-record-tampered', `execution intent ${record.id} content no longer matches its recorded content hash`);
  }
  if (computeIntentRecordHash(record) !== record.recordHash) {
    failTampered('intent-record-tampered', `execution intent ${record.id} record no longer matches its recorded integrity hash`);
  }
  return record;
}

function mapObservation(raw: unknown): ZeckResultObservation | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return raw as ZeckResultObservation;
}

function mapEvent(row: EventRow): ZeckCallbackEventRecord {
  if (row.disposition !== 'accepted' && row.disposition !== 'rejected') {
    failTampered('event-record-tampered', `event disposition "${row.disposition}" is out of enumeration`);
  }
  if (row.rejection_code !== null && !isRejectionCode(row.rejection_code)) {
    failTampered('event-record-tampered', `event rejection code "${row.rejection_code}" is out of enumeration`);
  }
  if (row.rejection_code !== null && row.disposition !== 'rejected') {
    failTampered('event-record-tampered', `event ${row.id} carries a rejection code while accepted`);
  }
  const record: ZeckCallbackEventRecord = {
    id: row.id,
    tenantId: row.tenant_id,
    eventId: row.event_id,
    eventType: row.event_type,
    zeckExecutionId: row.zeck_execution_id,
    intentId: row.intent_id,
    disposition: row.disposition,
    rejectionCode: row.rejection_code,
    observed: mapObservation(row.observed),
    deliveryHash: row.delivery_hash,
    recordHash: row.record_hash,
    receivedBy: row.received_by,
    receivedAt: toDate(row.received_at),
  };
  if (computeEventRecordHash(record) !== row.record_hash) {
    failTampered('event-record-tampered', `callback event ${record.id} record no longer matches its recorded integrity hash`);
  }
  return record;
}

function isRejectionCode(value: string): value is CallbackRejectionCode {
  return value === 'unknown_event_type' || value === 'invalid_payload' || value === 'uncorrelated' || value === 'conflicting_correlation';
}

// ---------------------------------------------------------------------------
// Lookup helpers (tenant-predicated)
// ---------------------------------------------------------------------------

async function findIntentRowById(tx: SqlExecutor, tenantId: string, intentId: string): Promise<IntentRow | null> {
  const result = await tx.query(
    `SELECT ${INTENT_COLUMNS} FROM zeck_execution_intents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, intentId],
  );
  return (result.rows[0] as unknown as IntentRow | undefined) ?? null;
}

async function findIntentRowByKey(tx: SqlExecutor, tenantId: string, idempotencyKey: string): Promise<IntentRow | null> {
  const result = await tx.query(
    `SELECT ${INTENT_COLUMNS} FROM zeck_execution_intents WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return (result.rows[0] as unknown as IntentRow | undefined) ?? null;
}

async function findIntentRowByAttempt(tx: SqlExecutor, tenantId: string, workAttemptId: string): Promise<IntentRow | null> {
  const result = await tx.query(
    `SELECT ${INTENT_COLUMNS} FROM zeck_execution_intents WHERE tenant_id = $1 AND work_attempt_id = $2`,
    [tenantId, workAttemptId],
  );
  return (result.rows[0] as unknown as IntentRow | undefined) ?? null;
}

async function findIntentRowByExecutionRef(tx: SqlExecutor, tenantId: string, zeckExecutionId: string): Promise<IntentRow | null> {
  const result = await tx.query(
    `SELECT ${INTENT_COLUMNS} FROM zeck_execution_intents WHERE tenant_id = $1 AND zeck_execution_id = $2`,
    [tenantId, zeckExecutionId],
  );
  return (result.rows[0] as unknown as IntentRow | undefined) ?? null;
}

async function findEventRow(tx: SqlExecutor, tenantId: string, eventId: string): Promise<EventRow | null> {
  const result = await tx.query(
    `SELECT ${EVENT_COLUMNS} FROM zeck_callback_events WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId],
  );
  return (result.rows[0] as unknown as EventRow | undefined) ?? null;
}

function keyedConflict(idempotencyKey: string): ZeckStoreRuleError {
  return new ZeckStoreRuleError(
    `execution-intent idempotency key "${idempotencyKey}" was already bound to different content`,
    'idempotency-input-conflict',
  );
}

function attemptLinked(workAttemptId: string): ZeckStoreRuleError {
  return new ZeckStoreRuleError(
    `work attempt ${workAttemptId} already carries an execution intent; a new logical AI request targets a new attempt, and a retry of the same logical intent reuses its idempotency key`,
    'attempt-already-linked',
  );
}

function referenceConflict(zeckExecutionId: string, detail: string): ZeckStoreRuleError {
  return new ZeckStoreRuleError(
    `conflicting Zeck execution reference "${zeckExecutionId}": ${detail}`,
    'reference-conflict',
  );
}

function eventConflict(eventId: string): ZeckStoreRuleError {
  return new ZeckStoreRuleError(
    `callback event "${eventId}" was already delivered with different content; divergent re-delivery fails closed`,
    'event-conflict',
  );
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createSqlZeckStore(executor: TransactionalExecutor): ZeckStore {
  return {
    async registerIntent(input: RegisterIntentStoreInput): Promise<{ intent: ZeckIntentRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Converge on an existing logical registration first.
        const existing = await findIntentRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (existing !== null) {
          if (existing.content_hash !== input.contentHash) {
            throw keyedConflict(input.idempotencyKey);
          }
          return { intent: mapIntent(existing), converged: true };
        }
        // Serialize the registration of this logical intent.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `zeck-intent:${input.tenantId}:${input.idempotencyKey}`,
        ]);
        // POST-LOCK IDEMPOTENCY RE-CHECK (the authoritative one): a racing
        // same-key registration may have committed while this transaction
        // waited for the advisory lock — invisible to the pre-lock
        // statement snapshot, decisive here (READ COMMITTED takes a fresh
        // snapshot per statement).
        const raced = await findIntentRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (raced !== null) {
          if (raced.content_hash !== input.contentHash) {
            throw keyedConflict(input.idempotencyKey);
          }
          return { intent: mapIntent(raced), converged: true };
        }
        // One intent per work attempt (the durable correlation identity).
        const linked = await findIntentRowByAttempt(tx, input.tenantId, input.workAttemptId);
        if (linked !== null) {
          if (linked.idempotency_key === input.idempotencyKey) {
            // Same key converged above under the lock; a different key
            // targeting the same attempt is the correlation conflict.
            return { intent: mapIntent(linked), converged: true };
          }
          throw attemptLinked(input.workAttemptId);
        }
        // ON CONFLICT DO NOTHING (any unique violation): a concurrent
        // creator committed first; this transaction stays healthy for the
        // convergence re-read below.
        const inserted = await tx.query(
          `INSERT INTO zeck_execution_intents
             (tenant_id, service_work_id, work_attempt_id, objective, input_artifact_refs, business_context,
              required_capabilities, business_constraints, output_contract, idempotency_key,
              content_hash, record_hash, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $14)
           ON CONFLICT DO NOTHING
           RETURNING ${INTENT_COLUMNS}`,
          [
            input.tenantId,
            input.serviceWorkId,
            input.workAttemptId,
            input.objective,
            JSON.stringify(input.inputArtifactRefs),
            JSON.stringify(input.businessContext),
            JSON.stringify(input.requiredCapabilities),
            JSON.stringify(input.businessConstraints),
            JSON.stringify(input.outputContract),
            input.idempotencyKey,
            input.contentHash,
            computeIntentRecordHash({
              id: '',
              tenantId: input.tenantId,
              serviceWorkId: input.serviceWorkId,
              workAttemptId: input.workAttemptId,
              objective: input.objective,
              inputArtifactRefs: input.inputArtifactRefs,
              businessContext: input.businessContext,
              requiredCapabilities: input.requiredCapabilities,
              businessConstraints: input.businessConstraints,
              outputContract: input.outputContract,
              idempotencyKey: input.idempotencyKey,
              contentHash: input.contentHash,
              recordHash: '',
              createdBy: input.createdBy,
              zeckExecutionId: null,
              zeckApplicationRef: null,
              submittedBy: null,
              submittedAt: null,
              lastSeenEventId: null,
              lastSeenAt: null,
              createdAt: input.now,
              updatedAt: input.now,
            }),
            input.createdBy,
            input.now,
          ],
        );
        if (inserted.rows.length > 0) {
          const row = inserted.rows[0] as unknown as IntentRow;
          // The placeholder id was hashed as ''; the RETURNING row carries
          // the hash the INSERT stored — mapping verifies it end to end.
          return { intent: mapIntent(row), converged: false };
        }
        // A concurrent registration committed first: converge when the
        // key/content match, fail closed otherwise (keyed conflict or the
        // attempt correlation conflict).
        const byKey = await findIntentRowByKey(tx, input.tenantId, input.idempotencyKey);
        if (byKey !== null) {
          if (byKey.content_hash !== input.contentHash) {
            throw keyedConflict(input.idempotencyKey);
          }
          return { intent: mapIntent(byKey), converged: true };
        }
        const byAttempt = await findIntentRowByAttempt(tx, input.tenantId, input.workAttemptId);
        if (byAttempt !== null) {
          throw attemptLinked(input.workAttemptId);
        }
        throw new ZeckStoreConflictError('registerIntent violated a uniqueness constraint', 'zeck_execution_intents_identity');
      });
    },

    async findIntent(tenantId: string, intentId: string): Promise<ZeckIntentRecord | null> {
      const result = await executor.query(
        `SELECT ${INTENT_COLUMNS} FROM zeck_execution_intents WHERE tenant_id = $1 AND id = $2`,
        [tenantId, intentId],
      );
      const row = result.rows[0] as unknown as IntentRow | undefined;
      return row === undefined ? null : mapIntent(row);
    },

    async findIntentByExecutionRef(tenantId: string, zeckExecutionId: string): Promise<ZeckIntentRecord | null> {
      const result = await executor.query(
        `SELECT ${INTENT_COLUMNS} FROM zeck_execution_intents WHERE tenant_id = $1 AND zeck_execution_id = $2`,
        [tenantId, zeckExecutionId],
      );
      const row = result.rows[0] as unknown as IntentRow | undefined;
      return row === undefined ? null : mapIntent(row);
    },

    async listIntents(tenantId: string, filter?: { serviceWorkId?: string; workAttemptId?: string }): Promise<ZeckIntentRecord[]> {
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
      const result = await executor.query(
        `SELECT ${INTENT_COLUMNS} FROM zeck_execution_intents WHERE ${where.join(' AND ')} ORDER BY created_at, id`,
        params,
      );
      return (result.rows as unknown as IntentRow[]).map((row) => mapIntent(row));
    },

    async attachExecutionReference(input: AttachReferenceInput): Promise<{ intent: ZeckIntentRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Serialize reference attachment for this intent.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `zeck-attach:${input.tenantId}:${input.intentId}`,
        ]);
        // LOCKED, FRESH read of the intent row: row-level locking
        // serializes against the accepted-callback cursor touch; the
        // record hash is computed over THIS state.
        const locked = await tx.query(
          `SELECT ${INTENT_COLUMNS} FROM zeck_execution_intents WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [input.tenantId, input.intentId],
        );
        const row = locked.rows[0] as unknown as IntentRow | undefined;
        if (row === undefined) {
          throw new ZeckStoreMissingError('intent', input.intentId);
        }
        const current = mapIntent(row);
        if (current.zeckExecutionId !== null) {
          if (current.zeckExecutionId === input.zeckExecutionId) {
            // The foreign identity converged: the logical intent holds
            // ONE execution reference (AC-6). The application ref is
            // auxiliary observability and does not affect convergence.
            return { intent: current, converged: true };
          }
          throw referenceConflict(
            input.zeckExecutionId,
            `intent ${input.intentId} already holds execution reference "${current.zeckExecutionId}"`,
          );
        }
        // The foreign identity must not be owned by another intent (the
        // unique partial index backstops this under any race).
        const owner = await findIntentRowByExecutionRef(tx, input.tenantId, input.zeckExecutionId);
        if (owner !== null) {
          throw referenceConflict(
            input.zeckExecutionId,
            `execution reference is already correlated to intent ${owner.id} (attempt ${owner.work_attempt_id})`,
          );
        }
        const next: ZeckIntentRecord = {
          ...current,
          zeckExecutionId: input.zeckExecutionId,
          zeckApplicationRef: input.applicationRef,
          submittedBy: input.submittedBy,
          submittedAt: input.now,
          updatedAt: input.now,
        };
        const recordHash = computeIntentRecordHash(next);
        let updated;
        try {
          updated = await tx.query(
            `UPDATE zeck_execution_intents
               SET zeck_execution_id = $1, zeck_application_ref = $2, submitted_by = $3, submitted_at = $4,
                   updated_at = $5, record_hash = $6
             WHERE tenant_id = $7 AND id = $8 AND zeck_execution_id IS NULL
             RETURNING ${INTENT_COLUMNS}`,
            [
              input.zeckExecutionId,
              input.applicationRef,
              input.submittedBy,
              input.now,
              input.now,
              recordHash,
              input.tenantId,
              input.intentId,
            ],
          );
        } catch (error) {
          // The partial UNIQUE (tenant, zeck_execution_id) backstop fired:
          // another intent's attach (serialized under ITS intent lock, not
          // this one) committed the same foreign identity between this
          // transaction's owner-check and its UPDATE. A raised 23505 would
          // abort with an untyped error — the typed conflict is the
          // contract (the transaction rolls back; nothing partial persists).
          const candidate = error as { code?: string };
          if (typeof candidate?.code === 'string' && candidate.code === '23505') {
            throw referenceConflict(
              input.zeckExecutionId,
              'the execution reference is already correlated to another intent (unique index backstop)',
            );
          }
          throw error;
        }
        if (updated.rows.length === 0) {
          // Lost the row race despite the locks (defense in depth): the
          // authoritative state decides — converge or fail closed.
          const fresh = await findIntentRowById(tx, input.tenantId, input.intentId);
          if (fresh === null) {
            throw new ZeckStoreMissingError('intent', input.intentId);
          }
          if (fresh.zeck_execution_id === input.zeckExecutionId) {
            return { intent: mapIntent(fresh), converged: true };
          }
          throw referenceConflict(
            input.zeckExecutionId,
            `intent ${input.intentId} already holds execution reference "${fresh.zeck_execution_id}"`,
          );
        }
        return { intent: mapIntent(updated.rows[0] as unknown as IntentRow), converged: false };
      });
    },

    async recordCallbackEvent(input: RecordCallbackEventStoreInput): Promise<{ event: ZeckCallbackEventRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Serialize the decision for this event identity.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `zeck-event:${input.tenantId}:${input.eventId}`,
        ]);
        // POST-LOCK RE-CHECK: a racing delivery of the same event identity
        // may have committed while this transaction waited.
        const existing = await findEventRow(tx, input.tenantId, input.eventId);
        if (existing !== null) {
          if (existing.delivery_hash !== input.deliveryHash) {
            throw eventConflict(input.eventId);
          }
          // Identical re-delivery converges (idempotent replay — accepted
          // or rejected, the first decision is stable).
          return { event: mapEvent(existing), converged: true };
        }
        // Decide the disposition INSIDE the critical section: the
        // correlation is resolved against the durable linkage state.
        let rejection: CallbackRejectionCode | null = input.proposedRejection;
        let intentId: string | null = null;
        let intentRow: IntentRow | null = null;
        if (rejection === null) {
          if (input.zeckExecutionId === null) {
            rejection = 'uncorrelated';
          } else {
            intentRow = await findIntentRowByExecutionRef(tx, input.tenantId, input.zeckExecutionId);
            if (intentRow === null) {
              rejection = 'uncorrelated';
            } else if (
              (input.correlation?.serviceWorkId !== undefined && input.correlation.serviceWorkId !== intentRow.service_work_id) ||
              (input.correlation?.workAttemptId !== undefined && input.correlation.workAttemptId !== intentRow.work_attempt_id)
            ) {
              rejection = 'conflicting_correlation';
              intentId = intentRow.id;
            }
          }
        }
        const disposition: CallbackDisposition = rejection === null ? 'accepted' : 'rejected';
        const observed = disposition === 'accepted' ? input.observed : null;
        const eventRecord = {
          id: '',
          tenantId: input.tenantId,
          eventId: input.eventId,
          eventType: input.eventType,
          zeckExecutionId: input.zeckExecutionId,
          intentId: disposition === 'accepted' ? (intentRow?.id ?? null) : intentId,
          disposition,
          rejectionCode: rejection,
          observed,
          deliveryHash: input.deliveryHash,
          recordHash: '',
          receivedBy: input.receivedBy,
          receivedAt: input.now,
        };
        const inserted = await tx.query(
          `INSERT INTO zeck_callback_events
             (tenant_id, event_id, event_type, zeck_execution_id, intent_id, disposition, rejection_code,
              observed, delivery_hash, record_hash, received_by, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
           ON CONFLICT DO NOTHING
           RETURNING ${EVENT_COLUMNS}`,
          [
            input.tenantId,
            input.eventId,
            input.eventType,
            input.zeckExecutionId,
            eventRecord.intentId,
            disposition,
            rejection,
            observed === null ? null : JSON.stringify(observed),
            input.deliveryHash,
            computeEventRecordHash(eventRecord),
            input.receivedBy,
            input.now,
          ],
        );
        if (inserted.rows.length === 0) {
          // A racing delivery committed first: identical converges,
          // divergent fails closed (the durable row is the evidence).
          const raced = await findEventRow(tx, input.tenantId, input.eventId);
          if (raced === null) {
            throw new ZeckStoreConflictError('recordCallbackEvent violated a uniqueness constraint', 'zeck_callback_events_identity');
          }
          if (raced.delivery_hash !== input.deliveryHash) {
            throw eventConflict(input.eventId);
          }
          return { event: mapEvent(raced), converged: true };
        }
        const event = mapEvent(inserted.rows[0] as unknown as EventRow);
        // Accepted events advance the intent's last-seen ingestion cursor
        // in the SAME transaction (one clock read: both rows pin input.now).
        if (disposition === 'accepted' && intentRow !== null) {
          const locked = await tx.query(
            `SELECT ${INTENT_COLUMNS} FROM zeck_execution_intents WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
            [input.tenantId, intentRow.id],
          );
          const freshRow = locked.rows[0] as unknown as IntentRow | undefined;
          if (freshRow === undefined) {
            throw new ZeckStoreMissingError('intent', intentRow.id);
          }
          const fresh = mapIntent(freshRow);
          const next: ZeckIntentRecord = {
            ...fresh,
            lastSeenEventId: input.eventId,
            lastSeenAt: input.now,
            updatedAt: input.now,
          };
          await tx.query(
            `UPDATE zeck_execution_intents
               SET last_seen_event_id = $1, last_seen_at = $2, updated_at = $3, record_hash = $4
             WHERE tenant_id = $5 AND id = $6`,
            [
              input.eventId,
              input.now,
              input.now,
              computeIntentRecordHash(next),
              input.tenantId,
              intentRow.id,
            ],
          );
        }
        return { event, converged: false };
      });
    },

    async findCallbackEvent(tenantId: string, eventId: string): Promise<ZeckCallbackEventRecord | null> {
      const result = await executor.query(
        `SELECT ${EVENT_COLUMNS} FROM zeck_callback_events WHERE tenant_id = $1 AND event_id = $2`,
        [tenantId, eventId],
      );
      const row = result.rows[0] as unknown as EventRow | undefined;
      return row === undefined ? null : mapEvent(row);
    },

    async listCallbackEvents(
      tenantId: string,
      filter?: { intentId?: string; disposition?: CallbackDisposition },
    ): Promise<ZeckCallbackEventRecord[]> {
      const where: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (filter?.intentId !== undefined) {
        params.push(filter.intentId);
        where.push(`intent_id = $${params.length}`);
      }
      if (filter?.disposition !== undefined) {
        params.push(filter.disposition);
        where.push(`disposition = $${params.length}`);
      }
      const result = await executor.query(
        `SELECT ${EVENT_COLUMNS} FROM zeck_callback_events WHERE ${where.join(' AND ')} ORDER BY received_at, id`,
        params,
      );
      return (result.rows as unknown as EventRow[]).map((row) => mapEvent(row));
    },
  };
}
