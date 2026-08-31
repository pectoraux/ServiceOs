/**
 * Dynamic AC-2 proof: the composed module set matches the frozen architecture.
 *
 * The architecture document is parsed (not hardcoded) so this test fails if
 * the module composition and spec/architecture/v1.0/architecture.md §6 drift
 * apart in either direction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { registerModules, defineModule, ModuleRegistryError } from '../src/platform/module-registry/index.js';
import { parseArchitectureModules } from '../src/platform/governance/index.js';
import { SERVICE_MODULES } from '../src/main.js';

const REPO_ROOT = resolve(process.cwd());

test('composed modules match the frozen architecture module table exactly', () => {
  const expected = parseArchitectureModules(
    resolve(REPO_ROOT, 'spec/architecture/v1.0/architecture.md'),
  );
  const registered = registerModules(SERVICE_MODULES);
  assert.deepEqual([...registered.names()].sort(), [...expected].sort());
  assert.equal(expected.length, 16);
});

test('module registration order follows the architecture table', () => {
  const expected = parseArchitectureModules(
    resolve(REPO_ROOT, 'spec/architecture/v1.0/architecture.md'),
  );
  const registered = registerModules(SERVICE_MODULES);
  assert.deepEqual(registered.names(), expected);
});

test('every module manifest carries name/version/description', () => {
  for (const module of SERVICE_MODULES) {
    assert.match(module.manifest.name, /^[a-z][a-z0-9-]*$/);
    assert.match(module.manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(module.manifest.description.trim().length > 0, `${module.manifest.name} needs a description`);
  }
});

test('module manifests are frozen', () => {
  const module = SERVICE_MODULES[0];
  assert.ok(module);
  assert.throws(() => {
    (module.manifest as { name: string }).name = 'tampered';
  });
});

test('defineModule rejects malformed manifests', () => {
  assert.throws(() => defineModule({ name: 'BadName', version: '0.1.0', description: 'x' }), ModuleRegistryError);
  assert.throws(() => defineModule({ name: 'ok', version: '0.1', description: 'x' }), ModuleRegistryError);
  assert.throws(() => defineModule({ name: 'ok', version: '1.0.0', description: '' }), ModuleRegistryError);
});

test('registerModules rejects duplicate module registrations', () => {
  const a = defineModule({ name: 'auth', version: '0.1.0', description: 'synthetic' });
  assert.throws(() => registerModules([a, a]), ModuleRegistryError);
});

test('registerModules rejects non-module values', () => {
  assert.throws(() => registerModules([{} as never]), ModuleRegistryError);
});

test('byName exposes name-addressable module access', () => {
  const registered = registerModules(SERVICE_MODULES);
  const work = registered.byName().get('work');
  assert.ok(work);
  assert.equal(work.manifest.name, 'work');
});
