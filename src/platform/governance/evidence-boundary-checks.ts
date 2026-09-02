/**
 * ServiceOS evidence boundary checks (WORK-007 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order
 * scope ("/evidence, business verification contracts, evidence
 * persistence"; architecture-lock #4: /evidence is the SOLE ServiceOS
 * authority for ServiceOS business evidence and business outcome
 * verification records):
 *
 * - ONE BUSINESS EVIDENCE AUTHORITY (Work Order protected surface
 *   "/evidence, business verification contracts, evidence
 *   persistence"): the evidence-attachment and outcome-verification
 *   entry points may be exported only from /evidence. Any other module
 *   exporting one is a duplicate evidence/verification authority
 *   (violation `evidence-authority-duplicate`).
 *
 * - NO AI EVIDENCE EVALUATOR (Work Order forbidden surface "AI model
 *   evaluator"; architecture.md §12): the /evidence module may never
 *   export a model/provider/agent/LLM-shaped evaluation entry point —
 *   outcome verification is deterministic ServiceOS business
 *   authority; AI execution evaluation belongs to the external AI
 *   authority (violation `ai-evidence-evaluator-surface`).
 *
 * - /EVIDENCE IMPORTS ITS AUTHORITIES, NEVER REDEFINES THEM: /evidence
 *   may import only the identity/tenancy chain (auth, organizations)
 *   and the work identities it attributes evidence to (/work,
 *   read-only — /evidence never mutates work state). Importing /zeck
 *   would collapse business evidence with foreign AI execution
 *   evidence (activation invariant 1); importing /workflow, /policies,
 *   /services, /verticals, /billing or anything else would either
 *   drive lifecycle from the evidence authority or duplicate a
 *   horizontal authority (violation `evidence-import-direction`).
 *   Cross-module calls use public interfaces only (violation
 *   `evidence-internal-import`).
 *
 * - NO CONSUMER OF THE EVIDENCE AUTHORITY YET (frontier-relative): no
 *   module imports /evidence at this frontier (violation
 *   `evidence-importer-frontier`); WORK-010 (execution flow) and
 *   WORK-012 (control plane) extend through their own scopes.
 *
 * - THE DURABLE SURFACE STAYS EVIDENCE-SHAPED (Work Order structural
 *   requirement "no parallel Zeck evidence store for AI execution";
 *   activation invariant 1): the `evidence_` tables are immutable
 *   ledgers — they may not declare lifecycle columns (violation
 *   `evidence-parallel-ai-execution-schema`) nor typed foreign-AI-
 *   execution/model columns (violation
 *   `evidence-parallel-ai-execution-schema`): foreign execution claims
 *   may be cited only as opaque provenance reference strings inside
 *   JSONB, never as a typed AI execution evidence store.
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
 * Evidence-authority entry points reserved to /evidence: the evidence
 * attachment surface and the business outcome verification surface.
 * Another module exporting one duplicates the evidence authority (the
 * protected surface of this Work Order).
 */
export const RESERVED_EVIDENCE_AUTHORITY_EXPORTS: readonly string[] = [
  'attachEvidence',
  'recordBusinessEvidence',
  'recordEvidence',
  'verifyOutcome',
  'verifyBusinessOutcome',
  'createEvidenceModule',
];

/**
 * Model/provider/agent/LLM-shaped evaluation entry points that may
 * never be exported from /evidence: outcome verification is
 * deterministic business authority; AI execution evaluation belongs to
 * the external AI authority (Zeck).
 */
export const RESERVED_AI_EVIDENCE_EXPORTS: readonly string[] = [
  'aiEvidenceEvaluator',
  'modelEvidenceEvaluator',
  'providerEvidenceEvaluator',
  'agentEvidenceEvaluator',
  'llmEvidenceEvaluator',
  'aiOutcomeEvaluator',
  'evaluateEvidenceWithModel',
  'evaluateEvidenceWithProvider',
  'scoreEvidenceWithModel',
  'evidenceModelRouter',
  'routeEvidenceModel',
];

/** The only sibling modules /evidence may import. */
export const EVIDENCE_ALLOWED_IMPORTS: readonly string[] = ['auth', 'organizations', 'work'];

/** Modules allowed to import /evidence (frontier-relative: none yet). */
export const EVIDENCE_IMPORTERS: readonly string[] = [];

/**
 * Columns the `evidence_` tables may never declare: the ledgers are
 * immutable attributable business records — a lifecycle column would
 * make them a state machine; a typed foreign-AI-execution or
 * model/provider column would make them a parallel AI execution
 * evidence store (the structural prohibition of this Work Order).
 */
export const EVIDENCE_SCHEMA_COLUMN_DENYLIST: readonly string[] = [
  'status',
  'state',
  'phase',
  'stage',
  'lifecycle',
  'execution_id',
  'execution_ref',
  'execution_status',
  'execution_state',
  'zeck_execution_id',
  'zeck_application_ref',
  'zeck_status',
  'zeck_state',
  'model',
  'provider',
  'prompt',
];

const MODULE_EVIDENCE = 'evidence';

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

export interface EvidenceBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
  /** Directory holding the SQL migrations (default: `<srcRoot>/../../db/migrations`). */
  migrationsDir?: string;
}

/**
 * Scan the module tree and migrations for evidence-boundary
 * violations. Returns an empty list when the boundaries hold.
 */
export function checkEvidenceBoundaries(options: EvidenceBoundaryCheckOptions): ArchitectureViolation[] {
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
    const isEvidenceModule = moduleName === MODULE_EVIDENCE;

    for (const file of walkTsFiles(join(modulesRoot, moduleName))) {
      const source = readFileSync(file, 'utf8');
      const exports = extractExportNames(source);

      for (const name of exports) {
        if (!isEvidenceModule && RESERVED_EVIDENCE_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'evidence-authority-duplicate',
              `module /${moduleName} exports "${name}"; /evidence is the sole ServiceOS business evidence and outcome-verification authority (architecture-lock #4; WORK-007 protected surface)`,
              file,
            ),
          );
        }
        if (isEvidenceModule && RESERVED_AI_EVIDENCE_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'ai-evidence-evaluator-surface',
              `module /evidence exports "${name}"; outcome verification is deterministic ServiceOS business authority and AI execution evaluation belongs to the external AI authority (WORK-007 forbidden surface: no AI model evaluator)`,
              file,
            ),
          );
        }
      }

      if (isEvidenceModule) {
        for (const { module: imported, rest } of extractSiblingModuleImports(source)) {
          if (!EVIDENCE_ALLOWED_IMPORTS.includes(imported)) {
            violations.push(
              violation(
                'evidence-import-direction',
                `module /evidence imports /${imported}; the evidence authority imports only the identity/tenancy chain and the work identities it attributes evidence to (/work, read-only) (${EVIDENCE_ALLOWED_IMPORTS.join(', ')}) — business evidence stays distinct from foreign AI execution evidence and never re-implements a horizontal authority`,
                file,
              ),
            );
            continue;
          }
          // Cross-module calls use public interfaces only.
          if (imported !== moduleName && rest !== undefined && rest !== '/index.js') {
            violations.push(
              violation(
                'evidence-internal-import',
                `module /evidence imports the internal file "../${imported}${rest}"; cross-module calls use public interfaces only (architecture.md §6)`,
                file,
              ),
            );
          }
        }
      } else {
        // Frontier-relative consumers: who may import /evidence.
        for (const { module: imported } of extractSiblingModuleImports(source)) {
          if (imported === MODULE_EVIDENCE && !EVIDENCE_IMPORTERS.includes(moduleName)) {
            violations.push(
              violation(
                'evidence-importer-frontier',
                `module /${moduleName} imports /evidence; no module consumes the business evidence authority at this frontier (WORK-010 and WORK-012 extend through their own scopes)`,
                file,
              ),
            );
          }
        }
      }
    }
  }

  // The durable surface: the `evidence_` tables stay immutable
  // evidence-shaped ledgers (the owned migration is admitted by
  // checkWorkBoundaries; the deep shape rules live here).
  const migrationsDir = options.migrationsDir ?? join(options.srcRoot, '..', '..', 'db', 'migrations');
  for (const migrationFile of listSqlFiles(migrationsDir)) {
    const sql = stripSqlComments(readFileSync(migrationFile, 'utf8'));
    const tables = extractCreatedTables(sql);
    for (const table of tables) {
      if (!table.startsWith('evidence_')) {
        continue;
      }
      for (const column of extractCreatedColumns(sql, table)) {
        if (EVIDENCE_SCHEMA_COLUMN_DENYLIST.includes(column)) {
          violations.push(
            violation(
              'evidence-parallel-ai-execution-schema',
              `table "${table}" declares column "${column}"; the /evidence durable surface is the immutable attributable business-evidence and decision ledger — a lifecycle or typed foreign-AI-execution/model column would make it a parallel AI execution evidence store or a shadow state machine (WORK-007 structural requirement; activation invariant 1)`,
              migrationFile,
            ),
          );
        }
      }
    }
  }

  return violations;
}
