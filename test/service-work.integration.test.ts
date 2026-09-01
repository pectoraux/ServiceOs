/**
 * Optional live-PostgreSQL integration proof for Service Work (WORK-003,
 * CRITICAL assurance). Runs ONLY when SERVICEOS_TEST_DATABASE_URL points at
 * a disposable PostgreSQL database; otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001 + 0002 apply in order and are idempotent;
 * - the full work lifecycle works over real SQL (identity → attempts →
 *   retry → supersession → results) with work state never mutated;
 * - cross-tenant reads carry the tenant predicate against real rows
 *   (isolation at the SQL level);
 * - TRUE parallel actors (separate pooled clients) converge on one durable
 *   work identity through the partial unique index (AC-1/AC-4);
 * - parallel retries of the same dispatched attempt converge on ONE new
 *   current attempt (AC-4) and a late result from the superseded attempt
 *   is rejected by the FOR UPDATE-serialized store (AC-5);
 * - concurrent opposite dependency edges commit at most one — the advisory
 *   transaction lock serializes the cycle check so no phantom cycle can
 *   commit (AC-3);
 * - duplicate result deliveries converge (idempotent by durable identity).
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
import { applyMigrations, withTransactionOn, type Migration, type TransactionalExecutor } from '../src/platform/persistence/index.js';
import { createAuthModule } from '../src/modules/auth/index.js';
import { createOrganizationsModule } from '../src/modules/organizations/index.js';
import { createWorkModule, WorkError } from '../src/modules/work/index.js';
import { createLiveTestDatabase, liveDatabaseRequested, type LiveDatabase } from './helpers/live-database.js';
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
  return [
    {
      version: 1,
      name: 'identity-tenancy',
      sql: readFileSync(resolve(base, '0001_identity_tenancy.sql'), 'utf8'),
    },
    {
      version: 2,
      name: 'service-work',
      sql: readFileSync(resolve(base, '0002_service_work.sql'), 'utf8'),
    },
  ];
}

interface LiveApp {
  live: LiveDatabase;
  pool: pg.Pool;
  auth: ReturnType<typeof createAuthModule>;
  organizations: ReturnType<typeof createOrganizationsModule>;
  work: ReturnType<typeof createWorkModule>;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
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
  const owner = await auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { live, pool, auth, organizations, work, owner, colleague, tenantId: created.tenant.id };
}

async function otherTenantApp(pool: pg.Pool): Promise<{ organizations: ReturnType<typeof createOrganizationsModule>; auth: ReturnType<typeof createAuthModule>; work: ReturnType<typeof createWorkModule>; carol: Principal; tenantId: string }> {
  const executor = poolExecutor(pool);
  const auth = createAuthModule({ executor });
  const organizations = createOrganizationsModule({ executor, authenticator: auth.authenticate, identity: auth });
  const work = createWorkModule({ executor, tenancy: organizations });
  const carol = await auth.registerHuman({ email: 'carol@b.com', password: PASSWORD, displayName: 'Carol' });
  const created = await organizations.createOrganization(carol, { slug: 'beta-org', displayName: 'Beta' });
  return { organizations, auth, work, carol, tenantId: created.tenant.id };
}

test('live: migrations 0001+0002 apply once and re-runs are no-ops', { skip: SKIP }, async () => {
  const live = await createLiveTestDatabase();
  const pool = new pg.Pool({ connectionString: live.dsn });
  try {
    const first = await applyMigrationsPinned(pool, migrations());
    assert.equal(first.applied.length, 2);
    const second = await applyMigrationsPinned(pool, migrations());
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped, 2);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('work_service_works','work_attempts','work_dependencies')
       ORDER BY table_name`,
    );
    assert.equal(tables.rows.length, 3);
    // The work-status enumeration is closed at 'draft' (transition authority
    // is /workflow): writing any other status must fail at the schema level.
    // CHECK constraints only apply to rows the UPDATE touches, so a row is
    // inserted first (minimal FK chain: user -> org -> tenant -> work).
    await pool.query(
      `INSERT INTO auth_users (email, kind, display_name) VALUES ('probe@x.com', 'human', 'Probe')`,
    );
    await pool.query(
      `INSERT INTO org_organizations (slug, display_name) VALUES ('probe-org', 'Probe')`,
    );
    await pool.query(
      `INSERT INTO org_service_tenants (organization_id, slug, display_name)
       SELECT id, 'probe-tenant', 'Probe' FROM org_organizations WHERE slug = 'probe-org'`,
    );
    await pool.query(
      `INSERT INTO work_service_works (tenant_id, work_type, title, created_by)
       SELECT t.id, 'probe', 'Probe', u.id
       FROM org_service_tenants t, auth_users u
       WHERE t.slug = 'probe-tenant' AND u.email = 'probe@x.com'`,
    );
    await assert.rejects(
      pool.query(`UPDATE work_service_works SET status = 'ready'`),
      /check constraint/,
    );
  } finally {
    await pool.end();
    await live.drop();
  }
});

test('live: full work lifecycle over real SQL (identity, attempts, retry, supersession)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const { work, owner, colleague, tenantId } = app;
    const created = await work.createWork(owner, {
      tenantId,
      workType: 'compliance.document-collection',
      title: 'Collect certificates',
      idempotencyKey: 'event-1',
    });
    assert.equal(created.converged, false);
    assert.equal(created.work.status, 'draft');

    // Idempotent re-creation converges on the durable row.
    const again = await work.createWork(colleague, {
      tenantId,
      workType: 'compliance.document-collection',
      title: 'Collect certificates',
      idempotencyKey: 'event-1',
    });
    assert.equal(again.converged, true);
    assert.equal(again.work.id, created.work.id);

    // Attempts: pre-dispatch convergence.
    const first = await work.createAttempt(owner, tenantId, created.work.id, { idempotencyKey: 'a1' });
    const preDispatchRetry = await work.createAttempt(colleague, tenantId, created.work.id, { idempotencyKey: 'a1' });
    assert.equal(preDispatchRetry.converged, true);
    assert.equal(preDispatchRetry.attempt.id, first.attempt.id);

    // Dispatch closes the convergence window; a retry supersedes.
    await work.dispatchAttempt(owner, tenantId, first.attempt.id);
    const replacement = await work.createAttempt(owner, tenantId, created.work.id, { idempotencyKey: 'a1' });
    assert.equal(replacement.converged, false);
    assert.equal(replacement.attempt.supersedesId, first.attempt.id);
    assert.notEqual(replacement.attempt.id, first.attempt.id);

    // The superseded attempt's late result is rejected.
    await assert.rejects(
      work.recordAttemptResult(colleague, tenantId, first.attempt.id, { outcome: 'completed', result: 'late' }),
      (error: unknown) => error instanceof WorkError && error.code === 'ATTEMPT_SUPERSEDED',
    );

    // The current attempt completes with an idempotent duplicate delivery.
    const recorded = await work.recordAttemptResult(owner, tenantId, replacement.attempt.id, {
      outcome: 'completed',
      result: 'ref-1',
    });
    assert.equal(recorded.attempt.outcome, 'completed');
    const duplicate = await work.recordAttemptResult(colleague, tenantId, replacement.attempt.id, {
      outcome: 'completed',
      result: 'ref-1',
    });
    assert.equal(duplicate.converged, true);

    // Dependencies: durable, convergent, cycle-safe.
    const b = await work.createWork(owner, { tenantId, workType: 't', title: 'B' });
    const c = await work.createWork(owner, { tenantId, workType: 't', title: 'C' });
    const ab = await work.addDependency(owner, tenantId, created.work.id, b.work.id);
    const abAgain = await work.addDependency(colleague, tenantId, created.work.id, b.work.id);
    assert.equal(abAgain.converged, true);
    assert.equal(abAgain.dependency.id, ab.dependency.id);
    await work.addDependency(owner, tenantId, b.work.id, c.work.id);
    await assert.rejects(
      work.addDependency(owner, tenantId, c.work.id, created.work.id),
      (error: unknown) => error instanceof WorkError && error.code === 'DEPENDENCY_CYCLE',
    );

    // Work state was never mutated by any attempt operation.
    const final = await work.getWork(owner, tenantId, created.work.id);
    assert.equal(final.status, 'draft');
    assert.equal(final.currentAttemptId, replacement.attempt.id);
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: cross-tenant work reads are invisible (SQL tenant predicates)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const other = await otherTenantApp(app.pool);
    const { work, owner, tenantId } = app;
    const secret = await work.createWork(owner, { tenantId, workType: 't', title: 'Tenant A secret' });
    const { attempt } = await work.createAttempt(owner, tenantId, secret.work.id);

    // A member of tenant B cannot read, mutate or correlate tenant A data.
    await assert.rejects(work.getWork(other.carol, other.tenantId, secret.work.id), (error: unknown) => error instanceof WorkError && error.code === 'WORK_NOT_FOUND');
    await assert.rejects(work.dispatchAttempt(other.carol, other.tenantId, attempt.id), (error: unknown) => error instanceof WorkError && error.code === 'ATTEMPT_NOT_FOUND');
    assert.equal((await work.listWorks(other.carol, other.tenantId)).length, 0);
    // Raw SQL: the rows exist but only through the tenant predicate.
    const raw = await app.pool.query('SELECT COUNT(*)::int AS n FROM work_service_works WHERE tenant_id = $1', [tenantId]);
    assert.equal((raw.rows[0] as { n: number }).n, 1);
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});

/** A module over its OWN pool (true independent-actor proof, lock #28). */
function workOverOwnPool(app: LiveApp): { module: ReturnType<typeof createWorkModule>; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: app.live.dsn, max: 4 });
  const module = createWorkModule({ executor: poolExecutor(pool), tenancy: app.organizations });
  return { module, pool };
}

test('live: two parallel actors converge on one durable work identity', { skip: SKIP }, async () => {
  const app = await preparedLive();
  const extraPools: pg.Pool[] = [];
  try {
    const { work, owner, colleague, tenantId, pool } = app;
    // Two INDEPENDENT module instances over separate pools.
    const actorA = workOverOwnPool(app);
    const actorB = workOverOwnPool(app);
    extraPools.push(actorA.pool, actorB.pool);

    const key = `parallel-${Date.now()}`;
    const [a, b] = await Promise.all([
      actorA.module.createWork(owner, { tenantId, workType: 't', title: 'A', idempotencyKey: key }),
      actorB.module.createWork(colleague, { tenantId, workType: 't', title: 'B', idempotencyKey: key }),
    ]);
    assert.equal(a.work.id, b.work.id);
    assert.equal((a.converged ? 1 : 0) + (b.converged ? 1 : 0), 1);
    const rows = await pool.query('SELECT COUNT(*)::int AS n FROM work_service_works WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId, key]);
    assert.equal((rows.rows[0] as { n: number }).n, 1);
    void work;
  } finally {
    // Drain the actor pools BEFORE the drop: DROP DATABASE WITH (FORCE)
    // would otherwise terminate their idle clients and surface as
    // unhandled pool errors.
    await Promise.allSettled(extraPools.map((pool) => pool.end()));
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: parallel retries of one dispatched attempt converge on a single new attempt', { skip: SKIP }, async () => {
  const app = await preparedLive();
  const extraPools: pg.Pool[] = [];
  try {
    const { work, owner, colleague, tenantId, pool } = app;
    const { work: created } = await work.createWork(owner, { tenantId, workType: 't', title: 'A' });
    const original = await work.createAttempt(owner, tenantId, created.id, { idempotencyKey: 'r' });
    await work.dispatchAttempt(owner, tenantId, original.attempt.id);

    const actorA = workOverOwnPool(app);
    const actorB = workOverOwnPool(app);
    extraPools.push(actorA.pool, actorB.pool);

    const [a, b] = await Promise.all([
      actorA.module.createAttempt(owner, tenantId, created.id, { idempotencyKey: 'r' }),
      actorB.module.createAttempt(colleague, tenantId, created.id, { idempotencyKey: 'r' }),
    ]);
    assert.equal(a.attempt.id, b.attempt.id);
    assert.notEqual(a.attempt.id, original.attempt.id);
    assert.equal((a.converged ? 1 : 0) + (b.converged ? 1 : 0), 1);

    // Exactly two attempts exist: the superseded original + one replacement.
    const rows = await pool.query('SELECT COUNT(*)::int AS n FROM work_attempts WHERE work_id = $1', [created.id]);
    assert.equal((rows.rows[0] as { n: number }).n, 2);
    const live = await pool.query('SELECT COUNT(*)::int AS n FROM work_attempts WHERE work_id = $1 AND superseded_at IS NULL', [created.id]);
    assert.equal((live.rows[0] as { n: number }).n, 1);
    const current = await work.getWork(owner, tenantId, created.id);
    assert.equal(current.currentAttemptId, a.attempt.id);
  } finally {
    await Promise.allSettled(extraPools.map((pool) => pool.end()));
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: late prior attempt cannot win after supersession (FOR UPDATE serialization)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const { work, owner, colleague, tenantId, pool } = app;
    const { work: created } = await work.createWork(owner, { tenantId, workType: 't', title: 'A' });
    const original = await work.createAttempt(owner, tenantId, created.id, { idempotencyKey: 'k' });
    await work.dispatchAttempt(owner, tenantId, original.attempt.id);

    // Run the replacement and the late result in PARALLEL: whichever order
    // they serialize in, the late result of the superseded attempt can
    // never be applied.
    const [replacement, lateResult] = await Promise.allSettled([
      work.createAttempt(colleague, tenantId, created.id, { idempotencyKey: 'k' }),
      work.recordAttemptResult(owner, tenantId, original.attempt.id, { outcome: 'completed', result: 'late' }),
    ]);
    assert.equal(replacement.status, 'fulfilled');
    assert.equal(lateResult.status, 'rejected');
    assert.ok((lateResult as PromiseRejectedResult).reason instanceof WorkError);
    assert.equal((lateResult as PromiseRejectedResult).reason.code, 'ATTEMPT_SUPERSEDED');

    const rows = await pool.query('SELECT outcome FROM work_attempts WHERE id = $1', [original.attempt.id]);
    assert.equal((rows.rows[0] as { outcome: string | null }).outcome, null);
    const current = await work.getWork(owner, tenantId, created.id);
    assert.equal(current.currentAttemptId, (replacement as PromiseFulfilledResult<{ attempt: { id: string } }>).value.attempt.id);
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: concurrent opposite dependency edges commit at most one', { skip: SKIP }, async () => {
  const app = await preparedLive();
  const extraPools: pg.Pool[] = [];
  try {
    const { work, owner, colleague, tenantId, pool } = app;
    const a = await work.createWork(owner, { tenantId, workType: 't', title: 'A' });
    const b = await work.createWork(owner, { tenantId, workType: 't', title: 'B' });

    const actorA = workOverOwnPool(app);
    const actorB = workOverOwnPool(app);
    extraPools.push(actorA.pool, actorB.pool);

    const [forward, backward] = await Promise.allSettled([
      actorA.module.addDependency(owner, tenantId, a.work.id, b.work.id),
      actorB.module.addDependency(colleague, tenantId, b.work.id, a.work.id),
    ]);
    const rejected = [forward, backward].filter((r) => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'DEPENDENCY_CYCLE');

    // No cycle exists in the durable graph.
    const cycle = await pool.query(
      `WITH RECURSIVE deps AS (
         SELECT depends_on_work_id AS node FROM work_dependencies WHERE work_id = $1
         UNION
         SELECT next.depends_on_work_id FROM work_dependencies next JOIN deps ON next.work_id = deps.node
       ) SELECT 1 AS hit FROM deps WHERE node = $1 LIMIT 1`,
      [a.work.id],
    );
    assert.equal(cycle.rows.length, 0);
    const total = await pool.query('SELECT COUNT(*)::int AS n FROM work_dependencies');
    assert.equal((total.rows[0] as { n: number }).n, 1);
  } finally {
    await Promise.allSettled(extraPools.map((pool) => pool.end()));
    await app.pool.end();
    await app.live.drop();
  }
});

test('live: schema-level backstops hold (one live attempt per work)', { skip: SKIP }, async () => {
  const app = await preparedLive();
  try {
    const { work, owner, tenantId, pool } = app;
    // A KEYED work: the tenant idempotency index applies to it.
    const { work: created, attempt } = await (async () => {
      const created = await work.createWork(owner, { tenantId, workType: 't', title: 'A', idempotencyKey: 'backstop-key' });
      const attempt = await work.createAttempt(owner, tenantId, created.work.id);
      return { work: created.work, attempt: attempt.attempt };
    })();
    // A raw second live attempt for the same work violates the partial
    // unique index — the schema itself refuses a second current attempt.
    await assert.rejects(
      pool.query(
        `INSERT INTO work_attempts (tenant_id, work_id, attempt_no, status, created_by) VALUES ($1, $2, 3, 'pending', $3)`,
        [tenantId, created.id, owner.id],
      ),
      /work_attempts_one_live_per_work/,
    );
    // And a second work row for the same logical identity is impossible.
    await assert.rejects(
      pool.query(
        `INSERT INTO work_service_works (tenant_id, work_type, title, status, created_by, idempotency_key) VALUES ($1, 't', 'dup', 'draft', $2, $3)`,
        [tenantId, owner.id, created.idempotencyKey],
      ),
      /work_service_works_tenant_idempotency_key/,
    );
    void attempt;
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
});
