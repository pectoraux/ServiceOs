/**
 * Optional live-PostgreSQL integration proof for identity/tenancy
 * (WORK-002, CRITICAL assurance). Runs ONLY when
 * SERVICEOS_TEST_DATABASE_URL points at a disposable PostgreSQL database;
 * otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migration 0001 applies and is idempotent;
 * - the full identity/tenancy lifecycle works over real SQL (register →
 *   login → organization → tenants → members → service accounts);
 * - cross-tenant directory reads carry the tenant predicate against real
 *   rows (isolation at the SQL level);
 * - TRUE parallel actors (separate pooled clients) converge on one durable
 *   identity through the schema constraints;
 * - concurrent last-owner revocations serialize through FOR UPDATE and the
 *   last-active-owner rule holds.
 *
 * Each proof runs against its OWN disposable database (node:test executes
 * test files concurrently and migration history is global per database, so
 * sharing one would make unrelated migration sets collide through the
 * version-history check).
 *
 * This environment has no local PostgreSQL, so these proofs execute in CI
 * (the governance workflow provisions a PostgreSQL service) — see the
 * Work Order evidence record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrations, withTransactionOn, type Migration, type TransactionalExecutor } from '../src/platform/persistence/index.js';
import type { MigrationReport } from '../src/platform/persistence/migrations.js';
import { createAuthModule } from '../src/modules/auth/index.js';
import { createOrganizationsModule, OrganizationsError } from '../src/modules/organizations/index.js';
import { createLiveTestDatabase, createTestPool, liveDatabaseRequested, type LiveDatabase } from './helpers/live-database.js';

const SKIP = !liveDatabaseRequested();
const PASSWORD = 'correct horse battery 7';

/** Wrap a pg pool as the transaction-capable executor modules consume. */
function poolExecutor(pool: pg.Pool): TransactionalExecutor {
  return {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params),
    withTransaction: <T>(fn: (tx: import('../src/platform/persistence/index.js').SqlExecutor) => Promise<T>) => {
      // Client-pinned transaction (the same contract the persistence
      // boundary provides in production).
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

/**
 * Apply migrations through a client-pinned executor: a raw pg.Pool is NOT a
 * valid pinned executor (per-statement client checkout — see the WORK-002
 * evidence for the defect this avoids).
 */
async function applyMigrationsPinned(pool: pg.Pool, migrations: readonly Migration[]): Promise<MigrationReport> {
  const client = await pool.connect();
  try {
    return await applyMigrations(client, migrations);
  } finally {
    client.release();
  }
}

function migration(): Migration {
  const sql = readFileSync(resolve(process.cwd(), 'db/migrations/0001_identity_tenancy.sql'), 'utf8');
  return { version: 1, name: 'identity-tenancy', sql };
}

/** Fresh pool + modules over a disposable database with migration 0001 applied. */
async function preparedLive(): Promise<{ live: LiveDatabase; pool: pg.Pool; auth: ReturnType<typeof createAuthModule>; organizations: ReturnType<typeof createOrganizationsModule> }> {
  const live = await createLiveTestDatabase();
  const pool = createTestPool({ connectionString: live.dsn, max: 8 });
  await applyMigrationsPinned(pool, [migration()]);
  const executor = poolExecutor(pool);
  const auth = createAuthModule({ executor });
  const organizations = createOrganizationsModule({
    executor,
    authenticator: auth.authenticate,
    identity: auth,
  });
  return { live, pool, auth, organizations };
}

test('live: migration 0001 applies once and re-runs are no-ops', { skip: SKIP }, async () => {
  const live = await createLiveTestDatabase();
  const pool = createTestPool({ connectionString: live.dsn });
  try {
    const first = await applyMigrationsPinned(pool, [migration()]);
    assert.equal(first.applied.length + first.skipped, 1);
    const second = await applyMigrationsPinned(pool, [migration()]);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped, 1);
    // The durable identity/tenancy tables exist.
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('auth_users','auth_sessions','auth_api_keys','org_organizations','org_service_tenants','org_memberships')
       ORDER BY table_name`,
    );
    assert.equal(tables.rows.length, 6);
  } finally {
    await pool.end();
    await live.drop();
  }
});

test('live: full identity/tenancy lifecycle over real SQL', { skip: SKIP }, async () => {
  const { live, pool, auth, organizations } = await preparedLive();
  try {
    const owner = await auth.registerHuman({
      email: 'alice@example.com',
      password: PASSWORD,
      displayName: 'Alice',
    });
    const issuance = await auth.login({ email: 'alice@example.com', password: PASSWORD });
    const resolved = await auth.authenticate(`Bearer ${issuance.token}`);
    assert.equal(resolved.id, owner.id);

    const created = await organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });
    assert.equal(created.tenant.slug, 'acme-default');
    const tenants = await organizations.createTenant(owner, 'acme', {
      slug: 'acme-project-1',
      displayName: 'Project 1',
    });
    assert.equal(tenants.organizationId, created.organization.id);

    const bob = await auth.registerHuman({ email: 'bob@example.com', password: PASSWORD, displayName: 'Bob' });
    await organizations.addMember(owner, 'acme', { principalId: bob.id, role: 'member' });
    const members = await organizations.listMembers(owner, 'acme');
    assert.equal(members.length, 2);

    const account = await organizations.createServiceAccount(owner, 'acme', {
      displayName: 'sync',
      role: 'viewer',
    });
    const machine = await auth.authenticate(`Bearer ${account.secret}`);
    assert.equal(machine.id, account.member.principal.id);
    const decision = await organizations.authorize(machine.id, { tenantId: created.tenant.id }, 'write');
    assert.equal(decision.allowed, false, 'machine viewer cannot write (AC-5)');
    const read = await organizations.authorize(machine.id, { tenantId: created.tenant.id }, 'read');
    assert.equal(read.allowed, true);
  } finally {
    await pool.end();
    await live.drop();
  }
});

test('live: tenant directories are isolated at the SQL level (cross-tenant rows invisible)', { skip: SKIP }, async () => {
  const { live, pool, auth, organizations } = await preparedLive();
  try {
    const alice = await auth.registerHuman({ email: 'alice@example.com', password: PASSWORD, displayName: 'Alice' });
    const carol = await auth.registerHuman({ email: 'carol@example.com', password: PASSWORD, displayName: 'Carol' });
    await organizations.createOrganization(alice, { slug: 'alpha-org', displayName: 'Alpha' });
    await organizations.createOrganization(carol, { slug: 'beta-org', displayName: 'Beta' });

    const directory = await organizations.listTenantMembers(alice, 'alpha-org-default');
    const principalIds = directory.map((member) => member.principal.id);
    assert.ok(principalIds.includes(alice.id));
    assert.ok(!principalIds.includes(carol.id), 'tenant A directory must never include tenant B members');
  } finally {
    await pool.end();
    await live.drop();
  }
});

test('live: truly parallel inserts converge on one durable identity (unique constraints arbitrate)', { skip: SKIP }, async () => {
  const { live, pool, auth, organizations } = await preparedLive();
  try {
    // Two independent connections insert the same organization slug at the
    // same time: the unique constraint must admit exactly one.
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      const insertA = clientA.query(
        `INSERT INTO org_organizations (slug, display_name) VALUES ($1, $2)`,
        ['raced-org', 'A'],
      );
      const insertB = clientB.query(
        `INSERT INTO org_organizations (slug, display_name) VALUES ($1, $2)`,
        ['raced-org', 'B'],
      );
      const results = await Promise.allSettled([insertA, insertB]);
      const rejected = results.filter((result) => result.status === 'rejected');
      assert.equal(rejected.length, 1, 'exactly one insert wins under the unique constraint');
      const code = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
      assert.equal(code.code, '23505');
      const rows = await pool.query(`SELECT COUNT(*)::int AS count FROM org_organizations WHERE slug = 'raced-org'`);
      assert.equal((rows.rows[0] as { count: number }).count, 1);
    } finally {
      clientA.release();
      clientB.release();
    }

    // Module-level: parallel organization creation converges on one
    // organization with a typed conflict for the loser.
    const owner = await auth.registerHuman({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' });
    const attempts = await Promise.allSettled([
      organizations.createOrganization(owner, { slug: 'raced-org-2', displayName: 'One' }),
      organizations.createOrganization(owner, { slug: 'raced-org-2', displayName: 'Two' }),
    ]);
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    assert.equal(rejected.length, 1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as OrganizationsError;
    assert.ok(reason instanceof OrganizationsError);
    assert.equal(reason.code, 'ORG_SLUG_TAKEN');
    const rows = await pool.query(`SELECT COUNT(*)::int AS count FROM org_organizations WHERE slug = 'raced-org-2'`);
    assert.equal((rows.rows[0] as { count: number }).count, 1);
  } finally {
    await pool.end();
    await live.drop();
  }
});

test('live: parallel last-owner revocations serialize through FOR UPDATE and preserve the rule', { skip: SKIP }, async () => {
  const { live, pool, auth, organizations } = await preparedLive();
  try {
    const owner1 = await auth.registerHuman({ email: 'o1@example.com', password: PASSWORD, displayName: 'O1' });
    const owner2 = await auth.registerHuman({ email: 'o2@example.com', password: PASSWORD, displayName: 'O2' });
    const created = await organizations.createOrganization(owner1, { slug: 'acme', displayName: 'ACME' });
    await organizations.addMember(owner1, 'acme', { principalId: owner2.id, role: 'owner' });

    // Two independent actors revoke the two owners simultaneously.
    const attempts = await Promise.allSettled([
      organizations.revokeMember(owner1, 'acme', owner1.id),
      organizations.revokeMember(owner2, 'acme', owner2.id),
    ]);
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    assert.equal(rejected.length, 1, 'only one of the two last owners can be revoked');
    const reason = (rejected[0] as PromiseRejectedResult).reason as OrganizationsError;
    assert.ok(reason instanceof OrganizationsError);
    assert.equal(reason.code, 'LAST_ACTIVE_OWNER');
    const owners = await pool.query(
      `SELECT COUNT(*)::int AS count FROM org_memberships WHERE organization_id = $1 AND status = 'active' AND role = 'owner'`,
      [created.organization.id],
    );
    assert.equal((owners.rows[0] as { count: number }).count, 1, 'the organization retains an active owner');
  } finally {
    await pool.end();
    await live.drop();
  }
});
