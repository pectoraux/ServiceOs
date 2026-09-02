/**
 * ServiceOS approvals boundary checks (WORK-008 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order
 * scope ("/approvals, approval request/decision records, approval
 * persistence/routes, authorization integration, approval policy
 * hooks"; architecture-lock #3: /approvals is the SOLE ServiceOS
 * authority for business/human approval state):
 *
 * - ONE APPROVAL AUTHORITY (Work Order protected surface "/approvals,
 *   approval persistence/routes, authorization integration"): the
 *   approval-request and approval-decision entry points may be
 *   exported only from /approvals. Any other module exporting one is a
 *   duplicate approval authority (violation
 *   `approvals-authority-duplicate`).
 *
 * - NO AI/AGENT APPROVAL SURFACE (Work Order forbidden surface
 *   "replacing Zeck's optional AI human-escalation execution
 *   primitive", "implicit approval from agent claims"; activation
 *   invariant 5: AI or agent output can never constitute business
 *   approval): the /approvals module may never export an AI/model/
 *   provider/agent/LLM-shaped approver or an auto-approval entry
 *   point (violation `ai-approval-surface`).
 *
 * - /APPROVALS IMPORTS ITS AUTHORITIES, NEVER REDEFINES THEM:
 *   /approvals may import only the identity/tenancy chain (auth,
 *   organizations), the work identities it binds requests to (/work,
 *   read-only — /approvals never mutates work state) and the policy
 *   hook it binds each request to (/policies, through the public
 *   evaluation contract — never a duplicate policy engine). Importing
 *   /zeck would replace Zeck's own human-escalation primitive with a
 *   ServiceOS approval surface driven by the AI boundary (activation
 *   invariant 1); importing /workflow, /evidence, /services,
 *   /verticals, /billing or anything else would either drive work
 *   lifecycle from the approval authority or duplicate a horizontal
 *   authority (violation `approvals-import-direction`). Cross-module
 *   calls use public interfaces only (violation
 *   `approvals-internal-import`).
 *
 * - NO CONSUMER OF THE APPROVAL AUTHORITY YET (frontier-relative): no
 *   module imports /approvals at this frontier (violation
 *   `approvals-importer-frontier`); WORK-010 (execution flow) and
 *   WORK-012 (control plane) extend through their own scopes.
 *
 * - THE DURABLE SURFACE STAYS HUMAN-AUTHORITY-SHAPED (Work Order
 *   structural requirement; activation invariant 5): the `approval_`
 *   tables may never declare typed AI-execution/model/provider/agent
 *   columns or credential columns (violation
 *   `approvals-ai-decider-schema`): an AI result is never a decision,
 *   and no approval surface is ever a credential surface. (Unlike the
 *   immutable /evidence ledgers, `approval_requests.status` is the
 *   module's OWN authority state — the closed pending/approved/
 *   rejected enumeration is pinned by the migration CHECK and the
 *   boundary tests, not denied here.)
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
 * Approval-authority entry points reserved to /approvals: the request
 * and decision surfaces. Another module exporting one duplicates the
 * approval authority (the protected surface of this Work Order).
 */
export const RESERVED_APPROVAL_AUTHORITY_EXPORTS: readonly string[] = [
  'requestApproval',
  'createApprovalRequest',
  'decideApproval',
  'approveRequest',
  'rejectRequest',
  'approve',
  'reject',
  'createApprovalsModule',
];

/**
 * AI/model/provider/agent/LLM-shaped approval entry points that may
 * never be exported from /approvals: business approval is an explicit
 * human authority; AI or agent output can never constitute approval
 * (activation invariant 5 — the forbidden surfaces of this Work
 * Order).
 */
export const RESERVED_AI_APPROVAL_EXPORTS: readonly string[] = [
  'aiApprover',
  'agentApprover',
  'modelApprover',
  'providerApprover',
  'llmApprover',
  'aiApprovalEvaluator',
  'evaluateApprovalWithModel',
  'evaluateApprovalWithAgent',
  'scoreApprovalWithModel',
  'autoApprove',
  'autoApproveRequest',
  'agentApproval',
  'approvalModelRouter',
  'routeApprovalModel',
];

/** The only sibling modules /approvals may import. */
export const APPROVALS_ALLOWED_IMPORTS: readonly string[] = ['auth', 'organizations', 'work', 'policies'];

/** Modules allowed to import /approvals (frontier-relative: none yet). */
export const APPROVALS_IMPORTERS: readonly string[] = [];

/**
 * Columns the `approval_` tables may never declare: a typed
 * AI-execution/model/provider/agent column would make an AI result a
 * decision surface (activation invariant 5: AI or agent output can
 * never constitute business approval); a credential column would make
 * the approval surface a secrets surface (no credentials in
 * ServiceOS-adjacent authority state).
 */
export const APPROVALS_SCHEMA_COLUMN_DENYLIST: readonly string[] = [
  'ai_verdict',
  'ai_decision',
  'ai_approval',
  'agent_verdict',
  'agent_decision',
  'agent_approval',
  'model',
  'provider',
  'model_id',
  'model_name',
  'provider_id',
  'llm',
  'prompt',
  'execution_id',
  'execution_ref',
  'execution_status',
  'execution_state',
  'zeck_execution_id',
  'zeck_application_ref',
  'zeck_status',
  'zeck_state',
  'api_key',
  'secret',
  'token',
  'credential',
  'password',
];

const MODULE_APPROVALS = 'approvals';

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

export interface ApprovalsBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
  /** Directory holding the SQL migrations (default: `<srcRoot>/../../db/migrations`). */
  migrationsDir?: string;
}

/**
 * Scan the module tree and migrations for approvals-boundary
 * violations. Returns an empty list when the boundaries hold.
 */
export function checkApprovalsBoundaries(options: ApprovalsBoundaryCheckOptions): ArchitectureViolation[] {
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
    const isApprovalsModule = moduleName === MODULE_APPROVALS;

    for (const file of walkTsFiles(join(modulesRoot, moduleName))) {
      const source = readFileSync(file, 'utf8');
      const exports = extractExportNames(source);

      for (const name of exports) {
        if (!isApprovalsModule && RESERVED_APPROVAL_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'approvals-authority-duplicate',
              `module /${moduleName} exports "${name}"; /approvals is the sole ServiceOS business/human approval authority (architecture-lock #3; WORK-008 protected surface)`,
              file,
            ),
          );
        }
        if (isApprovalsModule && RESERVED_AI_APPROVAL_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'ai-approval-surface',
              `module /approvals exports "${name}"; business approval is an explicit human authority and AI or agent output can never constitute approval (WORK-008 forbidden surface; activation invariant 5)`,
              file,
            ),
          );
        }
      }

      if (isApprovalsModule) {
        for (const { module: imported, rest } of extractSiblingModuleImports(source)) {
          if (!APPROVALS_ALLOWED_IMPORTS.includes(imported)) {
            violations.push(
              violation(
                'approvals-import-direction',
                `module /approvals imports /${imported}; the approval authority imports only the identity/tenancy chain, the work identities it binds requests to (/work, read-only) and the policy hook it binds each request to (/policies) (${APPROVALS_ALLOWED_IMPORTS.join(', ')}) — approval stays an explicit human authority, never a Zeck-escalation replacement and never a duplicate horizontal authority`,
                file,
              ),
            );
            continue;
          }
          // Cross-module calls use public interfaces only.
          if (imported !== moduleName && rest !== undefined && rest !== '/index.js') {
            violations.push(
              violation(
                'approvals-internal-import',
                `module /approvals imports the internal file "../${imported}${rest}"; cross-module calls use public interfaces only (architecture.md §6)`,
                file,
              ),
            );
          }
        }
      } else {
        // Frontier-relative consumers: who may import /approvals.
        for (const { module: imported } of extractSiblingModuleImports(source)) {
          if (imported === MODULE_APPROVALS && !APPROVALS_IMPORTERS.includes(moduleName)) {
            violations.push(
              violation(
                'approvals-importer-frontier',
                `module /${moduleName} imports /approvals; no module consumes the approval authority at this frontier (WORK-010 and WORK-012 extend through their own scopes)`,
                file,
              ),
            );
          }
        }
      }
    }
  }

  // The durable surface: the `approval_` tables stay human-authority-
  // shaped (the owned migration is admitted by checkWorkBoundaries;
  // the deep shape rules live here).
  const migrationsDir = options.migrationsDir ?? join(options.srcRoot, '..', '..', 'db', 'migrations');
  for (const migrationFile of listSqlFiles(migrationsDir)) {
    const sql = stripSqlComments(readFileSync(migrationFile, 'utf8'));
    const tables = extractCreatedTables(sql);
    for (const table of tables) {
      if (!table.startsWith('approval_')) {
        continue;
      }
      for (const column of extractCreatedColumns(sql, table)) {
        if (APPROVALS_SCHEMA_COLUMN_DENYLIST.includes(column)) {
          violations.push(
            violation(
              'approvals-ai-decider-schema',
              `table "${table}" declares column "${column}"; the /approvals durable surface is the explicit human approval authority — a typed AI-execution/model/provider/agent or credential column would let an AI result or a secret act as a decision surface (WORK-008 structural requirement; activation invariant 5)`,
              migrationFile,
            ),
          );
        }
      }
    }
  }

  return violations;
}
