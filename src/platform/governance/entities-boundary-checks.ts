/**
 * ServiceOS entities boundary checks (WORK-010 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order
 * scope ("subcontractor/vendor entities, compliance requirements,
 * document collection workflow, insurance certificate validation,
 * license validation, automated follow-up, exception escalation,
 * compliance package output, Zeck-backed document reasoning only
 * through WORK-005"):
 *
 * - ONE ENTITY-INSTANCE AUTHORITY (Work Order protected surface
 *   "compliance entities/work types"): the entity-instance entry
 *   points may be exported only from /entities. Any other module
 *   exporting one is a duplicate entity authority (violation
 *   `entities-authority-duplicate`).
 *
 * - NO VERTICAL REPLACEMENT ENGINES (Work Order invariant 1:
 *   "Construction logic consumes horizontal authorities and Zeck
 *   through public contracts; it owns no replacement engines";
 *   forbidden "generic workflow engine replacement"): /entities may
 *   never export transition-engine, policy-engine, evidence-ledger,
 *   interaction-ledger, AI-execution or approval entry points — every
 *   one of those is another authority's reserved surface (violation
 *   `vertical-engine-in-entities`).
 *
 * - NO AI SELECTION SURFACE (Work Order invariant 3: "AI functionality
 *   flows only through Zeck"; forbidden "AI provider/model code"):
 *   /entities may never export model/provider/agent/prompt/AI-runtime
 *   entry points (violation `ai-selection-in-entities`). Zeck is
 *   consumed through /zeck's public intent surface only (the import
 *   itself is authorized — "Zeck-backed document reasoning only
 *   through WORK-005").
 *
 * - /ENTITIES IMPORTS ITS AUTHORITIES, NEVER REDEFINES THEM: /entities
 *   may import exactly the identity/tenancy chain, the vertical
 *   package registry it validates entity declarations against
 *   (/verticals), the Service Work authority whose identities the flow
 *   creates (/work), the ONE transition authority (/workflow), the
 *   evidence/verification authority (/evidence), the durable
 *   interaction authority (/interactions), the Zeck integration
 *   boundary (/zeck) and the human approval authority (/approvals).
 *   Importing /services, /billing, /policies, /integrations,
 *   /notifications or /audit would duplicate or leak a horizontal
 *   authority (violation `entities-import-direction`). Cross-module
 *   calls use public interfaces only (violation
 *   `entities-internal-import`).
 *
 * - THE CONSTRUCTION FLOW IS THE SOLE /ENTITIES CONSUMER SURFACE: no
 *   OTHER module imports /entities at this frontier (violation
 *   `entities-importer-frontier`); WORK-012 (control plane) extends
 *   through its own scope.
 *
 * - THE DURABLE SURFACE STAYS ENTITY-SHAPED: the `entity_` tables are
 *   immutable tenant-bound entity instances — they may never declare
 *   lifecycle columns, work-state columns, policy columns, provider
 *   columns or typed foreign-AI-execution/model columns (violation
 *   `entities-vertical-state-schema`): the construction flow owns NO
 *   durable state; compliance status is derived from the authorities'
 *   ledgers.
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
 * Entity-instance authority entry points reserved to /entities: the
 * entity-instance creation/read surface of the business-entity
 * authority (WORK-010 protected surface "compliance entities").
 */
export const RESERVED_ENTITIES_AUTHORITY_EXPORTS: readonly string[] = [
  'createEntityInstance',
  'registerEntity',
  'registerEntityInstance',
  'createEntityRecord',
  'entityRegistry',
  'createEntityStore',
  'createEntitiesModule',
];

/**
 * Replacement-engine entry points that may never be exported from
 * /entities: every one is a horizontal authority's reserved surface.
 * The construction flow COMSUMES those authorities through their
 * public interfaces; it owns no engine of its own (Work Order
 * invariant 1 + forbidden "generic workflow engine replacement").
 */
export const RESERVED_VERTICAL_ENGINE_EXPORTS: readonly string[] = [
  'submitTransition',
  'applyTransition',
  'createWorkflowEngine',
  'evaluatePolicy',
  'resolvePolicyRules',
  'createPolicyEngine',
  'attachEvidence',
  'verifyOutcome',
  'createEvidenceStore',
  'createInteraction',
  'dispatchInteraction',
  'recordObservedResult',
  'createInteractionLedger',
  'submitExecutionIntent',
  'ingestCallback',
  'createZeckGateway',
  'requestApproval',
  'decideApproval',
  'createApprovalRequest',
];

/**
 * Model/provider/agent/LLM-shaped selection entry points that may
 * never be exported from /entities: AI execution (including model and
 * provider selection) is Zeck's authority; the flow only submits
 * capability REQUIREMENTS through /zeck's public intent surface
 * (invariant 3 + forbidden "AI provider/model code").
 */
export const RESERVED_AI_ENTITIES_EXPORTS: readonly string[] = [
  'modelRegistry',
  'registerModel',
  'selectModel',
  'modelRouter',
  'routeModel',
  'providerRegistry',
  'registerProvider',
  'selectProvider',
  'agentRuntime',
  'createAgent',
  'promptRuntime',
  'compilePrompt',
  'aiExecutionPlan',
  'planAiExecution',
  'aiRuntime',
  'aiContextCompiler',
  'sandboxRuntime',
  'zeckModelSelector',
  'zeckProviderSelector',
  'evaluateWithModel',
  'reasonWithModel',
];

/**
 * The only sibling modules /entities may import: the identity/tenancy
 * chain, the vertical package registry (entity-declaration
 * consultation), the Service Work authority, the ONE transition
 * authority, the evidence/verification authority, the durable
 * interaction authority, the Zeck integration boundary (public intent
 * surface only) and the human approval authority — exactly the
 * authorities the construction compliance flow composes.
 */
export const ENTITIES_ALLOWED_IMPORTS: readonly string[] = [
  'auth',
  'organizations',
  'verticals',
  'work',
  'workflow',
  'evidence',
  'interactions',
  'zeck',
  'approvals',
];

/** Modules allowed to import /entities (frontier-relative: none yet). */
export const ENTITIES_IMPORTERS: readonly string[] = [];

/**
 * Columns the `entity_` tables may never declare: entity instances are
 * immutable tenant-bound records of declared entity types — a
 * lifecycle/state column would make them a state machine; a policy,
 * provider or typed foreign-AI-execution/model column would leak
 * another authority's (or a foreign system's) durable surface into
 * the entity store. The construction flow owns NO durable state.
 */
export const ENTITIES_SCHEMA_COLUMN_DENYLIST: readonly string[] = [
  'status',
  'state',
  'phase',
  'stage',
  'lifecycle',
  'policy_key',
  'policy_decision_id',
  'provider',
  'provider_reference',
  'capability',
  'adapter',
  'api_key',
  'secret',
  'token',
  'credential',
  'execution_id',
  'execution_ref',
  'execution_status',
  'execution_state',
  'zeck_execution_id',
  'zeck_application_ref',
  'zeck_status',
  'zeck_state',
  'model',
  'prompt',
  'agent',
  'verdict',
  'compliant',
  'transitioned_by',
  'decided_by',
];

const MODULE_ENTITIES = 'entities';

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

export interface EntitiesBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
  /** Directory holding the SQL migrations (default: `<srcRoot>/../../db/migrations`). */
  migrationsDir?: string;
}

/**
 * Scan the module tree and migrations for entities-boundary
 * violations. Returns an empty list when the boundaries hold.
 */
export function checkEntitiesBoundaries(options: EntitiesBoundaryCheckOptions): ArchitectureViolation[] {
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
    const isEntitiesModule = moduleName === MODULE_ENTITIES;

    for (const file of walkTsFiles(join(modulesRoot, moduleName))) {
      const source = readFileSync(file, 'utf8');
      const exports = extractExportNames(source);

      for (const name of exports) {
        if (!isEntitiesModule && RESERVED_ENTITIES_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'entities-authority-duplicate',
              `module /${moduleName} exports "${name}"; /entities is the sole ServiceOS entity-instance authority (WORK-010 protected surface "compliance entities")`,
              file,
            ),
          );
        }
        if (isEntitiesModule && RESERVED_VERTICAL_ENGINE_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'vertical-engine-in-entities',
              `module /entities exports "${name}"; the construction flow consumes horizontal authorities through their public interfaces and owns no replacement engine (WORK-010 invariant 1; forbidden "generic workflow engine replacement")`,
              file,
            ),
          );
        }
        if (isEntitiesModule && RESERVED_AI_ENTITIES_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'ai-selection-in-entities',
              `module /entities exports "${name}"; AI execution (including model/provider selection) is Zeck's authority and the flow submits capability requirements through /zeck's public intent surface only (WORK-010 invariant 3; forbidden "AI provider/model code")`,
              file,
            ),
          );
        }
      }

      if (isEntitiesModule) {
        for (const { module: imported, rest } of extractSiblingModuleImports(source)) {
          if (!ENTITIES_ALLOWED_IMPORTS.includes(imported)) {
            violations.push(
              violation(
                'entities-import-direction',
                `module /entities imports /${imported}; the entity authority + construction flow import exactly the authorities they compose (${ENTITIES_ALLOWED_IMPORTS.join(', ')}) — never a duplicate or leaked horizontal authority`,
                file,
              ),
            );
            continue;
          }
          // Cross-module calls use public interfaces only.
          if (imported !== moduleName && rest !== undefined && rest !== '/index.js') {
            violations.push(
              violation(
                'entities-internal-import',
                `module /entities imports the internal file "../${imported}${rest}"; cross-module calls use public interfaces only (architecture.md §6)`,
                file,
              ),
            );
          }
        }
      } else {
        // Frontier-relative consumers: who may import /entities.
        for (const { module: imported } of extractSiblingModuleImports(source)) {
          if (imported === MODULE_ENTITIES && !ENTITIES_IMPORTERS.includes(moduleName)) {
            violations.push(
              violation(
                'entities-importer-frontier',
                `module /${moduleName} imports /entities; no module consumes the entity authority at this frontier (WORK-012 extends through its own scope)`,
                file,
              ),
            );
          }
        }
      }
    }
  }

  // The durable surface: the `entity_` tables stay immutable
  // entity-shaped records (the owned migration is admitted by the
  // ALLOWED_MIGRATION_TABLE_PREFIXES extension; the deep shape rules
  // live here).
  const migrationsDir = options.migrationsDir ?? join(options.srcRoot, '..', '..', 'db', 'migrations');
  for (const migrationFile of listSqlFiles(migrationsDir)) {
    const sql = stripSqlComments(readFileSync(migrationFile, 'utf8'));
    const tables = extractCreatedTables(sql);
    for (const table of tables) {
      if (!table.startsWith('entity_')) {
        continue;
      }
      for (const column of extractCreatedColumns(sql, table)) {
        if (ENTITIES_SCHEMA_COLUMN_DENYLIST.includes(column)) {
          violations.push(
            violation(
              'entities-vertical-state-schema',
              `table "${table}" declares column "${column}"; the /entities durable surface is the immutable tenant-bound entity-instance store — a lifecycle, policy, provider or typed foreign-AI-execution column would make it a vertical state machine or a leaked authority surface (the construction flow owns no durable state; WORK-010 structural requirement)`,
              migrationFile,
            ),
          );
        }
      }
    }
  }

  return violations;
}
