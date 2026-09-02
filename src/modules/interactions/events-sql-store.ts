/**
 * ServiceOS /interactions event-substrate SQL store (WORK-006, module
 * internal).
 *
 * Authoritative persistence for the durable event inbox/outbox
 * (migration 0011_event_substrate.sql), executed through the persistence
 * boundary's `TransactionalExecutor` (parameterized SQL only; this file
 * never imports `pg`). The same load-bearing disciplines as the
 * interaction-ledger SQL store (WORK-015) apply throughout:
 *
 * 1. THE EVENT SUBSTRATE'S DURABLE SURFACE. This store owns the inbox
 *    delivery records (received -> processing -> consumed | failed |
 *    rejected) and the outbox dispatch lifecycle (intended ->
 *    dispatching -> dispatched | failed) and NOTHING else: no provider
 *    or delivery port is called from here (the module invokes the
 *    injected provider-neutral delivery port between the claim and the
 *    completion writes), and no business state is written or derived
 *    here. The transaction-scope discipline: the `query` helper takes
 *    its executor EXPLICITLY and every statement inside
 *    `withTransaction` passes `tx` (the pinned transaction client);
 *    reads pass the pooled `executor`.
 *
 * 2. MANDATORY TENANT PREDICATES: every lookup/list selects through
 *    `tenant_id = $…`; a row in another tenant is indistinguishable
 *    from a missing row (removing a predicate must fail the
 *    tenant-isolation discrimination proofs).
 *
 * 3. CONVERGENCE, NOT DUPLICATION: the inbox insert uses
 *    `ON CONFLICT … DO NOTHING` against the stable identity
 *    (tenant, source, external event id) and converges by re-reading
 *    with the delivery-hash comparison (identical re-delivery
 *    converges; divergence fails closed `event-delivery-conflict`);
 *    the outbox insert does the same against the tenant-scoped keyed
 *    partial unique index (the WORK-014 healthy-transaction lesson:
 *    a concurrent creator keeps its transaction and re-reads).
 *
 * 4. SERIALIZED STATE TRANSITIONS: every mutation (claims, retries,
 *    reclaims, completions, failures) locks the row
 *    (`SELECT … FOR UPDATE`) BEFORE comparing the expected state, then
 *    UPDATEs with the state predicate re-asserted and recomputes the
 *    record integrity hash — one atomic unit per transition. Concurrent
 *    workers on the same event serialize on the row lock; every loser
 *    fails closed with the typed rule carrying the observed state
 *    (never a double claim, never a lost update, never a duplicate
 *    domain effect).
 *
 * 5. TAMPER-EVIDENT READS: `mapInboxEvent`/`mapOutboxEvent` recompute
 *    the record integrity hash from the stored fields and fail closed
 *    (`event-record-tampered`) on divergence; orphan/partial column
 *    groups fail closed at the read boundary (mirroring the schema
 *    shape CHECKs) instead of being silently dropped.
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/persistence/index.js';
import { StoreConflictError } from '../auth/index.js';
import { isCapabilityClass, type CapabilityClass } from '../integrations/index.js';
import { canonicalJson, computeInboxEventRecordHash, computeOutboxEventRecordHash } from './provenance.js';
import {
  EventsStoreMissingError,
  EventsStoreRuleError,
  type ClaimInboxEventInput,
  type ClaimOutboxEventInput,
  type CompleteInboxEventInput,
  type CompleteOutboxDispatchInput,
  type CreateOutboxEventInput,
  type EventsStore,
  type EventsStoreRule,
  type FailInboxEventInput,
  type FailOutboxDispatchInput,
  type InboxEventClaim,
  type InboxEventConsumption,
  type InboxEventFilter,
  type InboxEventRecord,
  type InboxEventRejection,
  type InboxEventState,
  type IngestInboxEventInput,
  type InteractionDeliveryResultPayload,
  type InteractionObservedPayload,
  type OutboxEventDispatch,
  type OutboxEventFailure,
  type OutboxEventFilter,
  type OutboxEventRecord,
  type OutboxEventState,
  type OutboundEventType,
  type ReclaimInboxEventInput,
  type ReclaimOutboxDispatchInput,
  type RetryInboxEventInput,
} from './events-store.js';

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

interface InboxEventRow {
  id: string;
  tenant_id: string;
  source: string;
  external_event_id: string;
  event_type: string;
  occurred_at: Date | string;
  payload: unknown;
  delivery_hash: string;
  state: string;
  rejection_code: string | null;
  rejection_rejected_at: Date | string | null;
  claimed_by: string | null;
  claimed_at: Date | string | null;
  consumer_result: unknown;
  consumed_by: string | null;
  consumed_at: Date | string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_failed_at: Date | string | null;
  received_by: string;
  record_hash: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OutboxEventRow {
  id: string;
  tenant_id: string;
  event_type: string;
  payload: unknown;
  destination: string;
  correlation: unknown;
  policy_key: string | null;
  policy_decision_id: string | null;
  requested_by: string;
  idempotency_key: string | null;
  input_hash: string;
  record_hash: string;
  state: string;
  claimed_by: string | null;
  claimed_at: Date | string | null;
  provider: string | null;
  provider_reference: string | null;
  dispatched_at: Date | string | null;
  dispatched_by: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_failed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const INBOX_COLUMNS = `id, tenant_id, source, external_event_id, event_type, occurred_at, payload, delivery_hash, state, rejection_code, rejection_rejected_at, claimed_by, claimed_at, consumer_result, consumed_by, consumed_at, failure_code, failure_message, failure_failed_at, received_by, record_hash, created_at, updated_at`;
const OUTBOX_COLUMNS = `id, tenant_id, event_type, payload, destination, correlation, policy_key, policy_decision_id, requested_by, idempotency_key, input_hash, record_hash, state, claimed_by, claimed_at, provider, provider_reference, dispatched_at, dispatched_by, failure_code, failure_message, failure_failed_at, created_at, updated_at`;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function inboxTampered(id: string, what: string): EventsStoreRuleError {
  return new EventsStoreRuleError(`inbox event ${id} record no longer matches its integrity hash (${what})`, 'event-record-tampered');
}

function outboxTampered(id: string, what: string): EventsStoreRuleError {
  return new EventsStoreRuleError(`outbox event ${id} record no longer matches its integrity hash (${what})`, 'event-record-tampered');
}

function isInboxState(value: string): value is InboxEventState {
  return value === 'received' || value === 'processing' || value === 'consumed' || value === 'failed' || value === 'rejected';
}

function isOutboxState(value: string): value is OutboxEventState {
  return value === 'intended' || value === 'dispatching' || value === 'dispatched' || value === 'failed';
}

function isInboxRejectionCode(value: string): boolean {
  return value === 'unknown_event_type' || value === 'invalid_payload' || value === 'uncorrelated';
}

function mapInboxEvent(row: InboxEventRow): InboxEventRecord {
  const id = row.id;
  const state = row.state;
  if (!isInboxState(state)) {
    throw inboxTampered(id, `state "${state}" is outside the inbox event lifecycle`);
  }
  if (!isCapabilityClass(row.source)) {
    throw inboxTampered(id, `source "${row.source}" is outside the frozen taxonomy`);
  }
  // Column-group consistency (fail closed, mirroring the schema shape
  // CHECKs): a partial or orphan group is detected at the read boundary
  // as tampering rather than silently dropped (which would blind the
  // integrity hash to those columns).
  if ((row.rejection_code !== null) !== (row.rejection_rejected_at !== null)) {
    throw inboxTampered(id, 'rejection columns are inconsistent');
  }
  if (state === 'rejected' && row.rejection_code === null) {
    throw inboxTampered(id, 'a rejected event carries no rejection code');
  }
  if (state !== 'rejected' && row.rejection_code !== null) {
    throw inboxTampered(id, `a ${state} event carries a rejection code`);
  }
  if ((row.claimed_by !== null) !== (row.claimed_at !== null)) {
    throw inboxTampered(id, 'claim columns are inconsistent');
  }
  if (state === 'received' && row.claimed_by !== null) {
    throw inboxTampered(id, 'a received event carries a claim');
  }
  if (state === 'rejected' && row.claimed_by !== null) {
    throw inboxTampered(id, 'a rejected event carries a claim');
  }
  const hasConsumption = row.consumed_by !== null;
  if (hasConsumption !== (row.consumed_at !== null) || hasConsumption !== (row.consumer_result !== null)) {
    throw inboxTampered(id, 'consumption columns are inconsistent');
  }
  if (state === 'consumed' && !hasConsumption) {
    throw inboxTampered(id, 'a consumed event carries no consumption record');
  }
  if (state !== 'consumed' && hasConsumption) {
    throw inboxTampered(id, `a ${state} event carries a consumption record`);
  }
  const hasFailure = row.failure_code !== null;
  if (hasFailure !== (row.failure_message !== null) || hasFailure !== (row.failure_failed_at !== null)) {
    throw inboxTampered(id, 'failure columns are inconsistent');
  }
  if (state === 'failed' && !hasFailure) {
    throw inboxTampered(id, 'a failed event carries no failure record');
  }
  if (state !== 'failed' && hasFailure) {
    throw inboxTampered(id, `a ${state} event carries a failure record`);
  }

  const claim: InboxEventClaim | null =
    row.claimed_by !== null && row.claimed_at !== null
      ? { claimedBy: row.claimed_by, claimedAt: toDate(row.claimed_at) }
      : null;
  if (row.rejection_code !== null && !isInboxRejectionCode(row.rejection_code)) {
    throw inboxTampered(id, `rejection code "${row.rejection_code}" is outside the frozen vocabulary`);
  }
  const rejection: InboxEventRejection | null =
    row.rejection_code !== null && row.rejection_rejected_at !== null
      ? {
          code: row.rejection_code as InboxEventRejection['code'],
          rejectedAt: toDate(row.rejection_rejected_at),
        }
      : null;
  const consumption: InboxEventConsumption | null = hasConsumption
    ? {
        result: (row.consumer_result ?? {}) as Readonly<Record<string, unknown>>,
        consumedBy: row.consumed_by as string,
        consumedAt: toDate(row.consumed_at as Date | string),
      }
    : null;
  const failure = hasFailure
    ? {
        code: row.failure_code as string,
        message: row.failure_message as string,
        failedAt: toDate(row.failure_failed_at as Date | string),
      }
    : null;

  const event: InboxEventRecord = {
    id,
    tenantId: row.tenant_id,
    source: row.source,
    externalEventId: row.external_event_id,
    eventType: row.event_type,
    occurredAt: toDate(row.occurred_at),
    payload: row.payload as InteractionDeliveryResultPayload | Readonly<Record<string, unknown>>,
    deliveryHash: row.delivery_hash,
    state,
    rejection,
    claim,
    consumption,
    failure,
    receivedBy: row.received_by,
    recordHash: row.record_hash,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  // Integrity verification: every read recomputes the persisted record
  // hash from the stored fields (after-the-fact mutation detection).
  if (computeInboxEventRecordHash(event) !== event.recordHash) {
    throw inboxTampered(id, 'record hash mismatch');
  }
  return event;
}

function mapOutboxEvent(row: OutboxEventRow): OutboxEventRecord {
  const id = row.id;
  const state = row.state;
  if (!isOutboxState(state)) {
    throw outboxTampered(id, `state "${state}" is outside the outbox event lifecycle`);
  }
  if ((row.policy_key === null) !== (row.policy_decision_id === null)) {
    throw outboxTampered(id, 'policy provenance has one column set without the other');
  }
  if ((row.claimed_by !== null) !== (row.claimed_at !== null)) {
    throw outboxTampered(id, 'claim columns are inconsistent');
  }
  if (state === 'intended' && row.claimed_by !== null) {
    throw outboxTampered(id, 'an intended event carries a claim');
  }
  if (state !== 'intended' && row.claimed_by === null) {
    throw outboxTampered(id, `a ${state} event carries no claim`);
  }
  const hasDispatch = row.provider !== null;
  if (hasDispatch !== (row.dispatched_at !== null) || hasDispatch !== (row.dispatched_by !== null)) {
    throw outboxTampered(id, 'dispatch acceptance columns are inconsistent');
  }
  if (row.provider_reference !== null && !hasDispatch) {
    throw outboxTampered(id, 'provider_reference is set without a provider');
  }
  if (state === 'dispatched' && !hasDispatch) {
    throw outboxTampered(id, 'a dispatched event carries no acceptance');
  }
  if (state !== 'dispatched' && hasDispatch) {
    throw outboxTampered(id, `a ${state} event carries an acceptance`);
  }
  const hasFailure = row.failure_code !== null;
  if (hasFailure !== (row.failure_message !== null) || hasFailure !== (row.failure_failed_at !== null)) {
    throw outboxTampered(id, 'failure columns are inconsistent');
  }
  if (state === 'failed' && !hasFailure) {
    throw outboxTampered(id, 'a failed event carries no failure record');
  }
  if (state !== 'failed' && hasFailure) {
    throw outboxTampered(id, `a ${state} event carries a failure record`);
  }
  if (typeof row.correlation !== 'object' || row.correlation === null || Array.isArray(row.correlation)) {
    throw outboxTampered(id, 'correlation is not an object');
  }

  const claim: InboxEventClaim | null =
    row.claimed_by !== null && row.claimed_at !== null
      ? { claimedBy: row.claimed_by, claimedAt: toDate(row.claimed_at) }
      : null;
  const dispatch: OutboxEventDispatch | null = hasDispatch
    ? {
        provider: row.provider as string,
        providerReference: row.provider_reference,
        dispatchedAt: toDate(row.dispatched_at as Date | string),
        dispatchedBy: row.dispatched_by as string,
      }
    : null;
  const failure: OutboxEventFailure | null = hasFailure
    ? {
        code: row.failure_code as string,
        message: row.failure_message as string,
        failedAt: toDate(row.failure_failed_at as Date | string),
      }
    : null;
  const correlation: Record<string, string> = {};
  for (const [key, entry] of Object.entries(row.correlation as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      throw outboxTampered(id, `correlation entry "${key}" is not a string`);
    }
    correlation[key] = entry;
  }

  const event: OutboxEventRecord = {
    id,
    tenantId: row.tenant_id,
    eventType: row.event_type as OutboundEventType,
    payload: row.payload as InteractionObservedPayload | Readonly<Record<string, unknown>>,
    destination: row.destination,
    correlation,
    policy:
      row.policy_key !== null && row.policy_decision_id !== null
        ? { policyKey: row.policy_key, decisionId: row.policy_decision_id }
        : null,
    requestedBy: row.requested_by,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    recordHash: row.record_hash,
    state,
    claim,
    dispatch,
    failure,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  if (computeOutboxEventRecordHash(event) !== event.recordHash) {
    throw outboxTampered(id, 'record hash mismatch');
  }
  return event;
}

/** Map a driver unique-violation to the shared conflict error. */
function mapStoreError(error: unknown, context: string): unknown {
  if (
    error instanceof StoreConflictError ||
    error instanceof EventsStoreRuleError ||
    error instanceof EventsStoreMissingError
  ) {
    return error;
  }
  const candidate = error as { code?: string; constraint?: string };
  if (typeof candidate?.code === 'string' && candidate.code === '23505') {
    return new StoreConflictError(`${context} violated a uniqueness constraint`, candidate.constraint ?? 'unknown');
  }
  return error;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createSqlEventsStore(executor: TransactionalExecutor): EventsStore {
  /**
   * Parameterized statement helper. The FIRST parameter is the executor
   * the statement runs on, passed EXPLICITLY at every call site: read
   * paths pass `executor` (the pool); every statement inside
   * `withTransaction` passes `tx` (the pinned client).
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

  async function findInboxEventRow(
    exec: SqlExecutor,
    tenantId: string,
    eventId: string,
  ): Promise<InboxEventRow | null> {
    const rows = await query(
      exec,
      `SELECT ${INBOX_COLUMNS} FROM event_inbox WHERE tenant_id = $1 AND id = $2`,
      [tenantId, eventId],
      'findInboxEvent',
    );
    const row = rows[0] as unknown as InboxEventRow | undefined;
    return row === undefined ? null : row;
  }

  async function findInboxEventRowByIdentity(
    exec: SqlExecutor,
    tenantId: string,
    source: string,
    externalEventId: string,
  ): Promise<InboxEventRow | null> {
    const rows = await query(
      exec,
      `SELECT ${INBOX_COLUMNS} FROM event_inbox WHERE tenant_id = $1 AND source = $2 AND external_event_id = $3`,
      [tenantId, source, externalEventId],
      'findInboxEventByIdentity',
    );
    const row = rows[0] as unknown as InboxEventRow | undefined;
    return row === undefined ? null : row;
  }

  async function findOutboxEventRow(
    exec: SqlExecutor,
    tenantId: string,
    eventId: string,
  ): Promise<OutboxEventRow | null> {
    const rows = await query(
      exec,
      `SELECT ${OUTBOX_COLUMNS} FROM event_outbox WHERE tenant_id = $1 AND id = $2`,
      [tenantId, eventId],
      'findOutboxEvent',
    );
    const row = rows[0] as unknown as OutboxEventRow | undefined;
    return row === undefined ? null : row;
  }

  async function findOutboxEventRowByKey(
    exec: SqlExecutor,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<OutboxEventRow | null> {
    const rows = await query(
      exec,
      `SELECT ${OUTBOX_COLUMNS} FROM event_outbox WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
      'findOutboxEventByKey',
    );
    const row = rows[0] as unknown as OutboxEventRow | undefined;
    return row === undefined ? null : row;
  }

  /** Lock the inbox row and map it (hash verified on read). */
  async function lockInboxEventRow(tx: SqlExecutor, tenantId: string, eventId: string, context: string): Promise<InboxEventRow> {
    const rows = await query(
      tx,
      `SELECT ${INBOX_COLUMNS} FROM event_inbox WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, eventId],
      context,
    );
    const row = rows[0] as unknown as InboxEventRow | undefined;
    if (row === undefined) {
      throw new EventsStoreMissingError(`inbox event ${eventId} does not exist in this tenant`, 'inbox-event');
    }
    return row;
  }

  /** Lock the outbox row and map it (hash verified on read). */
  async function lockOutboxEventRow(tx: SqlExecutor, tenantId: string, eventId: string, context: string): Promise<OutboxEventRow> {
    const rows = await query(
      tx,
      `SELECT ${OUTBOX_COLUMNS} FROM event_outbox WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, eventId],
      context,
    );
    const row = rows[0] as unknown as OutboxEventRow | undefined;
    if (row === undefined) {
      throw new EventsStoreMissingError(`outbox event ${eventId} does not exist in this tenant`, 'outbox-event');
    }
    return row;
  }

  /**
   * The one inbox state-write helper: assert the expected source state
   * (under the row lock), apply the transition, recompute the record
   * hash over the post-write record INCLUDING this write's now, and
   * UPDATE with the state predicate re-asserted — one atomic unit.
   */
  async function writeInboxState(
    tx: SqlExecutor,
    input: { tenantId: string; eventId: string; now: Date },
    expectedState: InboxEventState,
    conflictRule: EventsStoreRule,
    next: (current: InboxEventRecord) => Omit<InboxEventRecord, 'updatedAt'>,
    context: string,
  ): Promise<InboxEventRecord> {
    const row = await lockInboxEventRow(tx, input.tenantId, input.eventId, context);
    const current = mapInboxEvent(row);
    if (current.state !== expectedState) {
      throw new EventsStoreRuleError(
        `inbox event ${input.eventId} is in state "${current.state}", not the expected "${expectedState}"`,
        conflictRule,
      );
    }
    const updated: InboxEventRecord = { ...next(current), updatedAt: input.now };
    const recordHash = computeInboxEventRecordHash(updated);
    await query(
      tx,
      `UPDATE event_inbox
       SET state = $1, rejection_code = $2, rejection_rejected_at = $3,
           claimed_by = $4, claimed_at = $5,
           consumer_result = $6::jsonb, consumed_by = $7, consumed_at = $8,
           failure_code = $9, failure_message = $10, failure_failed_at = $11,
           record_hash = $12, updated_at = $13
       WHERE tenant_id = $14 AND id = $15 AND state = $16`,
      [
        updated.state,
        updated.rejection?.code ?? null,
        updated.rejection?.rejectedAt ?? null,
        updated.claim?.claimedBy ?? null,
        updated.claim?.claimedAt ?? null,
        updated.consumption === null ? null : canonicalJson(updated.consumption.result),
        updated.consumption?.consumedBy ?? null,
        updated.consumption?.consumedAt ?? null,
        updated.failure?.code ?? null,
        updated.failure?.message ?? null,
        updated.failure?.failedAt ?? null,
        recordHash,
        input.now,
        input.tenantId,
        input.eventId,
        expectedState,
      ],
      context,
    );
    return { ...updated, recordHash };
  }

  /**
   * The one outbox state-write helper (same discipline as the inbox:
   * expected state asserted under the row lock, hash recomputed over
   * the post-write record, state predicate re-asserted in the UPDATE).
   */
  async function writeOutboxState(
    tx: SqlExecutor,
    input: { tenantId: string; eventId: string; now: Date },
    expectedState: OutboxEventState,
    conflictRule: EventsStoreRule,
    next: (current: OutboxEventRecord) => Omit<OutboxEventRecord, 'updatedAt'>,
    context: string,
  ): Promise<OutboxEventRecord> {
    const row = await lockOutboxEventRow(tx, input.tenantId, input.eventId, context);
    const current = mapOutboxEvent(row);
    if (current.state !== expectedState) {
      throw new EventsStoreRuleError(
        `outbox event ${input.eventId} is in state "${current.state}", not the expected "${expectedState}"`,
        conflictRule,
      );
    }
    const updated: OutboxEventRecord = { ...next(current), updatedAt: input.now };
    const recordHash = computeOutboxEventRecordHash(updated);
    await query(
      tx,
      `UPDATE event_outbox
       SET state = $1, claimed_by = $2, claimed_at = $3,
           provider = $4, provider_reference = $5, dispatched_at = $6, dispatched_by = $7,
           failure_code = $8, failure_message = $9, failure_failed_at = $10,
           record_hash = $11, updated_at = $12
       WHERE tenant_id = $13 AND id = $14 AND state = $15`,
      [
        updated.state,
        updated.claim?.claimedBy ?? null,
        updated.claim?.claimedAt ?? null,
        updated.dispatch?.provider ?? null,
        updated.dispatch?.providerReference ?? null,
        updated.dispatch?.dispatchedAt ?? null,
        updated.dispatch?.dispatchedBy ?? null,
        updated.failure?.code ?? null,
        updated.failure?.message ?? null,
        updated.failure?.failedAt ?? null,
        recordHash,
        input.now,
        input.tenantId,
        input.eventId,
        expectedState,
      ],
      context,
    );
    return { ...updated, recordHash };
  }

  /** Converge an identical inbox re-delivery, or fail closed on divergence. */
  function convergeDelivery(
    row: InboxEventRow,
    input: IngestInboxEventInput,
  ): { event: InboxEventRecord; converged: boolean } {
    const event = mapInboxEvent(row);
    if (event.deliveryHash !== input.deliveryHash) {
      throw new EventsStoreRuleError(
        `external event identity (source ${input.source}, id "${input.externalEventId}") was already recorded with a different delivery`,
        'event-delivery-conflict',
      );
    }
    return { event, converged: true };
  }

  /** Converge a keyed outbox re-submission on the durable event, or fail closed. */
  function convergeOutbox(
    row: OutboxEventRow,
    input: CreateOutboxEventInput,
  ): { event: OutboxEventRecord; converged: boolean } {
    const event = mapOutboxEvent(row);
    if (event.inputHash !== input.inputHash) {
      throw new EventsStoreRuleError(
        `idempotency key "${input.idempotencyKey}" was already used for a different outbound event input`,
        'outbox-input-conflict',
      );
    }
    return { event, converged: true };
  }

  return {
    async ingestInboxEvent(input: IngestInboxEventInput): Promise<{ event: InboxEventRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Converge a re-delivery of the stable identity before anything else.
        const existing = await findInboxEventRowByIdentity(tx, input.tenantId, input.source, input.externalEventId);
        if (existing !== null) {
          return convergeDelivery(existing, input);
        }

        const base: Omit<InboxEventRecord, 'recordHash'> = {
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          source: input.source,
          externalEventId: input.externalEventId,
          eventType: input.eventType,
          occurredAt: input.occurredAt,
          payload: input.payload,
          deliveryHash: input.deliveryHash,
          state: input.rejection === null ? 'received' : 'rejected',
          rejection:
            input.rejection === null
              ? null
              : { code: input.rejection, rejectedAt: input.now },
          claim: null,
          consumption: null,
          failure: null,
          receivedBy: input.receivedBy,
          createdAt: input.now,
          updatedAt: input.now,
        };
        const record: InboxEventRecord = { ...base, recordHash: computeInboxEventRecordHash(base) };

        // ON CONFLICT DO NOTHING against the stable identity: a
        // concurrent delivery of the same identity keeps a healthy
        // transaction and converges by re-reading.
        const inserted = await query(
          tx,
          `INSERT INTO event_inbox
             (id, tenant_id, source, external_event_id, event_type, occurred_at, payload,
              delivery_hash, state, rejection_code, rejection_rejected_at, received_by, record_hash, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $14)
           ON CONFLICT (tenant_id, source, external_event_id) DO NOTHING
           RETURNING ${INBOX_COLUMNS}`,
          [
            record.id,
            input.tenantId,
            input.source,
            input.externalEventId,
            input.eventType,
            input.occurredAt,
            canonicalJson(input.payload),
            input.deliveryHash,
            record.state,
            input.rejection,
            input.rejection === null ? null : input.now,
            input.receivedBy,
            record.recordHash,
            input.now,
          ],
          'ingestInboxEvent',
        );
        if (inserted.length > 0) {
          return { event: mapInboxEvent(inserted[0] as unknown as InboxEventRow), converged: false };
        }
        const raced = await findInboxEventRowByIdentity(tx, input.tenantId, input.source, input.externalEventId);
        if (raced !== null) {
          return convergeDelivery(raced, input);
        }
        throw new StoreConflictError('ingestInboxEvent violated a uniqueness constraint', 'event_inbox_tenant_source_external_id');
      });
    },

    async findInboxEvent(tenantId: string, eventId: string): Promise<InboxEventRecord | null> {
      const row = await findInboxEventRow(executor, tenantId, eventId);
      return row === null ? null : mapInboxEvent(row);
    },

    async listInboxEvents(tenantId: string, filter?: InboxEventFilter): Promise<InboxEventRecord[]> {
      const predicates: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let slot = 1;
      if (filter?.state !== undefined) {
        slot += 1;
        predicates.push(`state = $${slot}`);
        params.push(filter.state);
      }
      if (filter?.source !== undefined) {
        slot += 1;
        predicates.push(`source = $${slot}`);
        params.push(filter.source);
      }
      const rows = await query(
        executor,
        `SELECT ${INBOX_COLUMNS} FROM event_inbox WHERE ${predicates.join(' AND ')} ORDER BY created_at, id`,
        params,
        'listInboxEvents',
      );
      return rows.map((row) => mapInboxEvent(row as unknown as InboxEventRow));
    },

    async listClaimableInboxEvents(tenantId: string, limit: number): Promise<InboxEventRecord[]> {
      const rows = await query(
        executor,
        `SELECT ${INBOX_COLUMNS} FROM event_inbox WHERE tenant_id = $1 AND state = 'received' ORDER BY created_at, id LIMIT $2`,
        [tenantId, limit],
        'listClaimableInboxEvents',
      );
      return rows.map((row) => mapInboxEvent(row as unknown as InboxEventRow));
    },

    async listRecoverableInboxEvents(tenantId: string): Promise<InboxEventRecord[]> {
      const rows = await query(
        executor,
        `SELECT ${INBOX_COLUMNS} FROM event_inbox WHERE tenant_id = $1 AND state = 'processing' ORDER BY claimed_at, id`,
        [tenantId],
        'listRecoverableInboxEvents',
      );
      return rows.map((row) => mapInboxEvent(row as unknown as InboxEventRow));
    },

    async claimInboxEvent(input: ClaimInboxEventInput): Promise<InboxEventRecord> {
      return executor.withTransaction(async (tx) =>
        writeInboxState(
          tx,
          input,
          'received',
          'inbox-claim-conflict',
          (current) => ({
            ...current,
            state: 'processing',
            claim: { claimedBy: input.claimedBy, claimedAt: input.now },
          }),
          'claimInboxEvent',
        ),
      );
    },

    async retryInboxEvent(input: RetryInboxEventInput): Promise<InboxEventRecord> {
      return executor.withTransaction(async (tx) =>
        writeInboxState(
          tx,
          input,
          'failed',
          'inbox-retry-conflict',
          (current) => ({
            ...current,
            state: 'processing',
            claim: { claimedBy: input.retriedBy, claimedAt: input.now },
            failure: null,
          }),
          'retryInboxEvent',
        ),
      );
    },

    async reclaimInboxEvent(input: ReclaimInboxEventInput): Promise<InboxEventRecord> {
      return executor.withTransaction(async (tx) =>
        writeInboxState(
          tx,
          input,
          'processing',
          'inbox-reclaim-conflict',
          (current) => ({
            ...current,
            claim: { claimedBy: input.reclaimedBy, claimedAt: input.now },
          }),
          'reclaimInboxEvent',
        ),
      );
    },

    async completeInboxEvent(input: CompleteInboxEventInput): Promise<InboxEventRecord> {
      return executor.withTransaction(async (tx) =>
        writeInboxState(
          tx,
          input,
          'processing',
          'inbox-completion-conflict',
          (current) => ({
            ...current,
            state: 'consumed',
            consumption: {
              result: input.result,
              consumedBy: input.consumedBy,
              consumedAt: input.now,
            },
            failure: null,
          }),
          'completeInboxEvent',
        ),
      );
    },

    async failInboxEvent(input: FailInboxEventInput): Promise<InboxEventRecord> {
      return executor.withTransaction(async (tx) =>
        writeInboxState(
          tx,
          input,
          'processing',
          'inbox-completion-conflict',
          (current) => ({
            ...current,
            state: 'failed',
            failure: {
              code: input.code,
              message: input.message,
              failedAt: input.now,
            },
          }),
          'failInboxEvent',
        ),
      );
    },

    async createOutboxEvent(input: CreateOutboxEventInput): Promise<{ event: OutboxEventRecord; converged: boolean }> {
      return executor.withTransaction(async (tx) => {
        // Keyed fast-path convergence: a retry re-observes the durable
        // event before anything else.
        if (input.idempotencyKey !== null) {
          const existing = await findOutboxEventRowByKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            return convergeOutbox(existing, input);
          }
        }

        const base: Omit<OutboxEventRecord, 'recordHash'> = {
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          eventType: input.eventType,
          payload: input.payload,
          destination: input.destination,
          correlation: input.correlation ?? {},
          policy: input.policy,
          requestedBy: input.requestedBy,
          idempotencyKey: input.idempotencyKey,
          inputHash: input.inputHash,
          state: 'intended',
          claim: null,
          dispatch: null,
          failure: null,
          createdAt: input.now,
          updatedAt: input.now,
        };
        const record: OutboxEventRecord = { ...base, recordHash: computeOutboxEventRecordHash(base) };

        // ON CONFLICT DO NOTHING against the tenant-scoped keyed partial
        // unique index: a concurrent creator of the same logical intent
        // keeps a healthy transaction and converges by re-reading.
        const inserted = await query(
          tx,
          `INSERT INTO event_outbox
             (id, tenant_id, event_type, payload, destination, correlation, policy_key, policy_decision_id,
              requested_by, idempotency_key, input_hash, record_hash, state, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, 'intended', $13, $13)
           ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING ${OUTBOX_COLUMNS}`,
          [
            record.id,
            input.tenantId,
            input.eventType,
            canonicalJson(input.payload),
            input.destination,
            canonicalJson(input.correlation ?? {}),
            input.policy?.policyKey ?? null,
            input.policy?.decisionId ?? null,
            input.requestedBy,
            input.idempotencyKey,
            input.inputHash,
            record.recordHash,
            input.now,
          ],
          'createOutboxEvent',
        );
        if (inserted.length > 0) {
          return { event: mapOutboxEvent(inserted[0] as unknown as OutboxEventRow), converged: false };
        }
        if (input.idempotencyKey !== null) {
          const existing = await findOutboxEventRowByKey(tx, input.tenantId, input.idempotencyKey);
          if (existing !== null) {
            return convergeOutbox(existing, input);
          }
        }
        throw new StoreConflictError('createOutboxEvent violated a uniqueness constraint', 'event_outbox_tenant_idempotency_key');
      });
    },

    async findOutboxEvent(tenantId: string, eventId: string): Promise<OutboxEventRecord | null> {
      const row = await findOutboxEventRow(executor, tenantId, eventId);
      return row === null ? null : mapOutboxEvent(row);
    },

    async listOutboxEvents(tenantId: string, filter?: OutboxEventFilter): Promise<OutboxEventRecord[]> {
      const predicates: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (filter?.state !== undefined) {
        params.push(filter.state);
        predicates.push('state = $2');
      }
      const rows = await query(
        executor,
        `SELECT ${OUTBOX_COLUMNS} FROM event_outbox WHERE ${predicates.join(' AND ')} ORDER BY created_at, id`,
        params,
        'listOutboxEvents',
      );
      return rows.map((row) => mapOutboxEvent(row as unknown as OutboxEventRow));
    },

    async listRecoverableOutboxEvents(tenantId: string): Promise<OutboxEventRecord[]> {
      const rows = await query(
        executor,
        `SELECT ${OUTBOX_COLUMNS} FROM event_outbox WHERE tenant_id = $1 AND state = 'dispatching' ORDER BY claimed_at, id`,
        [tenantId],
        'listRecoverableOutboxEvents',
      );
      return rows.map((row) => mapOutboxEvent(row as unknown as OutboxEventRow));
    },

    async claimOutboxEvent(input: ClaimOutboxEventInput): Promise<OutboxEventRecord> {
      return executor.withTransaction(async (tx) =>
        writeOutboxState(
          tx,
          input,
          'intended',
          'outbox-claim-conflict',
          (current) => ({
            ...current,
            state: 'dispatching',
            claim: { claimedBy: input.claimedBy, claimedAt: input.now },
          }),
          'claimOutboxEvent',
        ),
      );
    },

    async completeOutboxDispatch(input: CompleteOutboxDispatchInput): Promise<OutboxEventRecord> {
      return executor.withTransaction(async (tx) =>
        writeOutboxState(
          tx,
          input,
          'dispatching',
          'outbox-completion-conflict',
          (current) => ({
            ...current,
            state: 'dispatched',
            dispatch: {
              provider: input.provider,
              providerReference: input.providerReference,
              dispatchedAt: input.now,
              dispatchedBy: input.dispatchedBy,
            },
          }),
          'completeOutboxDispatch',
        ),
      );
    },

    async failOutboxDispatch(input: FailOutboxDispatchInput): Promise<OutboxEventRecord> {
      return executor.withTransaction(async (tx) =>
        writeOutboxState(
          tx,
          input,
          'dispatching',
          'outbox-completion-conflict',
          (current) => ({
            ...current,
            state: 'failed',
            failure: {
              code: 'DELIVERY_FAILED',
              message: input.error,
              failedAt: input.now,
            },
          }),
          'failOutboxDispatch',
        ),
      );
    },

    async reclaimOutboxDispatch(input: ReclaimOutboxDispatchInput): Promise<OutboxEventRecord> {
      return executor.withTransaction(async (tx) =>
        writeOutboxState(
          tx,
          input,
          'dispatching',
          'outbox-reclaim-conflict',
          (current) => ({
            ...current,
            claim: { claimedBy: input.reclaimedBy, claimedAt: input.now },
          }),
          'reclaimOutboxDispatch',
        ),
      );
    },
  };
}
