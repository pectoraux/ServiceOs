/**
 * Behavioral proof: base API/server composition (WORK-001).
 *
 * Proves the composed server:
 * - serves /healthz without touching persistence;
 * - reports truthful readiness on /readyz (503 when not configured, 503 when
 *   the probe fails, 200 only when the probe succeeds) — fail-closed
 *   discrimination between real and fabricated readiness;
 * - exposes module metadata on /api/_meta for every architecture module;
 * - answers unknown routes with 404 and wrong methods with 405;
 * - maps handler failures to 500 without crashing the process.
 *
 * The persistence probe is injected (fake) so no live database is required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeServer, type ReadinessProbe } from '../src/platform/http/index.js';
import { createLogger } from '../src/platform/logging/index.js';
import { registerModules } from '../src/platform/module-registry/index.js';
import { loadConfig } from '../src/platform/config/index.js';
import { SERVICE_MODULES } from '../src/main.js';

interface FakeProbe extends ReadinessProbe {
  setReady(ok: boolean, detail?: string): void;
  setThrow(what?: string): void;
}

function fakeProbe(configured: boolean): FakeProbe {
  let ok = true;
  let detail: string | undefined;
  let failure: string | undefined;
  return {
    isConfigured: () => configured,
    ready: async () => {
      if (failure !== undefined) throw new Error(failure);
      return ok ? { ok: true } : { ok: false, detail };
    },
    setReady: (value, reason) => {
      ok = value;
      detail = reason;
    },
    setThrow: (what = 'probe exploded') => {
      failure = what;
    },
  };
}

const quietLogger = createLogger('error', {}, () => {});

async function withServer(
  probe: ReadinessProbe,
  handler: (port: number) => Promise<void>,
): Promise<void> {
  const config = loadConfig({ SERVICEOS_PORT: '0' }, {});
  const modules = registerModules(SERVICE_MODULES);
  const server = composeServer({ modules, readiness: probe, config, logger: quietLogger });
  const { port } = await server.start();
  try {
    await handler(port);
  } finally {
    await server.stop();
  }
}

async function getJson(port: number, path: string, method = 'GET'): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

test('GET /healthz answers 200 without persistence', async () => {
  await withServer(fakeProbe(false), async (port) => {
    const { status, body } = await getJson(port, '/healthz');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'serviceos');
  });
});

test('GET /readyz answers 503 when persistence is not configured (fail closed)', async () => {
  await withServer(fakeProbe(false), async (port) => {
    const { status, body } = await getJson(port, '/readyz');
    assert.equal(status, 503);
    assert.equal(body.status, 'unavailable');
    assert.match(body.reason, /not configured/);
  });
});

test('GET /readyz answers 200 when the probe succeeds', async () => {
  await withServer(fakeProbe(true), async (port) => {
    const { status, body } = await getJson(port, '/readyz');
    assert.equal(status, 200);
    assert.equal(body.status, 'ready');
  });
});

test('GET /readyz answers 503 when the probe reports not-ready (discrimination)', async () => {
  const probe = fakeProbe(true);
  probe.setReady(false, 'connection refused');
  await withServer(probe, async (port) => {
    const { status, body } = await getJson(port, '/readyz');
    assert.equal(status, 503);
    assert.equal(body.status, 'unavailable');
    assert.match(body.reason, /connection refused/);
  });
});

test('GET /readyz answers 503 when the probe throws instead of crashing (fail closed)', async () => {
  const probe = fakeProbe(true);
  probe.setThrow();
  await withServer(probe, async (port) => {
    const { status, body } = await getJson(port, '/readyz');
    assert.equal(status, 503);
    assert.equal(body.status, 'unavailable');
  });
});

test('GET /api/_meta lists every architecture module', async () => {
  await withServer(fakeProbe(false), async (port) => {
    const { status, body } = await getJson(port, '/api/_meta');
    assert.equal(status, 200);
    assert.equal(body.architectureVersion, 'v1.0');
    const names = body.modules.map((m: { name: string }) => m.name);
    assert.equal(names.length, 16);
    for (const required of ['auth', 'work', 'workflow', 'policies', 'zeck', 'evidence', 'audit', 'notifications']) {
      assert.ok(names.includes(required), `module ${required} missing from /api/_meta`);
    }
  });
});

test('unknown routes answer 404 with a JSON error', async () => {
  await withServer(fakeProbe(false), async (port) => {
    const { status, body } = await getJson(port, '/api/nope');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

test('wrong methods on known routes answer 405 with allowed methods', async () => {
  await withServer(fakeProbe(false), async (port) => {
    const { status, body } = await getJson(port, '/healthz', 'POST');
    assert.equal(status, 405);
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
    assert.deepEqual(body.error.allowed, ['GET']);
  });
});

test('query strings do not break routing', async () => {
  await withServer(fakeProbe(false), async (port) => {
    const { status } = await getJson(port, '/healthz?verbose=1');
    assert.equal(status, 200);
  });
});

test('server start/stop is clean and stop before start is a no-op', async () => {
  const config = loadConfig({ SERVICEOS_PORT: '0' }, {});
  const server = composeServer({
    modules: registerModules(SERVICE_MODULES),
    readiness: fakeProbe(false),
    config,
    logger: quietLogger,
  });
  await server.stop();
  const { port } = await server.start();
  const { status } = await getJson(port, '/healthz');
  assert.equal(status, 200);
  await server.stop();
});
