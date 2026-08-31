/**
 * Behavioral proof: THE authorization chain (WORK-002).
 *
 * One decision path — `authorize` in /organizations, backed by the single
 * capability matrix — resolves every capability question. These tests prove
 * the chain's decisions for every role/action pair and the fail-closed deny
 * reasons, and prove AC-5: machine credentials cannot gain ungranted
 * capabilities because their grants come only from the same membership/role
 * chain (and the chain structurally refuses owner/admin for machines).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError } from '../src/modules/auth/index.js';
import { buildIdentityApp } from './helpers/in-memory-stores.js';

const PASSWORD = 'correct horse battery 7';

async function human(app: ReturnType<typeof buildIdentityApp>, email: string) {
  return app.auth.registerHuman({ email, password: PASSWORD, displayName: email.split('@')[0] ?? 'User' });
}

test('the capability matrix is the single decision source (all role/action pairs)', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'owner@example.com');
  const { organization, tenant } = await app.organizations.createOrganization(owner, {
    slug: 'acme',
    displayName: 'ACME',
  });
  const members: Record<string, string> = {};
  for (const [name, role] of [
    ['admin', 'admin'],
    ['member', 'member'],
    ['viewer', 'viewer'],
  ] as const) {
    const principal = await human(app, `${name}@example.com`);
    await app.organizations.addMember(owner, 'acme', { principalId: principal.id, role });
    members[name] = principal.id;
  }

  const expectations: Record<string, { read: boolean; write: boolean; administer: boolean }> = {
    owner: { read: true, write: true, administer: true },
    admin: { read: true, write: true, administer: true },
    member: { read: true, write: true, administer: false },
    viewer: { read: true, write: false, administer: false },
  };

  for (const [name, capabilities] of Object.entries(expectations)) {
    const principalId = name === 'owner' ? owner.id : (members[name] as string);
    for (const [action, expected] of Object.entries(capabilities)) {
      const organizationDecision = await app.organizations.authorize(principalId, { organizationId: organization.id }, action as 'read');
      assert.equal(
        organizationDecision.allowed,
        expected,
        `${name} organization ${action} should be ${expected}`,
      );
      const tenantDecision = await app.organizations.authorize(principalId, { tenantId: tenant.id }, action as 'read');
      assert.equal(tenantDecision.allowed, expected, `${name} tenant ${action} should be ${expected}`);
      if (!expected) {
        assert.equal(organizationDecision.reason, 'ROLE_FORBIDDEN');
        assert.equal(tenantDecision.reason, 'ROLE_FORBIDDEN');
      }
    }
  }
});

test('deny reasons are typed and fail closed', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'owner@example.com');
  const stranger = await human(app, 'stranger@example.com');
  const { organization, tenant } = await app.organizations.createOrganization(owner, {
    slug: 'acme',
    displayName: 'ACME',
  });

  const unknownOrg = await app.organizations.authorize(owner.id, { organizationId: '00000000-0000-0000-0000-000000000000' }, 'read');
  assert.equal(unknownOrg.allowed, false);
  assert.equal(unknownOrg.reason, 'ORGANIZATION_NOT_FOUND');

  const unknownTenant = await app.organizations.authorize(owner.id, { tenantId: '00000000-0000-0000-0000-000000000000' }, 'read');
  assert.equal(unknownTenant.allowed, false);
  assert.equal(unknownTenant.reason, 'TENANT_NOT_FOUND');

  const noMembership = await app.organizations.authorize(stranger.id, { organizationId: organization.id }, 'read');
  assert.equal(noMembership.allowed, false);
  assert.equal(noMembership.reason, 'MEMBERSHIP_FORBIDDEN');

  const crossTenant = await app.organizations.authorize(stranger.id, { tenantId: tenant.id }, 'write');
  assert.equal(crossTenant.allowed, false);
  assert.equal(crossTenant.reason, 'MEMBERSHIP_FORBIDDEN');
});

test('suspended organizations and tenants deny through the same chain', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'owner@example.com');
  const { organization, tenant } = await app.organizations.createOrganization(owner, {
    slug: 'acme',
    displayName: 'ACME',
  });
  // The store is the durable state: suspension is a state fact, set directly.
  app.orgStore.organizations.get(organization.id)!.status = 'suspended';
  const orgDecision = await app.organizations.authorize(owner.id, { organizationId: organization.id }, 'read');
  assert.equal(orgDecision.allowed, false);
  assert.equal(orgDecision.reason, 'ORGANIZATION_SUSPENDED');

  app.orgStore.organizations.get(organization.id)!.status = 'active';
  app.orgStore.tenants.get(tenant.id)!.status = 'suspended';
  const tenantDecision = await app.organizations.authorize(owner.id, { tenantId: tenant.id }, 'read');
  assert.equal(tenantDecision.allowed, false);
  assert.equal(tenantDecision.reason, 'TENANT_SUSPENDED');
});

test('AC-5: machine credentials resolve capabilities only through the membership chain', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'owner@example.com');
  const { organization, tenant } = await app.organizations.createOrganization(owner, {
    slug: 'acme',
    displayName: 'ACME',
  });

  // A machine service account with the viewer role: reads granted, writes
  // and administration denied — exactly like a human viewer.
  const viewerAccount = await app.organizations.createServiceAccount(owner, 'acme', {
    displayName: 'reader',
    role: 'viewer',
  });
  const viewerResolved = await app.auth.authenticate(`Bearer ${viewerAccount.secret}`);
  assert.equal(viewerResolved.kind, 'machine');
  const read = await app.organizations.authorize(viewerResolved.id, { tenantId: tenant.id }, 'read');
  assert.equal(read.allowed, true);
  const write = await app.organizations.authorize(viewerResolved.id, { tenantId: tenant.id }, 'write');
  assert.equal(write.allowed, false);
  const administer = await app.organizations.authorize(viewerResolved.id, { organizationId: organization.id }, 'administer');
  assert.equal(administer.allowed, false);

  // A machine principal with NO membership has zero capabilities.
  const orphan = await app.auth.createMachinePrincipal({ displayName: 'orphan' });
  const orphanKey = await app.auth.issueApiKey(orphan.id);
  const orphanResolved = await app.auth.authenticate(`Bearer ${orphanKey.secret}`);
  assert.equal(orphanResolved.id, orphan.id);
  for (const action of ['read', 'write', 'administer'] as const) {
    const decision = await app.organizations.authorize(orphan.id, { tenantId: tenant.id }, action);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'MEMBERSHIP_FORBIDDEN');
  }
});

test('AC-5: an API key is only as capable as its principal membership — cross-tenant denial', async () => {
  const app = buildIdentityApp();
  const ownerA = await human(app, 'a-owner@example.com');
  const ownerB = await human(app, 'b-owner@example.com');
  const orgA = await app.organizations.createOrganization(ownerA, { slug: 'org-a', displayName: 'Org A' });
  const orgB = await app.organizations.createOrganization(ownerB, { slug: 'org-b', displayName: 'Org B' });

  const machine = await app.organizations.createServiceAccount(ownerA, 'org-a', {
    displayName: 'sync-a',
    role: 'member',
  });
  // The machine credential authenticates fine (identity) but grants nothing
  // in organization B's tenant (authorization fails closed).
  const resolved = await app.auth.authenticate(`Bearer ${machine.secret}`);
  assert.equal(resolved.kind, 'machine');
  const decision = await app.organizations.authorize(resolved.id, { tenantId: orgB.tenant.id }, 'write');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'MEMBERSHIP_FORBIDDEN');
  // The same principal IS granted in its own tenant.
  const own = await app.organizations.authorize(resolved.id, { tenantId: orgA.tenant.id }, 'write');
  assert.equal(own.allowed, true);
});

test('revoking the service account membership removes machine capabilities immediately', async () => {
  const app = buildIdentityApp();
  const owner = await human(app, 'owner@example.com');
  const { tenant } = await app.organizations.createOrganization(owner, { slug: 'acme', displayName: 'ACME' });
  const account = await app.organizations.createServiceAccount(owner, 'acme', {
    displayName: 'temp',
    role: 'member',
  });
  const before = await app.organizations.authorize(account.member.principal.id, { tenantId: tenant.id }, 'write');
  assert.equal(before.allowed, true);
  await app.organizations.revokeServiceAccount(owner, 'acme', account.member.principal.id);
  // The credential itself is dead (revoked key) — double fail-closed.
  await assert.rejects(
    () => app.auth.authenticate(`Bearer ${account.secret}`),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal((error as AuthError).code, 'UNAUTHENTICATED');
      return true;
    },
  );
  const after = await app.organizations.authorize(account.member.principal.id, { tenantId: tenant.id }, 'write');
  assert.equal(after.allowed, false);
  assert.equal(after.reason, 'MEMBERSHIP_FORBIDDEN');
});
