/**
 * ServiceOS Zeck boundary checks (WORK-005 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order
 * scope ("/zeck integration module, AIExecutionIntent contract, Zeck
 * execution-reference persistence, Zeck webhook/callback translation,
 * retry/idempotency handling"):
 *
 * - ONE ZECK INTEGRATION BOUNDARY (Work Order protected surface
 *   "/zeck"): the AI-execution-intent submission and callback
 *   translation entry points may be exported only from /zeck. Any
 *   other module exporting one is a duplicate AI-boundary authority
 *   (violation `zeck-authority-duplicate`). The historical
 *   no-shadow-lifecycle export tripwires (RESERVED_ZECK_LIFECYCLE_EXPORTS)
 *   remain in work-boundary-checks.ts and still apply to every module
 *   including /zeck.
 *
 * - /ZECK IMPORTS ITS AUTHORITIES, NEVER REDEFINES THEM: /zeck may
 *   import only the identity/tenancy chain (auth, organizations), the
 *   work identities it correlates to (/work, read-only — /zeck never
 *   mutates work state) and the frozen capability-requirement contract
 *   it consumes (/verticals' public interface; never re-implemented).
 *   Importing /workflow, /policies, /billing, /evidence or anything
 *   else would either drive business transitions from the AI boundary
 *   or duplicate a horizontal authority (violation
 *   `zeck-import-direction`). Cross-module calls use public interfaces
 *   only (violation `zeck-internal-import`).
 *
 * - NO CONSUMER OF THE AI BOUNDARY YET (frontier-relative): no module
 *   imports /zeck at this frontier (violation `zeck-importer-frontier`);
 *   WORK-010 (execution flow) and WORK-012 (control plane) extend
 *   through their own scopes.
 *
 * - NO CREDENTIAL SURFACE (AC-4: "AI provider credentials are absent
 *   from ServiceOS domain modules"): credential-shaped tokens are
 *   rejected in /zeck module sources (violation
 *   `zeck-credential-surface`) and as columns of the `zeck_` durable
 *   surface (violation `zeck-credential-surface`). The provider-neutral
 *   gateway port carries connection identity only; provider
 *   credentials belong to the real gateway implementation outside
 *   ServiceOS domain modules.
 *
 * - THE DURABLE SURFACE STAYS REFERENCE-SHAPED (architecture-lock #19:
 *   no shadow Zeck execution lifecycle): the `zeck_` tables may not
 *   declare execution-lifecycle columns (violation
 *   `zeck-lifecycle-schema-in-serviceos`) — the /zeck schema persists
 *   the business-side linkage and translated observations, never an
 *   execution state machine.
 *
 * Like the other governance checks, violations carry stable codes so
 * discrimination tests can prove a mutated tree is rejected.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GovernanceError } from './program-state.js';
import { extractExportNames } from './identity-boundary-checks.js';
import { extractCreatedColumns, extractCreatedTables, listSqlFiles, stripSqlComments } from './work-boundary-checks.js';
import type { ArchitectureViolation } from './architecture-checks.js';

/**
 * Zeck integration-boundary entry points reserved to /zeck: the one
 * provider-neutral submission port and the callback translation
 * surface. Another module exporting one duplicates the AI execution
 * boundary (the protected surface of this Work Order).
 */
export const RESERVED_ZECK_AUTHORITY_EXPORTS: readonly string[] = [
  'submitExecutionIntent',
  'submitAIExecutionIntent',
  'ingestCallback',
  'ingestZeckCallback',
  'createZeckModule',
  'createZeckGateway',
];

/** The only sibling modules /zeck may import. */
export const ZECK_ALLOWED_IMPORTS: readonly string[] = ['auth', 'organizations', 'work', 'verticals'];

/** Modules allowed to import /zeck (frontier-relative: none yet). */
export const ZECK_IMPORTERS: readonly string[] = [];

/**
 * Execution-lifecycle columns the `zeck_` tables may never declare:
 * a status/state column would make the linkage a shadow copy of
 * Zeck's execution lifecycle (architecture-lock #19).
 */
export const ZECK_LIFECYCLE_COLUMN_DENYLIST: readonly string[] = [
  'status',
  'state',
  'phase',
  'stage',
  'step',
  'current_step',
  'lifecycle',
  'execution_status',
  'execution_state',
];

/**
 * Credential-shaped tokens absent from the /zeck module sources and the
 * `zeck_` durable surface (AC-4). Compound tokens only: prose about
 * credential ABSENCE in comments is legitimate; an apiKey surface is
 * not. Extending the list is an architecture-level decision.
 */
export const ZECK_CREDENTIAL_TOKENS: readonly string[] = [
  'apiKey',
  'api_key',
  'apiToken',
  'api_token',
  'accessToken',
  'access_token',
  'secretKey',
  'secret_key',
  'clientSecret',
  'client_secret',
  'providerKey',
  'provider_key',
  'password',
];

const MODULE_ZECK = 'zeck';

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

function violation(code: string, detail: string, file?: string): ArchitectureViolation {
  return { code, detail, file };
}

/** Extract sibling-module import specifiers: module name + rest pairs. */
function extractSiblingModuleImports(source: string): { module: string; rest: string | undefined }[] {
  const imports: { module: string; rest: string | undefined }[] = [];
  const pattern = /(?:from\s*|import\s*|require\s*\(\s*)['"]\.\.\/([a-z][a-z0-9-]*)(\/[^'"]*)?['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const module = match[1] as string;
    const rest = match[2] as string | undefined;
    if (!imports.some((entry) => entry.module === module && entry.rest === rest)) {
      imports.push({ module, rest });
    }
  }
  return imports;
}

export interface ZeckBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
  /** Directory holding the SQL migrations (default: `<srcRoot>/../../db/migrations`). */
  migrationsDir?: string;
}

/**
 * Scan the module tree and migrations for Zeck integration-boundary
 * violations. Returns an empty list when the boundaries hold.
 */
export function checkZeckBoundaries(options: ZeckBoundaryCheckOptions): ArchitectureViolation[] {
  const modulesRoot = join(options.srcRoot, 'modules');
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
    const isZeckModule = moduleName === MODULE_ZECK;

    for (const file of walkTsFiles(join(modulesRoot, moduleName))) {
      const source = readFileSync(file, 'utf8');
      const exports = extractExportNames(source);

      for (const name of exports) {
        if (!isZeckModule && RESERVED_ZECK_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'zeck-authority-duplicate',
              `module /${moduleName} exports "${name}"; /zeck is the sole AI execution integration boundary and other modules must never submit AI execution intents or translate Zeck callbacks (WORK-005 protected surface)`,
              file,
            ),
          );
        }
      }

      if (isZeckModule) {
        // The credential surface is absent from the /zeck sources (AC-4).
        for (const token of ZECK_CREDENTIAL_TOKENS) {
          if (source.includes(token)) {
            violations.push(
              violation(
                'zeck-credential-surface',
                `module /zeck source contains the credential-shaped token "${token}"; AI provider credentials are absent from ServiceOS domain modules (AC-4) — the provider-neutral gateway port carries connection identity only`,
                file,
              ),
            );
          }
        }
        for (const { module: imported, rest } of extractSiblingModuleImports(source)) {
          if (!ZECK_ALLOWED_IMPORTS.includes(imported)) {
            violations.push(
              violation(
                'zeck-import-direction',
                `module /zeck imports /${imported}; the integration boundary imports only the identity/tenancy chain, the work identities it correlates (/work, read-only) and the frozen capability-requirement contract (/verticals) (${ZECK_ALLOWED_IMPORTS.join(', ')}) — it never drives business transitions and never re-implements an authority`,
                file,
              ),
            );
            continue;
          }
          // Cross-module calls use public interfaces only.
          if (imported !== moduleName && rest !== undefined && rest !== '/index.js') {
            violations.push(
              violation(
                'zeck-internal-import',
                `module /zeck imports the internal file "../${imported}${rest}"; cross-module calls use public interfaces only (architecture.md §6)`,
                file,
              ),
            );
          }
        }
      } else {
        // Frontier-relative consumers: who may import /zeck.
        for (const { module: imported } of extractSiblingModuleImports(source)) {
          if (imported === MODULE_ZECK && !ZECK_IMPORTERS.includes(moduleName)) {
            violations.push(
              violation(
                'zeck-importer-frontier',
                `module /${moduleName} imports /zeck; no module consumes the AI execution boundary at this frontier (WORK-010 and WORK-012 extend through their own scopes)`,
                file,
              ),
            );
          }
        }
      }
    }
  }

  // The durable surface: the `zeck_` tables stay reference-shaped and
  // credential-free (the owned migration is admitted by
  // checkWorkBoundaries; the deep shape rules live here).
  const migrationsDir = options.migrationsDir ?? join(options.srcRoot, '..', '..', 'db', 'migrations');
  for (const migrationFile of listSqlFiles(migrationsDir)) {
    const sql = stripSqlComments(readFileSync(migrationFile, 'utf8'));
    const tables = extractCreatedTables(sql);
    for (const table of tables) {
      if (!table.startsWith('zeck_')) {
        continue;
      }
      for (const column of extractCreatedColumns(sql, table)) {
        if (ZECK_LIFECYCLE_COLUMN_DENYLIST.includes(column)) {
          violations.push(
            violation(
              'zeck-lifecycle-schema-in-serviceos',
              `table "${table}" declares column "${column}"; the /zeck durable surface persists the business-side linkage and translated observations — an execution-lifecycle column would make it a shadow copy of Zeck's execution state machine (architecture-lock #19)`,
              migrationFile,
            ),
          );
        }
        if (ZECK_CREDENTIAL_TOKENS.includes(column)) {
          violations.push(
            violation(
              'zeck-credential-surface',
              `table "${table}" declares column "${column}"; AI provider credentials are absent from the ServiceOS durable surface (AC-4) — provider connections belong to the real gateway outside ServiceOS domain modules`,
              migrationFile,
            ),
          );
        }
      }
    }
  }

  return violations;
}
