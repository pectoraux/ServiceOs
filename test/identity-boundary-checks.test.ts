/**
 * Structural + discrimination proof: identity/tenancy boundary checks
 * (WORK-002 governance wiring).
 *
 * Structural: the real module tree has exactly one authorization engine
 * (/organizations), one identity engine (/auth) and one route-guard factory
 * (/organizations).
 *
 * Discrimination / mutation: synthetic module trees that export a reserved
 * decision entry point from the WRONG module are rejected with the matching
 * stable violation code. A vacuously-passing checker would fail these tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  checkIdentityTenancyBoundaries,
  extractExportNames,
} from '../src/platform/governance/index.js';
import { makeTempTree } from './helpers/tree.js';

const REAL_SRC_ROOT = resolve(process.cwd(), 'src');

test('the real module tree has no second-engine violations (structural)', () => {
  const violations = checkIdentityTenancyBoundaries(REAL_SRC_ROOT);
  assert.deepEqual(violations, []);
});

test('the real tree keeps the reserved surfaces in their owning modules (structural)', () => {
  // The scanner must actually have visited the real modules; a trivially
  // empty scan would pass vacuously. The /organizations tree defines the
  // guard factory and the /auth tree the credential helpers.
  const violations = checkIdentityTenancyBoundaries(REAL_SRC_ROOT);
  assert.equal(violations.length, 0);
  // Positive control: the guard factory exists in organizations source.
  const guardSource = readFileSync(join(REAL_SRC_ROOT, 'modules/organizations/guard.ts'), 'utf8');
  assert.ok(/export function createAuthorizationGuard/.test(guardSource));
  const credentialsSource = readFileSync(join(REAL_SRC_ROOT, 'modules/auth/credentials.ts'), 'utf8');
  assert.ok(/export async function verifyPassword/.test(credentialsSource));
});

function runBoundaryChecks(files: Record<string, string>) {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkIdentityTenancyBoundaries(join(root, 'src'));
  } finally {
    cleanup();
  }
}

function expectViolation(files: Record<string, string>, code: string): void {
  const violations = runBoundaryChecks(files);
  const hit = violations.find((violation) => violation.code === code);
  assert.ok(hit, `expected violation code "${code}" but got: ${JSON.stringify(violations)}`);
  assert.ok(hit.file !== undefined && hit.file.includes('modules'), 'violation must point at the offending file');
}

test('a second authorization engine in another module is rejected (discrimination)', () => {
  expectViolation(
    {
      'src/modules/work/index.ts': `export function authorize(principalId: string, action: string): boolean {\n  return principalId !== '' && action === 'read';\n}\n`,
    },
    'second-authorization-engine',
  );
});

test('a permission/capability export in a vertical module is rejected (discrimination)', () => {
  expectViolation(
    {
      'src/modules/services/index.ts': `export const capabilitiesFor = (role: string) => new Set(role);\n`,
    },
    'second-authorization-engine',
  );
});

test('a second identity engine is rejected (discrimination)', () => {
  expectViolation(
    {
      'src/modules/notifications/index.ts': `export async function verifyToken(token: string): Promise<boolean> {\n  return token.length > 3;\n}\n`,
    },
    'second-identity-engine',
  );
});

test('a parallel credential verifier in another module is rejected (discrimination)', () => {
  expectViolation(
    {
      'src/modules/billing/index.ts': `export function authenticate(apiKey: string): string | null {\n  return apiKey === 'magic' ? 'user' : null;\n}\n`,
    },
    'second-identity-engine',
  );
});

test('a second route-guard factory is rejected (discrimination)', () => {
  expectViolation(
    {
      'src/modules/verticals/index.ts': `export function createTenantGuard(): () => void {\n  return () => undefined;\n}\n`,
    },
    'second-route-guard',
  );
});

test('the owning modules may define the reserved entry points (no false positive)', () => {
  const violations = runBoundaryChecks({
    'src/modules/organizations/index.ts': `export function authorize(principalId: string): boolean { return true; }\nexport function createTenantGuard(): () => void { return () => undefined; }\n`,
    'src/modules/auth/index.ts': `export async function authenticate(token: string): Promise<string> { return token; }\nexport async function verifyPassword(pw: string): Promise<boolean> { return true; }\n`,
    'src/modules/work/index.ts': `export function runWork(): void { return; }\n`,
  });
  assert.deepEqual(violations, []);
});

test('module tree absence fails closed instead of passing vacuously', () => {
  const { root, cleanup } = makeTempTree({ 'src/other.txt': 'nothing' });
  try {
    assert.throws(
      () => checkIdentityTenancyBoundaries(join(root, 'src')),
      /cannot scan module tree/,
    );
  } finally {
    cleanup();
  }
});

test('export-name extraction covers functions, consts, classes and re-exports', () => {
  const source = [
    'export function plain() {}',
    'export async function later() {}',
    'export function* gen() {}',
    'export const value = 1;',
    'export class Thing {}',
    'export type Shape = { a: string };',
    'export interface Face {}',
    'export { plain as renamed, value } from "./other.js";',
    'const internal = 2;',
  ].join('\n');
  assert.deepEqual(extractExportNames(source), [
    'plain',
    'later',
    'gen',
    'value',
    'Thing',
    'Shape',
    'Face',
    'renamed',
  ]);
});
