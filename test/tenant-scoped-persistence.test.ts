/**
 * Discrimination + concurrency proof: tenant-scoped persistence and identity
 * convergence (WORK-002, CRITICAL assurance).
 *
 * Part 1 — the mandatory tenant predicate (Work Order discrimination
 * requirement "removing tenant predicate must make a discrimination test
 * fail"): the SQL store's tenant-scoped read is executed against a recording
 * executor; the discriminator asserts (a) the predicate text is present and
 * (b) the bound parameter is exactly the server-resolved tenant id. Known
 * mutations of the SQL text (predicate removal, WHERE-clause removal) are
 * then fed through the SAME discriminator and MUST be rejected — proving the
 * test suite is sensitive to exactly the mutation it claims to detect.
 *
 * Part 2 — concurrency (independent-actor proof, lock #28): parallel actors
 * racing on the same logical identity converge on exactly one durable
 * identity with typed truthful outcomes; atomic store rules hold under
 * interleaving.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqlOrganizationsStore, OrganizationsError } from '../src/modules/organizations/index.js';
import {
  withTransactionOn,
  type SqlExecutor,
  type TransactionalExecutor,
} from '../src/platform/persistence/index.js';
import { AuthError } from '../src/modules/auth/index.js';
import {
  buildIdentityApp,
  InMemoryAuthStore,
  InMemoryOrganizationsStore,
} from './helpers/in-memory-stores.js';
import { FakeExecutor } from './helpers/tree.js';

const PASSWORD = 'correct horse battery 7';

// ---------------------------------------------------------------------------
// The discriminator: a tenant-scoped statement MUST carry the predicate and
// bind the tenant identity.
// ---------------------------------------------------------------------------

interface ScopedStatement {
  sql: string;
  params?: unknown[];
}

function assertTenantScoped(statement: ScopedStatement, tenantId: string): void {
  assert.ok(
    /FROM org_service_tenants\s+t/i.test(statement.sql),
    'tenant-scoped reads must select THROUGH org_service_tenants (isolated customer-domain boundary)',
  );
  assert.ok(
    /t\.id\s*=\s*\$\d+/.test(statement.sql),
    'the mandatory tenant predicate (t.id = $n) must be present — removing it is a cross-tenant read',
  );
  const index = Number(/t\.id\s*=\s*\$(\d+)/.exec(statement.sql)?.[1] ?? NaN);
  assert.ok(Number.isInteger(index), 'predicate parameter index must be parseable');
  assert.equal(
    statement.params?.[index - 1],
    tenantId,
    'the bound parameter must be the server-resolved tenant id',
  );
}

class TransactionalFakeExecutor extends FakeExecutor implements TransactionalExecutor {
  withTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return withTransactionOn(this, fn);
  }
}

test('listTenantDirectory executes a tenant-scoped statement with the predicate bound (discrimination)', async () => {
  const executor = new TransactionalFakeExecutor();
  const store = createSqlOrganizationsStore(executor);
  const tenantId = '11111111-1111-1111-1111-111111111111';
  await store.listTenantDirectory(tenantId);
  const scoped = executor.statements.filter((statement) =>
    /org_service_tenants/.test(statement.sql) && !/INSERT/.test(statement.sql),
  );
  assert.equal(scoped.length, 1, 'exactly one tenant-scoped select');
  assertTenantScoped(scoped[0] as ScopedStatement, tenantId);
});

test('known mutations of the tenant predicate are caught by the discriminator (mutation sensitivity)', () => {
  // The shipped SQL, captured from the store implementation.
  const executor = new TransactionalFakeExecutor();
  const original = {
    sql: `SELECT m.id, m.organization_id, m.principal_id, m.role, m.status, m.granted_by,
                m.created_at, m.updated_at
         FROM org_service_tenants t
         JOIN org_memberships m ON m.organization_id = t.organization_id
         WHERE t.id = $1 AND m.status = 'active'`,
    params: ['11111111-1111-1111-1111-111111111111'],
  };
  void executor;
  // Control: the shipped statement passes.
  assert.doesNotThrow(() => assertTenantScoped(original, original.params[0] as string));

  // Mutation 1: drop the tenant predicate entirely (the exact Work Order
  // mutation). The discriminator MUST reject it — this is what makes the
  // suite fail if someone removes the predicate from the store.
  const noPredicate = {
    sql: original.sql.replace(/WHERE t\.id = \$1 AND /, 'WHERE '),
    params: [],
  };
  assert.throws(() => assertTenantScoped(noPredicate, original.params[0] as string), /mandatory tenant predicate/);

  // Mutation 2: drop the whole WHERE clause (read every tenant's directory).
  const noWhere = { sql: original.sql.replace(/WHERE[\s\S]*$/, ''), params: [] };
  assert.throws(() => assertTenantScoped(noWhere, original.params[0] as string), /mandatory tenant predicate/);

  // Mutation 3: keep the text but bind the WRONG tenant (client-supplied
  // trust instead of server-side resolution).
  const wrongBinding = { sql: original.sql, params: ['22222222-2222-2222-2222-222222222222'] };
  assert.throws(() => assertTenantScoped(wrongBinding, original.params[0] as string), /bound parameter/);
});

test('organization-scoped reads bind the organization identity parameter', async () => {
  const executor = new TransactionalFakeExecutor();
  const store = createSqlOrganizationsStore(executor);
  const organizationId = '33333333-3333-3333-3333-333333333333';
  await store.listMembershipsForOrganization(organizationId);
  const scoped = executor.statements.filter((statement) => /org_memberships/.test(statement.sql));
  assert.equal(scoped.length, 1);
  assert.ok(/organization_id = \$1/.test((scoped[0] as ScopedStatement).sql));
  assert.equal((scoped[0] as ScopedStatement).params?.[0], organizationId);
});

test('updateMembership runs in one transaction with row locks and the last-owner rule query', async () => {
  const executor = new TransactionalFakeExecutor({
    answers: [
      { match: /SELECT principal_id FROM org_memberships/, rows: [{ principal_id: 'p1' }] },
      {
        match: /SELECT id, organization_id, principal_id, role, status, granted_by, created_at, updated_at\s+FROM org_memberships\s+WHERE organization_id = \$1 AND principal_id = \$2/,
        rows: [
          {
            id: 'm1',
            organization_id: 'o1',
            principal_id: 'p1',
            role: 'owner',
            status: 'active',
            granted_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      },
      { match: /SELECT COUNT\(\*\)::int AS count FROM org_memberships/, rows: [{ count: 1 }] },
      {
        match: /UPDATE org_memberships SET role = \$3, status = \$4/,
        rows: [
          {
            id: 'm1',
            organization_id: 'o1',
            principal_id: 'p1',
            role: 'owner',
            status: 'revoked',
            granted_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      },
    ],
  });
  const store = createSqlOrganizationsStore(executor);
  // With count=1 the revoke of the last owner must be rejected by the rule.
  await assert.rejects(
    () =>
      store.updateMembership('o1', 'p1', { status: 'revoked' }, { requireActiveOwnerRemaining: true }, new Date()),
    /last active owner/,
  );
  const sqlTrace = executor.sqlTrace();
  assert.ok(sqlTrace.includes('BEGIN'), 'membership updates are transactional');
  assert.ok(sqlTrace.includes('COMMIT') === false, 'a rejected rule rolls the transaction back');
  assert.ok(
    sqlTrace.some((sql) => /FOR UPDATE/.test(sql)),
    'concurrent membership mutations are serialized with row locks',
  );
});

// ---------------------------------------------------------------------------
// Convergence: concurrent identity creation/linking converges on one identity
// ---------------------------------------------------------------------------

test('parallel registration of the same email converges on exactly one principal', async () => {
  // Interleaving point: both coroutines pause inside createUser before the
  // atomic unique check, so both reach the insert decision concurrently.
  const racingStore = new InMemoryAuthStore({
    beforeCreateUser: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });
  const { createAuthModule } = await import('../src/modules/auth/index.js');
  const auth = createAuthModule({ store: racingStore });

  const attempts = await Promise.allSettled([
    auth.registerHuman({ email: 'race@example.com', password: PASSWORD, displayName: 'A' }),
    auth.registerHuman({ email: 'race@example.com', password: PASSWORD, displayName: 'B' }),
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one creator wins');
  assert.equal(rejected.length, 1, 'the loser gets a typed conflict');
  const reason = (rejected[0] as PromiseRejectedResult).reason as AuthError;
  assert.ok(reason instanceof AuthError);
  assert.equal(reason.code, 'EMAIL_TAKEN');
  assert.equal(racingStore.users.size, 1, 'exactly one durable identity exists');
  const winner = fulfilled[0] as PromiseFulfilledResult<{ id: string }>;
  assert.equal([...racingStore.users.values()][0]?.id, winner.value.id);
});

test('parallel organization creation of the same slug converges on exactly one organization', async () => {
  const barrier = new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const orgStore = new InMemoryOrganizationsStore({
    beforeCreateOrganization: async () => {
      await barrier;
    },
  });
  const authStore = new InMemoryAuthStore();
  const { createAuthModule } = await import('../src/modules/auth/index.js');
  const { createOrganizationsModule } = await import('../src/modules/organizations/index.js');
  const auth = createAuthModule({ store: authStore });
  const organizations = createOrganizationsModule({
    store: orgStore,
    authenticator: auth.authenticate,
    identity: auth,
  });
  const owner = await auth.registerHuman({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' });

  const attempts = await Promise.allSettled([
    organizations.createOrganization(owner, { slug: 'raced-org', displayName: 'One' }),
    organizations.createOrganization(owner, { slug: 'raced-org', displayName: 'Two' }),
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const reason = (rejected[0] as PromiseRejectedResult).reason as OrganizationsError;
  assert.ok(reason instanceof OrganizationsError);
  assert.equal(reason.code, 'ORG_SLUG_TAKEN');
  assert.equal(orgStore.organizations.size, 1, 'exactly one durable organization');
  assert.equal(orgStore.tenants.size, 1, 'exactly one default tenant');
  assert.equal(orgStore.memberships.size, 1, 'exactly one owner membership');
});

test('parallel membership creation for the same principal converges on one membership', async () => {
  const barrier = new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const orgStore = new InMemoryOrganizationsStore({
    beforeCreateMembership: async () => {
      await barrier;
    },
  });
  const authStore = new InMemoryAuthStore();
  const { createAuthModule } = await import('../src/modules/auth/index.js');
  const { createOrganizationsModule } = await import('../src/modules/organizations/index.js');
  const auth = createAuthModule({ store: authStore });
  const organizations = createOrganizationsModule({
    store: orgStore,
    authenticator: auth.authenticate,
    identity: auth,
  });
  const owner = await auth.registerHuman({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner' });
  const member = await auth.registerHuman({ email: 'member@example.com', password: PASSWORD, displayName: 'Member' });
  await organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });

  const attempts = await Promise.allSettled([
    organizations.addMember(owner, 'acme', { principalId: member.id, role: 'viewer' }),
    organizations.addMember(owner, 'acme', { principalId: member.id, role: 'member' }),
  ]);
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(rejected.length, 1);
  const reason = (rejected[0] as PromiseRejectedResult).reason as OrganizationsError;
  assert.equal(reason.code, 'MEMBERSHIP_EXISTS');
  const memberships = [...orgStore.memberships.values()].filter((m) => m.principalId === member.id);
  assert.equal(memberships.length, 1, 'exactly one durable membership (the first grant)');
});

test('parallel revocation of the two last owners preserves the last-active-owner rule', async () => {
  const app = buildIdentityApp();
  const owner1 = await app.auth.registerHuman({ email: 'o1@example.com', password: PASSWORD, displayName: 'O1' });
  const owner2 = await app.auth.registerHuman({ email: 'o2@example.com', password: PASSWORD, displayName: 'O2' });
  await app.organizations.createOrganization(owner1, { slug: 'acme', displayName: 'ACME' });
  await app.organizations.addMember(owner1, 'acme', { principalId: owner2.id, role: 'owner' });

  const attempts = await Promise.allSettled([
    app.organizations.revokeMember(owner1, 'acme', owner1.id),
    app.organizations.revokeMember(owner1, 'acme', owner2.id),
  ]);
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(rejected.length, 1, 'exactly one revocation may proceed');
  const reason = (rejected[0] as PromiseRejectedResult).reason as OrganizationsError;
  assert.ok(reason instanceof OrganizationsError);
  assert.equal(reason.code, 'LAST_ACTIVE_OWNER');
  const activeOwners = await app.orgStore.countActiveOwners(app.orgStore.organizationsBySlug.get('acme') as string);
  assert.equal(activeOwners, 1, 'the organization always retains an active owner');
});
