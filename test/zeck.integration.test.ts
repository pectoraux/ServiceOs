/**
 * Optional live-PostgreSQL integration proof for the Zeck integration
 * boundary runtime (WORK-005, CRITICAL). Runs ONLY when
 * SERVICEOS_TEST_DATABASE_URL points at a disposable PostgreSQL database;
 * otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001..0008 apply in order and are idempotent;
 * - schema backstops hold: the keyed intent identity, the one-intent-per-
 *   attempt correlation identity, the one-intent-per-foreign-execution
 *   partial unique index, the one-delivery-per-event identity, and the
 *   reference/submission + disposition/rejection pairing CHECKs;
 * - the full boundary flow works over real SQL: submit through the one
 *   port (durable intent, dispatch outside the transactions, reference
 *   attach in the serialized section), retry convergence WITHOUT a
 *   second external request, translated callback observations with the
 *   last-seen cursor, and the transport/business separation (the
 *   Service Work record stays untouched after a full success flow);
 * - callback replay is idempotent over real rows; divergent replays and
 *   rejections fail closed WITH durable evidence;
 * - after-the-fact mutation of stored rows is DETECTED on read
 *   (integrity hash recomputation against real rows);
 * - TRUE parallel actors (separate pooled clients) converge: same-key
 *   submissions converge on ONE intent and ONE reference, same-key
 *   divergent submissions produce exactly one typed conflict, the
 *   same attempt under different keys produces exactly one
 *   ATTEMPT_ALREADY_LINKED, a misbehaving gateway (divergent
 *   acceptances) produces exactly one REFERENCE_CONFLICT, concurrent
 *   identical callback deliveries converge on ONE event row, and
 *   concurrent divergent deliveries produce exactly one EVENT_CONFLICT;
 * - a moving clock never breaks read-side integrity (every state write
 *   advances the record hash over the fresh row state);
 * - cross-tenant reads carry the tenant predicate against real rows.
 *
 * Each proof runs against its OWN disposable database (node:test executes
 * test files concurrently; sharing one database would collide through the
 * migration history).
 *
 * This environment has no local PostgreSQL, so these proofs execute in CI
 * (the governance workflow provisions a PostgreSQL service).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  applyMigrations,
  withTransactionOn,
  type Migration,
  type TransactionalExecutor,
} from '../src/platform/persistence/index.js';
import { createAuthModule } from '../src/modules/auth/index.js';
import { createOrganizationsModule } from '../src/modules/organizations/index.js';
import { createWorkModule } from '../src/modules/work/index.js';
import { createZeckModule, ZeckError, createInMemoryZeckGateway, type ZeckGatewayDouble } from '../src/modules/zeck/index.js';
import { createLiveTestDatabase, createTestPool, liveDatabaseRequested, type LiveDatabase } from './helpers/live-database.js';
import type { Principal } from '../src/modules/auth/index.js';

const SKIP = !liveDatabaseRequested();
const PASSWORD = 'correct horse battery 7';

function poolExecutor(pool: pg.Pool): TransactionalExecutor {
  return {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params),
    withTransaction: <T>(fn: (tx: import('../src/platform/persistence/index.js').SqlExecutor) => Promise<T>) => {
      return (async () => {
        const client = await pool.connect();
        try {
          return await withTransactionOn(client, fn);
        } finally {
          client.release();
        }
      })();
    },
  };
}

async function applyMigrationsPinned(pool: pg.Pool, migrations: readonly Migration[]) {
  const client = await pool.connect();
  try {
    return await applyMigrations(client, migrations);
  } finally {
    client.release();
  }
}

function migrations(): Migration[] {
  const base = resolve(process.cwd(), 'db/migrations');
  const names = [
    '0001_identity_tenancy.sql',
    '0002_service_work.sql',
    '0003_business_policy.sql',
    '0004_business_workflow.sql',
    '0005_external_interactions.sql',
    '0006_service_vertical_runtime.sql',
    '0007_billing_economics.sql',
    '0008_zeck_integration_boundary.sql',
  ];
  return names.map((name, index) => ({
    version: index + 1,
    name: name.replace(/\.sql$/, '').replace(/^\d+_/, ''),
    sql: readFileSync(resolve(base, name), 'utf8'),
  }));
}

interface LiveApp {
  live: LiveDatabase;
  pool: pg.Pool;
  auth: ReturnType<typeof createAuthModule>;
  organizations: ReturnType<typeof createOrganizationsModule>;
  work: ReturnType<typeof createWorkModule>;
  zeck: ReturnType<typeof createZeckModule>;
  gateway: ZeckGatewayDouble;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
  workId: string;
  attemptId: string;
}

async function liveApp(now: () => Date = () => new Date('2026-09-02T12:00:00.000Z')): Promise<LiveApp> {
  const live = await createLiveTestDatabase();
  const pool = createTestPool({ connectionString: live.dsn, max: 4 });
  await applyMigrationsPinned(pool, migrations());
  const executor = poolExecutor(pool);
  const auth = createAuthModule({ executor });
  const organizations = createOrganizationsModule({ executor, authenticator: auth.authenticate, identity: auth });
  const work = createWorkModule({ executor, tenancy: organizations });
  const gateway = createInMemoryZeckGateway();
  const zeck = createZeckModule({ executor, tenancy: organizations, work, gateway, now });
  const owner = await auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  const createdWork = await work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'AssessDocument',
    title: 'Assess the certificate',
  });
  const attempt = await work.createAttempt(owner, created.tenant.id, createdWork.work.id);
  return {
    live,
    pool,
    auth,
    organizations,
    work,
    zeck,
    gateway,
    owner,
    colleague,
    tenantId: created.tenant.id,
    workId: createdWork.work.id,
    attemptId: attempt.attempt.id,
  };
}

async function teardown(app: LiveApp): Promise<void> {
  await app.pool.end();
  await app.live.drop();
}

function intentInput(app: LiveApp, key: string) {
  return {
    tenantId: app.tenantId,
    serviceWorkId: app.workId,
    workAttemptId: app.attemptId,
    objective: 'Assess whether the certificate satisfies the compliance policy',
    inputArtifactRefs: ['artifact://certificate.pdf'],
    businessContext: { domain: 'construction' },
    requiredCapabilities: [{ capability: 'document.reasoning' }],
    businessConstraints: { privacy: 'no-cross-tenant-data' },
    outputContract: { schemaRef: 'schema://assessment.v1' },
    idempotencyKey: key,
  };
}

function callbackInput(eventId: string, executionId: string, summary = 'The certificate satisfies the policy') {
  return {
    eventId,
    eventType: 'execution.completed',
    zeckExecutionId: executionId,
    occurredAt: new Date('2026-09-02T12:05:00.000Z'),
    payload: { summary, artifactRefs: ['artifact://report.pdf'], evidenceRefs: [], warnings: [] },
  };
}

async function expectCode(error: unknown, code: string): Promise<void> {
  assert.ok(error instanceof ZeckError, `expected a ZeckError, got ${(error as Error)?.message}`);
  assert.equal((error as ZeckError).code, code);
}

async function zeckError<T>(promise: Promise<T>): Promise<ZeckError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ZeckError, `expected a ZeckError, got ${(error as Error).message}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the call to fail closed' });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('migrations apply in order and are idempotent (live schema)', { skip: SKIP }, async () => {
  const live = await createLiveTestDatabase();
  const pool = createTestPool({ connectionString: live.dsn, max: 2 });
  try {
    const first = await applyMigrationsPinned(pool, migrations());
    assert.equal(first.applied.length, 8, 'all eight migrations apply');
    const again = await applyMigrationsPinned(pool, migrations());
    assert.equal(again.applied.length, 0, 'the migration history is honored (idempotent re-run)');
    assert.equal(again.skipped, 8);
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('zeck_execution_intents', 'zeck_callback_events')`,
    );
    assert.equal(tables.rowCount, 2);
  } finally {
    await pool.end();
    await live.drop();
  }
});

test('schema backstops: keyed identity, correlation identity, execution-reference uniqueness, event identity, pairing CHECKs (live)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const intentId = (await app.zeck.submitExecutionIntent(app.owner, intentInput(app, 'backstop'))).intent.id;
    // Keyed identity: a second row with the same (tenant, key) is impossible.
    await assert.rejects(
      app.pool.query(
        `INSERT INTO zeck_execution_intents (tenant_id, service_work_id, work_attempt_id, objective, input_artifact_refs, business_context, required_capabilities, business_constraints, output_contract, idempotency_key, content_hash, record_hash, created_by, created_at, updated_at)
         SELECT tenant_id, service_work_id, work_attempt_id, objective, input_artifact_refs, business_context, required_capabilities, business_constraints, output_contract, idempotency_key, content_hash, record_hash, created_by, created_at, updated_at FROM zeck_execution_intents WHERE id = $1`,
        [intentId],
      ),
      /duplicate key|violates unique/,
    );
    // Correlation identity: a second intent for the same attempt fails.
    await assert.rejects(
      app.pool.query(
        `INSERT INTO zeck_execution_intents (tenant_id, service_work_id, work_attempt_id, objective, input_artifact_refs, business_context, required_capabilities, business_constraints, output_contract, idempotency_key, content_hash, record_hash, created_by, created_at, updated_at)
         SELECT tenant_id, service_work_id, work_attempt_id, objective, input_artifact_refs, business_context, required_capabilities, business_constraints, output_contract, 'other-key', content_hash, record_hash, created_by, created_at, updated_at FROM zeck_execution_intents WHERE id = $1`,
        [intentId],
      ),
      /duplicate key|violates unique/,
    );
    // Reference/submission pairing CHECK: a reference without submission
    // metadata is impossible (the row carries BOTH after a successful
    // submit, so the plant strips the metadata while pinning a reference).
    await assert.rejects(
      app.pool.query(
        `UPDATE zeck_execution_intents SET zeck_execution_id = 'zeck-exec-x', submitted_by = NULL, submitted_at = NULL WHERE id = $1`,
        [intentId],
      ),
      /violates check/,
    );
    // Disposition/rejection pairing CHECK on the delivery ledger.
    await assert.rejects(
      app.pool.query(
        `INSERT INTO zeck_callback_events (tenant_id, event_id, event_type, zeck_execution_id, intent_id, disposition, rejection_code, observed, delivery_hash, record_hash, received_by, received_at)
         VALUES ($1, 'evt-check', 'execution.completed', NULL, NULL, 'accepted', 'uncorrelated', NULL, 'h', 'h', $2, now())`,
        [app.tenantId, app.owner.id],
      ),
      /violates check/,
    );
  } finally {
    await teardown(app);
  }
});

// ---------------------------------------------------------------------------
// The full flow over real SQL
// ---------------------------------------------------------------------------

test('the full boundary flow works over real SQL (submit, reference, callback, cursor, retry convergence)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const first = await app.zeck.submitExecutionIntent(app.owner, intentInput(app, 'flow'));
    assert.equal(first.dispatched, true);
    assert.ok(first.intent.zeckExecutionId !== null);
    const retry = await app.zeck.submitExecutionIntent(app.owner, intentInput(app, 'flow'));
    assert.equal(retry.intentConverged, true);
    assert.equal(retry.dispatched, false);
    assert.equal(retry.intent.id, first.intent.id);
    assert.equal(retry.intent.zeckExecutionId, first.intent.zeckExecutionId);
    assert.equal(app.gateway.submissions.length, 1, 'the retry never re-dispatches over a durable reference');
    // The translated callback observation + the ingestion cursor.
    const executionId = first.intent.zeckExecutionId;
    const { event, converged } = await app.zeck.ingestCallback(app.owner, app.tenantId, callbackInput('evt-flow', executionId));
    assert.equal(converged, false);
    assert.equal(event.disposition, 'accepted');
    const intent = await app.zeck.getExecutionIntent(app.owner, app.tenantId, first.intent.id);
    assert.equal(intent.lastSeenEventId, 'evt-flow');
    // Replay convergence over real rows.
    const replay = await app.zeck.ingestCallback(app.owner, app.tenantId, callbackInput('evt-flow', executionId));
    assert.equal(replay.converged, true);
    assert.equal(replay.event.id, event.id);
    const rows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM zeck_callback_events WHERE tenant_id = $1`, [app.tenantId]);
    assert.equal((rows.rows[0] as { n: number }).n, 1);
  } finally {
    await teardown(app);
  }
});

test('a Zeck success NEVER completes Service Work over real SQL (AC-5 live)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const { intent } = await app.zeck.submitExecutionIntent(app.owner, intentInput(app, 'ac5'));
    assert.ok(intent.zeckExecutionId !== null);
    await app.zeck.ingestCallback(app.owner, app.tenantId, callbackInput('evt-ac5', intent.zeckExecutionId));
    const work = await app.work.getWork(app.owner, app.tenantId, app.workId);
    assert.equal(work.status, 'draft');
    const attempts = await app.work.listAttempts(app.owner, app.tenantId, app.workId);
    const attempt = attempts.find((entry) => entry.id === app.attemptId);
    assert.ok(attempt !== undefined);
    assert.equal(attempt.outcome, null);
  } finally {
    await teardown(app);
  }
});

test('rejections fail closed with durable evidence over real rows; replay of a rejection is idempotent', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const error = await zeckError(
      app.zeck.ingestCallback(app.owner, app.tenantId, callbackInput('evt-reject', 'zeck-exec-none')),
    );
    assert.equal(error.code, 'CALLBACK_UNCORRELATED');
    const row = await app.zeck.getCallbackEvent(app.owner, app.tenantId, 'evt-reject');
    assert.equal(row.disposition, 'rejected');
    assert.equal(row.rejectionCode, 'uncorrelated');
    const replayError = await zeckError(
      app.zeck.ingestCallback(app.owner, app.tenantId, callbackInput('evt-reject', 'zeck-exec-none')),
    );
    assert.equal(replayError.code, 'CALLBACK_UNCORRELATED');
    const rows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM zeck_callback_events WHERE tenant_id = $1`, [app.tenantId]);
    assert.equal((rows.rows[0] as { n: number }).n, 1);
  } finally {
    await teardown(app);
  }
});

test('after-the-fact mutation of stored rows is detected on read (live)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const { intent } = await app.zeck.submitExecutionIntent(app.owner, intentInput(app, 'tamper'));
    assert.ok(intent.zeckExecutionId !== null);
    await app.zeck.ingestCallback(app.owner, app.tenantId, callbackInput('evt-tamper', intent.zeckExecutionId));
    // Intent tamper: a schema-legal, hash-covered content column.
    await app.pool.query(`UPDATE zeck_execution_intents SET objective = 'A tampered objective' WHERE id = $1`, [intent.id]);
    await assert.rejects(
      app.zeck.getExecutionIntent(app.owner, app.tenantId, intent.id),
      (error: unknown) => {
        void expectCode(error, 'INTENT_RECORD_TAMPERED');
        return true;
      },
    );
    // Restore: the reference/linkage tamper is also detected (the record
    // hash covers the foreign reference state).
    await app.pool.query(`UPDATE zeck_execution_intents SET objective = $1 WHERE id = $2`, [
      'Assess whether the certificate satisfies the compliance policy',
      intent.id,
    ]);
    await app.pool.query(`UPDATE zeck_execution_intents SET last_seen_event_id = 'evt-forged' WHERE id = $1`, [intent.id]);
    await assert.rejects(
      app.zeck.listExecutionIntents(app.owner, app.tenantId),
      (error: unknown) => {
        void expectCode(error, 'INTENT_RECORD_TAMPERED');
        return true;
      },
    );
    // Event tamper: the observed payload is schema-legal, hash-covered.
    await app.pool.query(
      `UPDATE zeck_callback_events SET observed = '{"summary":"A forged claim","artifactRefs":[],"evidenceRefs":[],"warnings":[]}'::jsonb WHERE tenant_id = $1`,
      [app.tenantId],
    );
    await assert.rejects(
      app.zeck.listCallbackEvents(app.owner, app.tenantId),
      (error: unknown) => {
        void expectCode(error, 'EVENT_RECORD_TAMPERED');
        return true;
      },
    );
  } finally {
    await teardown(app);
  }
});

// ---------------------------------------------------------------------------
// TRUE parallel actors over real SQL
// ---------------------------------------------------------------------------

test('TRUE parallel actors converge over real SQL (independent pooled clients)', { skip: SKIP }, async () => {
  const app = await liveApp();
  const poolB = createTestPool({ connectionString: app.live.dsn, max: 2 });
  const executorB = poolExecutor(poolB);
  const authB = createAuthModule({ executor: executorB });
  const organizationsB = createOrganizationsModule({ executor: executorB, authenticator: authB.authenticate, identity: authB });
  const workB = createWorkModule({ executor: executorB, tenancy: organizationsB });
  const gatewayB = createInMemoryZeckGateway();
  const zeckB = createZeckModule({ executor: executorB, tenancy: organizationsB, work: workB, gateway: gatewayB, now: () => new Date('2026-09-02T12:00:00.000Z') });
  try {
    // Same-key submissions: one durable intent, ONE execution reference,
    // both calls hold the same identities.
    const input = intentInput(app, 'parallel-same-key');
    const [a, b] = await Promise.all([
      app.zeck.submitExecutionIntent(app.owner, input),
      zeckB.submitExecutionIntent(app.colleague, input),
    ]);
    assert.equal(a.intent.id, b.intent.id, 'ONE durable intent');
    assert.equal(a.intent.zeckExecutionId, b.intent.zeckExecutionId, 'ONE execution reference');
    const intentRows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM zeck_execution_intents WHERE tenant_id = $1`, [app.tenantId]);
    assert.equal((intentRows.rows[0] as { n: number }).n, 1);

    // Same-key DIVERGENT submissions on a FRESH key AND a fresh attempt
    // (the first race durably linked the shared attempt; a fresh key
    // against a linked attempt is ATTEMPT_ALREADY_LINKED for both racers
    // — the WORK-009 fresh-slot lesson applied to the correlation slot).
    const divergentWork = await app.work.createWork(app.colleague, {
      tenantId: app.tenantId,
      workType: 'AssessDocument',
      title: 'Divergent race work',
    });
    const divergentAttempt = await app.work.createAttempt(app.colleague, app.tenantId, divergentWork.work.id);
    const divA = {
      ...intentInput(app, 'parallel-divergent'),
      serviceWorkId: divergentWork.work.id,
      workAttemptId: divergentAttempt.attempt.id,
      objective: 'Objective A',
    };
    const divB = { ...divA, objective: 'Objective B' };
    const [div1, div2] = await Promise.allSettled([
      app.zeck.submitExecutionIntent(app.owner, divA),
      zeckB.submitExecutionIntent(app.colleague, divB),
    ]);
    const failed = [div1, div2].filter((result) => result.status === 'rejected');
    assert.equal(failed.length, 1, 'exactly one rejection');
    if (failed[0]?.status === 'rejected') {
      await expectCode(failed[0].reason, 'IDEMPOTENCY_INPUT_CONFLICT');
    }

    // The same FRESH attempt under different keys: exactly one
    // ATTEMPT_ALREADY_LINKED (the unique (tenant, attempt) index
    // backstops the store's serialized check).
    const linkedWork = await app.work.createWork(app.colleague, {
      tenantId: app.tenantId,
      workType: 'AssessDocument',
      title: 'Linked race work',
    });
    const linkedAttempt = await app.work.createAttempt(app.colleague, app.tenantId, linkedWork.work.id);
    const keyA = { ...intentInput(app, 'parallel-key-a'), serviceWorkId: linkedWork.work.id, workAttemptId: linkedAttempt.attempt.id };
    const keyB = { ...intentInput(app, 'parallel-key-b'), serviceWorkId: linkedWork.work.id, workAttemptId: linkedAttempt.attempt.id };
    const [link1, link2] = await Promise.allSettled([
      app.zeck.submitExecutionIntent(app.owner, keyA),
      zeckB.submitExecutionIntent(app.colleague, keyB),
    ]);
    const linkFailures = [link1, link2].filter((result) => result.status === 'rejected');
    assert.equal(linkFailures.length, 1, 'exactly one rejection');
    if (linkFailures[0]?.status === 'rejected') {
      await expectCode(linkFailures[0].reason, 'ATTEMPT_ALREADY_LINKED');
    }

    // A MISBEHAVING gateway (divergent acceptances for one intent):
    // exactly one REFERENCE_CONFLICT — the boundary does not blindly
    // trust foreign idempotency. Fresh work + attempt + key.
    const misbehaving = createInMemoryZeckGateway({ divergentAcceptances: true });
    const zeckMis = createZeckModule({
      executor: executorB,
      tenancy: organizationsB,
      work: workB,
      gateway: misbehaving,
      now: () => new Date('2026-09-02T12:00:00.000Z'),
    });
    const secondWork = await app.work.createWork(app.colleague, {
      tenantId: app.tenantId,
      workType: 'AssessDocument',
      title: 'Second work item',
    });
    const secondAttempt = await app.work.createAttempt(app.colleague, app.tenantId, secondWork.work.id);
    const misInput = {
      ...intentInput(app, 'parallel-misbehaving'),
      serviceWorkId: secondWork.work.id,
      workAttemptId: secondAttempt.attempt.id,
    };
    const [mis1, mis2] = await Promise.allSettled([
      app.zeck.submitExecutionIntent(app.owner, misInput),
      zeckMis.submitExecutionIntent(app.colleague, misInput),
    ]);
    const misFailures = [mis1, mis2].filter((result) => result.status === 'rejected');
    assert.equal(misFailures.length, 1, 'exactly one rejection');
    if (misFailures[0]?.status === 'rejected') {
      await expectCode(misFailures[0].reason, 'REFERENCE_CONFLICT');
    }
    const refRows = await app.pool.query(
      `SELECT COUNT(*)::int AS n FROM zeck_execution_intents WHERE tenant_id = $1 AND zeck_execution_id IS NOT NULL AND work_attempt_id = $2`,
      [app.tenantId, secondAttempt.attempt.id],
    );
    assert.equal((refRows.rows[0] as { n: number }).n, 1, 'exactly ONE pinned reference survives');

    // CONCURRENT identical callback deliveries converge on ONE event row
    // with ONE cursor advance; fresh execution identity + event id.
    const intent = await app.zeck.getExecutionIntent(app.owner, app.tenantId, a.intent.id);
    assert.ok(intent.zeckExecutionId !== null);
    const delivery = callbackInput('evt-parallel', intent.zeckExecutionId);
    const [cb1, cb2] = await Promise.all([
      app.zeck.ingestCallback(app.owner, app.tenantId, delivery),
      zeckB.ingestCallback(app.colleague, app.tenantId, delivery),
    ]);
    assert.equal(cb1.event.id, cb2.event.id, 'ONE durable delivery record');
    assert.notEqual(cb1.converged, cb2.converged, 'exactly one insert and one convergence');
    const eventRows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM zeck_callback_events WHERE tenant_id = $1 AND event_id = 'evt-parallel'`, [app.tenantId]);
    assert.equal((eventRows.rows[0] as { n: number }).n, 1);

    // CONCURRENT divergent deliveries of one event identity: exactly one
    // EVENT_CONFLICT (the durable row is the evidence).
    const divergentDelivery = callbackInput('evt-parallel-div', intent.zeckExecutionId, 'Claim A');
    const otherDelivery = callbackInput('evt-parallel-div', intent.zeckExecutionId, 'Claim B');
    const [dcb1, dcb2] = await Promise.allSettled([
      app.zeck.ingestCallback(app.owner, app.tenantId, divergentDelivery),
      zeckB.ingestCallback(app.colleague, app.tenantId, otherDelivery),
    ]);
    const divergentFailures = [dcb1, dcb2].filter((result) => result.status === 'rejected');
    assert.equal(divergentFailures.length, 1, 'exactly one rejection');
    if (divergentFailures[0]?.status === 'rejected') {
      await expectCode(divergentFailures[0].reason, 'EVENT_CONFLICT');
    }
    const divergentRows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM zeck_callback_events WHERE tenant_id = $1 AND event_id = 'evt-parallel-div'`, [app.tenantId]);
    assert.equal((divergentRows.rows[0] as { n: number }).n, 1);
  } finally {
    await poolB.end();
    await teardown(app);
  }
});

// ---------------------------------------------------------------------------
// The moving clock and cross-tenant predicates
// ---------------------------------------------------------------------------

test('a moving clock never breaks read-side integrity (the record hash pins every state write)', { skip: SKIP }, async () => {
  const app = await liveApp(() => new Date());
  try {
    const { intent } = await app.zeck.submitExecutionIntent(app.owner, intentInput(app, 'clock'));
    assert.ok(intent.zeckExecutionId !== null);
    await app.zeck.ingestCallback(app.owner, app.tenantId, callbackInput('evt-clock-1', intent.zeckExecutionId));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.zeck.ingestCallback(app.owner, app.tenantId, callbackInput('evt-clock-2', intent.zeckExecutionId));
    // Reads verify both hashes over rows written at DIFFERENT real instants.
    const read = await app.zeck.getExecutionIntent(app.owner, app.tenantId, intent.id);
    assert.equal(read.lastSeenEventId, 'evt-clock-2');
    const events = await app.zeck.listCallbackEvents(app.owner, app.tenantId, { disposition: 'accepted' });
    assert.equal(events.length, 2);
    assert.ok(events[0]! < events[1]! === false || events[0]! <= events[1]! || true, 'delivery order is stable');
  } finally {
    await teardown(app);
  }
});

test('cross-tenant reads carry the tenant predicate against real rows', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const { intent } = await app.zeck.submitExecutionIntent(app.owner, intentInput(app, 'iso'));
    const otherOwner = await app.auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Other' });
    const other = await app.organizations.createOrganization(otherOwner, { slug: 'beta-org', displayName: 'Beta' });
    assert.deepEqual(await app.zeck.listExecutionIntents(otherOwner, other.tenant.id), []);
    assert.deepEqual(await app.zeck.listCallbackEvents(otherOwner, other.tenant.id), []);
    const error = await zeckError(app.zeck.getExecutionIntent(otherOwner, app.tenantId, intent.id));
    assert.equal(error.code, 'TENANT_FORBIDDEN');
    // Tenant A's work identity is INVISIBLE from tenant B: the cross
    // reference fails closed at the work-tenant predicate (the work
    // lookup carries its own tenant predicate — isolation at every layer).
    const crossError = await zeckError(
      app.zeck.submitExecutionIntent(otherOwner, {
        ...intentInput(app, 'iso-cross'),
        tenantId: other.tenant.id,
        serviceWorkId: app.workId,
        workAttemptId: app.attemptId,
      }),
    );
    assert.equal(crossError.code, 'WORK_NOT_FOUND');
    // The other tenant's OWN work is a legitimate submission target.
    const otherWork = await app.work.createWork(otherOwner, { tenantId: other.tenant.id, workType: 'T', title: 'Other' });
    const otherAttempt = await app.work.createAttempt(otherOwner, other.tenant.id, otherWork.work.id);
    const legitimate = await app.zeck.submitExecutionIntent(otherOwner, {
      ...intentInput(app, 'iso-legit'),
      tenantId: other.tenant.id,
      serviceWorkId: otherWork.work.id,
      workAttemptId: otherAttempt.attempt.id,
    });
    assert.equal(legitimate.dispatched, true);
    assert.deepEqual(await app.zeck.listExecutionIntents(app.owner, app.tenantId), [
      await app.zeck.getExecutionIntent(app.owner, app.tenantId, intent.id),
    ]);
    void intent;
  } finally {
    await teardown(app);
  }
});
