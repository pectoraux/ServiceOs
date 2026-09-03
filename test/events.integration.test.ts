/**
 * Optional live-PostgreSQL integration proof for the durable event
 * substrate (WORK-006, HIGH_ASSURANCE — the Work Order additionally
 * requires concurrency/crash-safety proofs). Runs ONLY when
 * SERVICEOS_TEST_DATABASE_URL points at a disposable PostgreSQL
 * database; otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001..0011 apply in order and are idempotent, and the
 *   schema pins the closed event vocabularies (source taxonomy,
 *   rejection codes, lifecycles), the stable identity unique index, the
 *   keyed outbox index and the lifecycle shape CHECKs (an inconsistent
 *   row is physically impossible);
 * - the full inbox/outbox lifecycle works over real SQL (ingest ->
 *   dedup -> claim -> consume; intent -> claim -> deliver -> accept),
 *   with record hashes verified on every read;
 * - TRUE parallel duplicate deliveries converge on ONE durable inbox
 *   record through the stable identity unique index (AC-1);
 * - TRUE parallel inbox processing of one event: exactly ONE consumer
 *   invocation (row-lock serialization) — two consumers of the same
 *   event never produce duplicate domain effects;
 * - the inbox crash window over real SQL: a claim left behind by a
 *   dead worker is recovered with ONE durable observation;
 * - the outbox over real SQL: authority-derived intent, TRUE parallel
 *   dispatches with exactly ONE delivery, and the crash windows
 *   (claim-then-die; accepted-then-die) recovering on ONE provider-side
 *   event through the identity-idempotent delivery double;
 * - a moving clock never breaks read-side integrity (the record hash
 *   pins every state write);
 * - out-of-band tampering of stored event rows is detected on read;
 * - cross-tenant event access fails closed (SQL tenant predicates);
 * - the SQL event store's mutation paths run on ONE pinned client: a
 *   pool with a SINGLE connection completes the full flows only if no
 *   statement escapes the transaction.
 *
 * Each proof runs against its OWN disposable database (node:test
 * executes test files concurrently; sharing one database would collide
 * through the migration history).
 *
 * This environment has no local PostgreSQL, so these proofs execute in
 * CI (the governance workflow provisions a PostgreSQL service).
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
import { createPoliciesModule } from '../src/modules/policies/index.js';
import {
  createInteractionsModule,
  createInMemoryEventDelivery,
  createSqlEventsStore,
  InteractionsError,
  type InboxEventRecord,
  type OutboxEventRecord,
} from '../src/modules/interactions/index.js';
import { createInMemoryProviderAdapter, createAdapterRegistry, createEffectSink } from '../src/modules/integrations/index.js';
import { createLiveTestDatabase, createTestPool, liveDatabaseRequested, type LiveDatabase } from './helpers/live-database.js';
import type { Principal } from '../src/modules/auth/index.js';

const SKIP = !liveDatabaseRequested();
const PASSWORD = 'correct horse battery 7';
const EMAIL_PARAMS = { to: ['vendor@example.com'], subject: 'Insurance certificate', body: 'Please send it.' };

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
  return [
    { version: 1, name: 'identity-tenancy', sql: readFileSync(resolve(base, '0001_identity_tenancy.sql'), 'utf8') },
    { version: 2, name: 'service-work', sql: readFileSync(resolve(base, '0002_service_work.sql'), 'utf8') },
    { version: 3, name: 'business-policy', sql: readFileSync(resolve(base, '0003_business_policy.sql'), 'utf8') },
    { version: 4, name: 'business-workflow', sql: readFileSync(resolve(base, '0004_business_workflow.sql'), 'utf8') },
    { version: 5, name: 'external-interactions', sql: readFileSync(resolve(base, '0005_external_interactions.sql'), 'utf8') },
    { version: 6, name: 'service-vertical-runtime', sql: readFileSync(resolve(base, '0006_service_vertical_runtime.sql'), 'utf8') },
    { version: 7, name: 'billing-economics', sql: readFileSync(resolve(base, '0007_billing_economics.sql'), 'utf8') },
    { version: 8, name: 'zeck-integration-boundary', sql: readFileSync(resolve(base, '0008_zeck_integration_boundary.sql'), 'utf8') },
    { version: 9, name: 'business-evidence', sql: readFileSync(resolve(base, '0009_business_evidence.sql'), 'utf8') },
    { version: 10, name: 'business-approvals', sql: readFileSync(resolve(base, '0010_business_approvals.sql'), 'utf8') },
    { version: 11, name: 'event-substrate', sql: readFileSync(resolve(base, '0011_event_substrate.sql'), 'utf8') },
  ];
}

interface LiveApp {
  live: LiveDatabase;
  pool: pg.Pool;
  executor: TransactionalExecutor;
  auth: ReturnType<typeof createAuthModule>;
  organizations: ReturnType<typeof createOrganizationsModule>;
  policies: ReturnType<typeof createPoliciesModule>;
  interactions: ReturnType<typeof createInteractionsModule>;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
  now: { value: Date };
  eventDelivery: ReturnType<typeof createInMemoryEventDelivery>;
}

/** Fresh pool + composed modules over a disposable migrated database. */
async function preparedLive(poolOptions: { max?: number } = {}): Promise<LiveApp> {
  const live = await createLiveTestDatabase();
  const pool = createTestPool({ connectionString: live.dsn, max: 8, ...poolOptions });
  await applyMigrationsPinned(pool, migrations());
  const executor = poolExecutor(pool);
  const auth = createAuthModule({ executor });
  const organizations = createOrganizationsModule({
    executor,
    authenticator: auth.authenticate,
    identity: auth,
  });
  const policies = createPoliciesModule({ executor, tenancy: organizations });
  const { adapter: emailAdapter } = createInMemoryProviderAdapter('email');
  const registry = createAdapterRegistry();
  registry.register(emailAdapter);
  registry.seal();
  const sink = createEffectSink(registry);
  const now = { value: new Date('2026-09-02T10:00:00.000Z') };
  const eventDelivery = createInMemoryEventDelivery({ now: () => now.value });
  const interactions = createInteractionsModule({
    executor,
    tenancy: organizations,
    policies,
    sink,
    eventDelivery,
    now: () => now.value,
  });
  const owner = await auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return {
    live,
    pool,
    executor,
    auth,
    organizations,
    policies,
    interactions,
    owner,
    colleague,
    tenantId: created.tenant.id,
    now,
    eventDelivery,
  };
}

async function withLive(
  run: (app: LiveApp) => Promise<void>,
  poolOptions: { max?: number } = {},
): Promise<void> {
  const app = await preparedLive(poolOptions);
  try {
    await run(app);
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
}

/** A dispatched (not yet observed) interaction of the tenant. */
async function dispatchedInteraction(app: LiveApp): Promise<string> {
  const { interaction } = await app.interactions.createInteraction(app.owner, app.tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
  });
  await app.interactions.dispatchInteraction(app.owner, app.tenantId, interaction.id);
  return interaction.id;
}

/** A terminally observed interaction of the tenant (outbox source). */
async function observedInteraction(app: LiveApp): Promise<string> {
  const interactionId = await dispatchedInteraction(app);
  await app.interactions.recordObservedResult(app.owner, app.tenantId, interactionId, {
    outcome: 'succeeded',
    providerObservation: { receipt: 'smth-1' },
  });
  return interactionId;
}

function deliveryResult(interactionId: string, eventId = 'evt-1') {
  return {
    source: 'email' as const,
    eventId,
    eventType: 'interaction.delivery_result',
    occurredAt: new Date('2026-09-02T12:05:00.000Z'),
    payload: { interactionId, outcome: 'succeeded' as const, providerObservation: { delivered: true, receipt: 'smth-1' } },
  };
}

async function interactionsError(promise: Promise<unknown>): Promise<InteractionsError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof InteractionsError, `expected InteractionsError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to fail closed');
}

test('migrations 0001..0011 apply in order and are idempotent (live schema)', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const report = await applyMigrationsPinned(app.pool, migrations());
    assert.equal(report.applied.length, 0);
    assert.equal(report.skipped, 11);
    const tables = await app.pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('event_inbox','event_outbox') ORDER BY tablename`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.tablename),
      ['event_inbox', 'event_outbox'],
    );
  });
});

test('schema backstops: the closed vocabularies and the stable identity are physical (live)', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    // LEGAL SHAPES ARE ADMISSIBLE: a raw received row (all lifecycle
    // columns null) and a raw rejected row (the rejection set, nothing
    // else) both insert cleanly — the shape CHECKs admit every legal
    // lifecycle shape (the regression that would have caught the CI
    // defect where a biconditional wrongly required received rows to
    // carry the claim/consumption/failure columns).
    const legalReceived = crypto.randomUUID();
    await app.pool.query(
      `INSERT INTO event_inbox (id, tenant_id, source, external_event_id, event_type, occurred_at, payload, delivery_hash, state, received_by, record_hash)
       VALUES ($1, $2, 'email', 'evt-legal-1', 'interaction.delivery_result', now(), '{}', 'h', 'received', $3, 'h')`,
      [legalReceived, app.tenantId, app.owner.id],
    );
    const legalRejected = crypto.randomUUID();
    await app.pool.query(
      `INSERT INTO event_inbox (id, tenant_id, source, external_event_id, event_type, occurred_at, payload, delivery_hash, state, rejection_code, rejection_rejected_at, received_by, record_hash)
       VALUES ($1, $2, 'email', 'evt-legal-2', 'weird.vertical.type', now(), '{}', 'h', 'rejected', 'unknown_event_type', now(), $3, 'h')`,
      [legalRejected, app.tenantId, app.owner.id],
    );
    const legalOutbox = crypto.randomUUID();
    await app.pool.query(
      `INSERT INTO event_outbox (id, tenant_id, event_type, payload, destination, requested_by, input_hash, record_hash, state)
       VALUES ($1, $2, 'interaction.observed', '{}', 'dest', $3, 'h', 'h', 'intended')`,
      [legalOutbox, app.tenantId, app.owner.id],
    );
    // The stable identity unique index exists.
    const indexes = await app.pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'event_inbox' AND indexname = 'event_inbox_stable_identity'`,
    );
    assert.equal(indexes.rows.length, 1);
    // The lifecycle shape CHECKs: an inconsistent row is impossible.
    const { interaction } = await app.interactions.createInteraction(app.owner, app.tenantId, {
      capability: 'email',
      params: EMAIL_PARAMS,
    });
    await assert.rejects(
      app.pool.query(
        `INSERT INTO event_inbox (id, tenant_id, source, external_event_id, event_type, occurred_at, payload, delivery_hash, state, claimed_by, claimed_at, received_by, record_hash)
         VALUES ($1, $2, 'email', 'evt-shape', 'interaction.delivery_result', now(), '{}', 'h', 'received', $3, now(), $3, 'h')`,
        [crypto.randomUUID(), app.tenantId, app.owner.id],
      ),
      /violates check constraint "event_inbox_(received_shape|claim_present)"/,
    );
    void interaction;
    // The closed source taxonomy: 'zeck' is not an event source (its
    // callbacks keep their own boundary).
    await assert.rejects(
      app.pool.query(
        `INSERT INTO event_inbox (id, tenant_id, source, external_event_id, event_type, occurred_at, payload, delivery_hash, state, received_by, record_hash)
         VALUES ($1, $2, 'zeck', 'evt-z', 'interaction.delivery_result', now(), '{}', 'h', 'received', $3, 'h')`,
        [crypto.randomUUID(), app.tenantId, app.owner.id],
      ),
      /violates check constraint "event_inbox_source_domain"/,
    );
    // The closed outbound event vocabulary (horizontal only).
    await assert.rejects(
      app.pool.query(
        `INSERT INTO event_outbox (id, tenant_id, event_type, payload, destination, requested_by, input_hash, record_hash, state)
         VALUES ($1, $2, 'construction.permit_approved', '{}', 'd', $3, 'h', 'h', 'intended')`,
        [crypto.randomUUID(), app.tenantId, app.owner.id],
      ),
      /violates check constraint "event_outbox_event_type_domain"/,
    );
  });
});

test('the full inbox/outbox lifecycle over real SQL, with verified record hashes', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    // INBOX: ingest -> dedup -> claim -> consume.
    const interactionId = await dispatchedInteraction(app);
    const first = await app.interactions.ingestExternalEvent(app.owner, app.tenantId, deliveryResult(interactionId));
    assert.equal(first.event.state, 'received');
    const replay = await app.interactions.ingestExternalEvent(app.owner, app.tenantId, deliveryResult(interactionId));
    assert.equal(replay.converged, true);
    assert.equal(replay.event.id, first.event.id);

    const { outcomes } = await app.interactions.processInboxEvents(app.owner, app.tenantId);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.event.state, 'consumed');
    const observed = await app.interactions.getInteraction(app.owner, app.tenantId, interactionId);
    assert.equal(observed.state, 'observed');
    assert.equal(observed.observation?.outcome, 'succeeded');

    // The durable record is re-readable with every read verifying the
    // record hash (tamper-evident reads over real SQL).
    const reread = await app.interactions.getInboxEvent(app.owner, app.tenantId, first.event.id);
    assert.equal(reread.state, 'consumed');

    // OUTBOX: authority-derived intent -> claim -> deliver -> accept.
    const outbox = await app.interactions.recordOutboundEvent(app.owner, app.tenantId, {
      eventType: 'interaction.observed',
      interactionId,
      destination: 'customer-webhook://ops-alpha',
      idempotencyKey: 'notify-live-1',
    });
    assert.equal(outbox.event.state, 'intended');
    assert.deepEqual(outbox.event.payload, {
      interactionId,
      outcome: 'succeeded',
      provider: observed.dispatch?.provider,
      providerReference: observed.dispatch?.providerReference,
      observedAt: observed.observation?.observedAt.toISOString(),
    });
    const dispatched = await app.interactions.dispatchOutboxEvent(app.owner, app.tenantId, outbox.event.id);
    assert.equal(dispatched.invoked, true);
    assert.equal(dispatched.event.state, 'dispatched');
    assert.equal(app.eventDelivery.delivered.length, 1);
  });
});

test('TRUE parallel duplicate deliveries converge on ONE durable inbox record (AC-1 live)', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const interactionId = await dispatchedInteraction(app);
    const results = await Promise.all([
      app.interactions.ingestExternalEvent(app.owner, app.tenantId, deliveryResult(interactionId)),
      app.interactions.ingestExternalEvent(app.colleague, app.tenantId, deliveryResult(interactionId)),
      app.interactions.ingestExternalEvent(app.owner, app.tenantId, deliveryResult(interactionId)),
    ]);
    const ids = new Set(results.map((result) => result.event.id));
    assert.equal(ids.size, 1);
    const count = await app.pool.query(`SELECT count(*)::int AS n FROM event_inbox WHERE tenant_id = $1`, [app.tenantId]);
    assert.equal(count.rows[0]?.n, 1);
  });
});

test('TRUE parallel inbox processing: ONE consumer invocation, ONE domain effect (row-lock serialization)', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const interactionId = await dispatchedInteraction(app);
    await app.interactions.ingestExternalEvent(app.owner, app.tenantId, deliveryResult(interactionId));

    const outcomes = await Promise.allSettled([
      app.interactions.processInboxEvents(app.owner, app.tenantId),
      app.interactions.processInboxEvents(app.colleague, app.tenantId),
    ]);
    // One consumption; the loser converged (same durable result) or
    // surfaced the typed in-progress state — never a duplicate effect
    // (the surface contract: the loser's fulfilled outcome carries
    // invoked=false with the durable in-progress/consumed state).
    const settledRecords = await app.interactions.listInboxEvents(app.owner, app.tenantId, { state: 'consumed' });
    assert.equal(settledRecords.length, 1);
    let consumerInvocations = 0;
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') continue;
      for (const result of outcome.value.outcomes as { event: InboxEventRecord; invoked: boolean }[]) {
        if (result.event.state === 'consumed' && result.invoked) {
          consumerInvocations += 1;
        }
        // The loser never invokes the consumer a second time; it either
        // converged on the winner's durable result or surfaced the typed
        // in-progress claim state (retryable later).
        assert.equal(result.invoked === false || result.event.state === 'consumed', true);
      }
    }
    assert.equal(consumerInvocations, 1);
    // The interaction was observed exactly once (one terminal row state).
    const observed = await app.interactions.getInteraction(app.owner, app.tenantId, interactionId);
    assert.equal(observed.state, 'observed');
    assert.equal(observed.observation?.outcome, 'succeeded');
    // Divergent observation attempts would have failed closed typed.
    const rows = await app.pool.query(`SELECT state, outcome FROM interaction_effects WHERE id = $1`, [interactionId]);
    assert.equal(rows.rows[0]?.state, 'observed');
    assert.equal(rows.rows[0]?.outcome, 'succeeded');
  });
});

test('the inbox crash window over real SQL: recovery converges with ONE durable observation', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const interactionId = await dispatchedInteraction(app);
    const { event } = await app.interactions.ingestExternalEvent(app.owner, app.tenantId, deliveryResult(interactionId));
    // A worker claims through the REAL store API (a legitimate, hash-
    // consistent claim) and then dies before the consumer runs: the
    // claim stands, the crash window is durable.
    const store = createSqlEventsStore(app.executor);
    const claimed = await store.claimInboxEvent({
      tenantId: app.tenantId,
      eventId: event.id,
      claimedBy: app.owner.id,
      now: new Date('2026-09-02T12:06:00.000Z'),
    });
    assert.equal(claimed.state, 'processing');
    const recoverable = await app.interactions.listRecoverableInboxEvents(app.owner, app.tenantId);
    assert.equal(recoverable.length, 1);
    // The interaction is still only dispatched (no domain effect yet).
    assert.equal((await app.interactions.getInteraction(app.owner, app.tenantId, interactionId)).state, 'dispatched');
    // Recovery re-claims and re-runs the idempotent consumer: the
    // observation lands exactly once and the event settles consumed.
    const recovered = await app.interactions.recoverInboxEvent(app.owner, app.tenantId, event.id);
    assert.equal(recovered.invoked, true);
    assert.equal(recovered.event.state, 'consumed');
    const observed = await app.interactions.getInteraction(app.owner, app.tenantId, interactionId);
    assert.equal(observed.state, 'observed');
    assert.equal(observed.observation?.outcome, 'succeeded');
  });
});

test('outbox over real SQL: parallel dispatches = ONE delivery; crash windows converge on ONE provider event', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const interactionId = await observedInteraction(app);
    const { event } = await app.interactions.recordOutboundEvent(app.owner, app.tenantId, {
      eventType: 'interaction.observed',
      interactionId,
      destination: 'customer-webhook://ops-alpha',
    });

    // TRUE parallel dispatches: exactly one delivery invocation.
    const outcomes = await Promise.allSettled([
      app.interactions.dispatchOutboxEvent(app.owner, app.tenantId, event.id),
      app.interactions.dispatchOutboxEvent(app.colleague, app.tenantId, event.id),
    ]);
    assert.equal(app.eventDelivery.delivered.length, 1);
    const record = await app.interactions.getOutboxEvent(app.owner, app.tenantId, event.id);
    assert.equal(record.state, 'dispatched');
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        assert.equal((outcome.value as { event: OutboxEventRecord }).event.state, 'dispatched');
      } else {
        assert.equal((outcome.reason as InteractionsError).code, 'OUTBOX_EVENT_IN_PROGRESS');
      }
    }

    // The crash window (claim stands after the port accepted, completion
    // never landed): recovery converges on ONE provider-side event.
    const second = await app.interactions.recordOutboundEvent(app.owner, app.tenantId, {
      eventType: 'interaction.observed',
      interactionId,
      destination: 'customer-webhook://ops-beta',
      idempotencyKey: 'notify-crash-1',
    });
    // The dispatcher claims through the REAL store API (hash-consistent)
    // and the port ACCEPTS the event for this identity; then the worker
    // dies before the durable completion write.
    const store = createSqlEventsStore(app.executor);
    await store.claimOutboxEvent({
      tenantId: app.tenantId,
      eventId: second.event.id,
      claimedBy: app.owner.id,
      now: new Date('2026-09-02T12:07:00.000Z'),
    });
    await app.eventDelivery.deliverEvent({
      tenantId: app.tenantId,
      eventId: second.event.id,
      eventType: 'interaction.observed',
      destination: 'customer-webhook://ops-beta',
      payload: second.event.payload as Readonly<Record<string, unknown>>,
    });
    const recovered = await app.interactions.recoverOutboxEvent(app.owner, app.tenantId, second.event.id);
    assert.equal(recovered.event.state, 'dispatched');
    assert.equal(app.eventDelivery.delivered.filter((entry) => entry.request.eventId === second.event.id).length, 1);
    assert.equal(app.eventDelivery.attemptsFor(second.event.id), 2);
  });
});

test('a moving clock never breaks read-side integrity (the record hash pins every state write)', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const interactionId = await observedInteraction(app);
    const { event } = await app.interactions.recordOutboundEvent(app.owner, app.tenantId, {
      eventType: 'interaction.observed',
      interactionId,
      destination: 'customer-webhook://ops-alpha',
    });
    // A MOVING clock between the writes and the reads.
    app.now.value = new Date('2026-09-03T09:30:00.000Z');
    const dispatched = await app.interactions.dispatchOutboxEvent(app.owner, app.tenantId, event.id);
    assert.equal(dispatched.event.state, 'dispatched');
    app.now.value = new Date('2026-09-03T09:31:00.000Z');
    // The next read still verifies (the stored hash matches the stored
    // row — every state write hashed the post-write record).
    const reread = await app.interactions.getOutboxEvent(app.owner, app.tenantId, event.id);
    assert.equal(reread.state, 'dispatched');

    // The inbox side too — over a FRESH dispatched interaction (the
    // outbox part's interaction is terminally observed; a delivery
    // result for it would correctly fail OBSERVATION_STATE_INVALID).
    const clockInteraction = await dispatchedInteraction(app);
    const { event: inboxEvent } = await app.interactions.ingestExternalEvent(
      app.owner,
      app.tenantId,
      deliveryResult(clockInteraction, 'evt-clock'),
    );
    app.now.value = new Date('2026-09-03T09:32:00.000Z');
    const { outcomes } = await app.interactions.processInboxEvents(app.owner, app.tenantId);
    assert.equal(outcomes.length, 1);
    app.now.value = new Date('2026-09-03T09:33:00.000Z');
    const inboxReread = await app.interactions.getInboxEvent(app.owner, app.tenantId, inboxEvent.id);
    assert.equal(inboxReread.state, 'consumed');
    assert.equal((await app.interactions.getInteraction(app.owner, app.tenantId, clockInteraction)).state, 'observed');
  });
});

test('out-of-band mutation of stored event rows is detected on read (live tamper)', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const interactionId = await dispatchedInteraction(app);
    const { event } = await app.interactions.ingestExternalEvent(app.owner, app.tenantId, deliveryResult(interactionId));
    // A schema-legal, hash-divergent mutation: flip the external event id
    // (the live equivalent of the in-env tamper seam).
    await app.pool.query(`UPDATE event_inbox SET external_event_id = 'evt-tampered' WHERE id = $1`, [event.id]);
    const error = await interactionsError(app.interactions.getInboxEvent(app.owner, app.tenantId, event.id));
    assert.equal(error.code, 'EVENT_RECORD_TAMPERED');
    void interactionId;
  });
});

test('cross-tenant event access fails closed (SQL tenant predicates)', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const interactionId = await dispatchedInteraction(app);
    const { event } = await app.interactions.ingestExternalEvent(app.owner, app.tenantId, deliveryResult(interactionId));
    // Another tenant + owner in the same database.
    const outsider = await app.auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Outsider' });
    const other = await app.organizations.createOrganization(outsider, { slug: 'beta-org', displayName: 'Beta' });
    const error = await interactionsError(app.interactions.getInboxEvent(outsider, other.tenant.id, event.id));
    assert.equal(error.code, 'EVENT_NOT_FOUND');
    const listed = await app.interactions.listInboxEvents(outsider, other.tenant.id);
    assert.equal(listed.length, 0);
    // An empty claimable set for the other tenant: the call succeeds
    // with NO outcomes — no cross-tenant processing ever happens.
    const processed = await app.interactions.processInboxEvents(outsider, other.tenant.id, {});
    assert.equal(processed.outcomes.length, 0);
    // The foreign event was never consumed by the other tenant's worker.
    const stillReceived = await app.interactions.getInboxEvent(app.owner, app.tenantId, event.id);
    assert.equal(stillReceived.state, 'received');
  });
});

test('single-connection-pool transaction scope: the event flows complete on ONE pinned client', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const interactionId = await dispatchedInteraction(app);
    const { event } = await app.interactions.ingestExternalEvent(app.owner, app.tenantId, deliveryResult(interactionId));
    const { outcomes } = await app.interactions.processInboxEvents(app.owner, app.tenantId);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.event.state, 'consumed');
    const outbox = await app.interactions.recordOutboundEvent(app.owner, app.tenantId, {
      eventType: 'interaction.observed',
      interactionId,
      destination: 'customer-webhook://ops-alpha',
    });
    const dispatched = await app.interactions.dispatchOutboxEvent(app.owner, app.tenantId, outbox.event.id);
    assert.equal(dispatched.event.state, 'dispatched');
    void event;
  }, { max: 1 });
});
