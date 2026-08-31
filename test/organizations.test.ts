/**
 * Behavioral proof: organization, tenant and membership lifecycle
 * (WORK-002, /organizations module API).
 *
 * AC-2 — organizations and memberships are persisted through the store port
 * (SQL in production, faithful in-memory double here) with schema-equivalent
 * uniqueness rules and the last-active-owner integrity rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrganizationsError } from '../src/modules/organizations/index.js';
import { buildIdentityApp } from './helpers/in-memory-stores.js';

const PASSWORD = 'correct horse battery 7';

async function human(
  app: ReturnType<typeof buildIdentityApp>,
  email: string,
): Promise<{ id: string; kind: 'human' | 'machine'; email: string; displayName: string; status: 'active' | 'disabled' }> {
  return app.auth.registerHuman({ email, password: PASSWORD, displayName: email.split('@')[0] ?? 'User' });
}

test('createOrganization persists organization + default service tenant + owner membership (AC-2)', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'alice@example.com');
  const created = await app.organizations.createOrganization(owner, {
    slug: 'acme',
    displayName: 'ACME Construction',
  });
  assert.equal(created.organization.slug, 'acme');
  assert.equal(created.tenant.slug, 'acme-default');
  assert.equal(created.tenant.organizationId, created.organization.id);
  assert.equal(created.membership.role, 'owner');
  assert.equal(created.membership.status, 'active');
  assert.equal(created.membership.principalId, owner.id);
  // Persisted: the store holds exactly one of each.
  assert.equal(app.orgStore.organizations.size, 1);
  assert.equal(app.orgStore.tenants.size, 1);
  assert.equal(app.orgStore.memberships.size, 1);
});

test('service accounts (machine principals) cannot create organizations', async () => {
  const app = buildIdentityApp();
  const machine = await app.auth.createMachinePrincipal({ displayName: 'svc' });
  await assert.rejects(
    () => app.organizations.createOrganization(machine, { slug: 'acme', displayName: 'ACME' }),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'MACHINE_PRINCIPAL_FORBIDDEN');
      return true;
    },
  );
  assert.equal(app.orgStore.organizations.size, 0);
});

test('organization slugs are validated and duplicates fail closed', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'alice@example.com');
  await app.organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });
  for (const bad of ['A', 'ab', 'Bad-Slug', 'x'.repeat(64), 'acme']) {
    await assert.rejects(
      () =>
        app.organizations.createOrganization(owner, {
          slug: bad,
          displayName: 'Whatever',
        }),
      (error: unknown) => {
        assert.ok(error instanceof OrganizationsError);
        const code = (error as OrganizationsError).code;
        assert.ok(code === 'INVALID_INPUT' || code === 'ORG_SLUG_TAKEN');
        return true;
      },
    );
  }
});

test('membership lifecycle: add member, change role, revoke member', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'alice@example.com');
  const member = await human(app, 'bob@example.com');
  const { organization } = await app.organizations.createOrganization(owner, {
    slug: 'acme',
    displayName: 'ACME',
  });

  const added = await app.organizations.addMember(owner, 'acme', { principalId: member.id, role: 'member' });
  assert.equal(added.membership.role, 'member');
  assert.equal(added.membership.status, 'active');
  assert.equal(added.principal.id, member.id);

  const promoted = await app.organizations.setMemberRole(owner, 'acme', member.id, 'admin');
  assert.equal(promoted.membership.role, 'admin');

  const revoked = await app.organizations.revokeMember(owner, 'acme', member.id);
  assert.equal(revoked.membership.status, 'revoked');
  // Revoked membership no longer grants anything.
  const denied = await app.organizations.authorize(member.id, { organizationId: organization.id }, 'read');
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'MEMBERSHIP_FORBIDDEN');
});

test('adding the same member twice converges on one membership (typed conflict)', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'alice@example.com');
  const member = await human(app, 'bob@example.com');
  await app.organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });
  await app.organizations.addMember(owner, 'acme', { principalId: member.id, role: 'member' });
  await assert.rejects(
    () => app.organizations.addMember(owner, 'acme', { principalId: member.id, role: 'viewer' }),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'MEMBERSHIP_EXISTS');
      return true;
    },
  );
  const memberships = [...app.orgStore.memberships.values()].filter((m) => m.principalId === member.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]?.role, 'member', 'the first grant stays authoritative');
});

test('only owners grant ownership; admins cannot', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'alice@example.com');
  const admin = await human(app, 'bob@example.com');
  const target = await human(app, 'carol@example.com');
  await app.organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });
  await app.organizations.addMember(owner, 'acme', { principalId: admin.id, role: 'admin' });
  await assert.rejects(
    () => app.organizations.addMember(admin, 'acme', { principalId: target.id, role: 'owner' }),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'ROLE_FORBIDDEN');
      return true;
    },
  );
  const byOwner = await app.organizations.addMember(owner, 'acme', { principalId: target.id, role: 'owner' });
  assert.equal(byOwner.membership.role, 'owner');
});

test('the last active owner cannot be revoked or demoted (tenant integrity rule)', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'alice@example.com');
  const other = await human(app, 'bob@example.com');
  await app.organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });
  await app.organizations.addMember(owner, 'acme', { principalId: other.id, role: 'admin' });

  await assert.rejects(
    () => app.organizations.revokeMember(owner, 'acme', owner.id),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'LAST_ACTIVE_OWNER');
      return true;
    },
  );
  await assert.rejects(
    () => app.organizations.setMemberRole(owner, 'acme', owner.id, 'admin'),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'LAST_ACTIVE_OWNER');
      return true;
    },
  );
});

test('revoking one of two owners succeeds and preserves the rule for the remaining one', async () => {
  const app = buildIdentityApp();
  const owner1 = await human(app, 'alice@example.com');
  const owner2 = await human(app, 'bob@example.com');
  await app.organizations.createOrganization(owner1, { slug: 'acme', displayName: 'ACME' });
  await app.organizations.addMember(owner1, 'acme', { principalId: owner2.id, role: 'owner' });
  const revoked = await app.organizations.revokeMember(owner1, 'acme', owner2.id);
  assert.equal(revoked.membership.status, 'revoked');
  await assert.rejects(
    () => app.organizations.revokeMember(owner1, 'acme', owner1.id),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'LAST_ACTIVE_OWNER');
      return true;
    },
  );
});

test('tenant lifecycle: create tenants, list them scoped to the organization', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'alice@example.com');
  await app.organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });
  const created = await app.organizations.createTenant(owner, 'acme', {
    slug: 'acme-project-1',
    displayName: 'Project 1',
  });
  assert.equal(created.organizationId, app.orgStore.organizationsBySlug.get('acme'));
  const tenants = await app.organizations.listTenants(owner, 'acme');
  assert.deepEqual(
    tenants.map((tenant) => tenant.slug).sort(),
    ['acme-default', 'acme-project-1'],
  );
  // Duplicate tenant slug fails closed.
  await assert.rejects(
    () => app.organizations.createTenant(owner, 'acme', { slug: 'acme-project-1', displayName: 'Dup' }),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'TENANT_SLUG_TAKEN');
      return true;
    },
  );
});

test('listOrganizationsForPrincipal is server-resolved from memberships only', async () => {
  const app = buildIdentityApp();
  const alice = await human(app, 'alice@example.com');
  const bob = await human(app, 'bob@example.com');
  await app.organizations.createOrganization(alice, { slug: 'acme', displayName: 'ACME' });
  await app.organizations.createOrganization(alice, { slug: 'globex', displayName: 'Globex' });
  await app.organizations.createOrganization(bob, { slug: 'initech', displayName: 'Initech' });

  const forAlice = await app.organizations.listOrganizationsForPrincipal(alice.id);
  assert.deepEqual(
    forAlice.map((entry) => entry.organization.slug),
    ['acme', 'globex'],
  );
  const forBob = await app.organizations.listOrganizationsForPrincipal(bob.id);
  assert.deepEqual(
    forBob.map((entry) => entry.organization.slug),
    ['initech'],
  );
});

test('service accounts: create, list and revoke through the organization surface', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'alice@example.com');
  await app.organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });
  const created = await app.organizations.createServiceAccount(owner, 'acme', {
    displayName: 'sync-worker',
    role: 'viewer',
  });
  assert.equal(created.member.principal.kind, 'machine');
  assert.match(created.secret, /^soak_/);
  const listed = await app.organizations.listServiceAccounts(owner, 'acme');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.principal.displayName, 'sync-worker');

  const revoked = await app.organizations.revokeServiceAccount(owner, 'acme', created.member.principal.id);
  assert.equal(revoked.member.membership.status, 'revoked');
  assert.equal(revoked.revokedKeys, 1);
  const after = await app.organizations.listServiceAccounts(owner, 'acme');
  assert.equal(after.length, 1, 'revoked service account stays listed with revoked membership');
  assert.equal(after[0]?.membership.status, 'revoked');
});

test('service accounts cannot be granted admin or owner roles (AC-5 grant-side guard)', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'alice@example.com');
  await app.organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });
  for (const role of ['admin', 'owner']) {
    await assert.rejects(
      () => app.organizations.createServiceAccount(owner, 'acme', { displayName: 'svc', role }),
      (error: unknown) => {
        assert.ok(error instanceof OrganizationsError);
        assert.equal((error as OrganizationsError).code, 'MACHINE_ROLE_FORBIDDEN');
        return true;
      },
    );
  }
  // Humans cannot be revoked through the service-account surface.
  const bob = await human(app, 'bob@example.com');
  await app.organizations.addMember(owner, 'acme', { principalId: bob.id, role: 'member' });
  await assert.rejects(
    () => app.organizations.revokeServiceAccount(owner, 'acme', bob.id),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('unknown principals and memberships fail with typed not-found errors', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'alice@example.com');
  await app.organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });
  await assert.rejects(
    () => app.organizations.addMember(owner, 'acme', { principalId: '00000000-0000-0000-0000-000000000000', role: 'member' }),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'PRINCIPAL_NOT_FOUND');
      return true;
    },
  );
  await assert.rejects(
    () => app.organizations.revokeMember(owner, 'acme', '00000000-0000-0000-0000-000000000000'),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'PRINCIPAL_NOT_FOUND');
      return true;
    },
  );
  await assert.rejects(
    () => app.organizations.listTenants(owner, 'ghost-org'),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationsError);
      assert.equal((error as OrganizationsError).code, 'ORGANIZATION_NOT_FOUND');
      return true;
    },
  );
});
