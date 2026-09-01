/**
 * ServiceOS identity/tenancy boundary checks (WORK-002 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen authority matrix:
 *
 * - ONE authorization engine: the capability-decision entry points
 *   (`authorize`, permission/capability exports) may exist only inside the
 *   /organizations module. Any other business module exporting one is a
 *   second authorization engine (violation `second-authorization-engine`).
 *
 * - ONE identity engine: credential-verification entry points
 *   (`authenticate`, password/token/credential verification exports) may
 *   exist only inside the /auth module (violation `second-identity-engine`).
 *
 * - ONE route-guard chain: guard factories (`create…Guard` exports) may exist
 *   only inside the /organizations module, so customer routes always resolve
 *   their context through the single authorization chain
 *   (violation `second-route-guard`).
 *
 * "All customer routes require scope" is additionally enforced at compile
 * time (the `defineRoute` overloads require a guard for non-public access)
 * and at composition time (fail-closed descriptor validation with the
 * `unguarded-route` code), and proven behaviorally by route enumeration
 * tests; this scanner keeps the authority tripwires static.
 *
 * Like the WORK-001 architecture checks, violations carry stable codes so
 * discrimination tests can prove a mutated tree is rejected.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GovernanceError } from './program-state.js';
import type { ArchitectureViolation } from './architecture-checks.js';

/** Capability/permission decision entry points reserved to /organizations. */
export const RESERVED_AUTHORIZATION_EXPORTS: readonly string[] = [
  'authorize',
  'authorizeRequest',
  'authorizePrincipal',
  'checkPermission',
  'hasPermission',
  'permissionsFor',
  'capabilitiesFor',
  'isPermitted',
  'requirePermission',
];

/** Credential-verification entry points reserved to /auth. */
export const RESERVED_CREDENTIAL_EXPORTS: readonly string[] = [
  'authenticate',
  'verifyPassword',
  'verifyCredential',
  'verifyToken',
  'verifyApiKey',
  'verifySession',
  'hashPassword',
  'issueCredential',
];

/** Route-guard factory name pattern reserved to /organizations. */
export const ROUTE_GUARD_FACTORY_PATTERN = /^create[A-Z]\w*Guard$/;

const MODULE_OWNER_AUTHORIZATION = 'organizations';
const MODULE_OWNER_IDENTITY = 'auth';
const MODULE_OWNER_GUARDS = 'organizations';

function* walkTsFiles(root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (stats.isFile() && entry.endsWith('.ts')) {
      yield full;
    }
  }
}

const EXPORT_PATTERNS: RegExp[] = [
  /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/g,
  /export\s+(?:const|let|var|class|type|interface|enum|abstract\s+class)\s+([A-Za-z0-9_$]+)/g,
];

/** Extract declared export names from TypeScript source text. */
export function extractExportNames(source: string): string[] {
  const names: string[] = [];
  for (const pattern of EXPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const name = match[1] as string;
      if (!names.includes(name)) names.push(name);
    }
  }
  const reExport = /export\s*{([^}]+)}/g;
  let reMatch: RegExpExecArray | null;
  while ((reMatch = reExport.exec(source)) !== null) {
    for (const clause of (reMatch[1] as string).split(',')) {
      const trimmed = clause.trim();
      if (trimmed === '') continue;
      // "A", "A as B", "type A" — the exported name is the last identifier.
      const identifier = trimmed.split(/\s+as\s+/).pop()?.trim() ?? trimmed;
      const clean = identifier.replace(/^type\s+/, '');
      if (/^[A-Za-z0-9_$]+$/.test(clean) && !names.includes(clean)) names.push(clean);
    }
  }
  return names;
}

/**
 * Scan the business-module tree for second-engine violations.
 * Returns an empty list when the identity/tenancy boundaries hold.
 */
export function checkIdentityTenancyBoundaries(srcRoot: string): ArchitectureViolation[] {
  const modulesRoot = join(srcRoot, 'modules');
  let modules: string[];
  try {
    modules = readdirSync(modulesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    throw new GovernanceError(
      `cannot scan module tree ${modulesRoot}: ${(cause as Error).message}`,
      'module-tree-unreadable',
    );
  }

  const violations: ArchitectureViolation[] = [];

  for (const moduleName of modules) {
    for (const file of walkTsFiles(join(modulesRoot, moduleName))) {
      const source = readFileSync(file, 'utf8');
      const exports = extractExportNames(source);

      for (const name of exports) {
        if (RESERVED_AUTHORIZATION_EXPORTS.includes(name) && moduleName !== MODULE_OWNER_AUTHORIZATION) {
          violations.push({
            code: 'second-authorization-engine',
            file: file,
            detail: `module /${moduleName} exports "${name}"; the authorization decision chain belongs exclusively to /organizations (authority matrix: tenant scope)`,
          });
        }
        if (RESERVED_CREDENTIAL_EXPORTS.includes(name) && moduleName !== MODULE_OWNER_IDENTITY) {
          violations.push({
            code: 'second-identity-engine',
            file: file,
            detail: `module /${moduleName} exports "${name}"; credential verification belongs exclusively to /auth (authority matrix: user identity)`,
          });
        }
        if (ROUTE_GUARD_FACTORY_PATTERN.test(name) && moduleName !== MODULE_OWNER_GUARDS) {
          violations.push({
            code: 'second-route-guard',
            file: file,
            detail: `module /${moduleName} exports guard factory "${name}"; customer route guards belong exclusively to the /organizations authorization chain`,
          });
        }
      }
    }
  }

  return violations;
}
