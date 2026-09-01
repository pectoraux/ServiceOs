/**
 * Behavioral + discrimination proof: customer route guard mechanics
 * (WORK-002, platform HTTP composition).
 *
 * The "customer route guards" protected surface:
 * - defineRoute REQUIRES a guard for every non-public access level
 *   (discrimination: an unguarded customer route is rejected with the stable
 *   `unguarded-route` code at definition AND at composition);
 * - malformed route specs fail closed with stable codes;
 * - duplicate registrations fail closed;
 * - route errors serialize as typed JSON envelopes and never crash the
 *   process or leak stack traces in production mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeServer,
  defineRoute,
  HttpCompositionError,
  RouteHttpError,
  type ReadinessProbe,
  type RouteDescriptor,
} from '../src/platform/http/index.js';
import { createLogger } from '../src/platform/logging/index.js';
import { registerModules } from '../src/platform/module-registry/index.js';
import { loadConfig } from '../src/platform/config/index.js';
import { SERVICE_MODULES } from '../src/main.js';

const quietLogger = createLogger('error', {}, () => {});
const fakeProbe: ReadinessProbe = { isConfigured: () => true, ready: async () => ({ ok: true }) };

const ok = (status = 200, body: unknown = { ok: true }) => ({ status, body });

const guarded = defineRoute({
  access: 'principal',
  method: 'GET',
  path: '/api/guarded/hello',
  guard: async () => ({ userId: 'u1' }),
  handler: async (_req, ctx) => ok(200, { userId: (ctx as { userId: string }).userId }),
});

const paramRoute = defineRoute({
  access: 'principal',
  method: 'GET',
  path: '/api/guarded/items/:itemId',
  guard: async (req) => ({ itemId: req.params['itemId'] }),
  handler: async (req, ctx) => ok(200, { itemId: (ctx as { itemId: string }).itemId, path: req.path }),
});

async function withRoutes(
  routes: readonly RouteDescriptor[],
  handler: (port: number) => Promise<void>,
  nodeEnv: 'development' | 'test' | 'production' = 'test',
): Promise<void> {
  const config = loadConfig({ SERVICEOS_PORT: '0', SERVICEOS_NODE_ENV: nodeEnv }, {});
  const server = composeServer({
    modules: registerModules(SERVICE_MODULES),
    readiness: fakeProbe,
    config,
    logger: quietLogger,
    customerRoutes: routes,
  });
  const { port } = await server.start();
  try {
    await handler(port);
  } finally {
    await server.stop();
  }
}

async function get(port: number, path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body,
  });
  return { status: response.status, text: await response.text() };
}

// ---------------------------------------------------------------------------
// Discrimination: the guard requirement is fail-closed
// ---------------------------------------------------------------------------

test('defineRoute rejects a customer route without a guard (unguarded-route)', () => {
  assert.throws(
    () =>
      // @ts-expect-error deliberate violation: guard omitted on a customer route
      defineRoute({
        access: 'tenant',
        method: 'GET',
        path: '/api/guarded/nope',
        handler: async () => ok(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpCompositionError);
      assert.equal((error as HttpCompositionError).code, 'unguarded-route');
      return true;
    },
  );
});

test('composeServer rejects hand-crafted unguarded descriptors (defense in depth)', () => {
  const config = loadConfig({ SERVICEOS_PORT: '0' }, {});
  const handCrafted = {
    access: 'organization',
    method: 'GET',
    path: '/api/handcrafted',
    guard: null,
    handler: async () => ok(),
  } as unknown as RouteDescriptor;
  assert.throws(
    () =>
      composeServer({
        modules: registerModules(SERVICE_MODULES),
        readiness: fakeProbe,
        config,
        logger: quietLogger,
        customerRoutes: [handCrafted],
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpCompositionError);
      assert.equal((error as HttpCompositionError).code, 'unguarded-route');
      return true;
    },
  );
});

test('defineRoute validates method, access and path with stable codes', () => {
  for (const [spec, code] of [
    [{ access: 'weird', method: 'GET', path: '/x', handler: async () => ok() }, 'invalid-route-access'],
    [{ access: 'public', method: 'FETCH', path: '/x', handler: async () => ok() }, 'invalid-route-method'],
    [{ access: 'public', method: 'GET', path: 'no-slash', handler: async () => ok() }, 'invalid-route-path'],
    [{ access: 'public', method: 'GET', path: '/x', handler: 'not-a-function' }, 'invalid-route-handler'],
  ] as const) {
    assert.throws(
      () => defineRoute(spec as unknown as Parameters<typeof defineRoute>[0]),
      (error: unknown) => {
        assert.ok(error instanceof HttpCompositionError);
        assert.equal((error as HttpCompositionError).code, code);
        return true;
      },
    );
  }
});

test('duplicate route registrations fail closed (duplicate-route)', () => {
  const config = loadConfig({ SERVICEOS_PORT: '0' }, {});
  const a = defineRoute({
    access: 'principal',
    method: 'GET',
    path: '/api/dup/:id',
    guard: async () => ({}),
    handler: async () => ok(),
  });
  const b = defineRoute({
    access: 'principal',
    method: 'GET',
    path: '/api/dup/:otherName',
    guard: async () => ({}),
    handler: async () => ok(),
  });
  assert.throws(
    () =>
      composeServer({
        modules: registerModules(SERVICE_MODULES),
        readiness: fakeProbe,
        config,
        logger: quietLogger,
        customerRoutes: [a, b],
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpCompositionError);
      assert.equal((error as HttpCompositionError).code, 'duplicate-route');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Behavioral: routing, params, bodies, errors
// ---------------------------------------------------------------------------

test('guarded routes run the guard before the handler and pass the context', async () => {
  await withRoutes([guarded], async (port) => {
    const response = await get(port, '/api/guarded/hello');
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { userId: 'u1' });
  });
});

test('path parameters are extracted, decoded, and reported to guards', async () => {
  await withRoutes([paramRoute], async (port) => {
    const response = await get(port, '/api/guarded/items/item-42');
    assert.equal(response.status, 200);
    const body = JSON.parse(response.text) as { itemId: string; path: string };
    assert.equal(body.itemId, 'item-42');
    assert.equal(body.path, '/api/guarded/items/item-42');
  });
});

test('guards can deny with typed HTTP errors before handlers run', async () => {
  const denying = defineRoute({
    access: 'tenant',
    method: 'GET',
    path: '/api/guarded/denied',
    guard: async () => {
      throw new RouteHttpError(403, 'TENANT_FORBIDDEN', 'no membership grants this tenant');
    },
    handler: async () => {
      throw new Error('handler must never run when the guard denies');
    },
  });
  await withRoutes([denying], async (port) => {
    const response = await get(port, '/api/guarded/denied');
    assert.equal(response.status, 403);
    const body = JSON.parse(response.text) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'TENANT_FORBIDDEN');
    assert.equal(body.error.message, 'no membership grants this tenant');
  });
});

test('wrong methods on parameterized paths answer 405 with the allowed methods', async () => {
  await withRoutes([paramRoute], async (port) => {
    const response = await get(port, '/api/guarded/items/item-42', 'POST');
    assert.equal(response.status, 405);
    const body = JSON.parse(response.text) as { error: { code: string; allowed: string[] } };
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
    assert.deepEqual(body.error.allowed, ['GET']);
  });
});

test('unknown paths still answer 404 with a JSON envelope', async () => {
  await withRoutes([guarded], async (port) => {
    const response = await get(port, '/api/guarded/unknown');
    assert.equal(response.status, 404);
    const body = JSON.parse(response.text) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

test('bodies are strictly parsed: invalid JSON and non-object bodies fail closed', async () => {
  const echo = defineRoute({
    access: 'public',
    method: 'POST',
    path: '/api/guarded/echo',
    handler: async (req) => ok(200, { body: await req.readBody() }),
  });
  await withRoutes([echo], async (port) => {
    const invalid = await get(port, '/api/guarded/echo', 'POST', '{not json');
    assert.equal(invalid.status, 400);
    assert.equal((JSON.parse(invalid.text) as { error: { code: string } }).error.code, 'INVALID_BODY');
    const array = await get(port, '/api/guarded/echo', 'POST', '[1,2,3]');
    assert.equal(array.status, 200, 'raw JSON values are transported; object-shape validation is module-level');
    const empty = await get(port, '/api/guarded/echo', 'POST');
    assert.equal(empty.status, 200);
    assert.deepEqual(JSON.parse(empty.text), { body: null });
  });
});

test('oversized bodies are rejected before parsing (413)', async () => {
  const echo = defineRoute({
    access: 'public',
    method: 'POST',
    path: '/api/guarded/echo',
    handler: async (req) => ok(200, { body: await req.readBody() }),
  });
  await withRoutes([echo], async (port) => {
    const huge = 'x'.repeat(300000);
    const response = await get(port, '/api/guarded/echo', 'POST', JSON.stringify({ padding: huge }));
    assert.equal(response.status, 413);
    assert.equal((JSON.parse(response.text) as { error: { code: string } }).error.code, 'BODY_TOO_LARGE');
  });
});

test('handler errors map to 500 without leaking internals in production', async () => {
  const exploding = defineRoute({
    access: 'public',
    method: 'GET',
    path: '/api/guarded/explode',
    handler: async () => {
      throw new Error('secret internal detail');
    },
  });
  await withRoutes([exploding], async (port) => {
    const response = await get(port, '/api/guarded/explode');
    assert.equal(response.status, 500);
    const body = JSON.parse(response.text) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'INTERNAL');
    assert.equal(body.error.message, 'internal error');
    assert.ok(!response.text.includes('secret internal detail'));
  });
});

test('describeRoutes reports truthful access and guard coverage', async () => {
  const config = loadConfig({ SERVICEOS_PORT: '0' }, {});
  const server = composeServer({
    modules: registerModules(SERVICE_MODULES),
    readiness: fakeProbe,
    config,
    logger: quietLogger,
    customerRoutes: [guarded, paramRoute],
  });
  const routes = server.describeRoutes();
  const platformPaths = routes.filter((route) => route.path.startsWith('/healthz') || route.path.startsWith('/readyz') || route.path.startsWith('/api/_meta'));
  assert.equal(platformPaths.length, 3);
  const customer = routes.filter((route) => route.path.startsWith('/api/guarded'));
  assert.equal(customer.length, 2);
  for (const route of customer) {
    assert.equal(route.access, 'principal');
    assert.equal(route.guarded, true);
  }
  await server.stop();
});
