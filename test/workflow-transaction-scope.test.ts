/**
 * WORK-004 transaction-scope proofs (in-env, always-on; no PostgreSQL
 * required — the live-PostgreSQL equivalents live in
 * workflow.integration.test.ts and run in CI).
 *
 * The CRITICAL guarantee under test: `applyTransition`'s critical section —
 * the keyed convergence lookup, the work-row `FOR UPDATE`, the
 * expected-status re-validation, the dependency gate (under the per-tenant
 * advisory lock), the ledger sequence allocation, the ledger insert and
 * the status write — runs as ONE unit on ONE pinned transaction client.
 *
 * The defect class this proof family pins (found in the Architect review
 * of PR #28): the SQL store's `query` helper closure-captured the POOLED
 * executor, so those load-bearing statements executed on a DIFFERENT
 * connection — autocommitted, outside the transaction, their locks
 * released at statement end — silently voiding the atomicity and
 * serialization the workflow authority claims, while the schema backstops
 * (UNIQUE (work_id, seq), the keyed partial unique index) kept the
 * observable test outcomes green.
 *
 * Layers:
 * 1. Tripwire executor (this file): the pooled channel HARD-FAILS while a
 *    transaction is open, and the transaction channel records every
 *    statement. `applyTransition` and `setSlaDeadline` are driven to
 *    completion through canned in-transaction responses; ANY pool
 *    statement issued during the open transaction fails the proof with
 *    the exact escaping statement, and the recorded statement sequence
 *    pins the critical-section order.
 * 2. Source discipline (this file): the `query` helper takes its executor
 *    explicitly and every call site names the executor it targets
 *    (`tx` inside transactions, `executor` on read paths).
 * 3. Live-PostgreSQL equivalents (CI): the single-connection-pool proof
 *    (an escaped statement can never acquire a client) and the
 *    forced-commit-rollback proof (an escaped autocommitted statement
 *    survives the rollback).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SqlExecutor, TransactionalExecutor, QueryResult } from '../src/platform/persistence/index.js';
import {
  createSqlWorkflowStore,
  hashTransitionInput,
  transitionRuleId,
  type ApplyTransitionInput,
  type SetSlaDeadlineInput,
  type TransitionRecord,
} from '../src/modules/workflow/index.js';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const WORK = '00000000-0000-4000-8000-0000000000bb';
const ACTOR = '00000000-0000-4000-8000-0000000000cc';
const TRANSITION_ID = '00000000-0000-4000-8000-0000000000dd';
const SLA_ID = '00000000-0000-4000-8000-0000000000ee';
const NOW = new Date('2026-09-01T10:00:00.000Z');

/** Canned in-transaction response for one classified statement. */
type Responder = (sql: string, params: unknown[]) => Record<string, unknown>[];

/** Classify a store statement by its SQL contract (order-sensitive proofs). */
function classify(sql: string): string {
  const s = sql.trim();
  if (s.startsWith('SELECT pg_advisory_xact_lock')) return 'advisory-dependency-lock';
  if (s.includes('FOR UPDATE')) return 'work-row-lock';
  if (s.startsWith('SELECT count(*) AS unmet')) return 'dependency-gate';
  if (s.startsWith('SELECT COALESCE(MAX(seq)')) return 'ledger-sequence';
  if (s.startsWith('INSERT INTO workflow_transitions')) return 'ledger-insert';
  if (s.startsWith('UPDATE work_service_works')) return 'status-write';
  if (s.startsWith('SELECT id, tenant_id, work_id, seq') && s.includes('idempotency_key = $2')) {
    return 'transition-keyed-lookup';
  }
  if (s.startsWith('SELECT id, tenant_id, work_id, state') && s.includes('idempotency_key = $2')) {
    return 'sla-keyed-lookup';
  }
  if (s.startsWith('SELECT id FROM work_service_works')) return 'sla-work-existence';
  if (s.startsWith('INSERT INTO workflow_sla_deadlines')) return 'sla-upsert';
  return `unexpected:${s.slice(0, 60)}`;
}

interface Tripwire {
  readonly executor: TransactionalExecutor;
  /** The classified statements observed on the TRANSACTION channel, in order. */
  readonly statements: string[];
  /** Transactions currently open (0 after every settled call). */
  openTransactions(): number;
}

/**
 * THE TRIPWIRE. `executor.query` is the POOLED channel (one client per
 * statement, autocommit). While a transaction is open on this executor,
 * any statement routed here has ESCAPED the pinned transaction client —
 * the exact PR #28 review defect class. It fails immediately with the
 * escaping statement.
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

/** Canned `applyTransition` in-transaction responses (echo the INSERT as RETURNING). */
function transitionResponder(): { respond: Responder; insertedRow(): Record<string, unknown> | null } {
  let inserted: Record<string, unknown> | null = null;
  const respond: Responder = (sql, params) => {
    switch (classify(sql)) {
      case 'transition-keyed-lookup':
        return inserted === null ? [] : [inserted];
      case 'work-row-lock':
        return [{ id: params[1], work_type: 'compliance.onboarding', status: 'draft' }];
      case 'advisory-dependency-lock':
        return [];
      case 'dependency-gate':
        return [{ unmet: 0 }];
      case 'ledger-sequence':
        return [{ next: 1 }];
      case 'ledger-insert': {
        // Echo the INSERT parameters as the RETURNING row. The store itself
        // computed the input/record hashes, so the echoed row is exactly
        // hash-consistent — the same guarantees PostgreSQL RETURNING gives.
        inserted = {
          id: TRANSITION_ID,
          tenant_id: params[0],
          work_id: params[1],
          seq: params[2],
          from_state: params[3],
          to_state: params[4],
          rule_id: params[5],
          preconditions: JSON.parse(String(params[6])),
          reason: params[7],
          transitioned_by: params[8],
          idempotency_key: params[9],
          input_hash: params[10],
          record_hash: params[11],
          created_at: params[12],
        };
        return [inserted];
      }
      case 'status-write':
        return [];
      default:
        throw new Error(
          `transaction-scope harness: SQL drifted from the store contract (update the classifier): ${sql.trim().slice(0, 80)}`,
        );
    }
  };
  return { respond, insertedRow: () => inserted };
}

function applyInput(): ApplyTransitionInput {
  return {
    tenantId: TENANT,
    workId: WORK,
    expectedFrom: 'draft',
    to: 'ready',
    ruleId: transitionRuleId('draft', 'ready'),
    dependencyGateRequired: true,
    policy: null,
    reason: 'transaction-scope proof',
    transitionedBy: ACTOR,
    idempotencyKey: 'scope-1',
    inputHash: hashTransitionInput({ workId: WORK, to: 'ready', policyKey: null }),
    now: NOW,
  };
}

test('applyTransition runs its whole critical section on the pinned transaction client', async () => {
  const harness = transitionResponder();
  const tripwire = createTripwireExecutor(harness.respond);
  const store = createSqlWorkflowStore(tripwire.executor);

  const { transition, converged } = await store.applyTransition(applyInput());

  assert.equal(converged, false);
  assert.equal(transition.id, TRANSITION_ID);
  assert.equal(transition.seq, 1);
  assert.equal(transition.fromState, 'draft');
  assert.equal(transition.toState, 'ready');
  assert.equal(transition.transitionedBy, ACTOR);
  // The critical section, in order, entirely on the transaction channel.
  // The pooled channel hard-failed on any escape (see the tripwire).
  assert.deepEqual(tripwire.statements, [
    'transition-keyed-lookup',
    'work-row-lock',
    'advisory-dependency-lock',
    'dependency-gate',
    'ledger-sequence',
    'ledger-insert',
    'status-write',
  ]);
  assert.equal(tripwire.openTransactions(), 0);
});

test('a keyed retry converges on the pinned client without touching the work row', async () => {
  const harness = transitionResponder();
  const tripwire = createTripwireExecutor(harness.respond);
  const store = createSqlWorkflowStore(tripwire.executor);

  const input = applyInput();
  const first: TransitionRecord = (await store.applyTransition(input)).transition;
  tripwire.statements.length = 0;

  const second = await store.applyTransition(input);

  assert.equal(second.converged, true);
  assert.equal(second.transition.id, first.id);
  // The retry is ONLY the keyed lookup, on the transaction client: the
  // durable transition is the authority and the work row is never touched.
  assert.deepEqual(tripwire.statements, ['transition-keyed-lookup']);
  assert.equal(tripwire.openTransactions(), 0);
});

test('setSlaDeadline runs its write path on the pinned transaction client', async () => {
  let slaRow: Record<string, unknown> | null = null;
  const respond: Responder = (sql, params) => {
    switch (classify(sql)) {
      case 'sla-keyed-lookup':
        return slaRow === null ? [] : [slaRow];
      case 'sla-work-existence':
        return [{ id: params[1] }];
      case 'sla-upsert':
        slaRow = {
          id: SLA_ID,
          tenant_id: params[0],
          work_id: params[1],
          state: params[2],
          deadline_at: params[3],
          set_by: params[4],
          idempotency_key: params[5],
          created_at: params[6],
          updated_at: params[6],
        };
        return [slaRow];
      default:
        throw new Error(
          `transaction-scope harness: SQL drifted from the store contract (update the classifier): ${sql.trim().slice(0, 80)}`,
        );
    }
  };
  const tripwire = createTripwireExecutor(respond);
  const store = createSqlWorkflowStore(tripwire.executor);

  const input: SetSlaDeadlineInput = {
    tenantId: TENANT,
    workId: WORK,
    state: 'draft',
    deadlineAt: new Date('2026-09-01T11:00:00.000Z'),
    setBy: ACTOR,
    idempotencyKey: 'sla-scope-1',
    now: NOW,
  };
  const { deadline, converged } = await store.setSlaDeadline(input);

  assert.equal(converged, false);
  assert.equal(deadline.id, SLA_ID);
  assert.equal(deadline.state, 'draft');
  assert.equal(deadline.idempotencyKey, 'sla-scope-1');
  // The SLA write path, in order, entirely on the transaction channel.
  assert.deepEqual(tripwire.statements, ['sla-keyed-lookup', 'sla-work-existence', 'sla-upsert']);
  assert.equal(tripwire.openTransactions(), 0);
});

test('the sql store keeps the query helper executor-explicit (regression tripwire)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/modules/workflow/sql-store.ts'), 'utf8');
  // The helper takes its executor as the FIRST parameter...
  assert.match(source, /async function query\(\s*exec: SqlExecutor,/);
  // ...and every call site names the executor it targets: `tx` inside
  // transactions, `executor` on read paths. A call site that omits the
  // executor can only compile against a closure-captured pool — the
  // transaction-escape class this proof family pins (PR #28 review).
  const calls = source.match(/await query\(/g) ?? [];
  const explicit = source.match(/await query\(\s*(?:tx|executor)\s*,/g) ?? [];
  assert.ok(calls.length >= 10, `expected the store's query call sites to be present (found ${calls.length})`);
  assert.equal(
    explicit.length,
    calls.length,
    'every query() call site must name its executor explicitly (tx inside transactions, executor on read paths)',
  );
});
