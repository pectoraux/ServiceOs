/**
 * WORK-015 transaction-scope proofs (in-env, always-on; no PostgreSQL
 * required — the live-PostgreSQL equivalents live in
 * interactions.integration.test.ts and run in CI).
 *
 * The guarantee under test (the PR #28 review defect class, fixed for
 * /workflow and pinned here for the new stores): every statement of
 * every `withTransaction` critical section in the /interactions and
 * /notifications SQL stores runs on the ONE pinned transaction client
 * (`tx`), never on the pooled executor.
 *
 * Layers:
 * 1. Tripwire executor (this file): the pooled channel HARD-FAILS while a
 *    transaction is open, and the transaction channel records every
 *    statement. The stores' mutation paths are driven to completion
 *    through canned in-transaction responses; ANY pool statement issued
 *    during the open transaction fails the proof with the exact
 *    escaping statement, and the recorded statement sequences pin the
 *    critical-section order.
 * 2. Source discipline (this file): the `query` helper takes its
 *    executor explicitly and every call site inside a transaction names
 *    `tx` (the same scan discipline as the WORK-004 proof).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SqlExecutor, TransactionalExecutor, QueryResult } from '../src/platform/persistence/index.js';
import {
  computeInteractionRecordHash,
  createSqlInteractionsStore,
  hashInteractionInput,
  type ClaimDispatchInput,
  type CompleteDispatchInput,
  type CreateInteractionInput,
  type RecordDispatchFailureInput,
  type RecordObservationInput,
  type InteractionRecord,
} from '../src/modules/interactions/index.js';
import {
  computeNotificationRecordHash,
  createSqlNotificationsStore,
  hashNotificationInput,
  type CreateNotificationInput,
  type SetInteractionPointerInput,
  type NotificationRecord,
} from '../src/modules/notifications/index.js';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const ACTOR = '00000000-0000-4000-8000-0000000000cc';
const INTERACTION_ID = '00000000-0000-4000-8000-0000000000dd';
const NEW_INTERACTION_ID = '00000000-0000-4000-8000-0000000000df';
const NOTIFICATION_ID = '00000000-0000-4000-8000-0000000000ee';
const PROVIDER = 'in-memory-double';
const PROVIDER_REF = `double-${INTERACTION_ID}`;
const NOW = new Date('2026-09-01T10:00:00.000Z');
const EMAIL_PARAMS = { to: ['a@b.c'], subject: 's', body: 'b' };

/** Canned in-transaction response for one classified statement. */
type Responder = (sql: string, params: unknown[]) => Record<string, unknown>[];

/** Classify a store statement by its SQL contract (order-sensitive proofs). */
function classify(sql: string): string {
  const s = sql.trim();
  if (s.startsWith('INSERT INTO interaction_effects')) return 'interaction-insert';
  if (s.startsWith('SELECT id, tenant_id, capability, params, correlation, retry_of_interaction_id, policy_key, policy_decision_id, requested_by, idempotency_key, input_hash, record_hash, state, claim_claimed_by, claim_claimed_at, provider, provider_reference, dispatched_at, dispatched_by, outcome, failure_stage, observed_by, observed_at, provider_observation, created_at, updated_at FROM interaction_effects WHERE tenant_id = $1 AND idempotency_key = $2')) {
    return 'interaction-keyed-lookup';
  }
  if (s.startsWith('SELECT id, tenant_id, capability, params, correlation, retry_of_interaction_id, policy_key, policy_decision_id, requested_by, idempotency_key, input_hash, record_hash, state, claim_claimed_by, claim_claimed_at, provider, provider_reference, dispatched_at, dispatched_by, outcome, failure_stage, observed_by, observed_at, provider_observation, created_at, updated_at FROM interaction_effects WHERE tenant_id = $1 AND id = $2 FOR UPDATE')) {
    return 'interaction-row-lock';
  }
  if (s.startsWith('UPDATE interaction_effects') && s.includes(`WHERE tenant_id = $15 AND id = $16 AND state = $17`)) {
    return 'interaction-state-write';
  }
  if (s.startsWith('UPDATE interaction_effects') && s.includes(`WHERE tenant_id = $7 AND id = $8 AND state = 'dispatched'`)) {
    return 'observation-write';
  }
  if (s.startsWith('SELECT id, tenant_id, capability, params, correlation, retry_of_interaction_id, policy_key, policy_decision_id')) {
    return 'interaction-retry-target-lookup';
  }
  if (s.startsWith('INSERT INTO notification_requests')) return 'notification-insert';
  if (s.startsWith('SELECT id, tenant_id, channel, recipient, content, purpose, correlation, requested_by, idempotency_key, input_hash, record_hash, current_interaction_id, created_at, updated_at FROM notification_requests WHERE tenant_id = $1 AND idempotency_key = $2')) {
    return 'notification-keyed-lookup';
  }
  if (s.startsWith('SELECT id, tenant_id, channel, recipient, content, purpose, correlation, requested_by, idempotency_key, input_hash, record_hash, current_interaction_id, created_at, updated_at FROM notification_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE')) {
    return 'notification-row-lock';
  }
  if (s.startsWith('UPDATE notification_requests')) return 'notification-pointer-write';
  return `unexpected:${s.slice(0, 80)}`;
}

interface Tripwire {
  readonly executor: TransactionalExecutor;
  /** The classified statements observed on the TRANSACTION channel, in order. */
  readonly statements: string[];
  /** Transactions currently open (0 after every settled call). */
  openTransactions(): number;
}

/**
 * THE TRIPWIRE. `executor.query` is the POOLED channel. While a
 * transaction is open on this executor, any statement routed here has
 * ESCAPED the pinned transaction client — the exact PR #28 review defect
 * class. It fails immediately with the escaping statement.
 */
function createTripwireExecutor(respond: Responder): Tripwire {
  let open = 0;
  const statements: string[] = [];
  const tx: SqlExecutor = {
    query: async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      statements.push(classify(sql));
      return { rows: respond(sql, params ?? []), rowCount: null };
    },
  };
  const executor: TransactionalExecutor = {
    query: async (sql: string): Promise<QueryResult> => {
      assert.fail(
        open === 0
          ? `pool channel unexpectedly used outside a transaction (extend the harness): ${sql.trim().slice(0, 80)}`
          : `TRANSACTION ESCAPE: statement issued on the pooled executor while the transaction is open `
          + `(it would run on a different connection, autocommitted, outside the transaction): ${sql.trim().slice(0, 80)}`,
      );
    },
    withTransaction: async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
      open += 1;
      try {
        const result = await fn(tx);
        open -= 1; // COMMIT
        return result;
      } catch (error) {
        open -= 1; // ROLLBACK
        throw error;
      }
    },
  };
  return { executor, statements, openTransactions: () => open };
}

// ---------------------------------------------------------------------------
// /interactions store: canned row builders
// ---------------------------------------------------------------------------

function interactionRow(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const inputHash = hashInteractionInput({ capability: 'email', params: EMAIL_PARAMS, correlation: {}, retryOf: null, policyKey: null });
  const base: Record<string, unknown> = {
    id: INTERACTION_ID,
    tenant_id: TENANT,
    capability: 'email',
    params: EMAIL_PARAMS,
    correlation: {},
    retry_of_interaction_id: null,
    policy_key: null,
    policy_decision_id: null,
    requested_by: ACTOR,
    idempotency_key: null,
    input_hash: inputHash,
    record_hash: 'pending',
    state,
    claim_claimed_by: state === 'intended' ? null : ACTOR,
    claim_claimed_at: state === 'intended' ? null : NOW,
    provider: state === 'dispatched' || state === 'observed' ? PROVIDER : null,
    provider_reference: state === 'dispatched' || state === 'observed' ? PROVIDER_REF : null,
    dispatched_at: state === 'dispatched' || state === 'observed' ? NOW : null,
    dispatched_by: state === 'dispatched' || state === 'observed' ? ACTOR : null,
    outcome: state === 'observed' ? 'succeeded' : null,
    failure_stage: null,
    observed_by: state === 'observed' ? ACTOR : null,
    observed_at: state === 'observed' ? NOW : null,
    provider_observation: state === 'observed' ? { receipt: 'r' } : null,
    created_at: NOW,
    updated_at: NOW,
  };
  // The canned row must carry a VALID record hash (the store verifies it
  // on read before every mutation).
  const record = {
    id: INTERACTION_ID,
    tenantId: TENANT,
    capability: 'email' as const,
    params: EMAIL_PARAMS,
    correlation: {},
    retryOfInteractionId: null,
    policy: null,
    requestedBy: ACTOR,
    idempotencyKey: null,
    inputHash: inputHash,
    state: state as 'intended' | 'dispatching' | 'dispatched' | 'observed',
    claim: state === 'intended' ? null : { claimedBy: ACTOR, claimedAt: NOW },
    dispatch:
      state === 'dispatched' || state === 'observed'
        ? { provider: PROVIDER, providerReference: PROVIDER_REF, dispatchedAt: NOW, dispatchedBy: ACTOR }
        : null,
    observation:
      state === 'observed'
        ? { outcome: 'succeeded' as const, failureStage: null, providerObservation: { receipt: 'r' }, observedBy: ACTOR, observedAt: NOW }
        : null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  base['record_hash'] = computeInteractionRecordHash(record);
  return { ...base, ...overrides };
}

test('createInteraction runs its whole critical section on the pinned transaction client', async () => {
  let insertedRow: Record<string, unknown> | null = null;
  const respond: Responder = (sql, params) => {
    switch (classify(sql)) {
      case 'interaction-keyed-lookup':
        return insertedRow === null ? [] : [insertedRow];
      case 'interaction-insert': {
        // Echo the INSERT parameters as the RETURNING row (the store
        // computed the record hash, so the echo is hash-consistent — the
        // same guarantee PostgreSQL RETURNING gives).
        insertedRow = {
          id: params[0],
          tenant_id: params[1],
          capability: params[2],
          params: JSON.parse(String(params[3])),
          correlation: JSON.parse(String(params[4])),
          retry_of_interaction_id: params[5],
          policy_key: params[6],
          policy_decision_id: params[7],
          requested_by: params[8],
          idempotency_key: params[9],
          input_hash: params[10],
          record_hash: params[11],
          state: 'intended',
          claim_claimed_by: null,
          claim_claimed_at: null,
          provider: null,
          provider_reference: null,
          dispatched_at: null,
          dispatched_by: null,
          outcome: null,
          failure_stage: null,
          observed_by: null,
          observed_at: null,
          provider_observation: null,
          created_at: params[12],
          updated_at: params[12],
        };
        return [insertedRow];
      }
      default:
        throw new Error(
          `transaction-scope harness: SQL drifted from the store contract (update the classifier): ${sql.trim().slice(0, 80)}`,
        );
    }
  };
  const tripwire = createTripwireExecutor(respond);
  const store = createSqlInteractionsStore(tripwire.executor);

  const input: CreateInteractionInput = {
    tenantId: TENANT,
    capability: 'email',
    params: EMAIL_PARAMS,
    correlation: null,
    retryOfInteractionId: null,
    policy: null,
    requestedBy: ACTOR,
    idempotencyKey: 'scope-1',
    inputHash: hashInteractionInput({ capability: 'email', params: EMAIL_PARAMS, correlation: {}, retryOf: null, policyKey: null }),
    now: NOW,
  };
  const { interaction, converged } = await store.createInteraction(input);

  assert.equal(converged, false);
  assert.equal(interaction.state, 'intended');
  // The critical section, in order, entirely on the transaction client.
  assert.deepEqual(tripwire.statements, ['interaction-keyed-lookup', 'interaction-insert']);
  assert.equal(tripwire.openTransactions(), 0);

  // A keyed retry converges with ONLY the keyed lookup, on the pinned client.
  tripwire.statements.length = 0;
  const second = await store.createInteraction(input);
  assert.equal(second.converged, true);
  assert.deepEqual(tripwire.statements, ['interaction-keyed-lookup']);
  assert.equal(tripwire.openTransactions(), 0);
});

test('the dispatch mutations (claim, completion, failure, observation) each run on the pinned transaction client', async () => {
  // One row whose state is advanced by the harness as the canned responses.
  let row: Record<string, unknown> = interactionRow('intended');
  const respond: Responder = (sql, params) => {
    switch (classify(sql)) {
      case 'interaction-row-lock':
        return [row];
      case 'interaction-state-write':
      case 'observation-write': {
        // Echo the row with the UPDATE's new values applied: the store
        // computed the new record hash, so the echo is hash-consistent.
        row = {
          ...row,
          state: params[0],
          claim_claimed_by: params[1],
          claim_claimed_at: params[2],
          provider: params[3],
          provider_reference: params[4],
          dispatched_at: params[5],
          dispatched_by: params[6],
          outcome: params[7],
          failure_stage: params[8],
          observed_by: params[9],
          observed_at: params[10],
          provider_observation: params[11],
          record_hash: params[12],
          updated_at: params[13],
        };
        return [];
      }
      default:
        throw new Error(
          `transaction-scope harness: SQL drifted from the store contract (update the classifier): ${sql.trim().slice(0, 80)}`,
        );
    }
  };
  const tripwire = createTripwireExecutor(respond);
  const store = createSqlInteractionsStore(tripwire.executor);

  // claimDispatch: intended -> dispatching.
  const claimed: InteractionRecord = await store.claimDispatch({
    tenantId: TENANT,
    interactionId: INTERACTION_ID,
    claimedBy: ACTOR,
    now: NOW,
  });
  assert.equal(claimed.state, 'dispatching');
  assert.deepEqual(tripwire.statements, ['interaction-row-lock', 'interaction-state-write']);
  assert.equal(tripwire.openTransactions(), 0);

  // completeDispatch: dispatching -> dispatched.
  tripwire.statements.length = 0;
  const completed = await store.completeDispatch({
    tenantId: TENANT,
    interactionId: INTERACTION_ID,
    provider: PROVIDER,
    providerReference: PROVIDER_REF,
    dispatchedBy: ACTOR,
    now: NOW,
  });
  assert.equal(completed.state, 'dispatched');
  assert.deepEqual(tripwire.statements, ['interaction-row-lock', 'interaction-state-write']);
  assert.equal(tripwire.openTransactions(), 0);

  // recordObservation: dispatched -> observed.
  tripwire.statements.length = 0;
  const observed = await store.recordObservation({
    tenantId: TENANT,
    interactionId: INTERACTION_ID,
    outcome: 'succeeded',
    providerObservation: { receipt: 'r' },
    observedBy: ACTOR,
    now: NOW,
  });
  assert.equal(observed.interaction.state, 'observed');
  assert.deepEqual(tripwire.statements, ['interaction-row-lock', 'observation-write']);
  assert.equal(tripwire.openTransactions(), 0);

  // recordDispatchFailure from a fresh dispatching row.
  row = interactionRow('dispatching');
  tripwire.statements.length = 0;
  const failed = await store.recordDispatchFailure({
    tenantId: TENANT,
    interactionId: INTERACTION_ID,
    dispatchedBy: ACTOR,
    error: 'provider exploded',
    now: NOW,
  });
  assert.equal(failed.state, 'observed');
  assert.equal(failed.observation?.failureStage, 'dispatch');
  assert.deepEqual(tripwire.statements, ['interaction-row-lock', 'interaction-state-write']);
  assert.equal(tripwire.openTransactions(), 0);
});

test('state writes keep the stored record hash consistent with the stored updated_at (moving clock)', async () => {
  // Regression proof for a frozen-clock-masked defect class: the record
  // hash must be computed over the POST-write record INCLUDING the new
  // updated_at. A store that hashes the stale updatedAt while the row
  // stores the write's now poisons every subsequent read's integrity
  // verification (a false interaction-record-tampered). The harness
  // echoes each UPDATE's parameters into the canned row, so the poisoned
  // row is read back by the very next statement and the defect fails
  // here; the frozen clocks elsewhere in the suite cannot see it.
  let row: Record<string, unknown> = interactionRow('intended');
  const respond: Responder = (sql, params) => {
    switch (classify(sql)) {
      case 'interaction-row-lock':
        return [row];
      case 'interaction-state-write': {
        row = {
          ...row,
          state: params[0],
          claim_claimed_by: params[1],
          claim_claimed_at: params[2],
          provider: params[3],
          provider_reference: params[4],
          dispatched_at: params[5],
          dispatched_by: params[6],
          outcome: params[7],
          failure_stage: params[8],
          observed_by: params[9],
          observed_at: params[10],
          provider_observation: params[11],
          record_hash: params[12],
          updated_at: params[13],
        };
        return [];
      }
      case 'observation-write': {
        // recordObservation's UPDATE: SET state = 'observed', outcome = $1,
        // failure_stage = $2, observed_by = $3, observed_at = $4,
        // provider_observation = $5, record_hash = $6, updated_at = $4.
        row = {
          ...row,
          state: 'observed',
          outcome: params[0],
          failure_stage: params[1],
          observed_by: params[2],
          observed_at: params[3],
          provider_observation: params[4],
          record_hash: params[5],
          updated_at: params[3],
        };
        return [];
      }
      default:
        throw new Error(
          `transaction-scope harness: SQL drifted from the store contract (update the classifier): ${sql.trim().slice(0, 80)}`,
        );
    }
  };
  const tripwire = createTripwireExecutor(respond);
  const store = createSqlInteractionsStore(tripwire.executor);

  // A MOVING clock: each state write lands strictly after the previous one.
  const t1 = new Date('2026-09-01T11:00:00.000Z');
  const t2 = new Date('2026-09-01T12:00:00.000Z');
  const t3 = new Date('2026-09-01T13:00:00.000Z');

  const claimed = await store.claimDispatch({
    tenantId: TENANT,
    interactionId: INTERACTION_ID,
    claimedBy: ACTOR,
    now: t1,
  });
  assert.equal(claimed.state, 'dispatching');
  assert.equal(claimed.updatedAt.getTime(), t1.getTime(), 'the post-write record carries the write timestamp');

  // Reading the claim's own write back (row-lock) verifies the integrity
  // hash over the STORED updated_at — a stale-hash claim fails here.
  const completed = await store.completeDispatch({
    tenantId: TENANT,
    interactionId: INTERACTION_ID,
    provider: PROVIDER,
    providerReference: PROVIDER_REF,
    dispatchedBy: ACTOR,
    now: t2,
  });
  assert.equal(completed.state, 'dispatched');
  assert.equal(completed.updatedAt.getTime(), t2.getTime());

  const observed = await store.recordObservation({
    tenantId: TENANT,
    interactionId: INTERACTION_ID,
    outcome: 'succeeded',
    providerObservation: { receipt: 'moving-clock' },
    observedBy: ACTOR,
    now: t3,
  });
  assert.equal(observed.interaction.state, 'observed');
  assert.equal(observed.interaction.updatedAt.getTime(), t3.getTime());
  assert.equal(tripwire.openTransactions(), 0);
});

// ---------------------------------------------------------------------------
// /notifications store: the pointer write
// ---------------------------------------------------------------------------

function notificationRow(interactionId: string | null): Record<string, unknown> {
  const inputHash = hashNotificationInput({
    channel: 'email',
    recipient: { address: 'a@b.c' },
    content: { subject: 's', body: 'b' },
    purpose: null,
    correlation: {},
  });
  const base: Record<string, unknown> = {
    id: NOTIFICATION_ID,
    tenant_id: TENANT,
    channel: 'email',
    recipient: { address: 'a@b.c' },
    content: { subject: 's', body: 'b' },
    purpose: null,
    correlation: {},
    requested_by: ACTOR,
    idempotency_key: null,
    input_hash: inputHash,
    record_hash: 'pending',
    current_interaction_id: interactionId,
    created_at: NOW,
    updated_at: NOW,
  };
  const record = {
    id: NOTIFICATION_ID,
    tenantId: TENANT,
    channel: 'email' as const,
    recipient: { address: 'a@b.c' },
    content: { subject: 's', body: 'b' },
    purpose: null,
    correlation: {},
    requestedBy: ACTOR,
    idempotencyKey: null,
    inputHash: inputHash,
    currentInteractionId: interactionId,
    createdAt: NOW,
    updatedAt: NOW,
  };
  base['record_hash'] = computeNotificationRecordHash(record);
  return base;
}

test('setInteractionPointer runs its write path on the pinned transaction client', async () => {
  let row = notificationRow(null);
  const respond: Responder = (sql, params) => {
    switch (classify(sql)) {
      case 'notification-row-lock':
        return [row];
      case 'notification-pointer-write': {
        row = { ...row, current_interaction_id: params[0], record_hash: params[1], updated_at: params[2] };
        return [];
      }
      default:
        throw new Error(
          `transaction-scope harness: SQL drifted from the store contract (update the classifier): ${sql.trim().slice(0, 80)}`,
        );
    }
  };
  const tripwire = createTripwireExecutor(respond);
  const store = createSqlNotificationsStore(tripwire.executor);

  const updated: NotificationRecord = await store.setInteractionPointer({
    tenantId: TENANT,
    notificationId: NOTIFICATION_ID,
    interactionId: INTERACTION_ID,
    now: NOW,
  });
  assert.equal(updated.currentInteractionId, INTERACTION_ID);
  assert.deepEqual(tripwire.statements, ['notification-row-lock', 'notification-pointer-write']);
  assert.equal(tripwire.openTransactions(), 0);
});

// ---------------------------------------------------------------------------
// Source discipline: the executor-explicit query convention
// ---------------------------------------------------------------------------

test('source discipline: the new stores take their executor explicitly at every call site', () => {
  const interactionsSource = readFileSync(resolve(process.cwd(), 'src/modules/interactions/sql-store.ts'), 'utf8');
  const notificationsSource = readFileSync(resolve(process.cwd(), 'src/modules/notifications/sql-store.ts'), 'utf8');
  for (const [label, source] of [
    ['interactions/sql-store.ts', interactionsSource],
    ['notifications/sql-store.ts', notificationsSource],
  ] as const) {
    // The helper signature takes the executor as its FIRST parameter.
    assert.match(
      source,
      /async function query\(\s*exec: SqlExecutor,/,
      `${label}: the query helper must take its executor explicitly (first parameter)`,
    );
    // No closure-captured executor inside withTransaction: every pooled
    // read passes `executor` OUTSIDE transactions only; the pooled call
    // sites are the read paths.
    const pooledReads = [...source.matchAll(/await query\(\s*executor,/g)].length;
    assert.ok(pooledReads > 0, `${label}: expected pooled read paths to pass the executor explicitly`);
    // The transactional call sites pass `tx` explicitly.
    const txCalls = [...source.matchAll(/await query\(\s*tx,/g)].length;
    assert.ok(txCalls > 0, `${label}: expected in-transaction statements to pass tx explicitly`);
  }
});
