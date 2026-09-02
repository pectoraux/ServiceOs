/**
 * ServiceOS billing boundary checks (WORK-011 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order scope
 * ("/billing, service metering, subscription/work/outcome billing
 * ledger"):
 *
 * - ONE BILLING AUTHORITY (Work Order protected surface "/billing"):
 *   subscription/metering/settlement/ledger entry points may be exported
 *   only from /billing. Any other module exporting one is a duplicate
 *   billing authority (violation `billing-authority-duplicate`).
 *
 * - NO PROVIDER-LEVEL AI USAGE/COST AUTHORITY IN ServiceOS (Work Order
 *   forbidden "provider-level AI usage authority", "replacing Zeck's AI
 *   economic ledger"; structural verification requirement "no
 *   provider-specific AI cost authority"; AC-3): no module anywhere in
 *   the tree may export AI usage/provider cost ledger entry points
 *   (violation `ai-cost-authority-in-serviceos`) and /billing never
 *   imports /zeck (violation `ai-import-in-billing`) — cost data
 *   arrives as NON-AUTHORITATIVE references through the module's
 *   validated input surface, never through the AI authority's code.
 *
 * - BILLING BINDS, NEVER REDEFINES: /billing may import only the
 *   identity/tenancy chain, the service catalog it bills against
 *   (/services) and the work identities it meters (/work) (violation
 *   `billing-import-direction`). Importing /policies, /workflow,
 *   /interactions, /integrations, /entities or anything else would
 *   either duplicate a horizontal authority or leak economics into
 *   redefinition.
 *
 * - FRONTIER-RELATIVE CONSUMERS: only /billing imports /services at this
 *   frontier (the /services importer list lives in
 *   service-vertical-boundary-checks.ts and was extended by this Work
 *   Order); nobody imports /billing yet (WORK-013 and successors extend
 *   through their own scopes; violation `billing-import-direction`).
 *
 * - CROSS-MODULE CALLS USE PUBLIC INTERFACES: sibling imports from
 *   /billing must target a module's `index.js` (violation
 *   `billing-internal-import`).
 *
 * - THE DURABLE SURFACE STAYS COST-REFERENCE-SHAPED: migrations may not
 *   create provider/model/token usage or cost tables (violation
 *   `ai-cost-table-in-migration`), and the billing cost-reference table
 *   may not grow provider/model/token columns (violation
 *   `ai-cost-columns-in-billing`).
 *
 * Like the other governance checks, violations carry stable codes so
 * discrimination tests can prove a mutated tree is rejected.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GovernanceError } from './program-state.js';
import { extractExportNames } from './identity-boundary-checks.js';
import { extractCreatedTables, stripSqlComments, listSqlFiles } from './work-boundary-checks.js';
import type { ArchitectureViolation } from './architecture-checks.js';

/** Billing authority entry points reserved to /billing. */
export const RESERVED_BILLING_AUTHORITY_EXPORTS: readonly string[] = [
  'registerSubscription',
  'registerBillingSubscription',
  'createBillingSubscription',
  'activateSubscription',
  'cancelSubscription',
  'recordUsage',
  'meterWork',
  'meterWorkUsage',
  'meterOutcome',
  'meterOutcomeUsage',
  'recordManualUsage',
  'settleBillingPeriod',
  'settlePeriod',
  'settleBilling',
  'billingLedger',
  'billingRegistry',
  'createBillingStore',
  'computeMarginReport',
  'marginReport',
  'recordCostReference',
];

/**
 * AI usage/provider-cost authority entry points that may NEVER be
 * exported from ANY ServiceOS module: provider-level AI usage/cost is
 * Zeck's authority (architecture.md §11/§17; Work Order forbidden
 * surface). ServiceOS consumes opaque cost REFERENCES only.
 */
export const RESERVED_AI_COST_AUTHORITY_EXPORTS: readonly string[] = [
  'aiUsageLedger',
  'recordAiUsage',
  'aiCostLedger',
  'recordAiCost',
  'aiCostAuthority',
  'providerUsageLedger',
  'recordProviderUsage',
  'providerCostLedger',
  'recordProviderCost',
  'modelCostRates',
  'modelCostTable',
  'recordModelCost',
  'modelRateCard',
  'providerRateCard',
  'tokenUsageLedger',
  'recordTokenUsage',
  'tokenCostLedger',
  'llmUsageLedger',
  'aiUsageAuthority',
];

/** The only sibling modules /billing may import. */
export const BILLING_ALLOWED_IMPORTS: readonly string[] = ['auth', 'organizations', 'services', 'work'];

/** Modules allowed to import /billing (frontier-relative: none yet). */
export const BILLING_IMPORTERS: readonly string[] = [];

/**
 * Table names a ServiceOS migration may never create: provider-level AI
 * usage/cost persistence is the forbidden surface (the AI authority
 * owns its economic ledger; ServiceOS holds only cost REFERENCES).
 */
const AI_COST_TABLE_NAME_PATTERN = /(^|_)(ai|llm|model|provider|token)(_|$).*?(usage|cost|rate|ledger)|^(usage|cost|rate|ledger)(_|$).*?(ai|llm|model|provider|token)(_|$)/i;

/**
 * Columns the billing cost-reference table may never grow: a usage
 * breakdown would turn non-authoritative references into a provider
 * cost ledger (Work Order forbidden surface).
 */
const AI_COST_COLUMN_DENYLIST: readonly string[] = [
  'provider',
  'provider_id',
  'provider_name',
  'model',
  'model_id',
  'model_name',
  'tokens',
  'token_count',
  'prompt',
  'usage',
  'usage_detail',
  'per_model',
  'model_rates',
  'rate_card',
  'requests',
];

const MODULE_BILLING = 'billing';

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

export interface BillingBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
  /** Directory holding the SQL migrations (default: `<srcRoot>/../../db/migrations`). */
  migrationsDir?: string;
}

/**
 * Scan the module tree and migrations for billing boundary violations.
 * Returns an empty list when the boundaries hold.
 */
export function checkBillingBoundaries(options: BillingBoundaryCheckOptions): ArchitectureViolation[] {
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
    const isBillingModule = moduleName === MODULE_BILLING;

    for (const file of walkTsFiles(join(modulesRoot, moduleName))) {
      const source = readFileSync(file, 'utf8');
      const exports = extractExportNames(source);

      for (const name of exports) {
        if (!isBillingModule && RESERVED_BILLING_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'billing-authority-duplicate',
              `module /${moduleName} exports "${name}"; /billing is the sole customer service-economics authority and other modules must consume its public contract`,
              file,
            ),
          );
        }
        // The forbidden provider-level AI usage/cost authority — checked
        // across the WHOLE tree (ServiceOS-wide invariant, not just /billing).
        if (RESERVED_AI_COST_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'ai-cost-authority-in-serviceos',
              `module /${moduleName} exports "${name}"; provider-level AI usage/cost authority belongs to the external AI authority (Zeck) — ServiceOS consumes opaque cost references only (WORK-011 forbidden surface)`,
              file,
            ),
          );
        }
      }

      if (isBillingModule) {
        for (const { module: imported, rest } of extractSiblingModuleImports(source)) {
          if (imported === 'zeck') {
            violations.push(
              violation(
                'ai-import-in-billing',
                `module /billing imports /zeck; the AI cost authority stays external — cost data arrives as validated non-authoritative references, never through the AI authority's code (AC-3)`,
                file,
              ),
            );
            continue;
          }
          if (!BILLING_ALLOWED_IMPORTS.includes(imported)) {
            violations.push(
              violation(
                'billing-import-direction',
                `module /billing imports /${imported}; the billing authority imports only the identity/tenancy chain, the service catalog it bills (/services) and the work identities it meters (/work) (${BILLING_ALLOWED_IMPORTS.join(', ')})`,
                file,
              ),
            );
            continue;
          }
          // Cross-module calls use public interfaces only.
          if (imported !== moduleName && rest !== undefined && rest !== '/index.js') {
            violations.push(
              violation(
                'billing-internal-import',
                `module /billing imports the internal file "../${imported}${rest}"; cross-module calls use public interfaces only (architecture.md §6)`,
                file,
              ),
            );
          }
        }
      } else {
        // Frontier-relative consumers: who may import /billing.
        for (const { module: imported } of extractSiblingModuleImports(source)) {
          if (imported === MODULE_BILLING && !BILLING_IMPORTERS.includes(moduleName)) {
            violations.push(
              violation(
                'billing-import-direction',
                `module /${moduleName} imports /billing; no module consumes the billing authority at this frontier (WORK-013 and successors extend through their own scopes)`,
                file,
              ),
            );
          }
        }
      }
    }
  }

  // The durable surface: migrations may not create provider-level AI
  // usage/cost tables, and the cost-reference table may not grow
  // provider/model/token columns.
  const migrationsDir = options.migrationsDir ?? join(options.srcRoot, '..', '..', 'db', 'migrations');
  for (const migrationFile of listSqlFiles(migrationsDir)) {
    const sql = readFileSync(migrationFile, 'utf8');
    const executable = stripSqlComments(sql);
    for (const table of extractCreatedTables(executable)) {
      if (AI_COST_TABLE_NAME_PATTERN.test(table)) {
        violations.push(
          violation(
            'ai-cost-table-in-migration',
            `migration creates table "${table}"; provider-level AI usage/cost persistence is the forbidden surface (the AI authority owns its economic ledger; ServiceOS holds only non-authoritative cost references)`,
            migrationFile,
          ),
        );
      }
      if (table.startsWith('billing_cost')) {
        for (const column of extractCreatedColumns(executable, table)) {
          if (AI_COST_COLUMN_DENYLIST.includes(column)) {
            violations.push(
              violation(
                'ai-cost-columns-in-billing',
                `table "${table}" declares column "${column}"; the cost-reference surface is an opaque pointer plus reported total — a provider/model/token breakdown would make ServiceOS a provider AI cost authority (WORK-011 forbidden surface)`,
                migrationFile,
              ),
            );
          }
        }
      }
    }
  }

  return violations;
}

/** Extract the column names of one CREATE TABLE statement's columns. */
function extractCreatedColumns(sql: string, table: string): string[] {
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
