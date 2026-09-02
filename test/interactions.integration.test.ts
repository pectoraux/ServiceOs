/**
 * Optional live-PostgreSQL integration proof for the External Interaction
 * & Integration Authority (WORK-015, HIGH_ASSURANCE — the Work Order
 * additionally requires concurrency/crash-safety proofs). Runs ONLY when
 * SERVICEOS_TEST_DATABASE_URL points at a disposable PostgreSQL database;
 * otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001..0005 apply in order and are idempotent, and the
 *   schema pins the closed capability/state/channel enumerations with the
 *   lifecycle shape invariants (a claim-less acceptance or an
 *   acceptance-less observation is physically impossible);
 * - the full lifecycle works over real SQL (intend -> claim -> dispatch
 *   -> observe; record hashes verified on every read);
 * - TRUE parallel keyed intent creations converge on ONE durable
 *   interaction through the partial unique index (AC-3);
 * - TRUE parallel dispatches of one interaction: exactly ONE adapter
 *   invocation (row-lock serialization); the loser fails closed with
 *   DISPATCH_IN_PROGRESS or converges;
 * - the crash window over real SQL: a claim left behind by a crashed
 *   dispatcher is recovered through recoverInteraction with NO duplicate
 *   provider effect (identity-idempotent adapter);
 * - parallel observations converge (identical) or arbitrate
 *   deterministically (divergent — one wins, one OBSERVATION_CONFLICT);
 * - the policy gate consumes the real /policies module (deny fails
 *   closed BEFORE the intent row; allow pins provenance);
 * - out-of-band tampering of an interaction row is detected on read
 *   (record-hash verification);
 * - cross-tenant interaction access fails closed (SQL tenant predicates)
 *   and the adapter is never invoked;
 * - notifications work end-to-end over real SQL: request -> dispatch ->
 *   delivered; an injected provider failure stays explicit and is
 *   recovered by a retry interaction (retryOf lineage) — and the
 *   notification read derives the status from the interaction rows;
 * - the SQL store's mutation paths run on ONE pinned client: a pool with
 *   a SINGLE connection completes claim/complete/observe only if no
 *   statement escapes the transaction.
 *
 * Each proof runs against its OWN disposable database (node:test executes
 * test files concurrently; sharing one database would collide through the
 * migration history).
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
import { createWorkModule } from '../src/modules/work/index.js';
import { createPoliciesModule } from '../src/modules/policies/index.js';
import {
  createAdapterRegistry,
  createEffectSink,
  createInMemoryProviderAdapter,
  type CapabilityClass,
  type ExternalEffectSink,
  type ProviderEffectLog,
} from '../src/modules/integrations/index.js';
import {
  createInteractionsModule,
  createSqlInteractionsStore,
  InteractionsError,
  type InteractionRecord,
} from '../src/modules/interactions/index.js';
import {
  createNotificationsModule,
  type NotificationView,
} from '../src/modules/notifications/index.js';
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
  ];
}

interface LiveApp {
  live: LiveDatabase;
  pool: pg.Pool;
  executor: TransactionalExecutor;
  auth: ReturnType<typeof createAuthModule>;
  organizations: ReturnType<typeof createOrganizationsModule>;
  work: ReturnType<typeof createWorkModule>;
  policies: ReturnType<typeof createPoliciesModule>;
  interactions: ReturnType<typeof createInteractionsModule>;
  notifications: ReturnType<typeof createNotificationsModule>;
  interactionsStore: ReturnType<typeof createSqlInteractionsStore>;
  sink: ExternalEffectSink;
  emailLog: ProviderEffectLog;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
  now: { value: Date };
}

/** Fresh pool + composed modules over a disposable migrated database. */
async function preparedLive(
  options: { failFirstEmail?: boolean; poolOptions?: { max?: number } } = {},
): Promise<LiveApp> {
  const live = await createLiveTestDatabase();
  const pool = createTestPool({ connectionString: live.dsn, max: 8, ...options.poolOptions });
  await applyMigrationsPinned(pool, migrations());
  const executor = poolExecutor(pool);
  const auth = createAuthModule({ executor });
  const organizations = createOrganizationsModule({
    executor,
    authenticator: auth.authenticate,
    identity: auth,
  });
  const work = createWorkModule({ executor, tenancy: organizations });
  const policies = createPoliciesModule({ executor, tenancy: organizations });
  const { adapter: emailAdapter, log: emailLog } = createInMemoryProviderAdapter('email', {
    failNextDispatches: options.failFirstEmail === true ? 1 : 0,
  });
  const registry = createAdapterRegistry();
  registry.register(emailAdapter);
  registry.seal();
  const sink = createEffectSink(registry);
  const now = { value: new Date('2026-09-01T10:00:00.000Z') };
  const interactions = createInteractionsModule({
    executor,
    tenancy: organizations,
    policies,
    sink,
    now: () => now.value,
  });
  const notifications = createNotificationsModule({
    executor,
    tenancy: organizations,
    interactions,
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
    work,
    policies,
    interactions,
    notifications,
    interactionsStore: createSqlInteractionsStore(executor),
    sink,
    emailLog,
    owner,
    colleague,
    tenantId: created.tenant.id,
    now,
  };
}

async function intend(b: LiveApp, key?: string, correlation?: Record<string, string>): Promise<InteractionRecord> {
  const { interaction } = await b.interactions.createInteraction(b.owner, b.tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
    idempotencyKey: key,
    correlation,
  });
  return interaction;
}

// ---------------------------------------------------------------------------
// Migrations and schema
// ---------------------------------------------------------------------------

test('live: migrations 0001..0005 apply once and re-runs are no-ops; the enumerations are pinned', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const report = await applyMigrationsPinned(b.pool, migrations());
    assert.equal(report.applied.length, 0);
    assert.equal(report.skipped, 5);
    // The interaction capability CHECK pins the frozen taxonomy (minus Zeck).
    const defs = await b.pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'interaction_effects'::regclass AND contype = 'c'
       ORDER BY conname`,
    );
    const all = defs.rows.map((row) => (row as { def: string }).def).join('\n');
    for (const capability of [
      'email', 'sms', 'voice', 'accounting_erp', 'crm', 'construction_management',
      'property_management', 'procurement', 'payment', 'document_storage', 'government_portal',
    ]) {
      assert.ok(all.includes(`'${capability}'`), `the capability CHECK includes ${capability}`);
    }
    assert.ok(!all.includes("'zeck'"), 'the Zeck capability must not appear');
    for (const state of ['intended', 'dispatching', 'dispatched', 'observed']) {
      assert.ok(all.includes(`'${state}'`), `the state CHECK includes ${state}`);
    }
    for (const channel of ['email', 'sms', 'voice']) {
      assert.ok(
        (await b.pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'notification_requests'::regclass AND contype = 'c'`))
          .rows.some((row) => (row as { def: string }).def.includes(`'${channel}'`)),
        `the channel CHECK includes ${channel}`,
      );
    }
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: the lifecycle shape invariants are enforced at the schema level', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const interaction = await intend(b, 'shape-1');
    // An observation without an acceptance is physically impossible.
    await assert.rejects(
      b.pool.query(
        `UPDATE interaction_effects SET outcome = 'succeeded', observed_by = $1, observed_at = now(), provider_observation = '{}'::jsonb WHERE id = $2`,
        [b.owner.id, interaction.id],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    // A dispatch without a claim is physically impossible.
    await assert.rejects(
      b.pool.query(
        `UPDATE interaction_effects SET state = 'dispatched', provider = 'x', dispatched_at = now(), dispatched_by = $1 WHERE id = $2`,
        [b.owner.id, interaction.id],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    // A failure stage without a failed outcome is physically impossible.
    await assert.rejects(
      b.pool.query(`UPDATE interaction_effects SET failure_stage = 'dispatch' WHERE id = $1`, [interaction.id]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

// ---------------------------------------------------------------------------
// Full lifecycle over real SQL
// ---------------------------------------------------------------------------

test('live: the full lifecycle over real SQL (intend -> dispatch -> observe) with verified hashes', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const interaction = await intend(b, 'live-1', { workId: '00000000-0000-4000-8000-000000000077' });
    assert.equal(interaction.state, 'intended');
    const dispatched = await b.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
    assert.equal(dispatched.invoked, true);
    assert.equal(dispatched.interaction.state, 'dispatched');
    assert.equal(dispatched.interaction.dispatch?.providerReference, `double-${interaction.id}`);
    assert.equal(b.emailLog.count(), 1);
    const observed = await b.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, {
      outcome: 'succeeded',
      providerObservation: { receipt: 'live-1' },
    });
    assert.equal(observed.interaction.state, 'observed');
    // Every read re-verifies the record hash over the real row.
    const reread = await b.interactions.getInteraction(b.owner, b.tenantId, interaction.id);
    assert.equal(reread.observation?.outcome, 'succeeded');
    assert.deepEqual(reread.correlation, { workId: '00000000-0000-4000-8000-000000000077' });
    // The keyed retry converges on the durable record. The re-submission
    // carries the SAME logical intent (capability, params AND correlation
    // — the input hash covers the full intent core): anything less would
    // be a divergent re-submission of the key, which correctly fails
    // closed with INTERACTION_INPUT_CONFLICT.
    const retry = await b.interactions.createInteraction(b.owner, b.tenantId, {
      capability: 'email',
      params: EMAIL_PARAMS,
      correlation: { workId: '00000000-0000-4000-8000-000000000077' },
      idempotencyKey: 'live-1',
    });
    assert.equal(retry.converged, true);
    assert.equal(retry.interaction.id, interaction.id);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

// ---------------------------------------------------------------------------
// Concurrency over real SQL
// ---------------------------------------------------------------------------

test('live: parallel keyed intent creations converge on ONE durable interaction (AC-3)', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const [a, c] = await Promise.all([
      b.interactions.createInteraction(b.owner, b.tenantId, { capability: 'email', params: EMAIL_PARAMS, idempotencyKey: 'race-key-1' }),
      b.interactions.createInteraction(b.colleague, b.tenantId, { capability: 'email', params: EMAIL_PARAMS, idempotencyKey: 'race-key-1' }),
    ]);
    assert.equal(a.interaction.id, c.interaction.id);
    assert.equal(a.converged || c.converged, true);
    assert.notEqual(a.converged && c.converged, true);
    const rows = await b.pool.query('SELECT count(*)::int AS n FROM interaction_effects WHERE tenant_id = $1', [b.tenantId]);
    assert.equal((rows.rows[0] as { n: number }).n, 1);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: parallel dispatches — ONE adapter invocation; the loser fails closed or converges', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const interaction = await intend(b, 'dispatch-race');
    const outcomes = await Promise.allSettled([
      b.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id),
      b.interactions.dispatchInteraction(b.colleague, b.tenantId, interaction.id),
    ]);
    const fulfilled = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
    const rejected = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason as InteractionsError] : []));
    // The claim CAS serializes the dispatches: BOTH legal loser outcomes
    // are accepted (the module contract: "the loser converges (already
    // dispatched) or fails closed with DISPATCH_IN_PROGRESS"). Over real
    // SQL the loser's post-conflict re-check may postdate the winner's
    // COMPLETE dispatch commit — converging is then the correct outcome
    // (the WORK-004 post-conflict re-check discipline; demanding the
    // rejection would make the proof timing-dependent).
    assert.ok(
      (fulfilled.length === 1 && rejected.length === 1) || (fulfilled.length === 2 && rejected.length === 0),
      `exactly one of the legal loser outcomes: fulfilled=${fulfilled.length} rejected=${rejected.length}`,
    );
    if (rejected.length === 1) {
      // The loser observed the claim still held: typed, recoverable.
      assert.ok(rejected[0] instanceof InteractionsError);
      assert.equal(rejected[0].code, 'DISPATCH_IN_PROGRESS');
      assert.equal(fulfilled[0]?.invoked, true);
    } else {
      // The loser converged on the twin's completed dispatch: NO second
      // invocation, the converged view of the same durable record.
      assert.equal(fulfilled.filter((outcome) => outcome.invoked).length, 1);
      assert.equal(fulfilled.filter((outcome) => outcome.converged).length, 1);
    }
    // Every fulfilled view agrees on the durable settled state.
    for (const outcome of fulfilled) {
      assert.equal(outcome.interaction.state, 'dispatched');
    }
    // ONE provider effect; the row is in exactly one settled state.
    assert.equal(b.emailLog.count(), 1);
    const rows = await b.pool.query('SELECT state FROM interaction_effects WHERE id = $1', [interaction.id]);
    assert.equal((rows.rows[0] as { state: string }).state, 'dispatched');
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: the crash window — a claimed-but-unsettled dispatch recovers with NO duplicate effect', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const interaction = await intend(b, 'crash-1');
    // Simulate the crash: the STORE port performs the durable claim (the
    // public test seam — the exact state a crashed dispatcher leaves
    // behind), and no module code runs the adapter.
    const claimed = await b.interactionsStore.claimDispatch({
      tenantId: b.tenantId,
      interactionId: interaction.id,
      claimedBy: b.owner.id,
      now: b.now.value,
    });
    assert.equal(claimed.state, 'dispatching');
    assert.equal(b.emailLog.count(), 0, 'no adapter ran before the crash');
    // The recovery surface lists it.
    assert.equal((await b.interactions.listRecoverableDispatches(b.owner, b.tenantId)).length, 1);
    // A fresh dispatcher cannot double-claim.
    await assert.rejects(
      b.interactions.dispatchInteraction(b.colleague, b.tenantId, interaction.id),
      (error: unknown) => (error as InteractionsError).code === 'DISPATCH_IN_PROGRESS',
    );
    // Recovery re-dispatches: the adapter converges by identity.
    const recovered = await b.interactions.recoverInteraction(b.colleague, b.tenantId, interaction.id);
    assert.equal(recovered.interaction.state, 'dispatched');
    assert.equal(recovered.interaction.claim?.claimedBy, b.colleague.id);
    assert.equal(b.emailLog.count(), 1, 'exactly ONE provider effect after recovery');
    assert.equal(b.emailLog.find(interaction.id)?.attempts, 1);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: parallel observations — identical converge, divergent arbitrate deterministically', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const interaction = await intend(b, 'obs-race');
    await b.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
    // Identical parallel observations: ONE durable observation.
    const [a, c] = await Promise.all([
      b.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, { outcome: 'succeeded', providerObservation: { receipt: 'same' } }),
      b.interactions.recordObservedResult(b.colleague, b.tenantId, interaction.id, { outcome: 'succeeded', providerObservation: { receipt: 'same' } }),
    ]);
    assert.equal(a.converged || c.converged, true);
    assert.equal(a.interaction.observation?.observedBy, c.interaction.observation?.observedBy);
    // Divergent parallel observations: one wins, one fails closed.
    const interaction2 = await intend(b, 'obs-race-2');
    await b.interactions.dispatchInteraction(b.owner, b.tenantId, interaction2.id);
    const outcomes = await Promise.allSettled([
      b.interactions.recordObservedResult(b.owner, b.tenantId, interaction2.id, { outcome: 'succeeded', providerObservation: { receipt: 'A' } }),
      b.interactions.recordObservedResult(b.colleague, b.tenantId, interaction2.id, { outcome: 'failed', providerObservation: { receipt: 'B' } }),
    ]);
    const rejected = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason as InteractionsError] : []));
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.code, 'OBSERVATION_CONFLICT');
    const rows = await b.pool.query('SELECT outcome, provider_observation FROM interaction_effects WHERE id = $1', [interaction2.id]);
    const row = rows.rows[0] as { outcome: string; provider_observation: { receipt: string } };
    assert.ok(['A', 'B'].includes(row.provider_observation.receipt));
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

// ---------------------------------------------------------------------------
// Policy gate, tampering, tenant isolation
// ---------------------------------------------------------------------------

test('live: the policy gate consumes the real /policies module (deny fails closed before the intent row)', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const { contract } = await b.policies.createPolicyVersion(b.owner, {
      tenantId: b.tenantId,
      policyKey: 'interaction.live.email-guard',
      scope: 'base',
      rules: [
        { id: 'deny-email', when: { kind: 'attribute', name: 'capability', operator: 'eq', value: 'email' }, effect: 'deny' },
      ],
      defaultEffect: 'allow',
    });
    await b.policies.activatePolicyVersion(b.owner, b.tenantId, contract.id);
    await assert.rejects(
      b.interactions.createInteraction(b.owner, b.tenantId, {
        capability: 'email',
        params: EMAIL_PARAMS,
        policyKey: 'interaction.live.email-guard',
        idempotencyKey: 'denied-live-1',
      }),
      (error: unknown) => (error as InteractionsError).code === 'POLICY_DENIED',
    );
    const rows = await b.pool.query('SELECT count(*)::int AS n FROM interaction_effects WHERE tenant_id = $1', [b.tenantId]);
    assert.equal((rows.rows[0] as { n: number }).n, 0, 'no intent row was created');
    assert.equal(b.emailLog.count(), 0, 'no adapter was invoked');
    // An allow decision pins the provenance over real SQL.
    const { contract: allow } = await b.policies.createPolicyVersion(b.owner, {
      tenantId: b.tenantId,
      policyKey: 'interaction.live.allow-guard',
      scope: 'base',
      rules: [{ id: 'allow-email', when: { kind: 'attribute', name: 'capability', operator: 'eq', value: 'email' }, effect: 'allow' }],
      defaultEffect: 'allow',
    });
    await b.policies.activatePolicyVersion(b.owner, b.tenantId, allow.id);
    const { interaction } = await b.interactions.createInteraction(b.owner, b.tenantId, {
      capability: 'email',
      params: EMAIL_PARAMS,
      policyKey: 'interaction.live.allow-guard',
      idempotencyKey: 'allowed-live-1',
    });
    assert.match(interaction.policy?.decisionId ?? '', /^[0-9a-f-]{36}$/);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: out-of-band tampering of an interaction row is detected on read', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const interaction = await intend(b, 'tamper-live-1');
    // Out-of-band UPDATE without recomputing the record hash: the live
    // equivalent of the in-env capability flip — a schema-LEGAL value
    // (still inside the frozen taxonomy) that diverges the record hash.
    // (Fields the schema's shape CHECKs pin — orphan columns, partial
    // groups — are rejected by the database itself at write time; the
    // record hash is the tamper evidence for every LEGAL-shaped write.)
    await b.pool.query(`UPDATE interaction_effects SET capability = 'sms' WHERE id = $1`, [interaction.id]);
    await assert.rejects(
      b.interactions.getInteraction(b.owner, b.tenantId, interaction.id),
      (error: unknown) => (error as InteractionsError).code === 'INTERACTION_RECORD_TAMPERED',
    );
    // Tampering with a notification row is detected the same way.
    const { notification } = await b.notifications.requestNotification(b.owner, b.tenantId, {
      channel: 'email',
      recipient: { address: 'vendor@example.com' },
      content: { subject: 's', body: 'b' },
      idempotencyKey: 'tamper-notif-1',
    });
    await b.pool.query(`UPDATE notification_requests SET purpose = 'forged' WHERE id = $1`, [notification.id]);
    await assert.rejects(
      b.notifications.getNotification(b.owner, b.tenantId, notification.id),
      (error: unknown) => (error as { code?: string }).code === 'NOTIFICATION_RECORD_TAMPERED',
    );
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: cross-tenant interaction access fails closed and the adapter is never invoked', { skip: SKIP }, async () => {
  const b = await preparedLive();
  const other = await preparedLive();
  try {
    const interaction = await intend(b, 'tenant-live-1');
    await assert.rejects(
      other.interactions.getInteraction(other.owner, other.tenantId, interaction.id),
      (error: unknown) => (error as InteractionsError).code === 'INTERACTION_NOT_FOUND',
    );
    await assert.rejects(
      other.interactions.dispatchInteraction(other.owner, other.tenantId, interaction.id),
      (error: unknown) => (error as InteractionsError).code === 'INTERACTION_NOT_FOUND',
    );
    assert.equal(other.emailLog.count(), 0);
    assert.equal(b.emailLog.count(), 0);
    // And the row is untouched in its own tenant.
    const view = await b.interactions.getInteraction(b.owner, b.tenantId, interaction.id);
    assert.equal(view.state, 'intended');
  } finally {
    await other.pool.end();
    await other.live.drop();
    await b.pool.end();
    await b.live.drop();
  }
});

// ---------------------------------------------------------------------------
// Notifications end-to-end over real SQL (AC-5: explicit, recoverable)
// ---------------------------------------------------------------------------

test('live: notifications end-to-end — request, dispatch, deliver; fail explicitly; retry recovers', { skip: SKIP }, async () => {
  const b = await preparedLive({ failFirstEmail: true });
  try {
    const { notification } = await b.notifications.requestNotification(b.owner, b.tenantId, {
      channel: 'email',
      recipient: { address: 'vendor@example.com', displayName: 'Acme' },
      content: { subject: 'Certificate required', body: 'Please send it.' },
      purpose: 'compliance-followup',
      correlation: { workId: '00000000-0000-4000-8000-000000000077' },
      idempotencyKey: 'live-notif-1',
    });
    // The first delivery fails (injected provider failure): EXPLICIT.
    const first = await b.notifications.dispatchNotification(b.owner, b.tenantId, notification.id);
    assert.equal(first.view.delivery, 'failed');
    assert.equal(first.view.interaction?.observation?.failureStage, 'dispatch');
    assert.equal(b.emailLog.count(), 0);
    // The failure is listed.
    assert.equal((await b.notifications.listNotifications(b.owner, b.tenantId, { delivery: 'failed' })).length, 1);
    // The retry creates a NEW interaction with retryOf lineage and delivers.
    const retry = await b.notifications.retryNotification(b.owner, b.tenantId, notification.id, { idempotencyKey: 'live-retry-1' });
    assert.equal(retry.view.delivery, 'in_flight');
    assert.equal(retry.view.interaction?.retryOfInteractionId, first.view.interaction?.id);
    await b.interactions.recordObservedResult(b.owner, b.tenantId, retry.view.interaction?.id ?? '', {
      outcome: 'succeeded',
      providerObservation: { delivered: true },
    });
    const final: NotificationView = await b.notifications.getNotification(b.owner, b.tenantId, notification.id);
    assert.equal(final.delivery, 'delivered');
    // Both interactions are durable: the failed original + the retry.
    const rows = await b.pool.query('SELECT count(*)::int AS n FROM interaction_effects WHERE tenant_id = $1', [b.tenantId]);
    assert.equal((rows.rows[0] as { n: number }).n, 2);
    // The notification request is ONE durable row with the pointer moved.
    const notifRows = await b.pool.query('SELECT count(*)::int AS n FROM notification_requests WHERE tenant_id = $1', [b.tenantId]);
    assert.equal((notifRows.rows[0] as { n: number }).n, 1);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

// ---------------------------------------------------------------------------
// Transaction scope over real SQL (the PR #28 defect class)
// ---------------------------------------------------------------------------

test('live: the interaction mutation paths run on ONE pinned client — a single-connection pool completes them', { skip: SKIP }, async () => {
  // A pool with EXACTLY ONE connection: while a store transaction holds
  // the client, ANY statement routed to the pooled executor would wait
  // forever on the exhausted pool — an escaped statement fails the
  // proof. (The in-env tripwire covers the same discipline always-on.)
  const b = await preparedLive({ poolOptions: { max: 1 } });
  try {
    const interaction = await intend(b, 'scope-live-1');
    const claimed = await b.interactionsStore.claimDispatch({
      tenantId: b.tenantId,
      interactionId: interaction.id,
      claimedBy: b.owner.id,
      now: b.now.value,
    });
    assert.equal(claimed.state, 'dispatching');
    const completed = await b.interactionsStore.completeDispatch({
      tenantId: b.tenantId,
      interactionId: interaction.id,
      provider: 'in-memory-double',
      providerReference: `double-${interaction.id}`,
      dispatchedBy: b.owner.id,
      now: b.now.value,
    });
    assert.equal(completed.state, 'dispatched');
    const observed = await b.interactionsStore.recordObservation({
      tenantId: b.tenantId,
      interactionId: interaction.id,
      outcome: 'succeeded',
      providerObservation: { receipt: 'scope' },
      observedBy: b.owner.id,
      now: b.now.value,
    });
    assert.equal(observed.interaction.state, 'observed');
    assert.equal(observed.converged, false);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

// ---------------------------------------------------------------------------
// AC-4 over the composed real stack
// ---------------------------------------------------------------------------

test('live: a provider success never completes Service Work (AC-4, real SQL)', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const { work } = await b.work.createWork(b.owner, {
      tenantId: b.tenantId,
      workType: 'compliance.onboarding',
      title: 'Subcontractor onboarding',
    });
    const interaction = await intend(b, 'live-ac4', { workId: work.id });
    await b.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
    await b.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, {
      outcome: 'succeeded',
      providerObservation: { delivered: true },
    });
    // The provider succeeded; the work state is UNTOUCHED.
    const view = await b.work.getWork(b.owner, b.tenantId, work.id);
    assert.equal(view.status, 'draft');
    const transitions = await b.pool.query('SELECT count(*)::int AS n FROM workflow_transitions WHERE work_id = $1', [work.id]);
    assert.equal((transitions.rows[0] as { n: number }).n, 0, 'the workflow ledger is empty');
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});
