/**
 * ServiceOS work-boundary checks (WORK-003 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order scope:
 *
 * - NO WORKFLOW ENGINE IN /WORK (Work Order "Structural": the business
 *   state-transition engine belongs to /workflow, WORK-004). Violations:
 *     * a /work source file exporting transition-engine entry points
 *     (violation `workflow-engine-in-work`);
 *   * a /work source file mutating ServiceWork state (any UPDATE of
 *     `work_service_works` … `status`) — /work persists the record as
 *     created ('draft') and never transitions it;
 *   * /work importing the /workflow or /zeck module (wrong dependency
 *     direction: those modules consume /work, never the reverse).
 *
 * - NO ZECK STATE MACHINE IN SERVICEOS (architecture-lock #19: ServiceOS
 *   does not persist an authoritative shadow copy of Zeck's execution
 *   lifecycle). Violations:
 *   * any module exporting a Zeck execution lifecycle/state entry point
 *     (violation `zeck-state-machine`);
 *   * any migration creating a shadow Zeck execution store (violation
 *     `zeck-schema-in-serviceos`). Since WORK-005 the /zeck module OWNS a
 *     durable reference surface (`zeck_`-prefixed tables in the
 *     `zeck`-named migration): executable SQL may reference "zeck" ONLY
 *     there — every created table `zeck_`-prefixed. The deep shape rules
 *     (no execution-lifecycle columns, no credential columns on the
 *     `zeck_` tables) are enforced by `checkZeckBoundaries` (WORK-005
 *     governance wiring); this check keeps the boundary-wide tripwire.
 *
 * - WORK/ATTEMPT SEPARATION (AC-2: WorkAttempt is distinct from external
 *   Zeck executions): /work exports and the WORK-003-owned migration
 *   contain no Zeck references at all (violation `zeck-state-in-work`).
 *   The execution-reference linkage belongs to the /zeck integration
 *   boundary (WORK-005).
 *
 * - MIGRATION TABLE-PREFIX DISCIPLINE: migration files create tables only
 *   under module-owned prefixes (auth_, org_, work_ …). Extending the
 *   allowlist is a deliberate, reviewed change belonging to the Work Order
 *   that owns the new module's tables (violation
 *   `unknown-migration-table-prefix`).
 *
 * Like the WORK-001/WORK-002 governance checks, violations carry stable
 * codes so discrimination tests can prove a mutated tree is rejected.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GovernanceError } from './program-state.js';
import { extractExportNames } from './identity-boundary-checks.js';
import type { ArchitectureViolation } from './architecture-checks.js';

/**
 * Transition-engine entry points that may never be exported from /work.
 * The deterministic transition authority belongs to /workflow (WORK-004).
 */
export const RESERVED_TRANSITION_EXPORTS: readonly string[] = [
  'transition',
  'transitionWork',
  'applyTransition',
  'submitTransition',
  'canTransition',
  'legalTransitions',
  'nextStates',
  'transitionRules',
  'evaluateTransition',
  'workflow',
  'workflowEngine',
  'stateMachine',
];

/**
 * Zeck execution lifecycle/state entry points that may never be exported
 * from ANY ServiceOS module: persisting or driving a Zeck execution
 * lifecycle inside ServiceOS is a forbidden shadow state machine
 * (architecture-lock #19; the /zeck module is an integration boundary
 * only).
 */
export const RESERVED_ZECK_LIFECYCLE_EXPORTS: readonly string[] = [
  'zeckExecution',
  'zeckExecutionState',
  'zeckExecutionStatus',
  'zeckLifecycle',
  'executionLifecycle',
  'createZeckExecution',
  'recordZeckResult',
  'updateZeckExecutionStatus',
  'zeckStateMachine',
  'zeckExecutionStateMachine',
];

/**
 * Module-owned table prefixes allowed in migration files. `policy_` was
 * added by WORK-014 and `workflow_` by WORK-004, each owning the new
 * module's tables (the deliberate, reviewed extension point of this
 * allowlist).
 */
export const ALLOWED_MIGRATION_TABLE_PREFIXES: readonly string[] = [
  'auth_',
  'org_',
  'work_',
  'policy_',
  'workflow_',
  'interaction_',
  'notification_',
  // WORK-009 owns the service/vertical runtime tables (migration 0006).
  'verticals_',
  'services_',
  // WORK-011 owns the billing tables (migration 0007).
  'billing_',
  // WORK-005 owns the /zeck reference/observation tables (migration
  // 0008: execution-intent linkage + translated callback ledger — no
  // Zeck execution lifecycle, checked by checkZeckBoundaries).
  'zeck_',
  // WORK-007 owns the /evidence tables (migration 0009: the immutable
  // attributable business-evidence ledger + the immutable outcome-
  // verification decision ledger — no lifecycle, no parallel AI
  // execution evidence store, checked by checkEvidenceBoundaries).
  'evidence_',
  // WORK-008 owns the /approvals tables (migration 0010: the approval
  // request ledger + the one-terminal-decision immutable approval
  // decision ledger — no AI/agent decider surface, no credentials,
  // checked by checkApprovalsBoundaries).
  'approval_',
];

const MODULE_WORK = 'work';

/** Any UPDATE of the works table that writes the status column. Exported
 * for reuse by the workflow boundary checks: the /workflow authority is the
 * only writer of `work_service_works.status` (WORK-004). */
export const WORK_STATUS_MUTATION_PATTERN = /UPDATE\s+work_service_works\b[^;]*?\bstatus\s*=/is;

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

export function listSqlFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function violation(code: string, detail: string, file?: string): ArchitectureViolation {
  return { code, detail, file };
}

/** Extract `CREATE TABLE <name>` targets from migration SQL text. */
export function extractCreatedTables(sql: string): string[] {
  const tables: string[] = [];
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const name = match[1] as string;
    if (!tables.includes(name)) tables.push(name);
  }
  return tables;
}

/** Strip `--` line comments and block comments from SQL text. */
export function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

export interface WorkBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
  /** Migration directory (default: `<repoRoot>/db/migrations`). */
  migrationsDir: string;
}

/**
 * Scan the module tree and migrations for work/Zeck boundary violations.
 * Returns an empty list when the boundaries hold.
 */
export function checkWorkBoundaries(options: WorkBoundaryCheckOptions): ArchitectureViolation[] {
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
    for (const file of walkTsFiles(join(modulesRoot, moduleName))) {
      const source = readFileSync(file, 'utf8');
      const exports = extractExportNames(source);
      const isWorkModule = moduleName === MODULE_WORK;

      for (const name of exports) {
        if (isWorkModule && RESERVED_TRANSITION_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'workflow-engine-in-work',
              `module /work exports "${name}"; the Service Work transition engine belongs exclusively to /workflow (WORK-004)`,
              file,
            ),
          );
        }
        if (RESERVED_ZECK_LIFECYCLE_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'zeck-state-machine',
              `module /${moduleName} exports "${name}"; ServiceOS must not persist or drive a Zeck execution lifecycle (architecture-lock #19)`,
              file,
            ),
          );
        }
        if (isWorkModule && /zeck/i.test(name)) {
          violations.push(
            violation(
              'zeck-state-in-work',
              `module /work exports "${name}"; WorkAttempt identity is distinct from external/Zeck executions and /work holds no Zeck references (AC-2; the linkage belongs to /zeck, WORK-005)`,
              file,
            ),
          );
        }
      }

      if (isWorkModule) {
        if (WORK_STATUS_MUTATION_PATTERN.test(source)) {
          violations.push(
            violation(
              'workflow-engine-in-work',
              'module /work mutates ServiceWork state (UPDATE work_service_works … status); work state transitions belong to /workflow',
              file,
            ),
          );
        }
        for (const specifier of extractRelativeModuleImports(source)) {
          if (specifier === 'workflow' || specifier === 'zeck') {
            violations.push(
              violation(
                'workflow-engine-in-work',
                `module /work imports /${specifier}; the dependency direction is ${specifier === 'workflow' ? '/workflow -> /work (the transition authority consumes work identity)' : '/zeck -> /work (the integration boundary references work identities)'}, never the reverse`,
                file,
              ),
            );
          }
        }
      }
    }
  }

  for (const migrationFile of listSqlFiles(options.migrationsDir)) {
    // Comments legitimately discuss the boundary (e.g. "no Zeck state
    // here"); the schema checks apply to executable SQL only.
    const sql = stripSqlComments(readFileSync(migrationFile, 'utf8'));
    if (/zeck/i.test(sql)) {
      // WORK-005 refinement: executable SQL may reference "zeck" ONLY in
      // the /zeck-owned migration — the file is `zeck`-named AND every
      // created table is `zeck_`-prefixed (the reference/observation
      // surface; the deep shape rules — no execution-lifecycle columns,
      // no credential columns — are enforced by checkZeckBoundaries).
      // Any other zeck reference in a migration is a shadow-lifecycle
      // or boundary leak and fails closed exactly as before.
      const basename = migrationFile.split(/[\\/]/).pop() ?? '';
      const tables = extractCreatedTables(sql);
      const owned =
        basename.includes('zeck') &&
        tables.length > 0 &&
        tables.every((table) => table.startsWith('zeck_'));
      if (!owned) {
        violations.push(
          violation(
            'zeck-schema-in-serviceos',
            'migration references "zeck" outside the /zeck-owned reference migration (a `zeck`-named migration whose created tables are all `zeck_`-prefixed); ServiceOS persists no Zeck execution state (architecture-lock #19; the /zeck boundary persists references, not a lifecycle)',
            migrationFile,
          ),
        );
      }
    }
    for (const table of extractCreatedTables(sql)) {
      if (!ALLOWED_MIGRATION_TABLE_PREFIXES.some((prefix) => table.startsWith(prefix))) {
        violations.push(
          violation(
            'unknown-migration-table-prefix',
            `migration creates table "${table}" outside the module-owned prefixes (${ALLOWED_MIGRATION_TABLE_PREFIXES.join(', ')}); extend the allowlist through the Work Order that owns the new module's tables`,
            migrationFile,
          ),
        );
      }
    }
  }

  return violations;
}

/**
 * Extract the column names of one CREATE TABLE statement's columns.
 * Exported for reuse by the WORK-005 Zeck boundary checks (the shape
 * rules over the `zeck_` reference tables live there).
 */
export function extractCreatedColumns(sql: string, table: string): string[] {
  const pattern = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\n\\)`, 'i');
  const match = pattern.exec(sql);
  if (match === null) {
    return [];
  }
  const body = match[1] as string;
  const columns: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim().replace(/,$/, '');
    if (line.length === 0 || line.startsWith('--')) {
      continue;
    }
    const first = line.split(/\s+/)[0] as string;
    // Skip table-level constraint clauses.
    if (/^(FOREIGN|PRIMARY|UNIQUE|CHECK|CONSTRAINT|EXCLUDE)$/i.test(first)) {
      continue;
    }
    columns.push(first.toLowerCase());
  }
  return columns;
}

/**
 * Extract cross-module relative imports (`../<module>/…`) from source text,
 * returning the imported module name. Used to enforce the /work dependency
 * direction (workflow/zeck consume work; never the reverse).
 */
export function extractRelativeModuleImports(source: string): string[] {
  const modules: string[] = [];
  const pattern = /(?:from\s*|import\s*|require\s*\(\s*)['"](\.\.\/[a-z][a-z0-9-]*)(?:\/[^'"]*)?['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1] as string;
    const moduleName = specifier.replace(/^\.\.\//, '');
    if (!modules.includes(moduleName)) modules.push(moduleName);
  }
  return modules;
}
