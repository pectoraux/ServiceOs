/**
 * Behavioral proof: tenant isolation at the HTTP boundary (WORK-002, AC-4).
 *
 * Proves through the composed server (real routing, guards, handlers over
 * faithful in-memory stores):
 *
 * - every customer route rejects unauthenticated requests (the enumeration
 *   proof for "all customer routes require scope" — structural requirement);
 * - cross-tenant access is rejected BEFORE domain data is touched (the store
 *   read counters prove the handler never ran);
 * - authorization denial (403) stays distinct from a missing resource (404);
 * - client-supplied trust material (tenant headers, body tenant claims) is
 *   never a trust source — scope always resolves server-side from the route;
 * - tenant directories are scoped to the requesting tenant only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeServer, type ReadinessProbe } from '../src/platform/http/index.js';
import { createLogger } from '../src/platform/logging/index.js';
import { registerModules } from '../src/platform/module-registry/index.js';
import { loadConfig } from '../src/platform/config/index.js';
import { SERVICE_MODULES } from '../src/main.js';
import { buildIdentityApp, type IdentityApp } from './helpers/in-memory-stores.js';

const PASSWORD = 'correct horse battery 7';
const quietLogger = createLogger('error', {}, () => {});

const fakeProbe: ReadinessProbe = {
  isConfigured: () => true,
  ready: async () => ({ ok: true }),
};

async function withIdentityServer(
  app: IdentityApp,
  handler: (port: number) => Promise<void>,
): Promise<void> {
  const config = loadConfig({ SERVICEOS_PORT: '0' }, {});
  const server = composeServer({
    modules: registerModules(SERVICE_MODULES),
    readiness: fakeProbe,
    config,
    logger: quietLogger,
    customerRoutes: app.routes,
  });
  const { port } = await server.start();
  try {
    await handler(port);
  } finally {
    await server.stop();
  }
}

interface JsonResult {
  status: number;
  body: any;
}

async function call(
  port: number,
  path: string,
  options: { method?: string; token?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<JsonResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) {
    headers['authorization'] = `Bearer ${options.token}`;
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

async function scenario() {
  const app = buildIdentityApp();
  const alice = await app.auth.registerHuman({ email: 'alice@a.com', password: PASSWORD, displayName: 'Alice' });
  const bob = await app.auth.registerHuman({ email: 'bob@a.com', password: PASSWORD, displayName: 'Bob' });
  const carol = await app.auth.registerHuman({ email: 'carol@b.com', password: PASSWORD, displayName: 'Carol' });

  const orgA = await app.organizations.createOrganization(alice, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(alice, 'alpha-org', { principalId: bob.id, role: 'member' });
  const orgB = await app.organizations.createOrganization(carol, { slug: 'beta-org', displayName: 'Beta' });

  const aliceToken = (await app.auth.login({ email: 'alice@a.com', password: PASSWORD })).token;
  const bobToken = (await app.auth.login({ email: 'bob@a.com', password: PASSWORD })).token;
  const carolToken = (await app.auth.login({ email: 'carol@b.com', password: PASSWORD })).token;

  return {
    app,
    principals: { alice, bob, carol },
    orgA,
    orgB,
    tokens: { alice: aliceToken, bob: bobToken, carol: carolToken },
  };
}

test('every customer route rejects unauthenticated requests (all-customer-routes-require-scope)', async () => {
  const app = buildIdentityApp();
  await withIdentityServer(app, async (port) => {
    // Path-parameter placeholders get benign concrete values.
    const requests: { method: string; path: string }[] = [
      { method: 'POST', path: '/api/auth/logout' },
      { method: 'GET', path: '/api/auth/me' },
      { method: 'POST', path: '/api/organizations' },
      { method: 'GET', path: '/api/organizations' },
      { method: 'GET', path: '/api/organizations/alpha-org' },
      { method: 'POST', path: '/api/organizations/alpha-org/tenants' },
      { method: 'GET', path: '/api/organizations/alpha-org/tenants' },
      { method: 'POST', path: '/api/organizations/alpha-org/members' },
      { method: 'GET', path: '/api/organizations/alpha-org/members' },
      { method: 'POST', path: '/api/organizations/alpha-org/members/00000000-0000-0000-0000-000000000000/role' },
      { method: 'POST', path: '/api/organizations/alpha-org/members/00000000-0000-0000-0000-000000000000/revoke' },
      { method: 'GET', path: '/api/tenants/alpha-org-default' },
      { method: 'GET', path: '/api/tenants/alpha-org-default/members' },
      { method: 'POST', path: '/api/organizations/alpha-org/service-accounts' },
      { method: 'GET', path: '/api/organizations/alpha-org/service-accounts' },
      { method: 'POST', path: '/api/organizations/alpha-org/service-accounts/00000000-0000-0000-0000-000000000000/revoke' },
    ];
    for (const request of requests) {
      const result = await call(port, request.path, { method: request.method });
      assert.equal(result.status, 401, `${request.method} ${request.path} must reject unauthenticated callers`);
      assert.equal(result.body.error.code, 'UNAUTHENTICATED');
    }
    // Public identity routes stay public (no guard needed by design).
    const health = await call(port, '/healthz');
    assert.equal(health.status, 200);
    const register = await call(port, '/api/auth/register', {
      method: 'POST',
      body: { email: 'x@x.com', password: PASSWORD, displayName: 'X' },
    });
    assert.equal(register.status, 201);
  });
});

test('cross-tenant access is rejected BEFORE domain data is read (AC-4, deny-before-data)', async () => {
  const scene = await scenario();
  await withIdentityServer(scene.app, async (port) => {
    const directoryReadsBefore = scene.app.orgStore.reads.tenantDirectory;
    const membershipReadsBefore = scene.app.orgStore.reads.membershipsForOrganization;

    // Bob (org A) requests org B's tenant directory -> 403, no data touched.
    const tenantDeny = await call(port, '/api/tenants/beta-org-default/members', { token: scene.tokens.bob });
    assert.equal(tenantDeny.status, 403);
    assert.equal(tenantDeny.body.error.code, 'TENANT_FORBIDDEN');
    assert.equal(scene.app.orgStore.reads.tenantDirectory, directoryReadsBefore, 'handler must not run after deny');

    // Bob (org A) requests org B's organization view -> 403, no data touched.
    const orgDeny = await call(port, '/api/organizations/beta-org', { token: scene.tokens.bob });
    assert.equal(orgDeny.status, 403);
    assert.equal(orgDeny.body.error.code, 'ORGANIZATION_FORBIDDEN');
    assert.equal(scene.app.orgStore.reads.membershipsForOrganization, membershipReadsBefore, 'handler must not run after deny');
    assert.equal(scene.app.orgStore.reads.tenantsForOrganization, 0, 'no tenant listing after deny');
  });
});

test('authorization denial (403) is distinct from a missing resource (404)', async () => {
  const scene = await scenario();
  await withIdentityServer(scene.app, async (port) => {
    // Bob lacks membership in beta-org -> 403 FORBIDDEN.
    const forbidden = await call(port, '/api/tenants/beta-org-default', { token: scene.tokens.bob });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'TENANT_FORBIDDEN');
    // A tenant that does not exist at all -> 404 NOT_FOUND (distinct fact).
    const missing = await call(port, '/api/tenants/ghost-tenant', { token: scene.tokens.bob });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'TENANT_NOT_FOUND');
    const missingOrg = await call(port, '/api/organizations/ghost-org', { token: scene.tokens.bob });
    assert.equal(missingOrg.status, 404);
    assert.equal(missingOrg.body.error.code, 'ORGANIZATION_NOT_FOUND');
  });
});

test('tenant directories are scoped to the tenant: no cross-tenant member data', async () => {
  const scene = await scenario();
  await withIdentityServer(scene.app, async (port) => {
    const result = await call(port, '/api/tenants/alpha-org-default/members', { token: scene.tokens.bob });
    assert.equal(result.status, 200);
    const principalIds = result.body.members.map((member: { principal: { id: string } }) => member.principal.id);
    assert.ok(principalIds.includes(scene.principals.alice.id));
    assert.ok(principalIds.includes(scene.principals.bob.id));
    assert.ok(!principalIds.includes(scene.principals.carol.id), 'org B member must never appear in org A directory');
    const emails = result.body.members.map((member: { principal: { email: string } }) => member.principal.email);
    assert.ok(!emails.includes('carol@b.com'));
  });
});

test('client-supplied tenant claims are never trusted (server-side resolution)', async () => {
  const scene = await scenario();
  await withIdentityServer(scene.app, async (port) => {
    // Bob requests org A's tenant while forging headers/body pointing at org B.
    const forged = await call(port, '/api/tenants/alpha-org-default', {
      token: scene.tokens.bob,
      headers: { 'x-tenant-id': scene.orgB.tenant.id, 'x-organization': 'beta-org' },
    });
    assert.equal(forged.status, 200);
    assert.equal(forged.body.tenant.slug, 'alpha-org-default', 'scope resolves from the route, never the client');
    assert.equal(forged.body.organization.slug, 'alpha-org');

    // A machine service account for org A gets the same server-side treatment.
    const account = await scene.app.organizations.createServiceAccount(scene.principals.alice, 'alpha-org', {
      displayName: 'sync',
      role: 'viewer',
    });
    const machineView = await call(port, '/api/tenants/beta-org-default', {
      token: account.secret,
      headers: { 'x-tenant-id': scene.orgA.tenant.id },
    });
    assert.equal(machineView.status, 403);
    assert.equal(machineView.body.error.code, 'TENANT_FORBIDDEN');
  });
});

test('role insufficiency is a distinct typed denial (403 ROLE_FORBIDDEN)', async () => {
  const scene = await scenario();
  await withIdentityServer(scene.app, async (port) => {
    // Bob is 'member' in org A: reads allowed, administration denied.
    const read = await call(port, '/api/organizations/alpha-org/tenants', { token: scene.tokens.bob });
    assert.equal(read.status, 200);
    const administer = await call(port, '/api/organizations/alpha-org/tenants', {
      method: 'POST',
      token: scene.tokens.bob,
      body: { slug: 'alpha-new', displayName: 'New' },
    });
    assert.equal(administer.status, 403);
    assert.equal(administer.body.error.code, 'ROLE_FORBIDDEN');
  });
});

test('machine service accounts authenticate and receive exactly their granted scope over HTTP', async () => {
  const scene = await scenario();
  await withIdentityServer(scene.app, async (port) => {
    const account = await scene.app.organizations.createServiceAccount(scene.principals.alice, 'alpha-org', {
      displayName: 'sync',
      role: 'viewer',
    });
    // Granted read works.
    const read = await call(port, '/api/tenants/alpha-org-default/members', { token: account.secret });
    assert.equal(read.status, 200);
    // Ungranted administration is denied before data (AC-5 over HTTP).
    const administer = await call(port, '/api/organizations/alpha-org/service-accounts', {
      method: 'POST',
      token: account.secret,
      body: { displayName: 'escalate', role: 'viewer' },
    });
    assert.equal(administer.status, 403);
    assert.equal(administer.body.error.code, 'ROLE_FORBIDDEN');
    // Revocation kills the credential and the membership.
    await scene.app.organizations.revokeServiceAccount(scene.principals.alice, 'alpha-org', account.member.principal.id);
    const dead = await call(port, '/api/tenants/alpha-org-default/members', { token: account.secret });
    assert.equal(dead.status, 401);
    assert.equal(dead.body.error.code, 'UNAUTHENTICATED');
  });
});

test('organization creation over HTTP returns org + tenant + membership and lists server-side', async () => {
  const app = buildIdentityApp();
  await withIdentityServer(app, async (port) => {
    const registered = await call(port, '/api/auth/register', {
      method: 'POST',
      body: { email: 'founder@example.com', password: PASSWORD, displayName: 'Founder' },
    });
    assert.equal(registered.status, 201);
    const login = await call(port, '/api/auth/login', {
      method: 'POST',
      body: { email: 'founder@example.com', password: PASSWORD },
    });
    assert.equal(login.status, 200);
    const token = login.body.token as string;

    const created = await call(port, '/api/organizations', {
      method: 'POST',
      token,
      body: { slug: 'newco', displayName: 'NewCo' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.tenant.slug, 'newco-default');
    assert.equal(created.body.membership.role, 'owner');

    // Duplicate slug over HTTP converges to a typed 409.
    const duplicate = await call(port, '/api/organizations', {
      method: 'POST',
      token,
      body: { slug: 'newco', displayName: 'NewCo Again' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'ORG_SLUG_TAKEN');

    // The organization list is server-resolved from the principal's memberships.
    const mine = await call(port, '/api/organizations', { token });
    assert.equal(mine.status, 200);
    assert.deepEqual(
      mine.body.organizations.map((entry: { organization: { slug: string } }) => entry.organization.slug),
      ['newco'],
    );
  });
});
