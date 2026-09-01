/**
 * Optional live-PostgreSQL integration proof for the Business Workflow
 * Authority (WORK-004, CRITICAL assurance). Runs ONLY when
 * SERVICEOS_TEST_DATABASE_URL points at a disposable PostgreSQL database;
 * otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001..0004 apply in order and are idempotent (including the
 *   DO-block extension of migration 0002's closed status enumeration);
 * - the extended status enumeration is enforced at the schema level (a
 *   non-enum status is rejected; /work still only ever writes 'draft');
 * - the full lifecycle works over real SQL (draft -> ... -> completed) with
 *   the append-only ledger strictly sequenced per work and the status write
 *   committed atomically with the audit record;
 * - the dependency gate over real SQL fails closed until the prerequisite
 *   work is terminal-completed;
 * - TRUE parallel transitions from the same state: one commits, the other
 *   fails deterministically with TRANSITION_CONFLICT (FOR UPDATE
 *   serialization — never a lost update, never a double ledger row);
 * - parallel keyed submissions of the same logical transition converge on
 *   ONE durable transition through the partial unique index (AC-4);
 * - a concurrent dependency add racing the readiness gate serializes on
 *   the per-tenant advisory lock into one of the two consistent outcomes;
 * - the policy gate consumes the real /policies module (deny fails closed,
 *   allow pins the decision provenance);
 * - out-of-band tampering of a transition row is detected on read
 *   (record-hash verification, AC-5);
 * - the SLA hooks work over real SQL and breach evaluation is deterministic.
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
import { createPoliciesModule } from '../src/modules/policies/index.js';
import { createWorkflowModule, WorkflowError } from '../src/modules/workflow/index.js';
import { createLiveTestDatabase, liveDatabaseRequested, type LiveDatabase } from './helpers/live-database.js';
import type { Principal } from '../src/modules/auth/index.js';
import type { WorkStatus } from '../src/modules/workflow/index.js';

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
  return [
    { version: 1, name: 'identity-tenancy', sql: readFileSync(resolve(base, '0001_identity_tenancy.sql'), 'utf8') },
    { version: 2, name: 'service-work', sql: readFileSync(resolve(base, '0002_service_work.sql'), 'utf8') },
    { version: 3, name: 'business-policy', sql: readFileSync(resolve(base, '0003_business_policy.sql'), 'utf8') },
    { version: 4, name: 'business-workflow', sql: readFileSync(resolve(base, '0004_business_workflow.sql'), 'utf8') },
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
  workflow: ReturnType<typeof createWorkflowModule>;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
  now: { value: Date };
}

/** Fresh pool + composed modules over a disposable migrated database. */
async function preparedLive(): Promise<LiveApp> {
  const live = await createLiveTestDatabase();
  const pool = new pg.Pool({ connectionString: live.dsn, max: 8 });
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
  const now = { value: new Date('2026-09-01T10:00:00.000Z') };
  const workflow = createWorkflowModule({
    executor,
    tenancy: organizations,
    policies,
    now: () => now.value,
  });
  const owner = await auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { live, pool, executor, auth, organizations, work, policies, workflow, owner, colleague, tenantId: created.tenant.id, now };
}

async function createDraftWork(b: LiveApp, title = 'Work'): Promise<string> {
  const { work } = await b.work.createWork(b.owner, {
    tenantId: b.tenantId,
    workType: 'compliance.onboarding',
    title,
  });
  return work.id;
}

async function moveTo(b: LiveApp, workId: string, states: readonly WorkStatus[]): Promise<void> {
  for (const to of states) {
    await b.workflow.submitTransition(b.owner, b.tenantId, workId, { to });
  }
}

test('live: migrations 0001..0004 apply once and re-runs are no-ops', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const report = await applyMigrationsPinned(b.pool, migrations());
    assert.equal(report.applied.length, 0);
    assert.equal(report.skipped, 4);
    // The extended status enumeration constraint exists and matches the
    // canonical 12-state machine.
    const constraints = await b.pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'work_service_works'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ 'status'`,
    );
    assert.equal(constraints.rows.length, 1);
    const def = (constraints.rows[0] as { def: string }).def;
    for (const state of ['draft', 'ready', 'accepted', 'in_progress', 'waiting_information', 'waiting_approval', 'blocked', 'verifying', 'completed', 'cancelled', 'failed', 'expired']) {
      assert.ok(def.includes(`'${state}'`), `the constraint includes ${state}`);
    }
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: the schema enforces the closed status enumeration (and /work still writes only draft)', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const workId = await createDraftWork(b);
    // A raw status write to a canonical state is allowed at the schema
    // level (the transition boundary is the /workflow authority's WRITE
    // path — structurally enforced, not by the schema)...
    await b.pool.query('UPDATE work_service_works SET status = $1 WHERE id = $2', ['ready', workId]);
    // ...but an out-of-enumeration status is rejected by the CHECK.
    await assert.rejects(
      b.pool.query('UPDATE work_service_works SET status = $1 WHERE id = $2', ['deleted', workId]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: full lifecycle over real SQL with a strictly sequenced append-only ledger', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const workId = await createDraftWork(b);
    const chain: WorkStatus[] = [
      'ready',
      'accepted',
      'in_progress',
      'waiting_information',
      'in_progress',
      'blocked',
      'in_progress',
      'verifying',
      'in_progress',
      'verifying',
      'completed',
    ];
    await moveTo(b, workId, chain);
    const work = await b.work.getWork(b.owner, b.tenantId, workId);
    assert.equal(work.status, 'completed');
    const ledger = await b.workflow.listTransitions(b.owner, b.tenantId, workId);
    assert.equal(ledger.length, chain.length);
    for (let i = 0; i < ledger.length; i += 1) {
      assert.equal(ledger[i]?.seq, i + 1);
      assert.equal(ledger[i]?.fromState, i === 0 ? 'draft' : chain[i - 1]);
      assert.equal(ledger[i]?.toState, chain[i]);
    }
    // The dependency gate evidence is pinned on the first transition.
    assert.deepEqual(ledger[0]?.preconditions.dependencies, { evaluated: true, satisfied: true });
    // Continuations of a terminal state are empty.
    const continuations = await b.workflow.listContinuations(b.owner, b.tenantId, workId);
    assert.deepEqual(continuations.continuations, []);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: the dependency gate fails closed until the prerequisite is terminal-completed', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const prerequisite = await createDraftWork(b, 'Prerequisite');
    const dependent = await createDraftWork(b, 'Dependent');
    await b.work.addDependency(b.owner, b.tenantId, dependent, prerequisite);
    await assert.rejects(
      b.workflow.submitTransition(b.owner, b.tenantId, dependent, { to: 'ready' }),
      (error: unknown) => error instanceof WorkflowError && error.code === 'PRECONDITION_DEPENDENCIES',
    );
    // A cancelled prerequisite does not satisfy readiness.
    await moveTo(b, prerequisite, ['cancelled']);
    await assert.rejects(
      b.workflow.submitTransition(b.owner, b.tenantId, dependent, { to: 'ready' }),
      (error: unknown) => error instanceof WorkflowError && error.code === 'PRECONDITION_DEPENDENCIES',
    );
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: parallel transitions from the same state — one commits, the other fails deterministically', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const workId = await createDraftWork(b);
    const submissions = await Promise.allSettled([
      b.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready' }),
      b.workflow.submitTransition(b.colleague, b.tenantId, workId, { to: 'cancelled' }),
    ]);
    const fulfilled = submissions.filter((entry) => entry.status === 'fulfilled');
    const rejected = submissions.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const rejection = rejected[0];
    assert.ok(rejection !== undefined && rejection.status === 'rejected');
    assert.ok(rejection.reason instanceof WorkflowError);
    assert.equal(rejection.reason.code, 'TRANSITION_CONFLICT');
    // Exactly one durable ledger row; the status is the winner's target.
    const ledger = await b.workflow.listTransitions(b.owner, b.tenantId, workId);
    assert.equal(ledger.length, 1);
    const status = (await b.work.getWork(b.owner, b.tenantId, workId)).status;
    assert.equal(status, ledger[0]?.toState);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: parallel keyed submissions converge on one durable transition (AC-4)', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const workId = await createDraftWork(b);
    const [a, c] = await Promise.all([
      b.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready', idempotencyKey: 'live-key' }),
      b.workflow.submitTransition(b.colleague, b.tenantId, workId, { to: 'ready', idempotencyKey: 'live-key' }),
    ]);
    assert.equal(a.transition.id, c.transition.id);
    assert.equal((a.converged ? 1 : 0) + (c.converged ? 1 : 0), 1);
    const ledger = await b.workflow.listTransitions(b.owner, b.tenantId, workId);
    assert.equal(ledger.length, 1);
    const rows = await b.pool.query('SELECT count(*)::int AS n FROM workflow_transitions WHERE work_id = $1', [workId]);
    assert.equal((rows.rows[0] as { n: number }).n, 1);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: a concurrent dependency add racing the readiness gate serializes into a consistent outcome', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const prerequisite = await createDraftWork(b, 'Prerequisite');
    const dependent = await createDraftWork(b, 'Dependent');
    // TRUE parallel actors: the gate (advisory lock + FOR UPDATE) and the
    // dependency add (the same advisory lock) serialize; either the edge
    // commits first (gate fails closed) or the transition commits first
    // (the edge lands on an already-ready work). Both outcomes are
    // consistent; no interleaving produces a torn state.
    const [transition, edge] = await Promise.allSettled([
      b.workflow.submitTransition(b.owner, b.tenantId, dependent, { to: 'ready' }),
      b.work.addDependency(b.owner, b.tenantId, dependent, prerequisite),
    ]);
    assert.equal(edge.status, 'fulfilled'); // the edge add always commits
    if (transition.status === 'fulfilled') {
      assert.equal((await b.work.getWork(b.owner, b.tenantId, dependent)).status, 'ready');
      assert.equal(transition.value.transition.preconditions.dependencies.satisfied, true);
    } else {
      assert.ok(transition.reason instanceof WorkflowError);
      assert.equal(transition.reason.code, 'PRECONDITION_DEPENDENCIES');
      assert.equal((await b.work.getWork(b.owner, b.tenantId, dependent)).status, 'draft');
    }
    // The dependency row is durable in both cases.
    const deps = await b.work.listDependencies(b.owner, b.tenantId, dependent);
    assert.equal(deps.length, 1);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: the policy gate consumes the real /policies module (deny fails closed, allow pins provenance)', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const workId = await createDraftWork(b);
    const { contract } = await b.policies.createPolicyVersion(b.owner, {
      tenantId: b.tenantId,
      policyKey: 'workflow.live.guard',
      scope: 'base',
      rules: [
        { id: 'deny-cancel', when: { kind: 'attribute', name: 'to', operator: 'eq', value: 'cancelled' }, effect: 'deny' },
      ],
      defaultEffect: 'allow',
    });
    await b.policies.activatePolicyVersion(b.owner, b.tenantId, contract.id);

    await assert.rejects(
      b.workflow.submitTransition(b.owner, b.tenantId, workId, {
        to: 'cancelled',
        policyKey: 'workflow.live.guard',
      }),
      (error: unknown) => error instanceof WorkflowError && error.code === 'POLICY_DENIED',
    );
    assert.equal((await b.work.getWork(b.owner, b.tenantId, workId)).status, 'draft');

    const { transition } = await b.workflow.submitTransition(b.owner, b.tenantId, workId, {
      to: 'ready',
      policyKey: 'workflow.live.guard',
    });
    assert.ok(transition.preconditions.policy !== null);
    const decision = await b.policies.getDecision(b.owner, b.tenantId, transition.preconditions.policy.decisionId);
    assert.equal(decision.outcome, 'allow');
    assert.equal(decision.input.action, 'workflow.transition');
    assert.deepEqual(decision.input.attributes, {
      workType: 'compliance.onboarding',
      from: 'draft',
      to: 'ready',
    });
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: out-of-band tampering of a transition row is detected on read (AC-5)', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const workId = await createDraftWork(b);
    const { transition } = await b.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready' });
    // Out-of-band mutation (simulated row tamper, bypassing the module).
    await b.pool.query('UPDATE workflow_transitions SET reason = $1 WHERE id = $2', [
      'tampered reason',
      transition.id,
    ]);
    await assert.rejects(
      b.workflow.getTransition(b.owner, b.tenantId, transition.id),
      (error: unknown) => error instanceof WorkflowError && error.code === 'TRANSITION_RECORD_TAMPERED',
    );
    await assert.rejects(
      b.workflow.listTransitions(b.owner, b.tenantId, workId),
      (error: unknown) => error instanceof WorkflowError && error.code === 'TRANSITION_RECORD_TAMPERED',
    );
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: SLA hooks over real SQL — deterministic breach evaluation and enforcement through the authority', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    const breached = await createDraftWork(b, 'Breached');
    const healthy = await createDraftWork(b, 'Healthy');
    await b.workflow.setSlaDeadline(b.owner, b.tenantId, breached, {
      state: 'draft',
      deadlineAt: new Date('2026-09-01T09:00:00.000Z'),
      idempotencyKey: 'sla-live-1',
    });
    await b.workflow.setSlaDeadline(b.owner, b.tenantId, healthy, {
      state: 'draft',
      deadlineAt: new Date('2026-09-01T11:00:00.000Z'),
    });

    let breaches = await b.workflow.listSlaBreaches(b.owner, b.tenantId);
    assert.deepEqual(breaches.map((entry) => entry.workId), [breached]);

    // Advance the injected clock: the healthy deadline also passes.
    b.now.value = new Date('2026-09-01T11:30:00.000Z');
    breaches = await b.workflow.listSlaBreaches(b.owner, b.tenantId);
    assert.equal(breaches.length, 2);

    // Enforcement through the single authority; the expired work stops
    // breaching (its deadline was state-bound).
    await b.workflow.submitTransition(b.owner, b.tenantId, breached, { to: 'expired', reason: 'SLA breach' });
    breaches = await b.workflow.listSlaBreaches(b.owner, b.tenantId);
    assert.deepEqual(breaches.map((entry) => entry.workId), [healthy]);
    // Keyed deadline convergence over real SQL.
    const retry = await b.workflow.setSlaDeadline(b.owner, b.tenantId, healthy, {
      state: 'draft',
      deadlineAt: new Date('2026-09-01T11:00:00.000Z'),
      idempotencyKey: 'other-key',
    });
    assert.equal(retry.converged, false);
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});

test('live: cross-tenant workflow access fails closed (SQL tenant predicates)', { skip: SKIP }, async () => {
  const b = await preparedLive();
  try {
    // A second, fully separate tenant in the same database.
    const carol = await b.auth.registerHuman({ email: 'carol@b.com', password: PASSWORD, displayName: 'Carol' });
    const second = await b.organizations.createOrganization(carol, { slug: 'beta-org', displayName: 'Beta' });
    const { work: foreignWork } = await b.work.createWork(carol, {
      tenantId: second.tenant.id,
      workType: 'compliance.onboarding',
      title: 'Foreign',
    });
    // Alpha's authorized actor cannot transition, read, or gate Beta's work.
    await assert.rejects(
      b.workflow.submitTransition(b.owner, b.tenantId, foreignWork.id, { to: 'ready' }),
      (error: unknown) => error instanceof WorkflowError && error.code === 'WORK_NOT_FOUND',
    );
    assert.equal((await b.workflow.listTransitions(b.owner, b.tenantId, foreignWork.id)).length, 0);
    await assert.rejects(
      b.workflow.setSlaDeadline(b.owner, b.tenantId, foreignWork.id, { state: 'draft', deadlineAt: new Date() }),
      (error: unknown) => error instanceof WorkflowError && error.code === 'WORK_NOT_FOUND',
    );
    // Carol can act through her own tenant.
    await b.workflow.submitTransition(carol, second.tenant.id, foreignWork.id, { to: 'ready' });
    assert.equal((await b.work.getWork(carol, second.tenant.id, foreignWork.id)).status, 'ready');
  } finally {
    await b.pool.end();
    await b.live.drop();
  }
});
