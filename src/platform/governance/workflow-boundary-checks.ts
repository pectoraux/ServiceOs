/**
 * ServiceOS workflow-boundary checks (WORK-004 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order scope:
 *
 * - ONE DETERMINISTIC WORKFLOW AUTHORITY (Work Order "exactly one business
 *   workflow authority"; architecture-lock #1): transition-engine entry
 *   points may be exported only from /workflow. Any other module exporting
 *   one is a duplicate transition engine (violation
 *   `workflow-engine-duplicate`) — the machine-enforced form of the
 *   authority matrix's forbidden "direct row update from another module".
 *
 * - THE STATUS COLUMN BELONGS TO /WORKFLOW ONLY (AC-1/AC-3): no module
 *   other than /workflow may UPDATE `work_service_works.status` (violation
 *   `work-status-mutation-outside-workflow`). /work itself is additionally
 *   covered by the WORK-003 checks (`workflow-engine-in-work`). This is the
 *   structural guarantee that Zeck execution status (or anything else) can
 *   never directly mutate Service Work state outside the transition
 *   boundary.
 *
 * - NO ZECK/AI/VERTICAL SURFACE IN /WORKFLOW (Work Order forbidden zones
 *   "Zeck execution lifecycle, AI planning/routing, vertical-specific
 *   semantics"): /workflow never imports /zeck, /verticals, /services or
 *   /entities (violation `workflow-import-direction`) and never exports
 *   model/provider/agent-named entry points (violation
 *   `ai-engine-in-workflow`).
 *
 * - NO POLICY/AUTHORIZATION ENGINE IN /WORKFLOW (authority matrix:
 *   "workflow/vertical duplicate policy engine"; Work Order forbidden zone
 *   "authorization replacement"): /workflow consumes the /policies public
 *   contract for its policy gate and the /organizations authorization chain
 *   for its own surface; it never exports policy-engine, authorization,
 *   credential or route-guard entry points (violations
 *   `policy-engine-in-workflow`, `authorization-in-workflow`,
 *   `identity-engine-in-workflow`, `route-guard-in-workflow`).
 *
 * - CROSS-MODULE CALLS USE PUBLIC INTERFACES (architecture.md §6):
 *   /workflow files may import other modules only through their public
 *   `index.js` surface (violation `workflow-internal-import`).
 *
 * Like the WORK-001/002/003/014 governance checks, violations carry stable
 * codes so discrimination tests can prove a mutated tree is rejected
 * ("bypassing the workflow transition service must fail structural checks").
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GovernanceError } from './program-state.js';
import {
  extractExportNames,
  RESERVED_AUTHORIZATION_EXPORTS,
  RESERVED_CREDENTIAL_EXPORTS,
  ROUTE_GUARD_FACTORY_PATTERN,
} from './identity-boundary-checks.js';
import {
  RESERVED_TRANSITION_EXPORTS,
  extractRelativeModuleImports,
  WORK_STATUS_MUTATION_PATTERN,
} from './work-boundary-checks.js';
import { RESERVED_POLICY_AUTHORITY_EXPORTS } from './policies-boundary-checks.js';
import type { ArchitectureViolation } from './architecture-checks.js';

/**
 * Transition-authority entry points that may never be exported from any
 * module other than /workflow. Extends the WORK-003 reserved list with the
 * exact public names of the WORK-004 authority surface.
 */
export const RESERVED_WORKFLOW_AUTHORITY_EXPORTS: readonly string[] = [
  ...RESERVED_TRANSITION_EXPORTS,
  'listLegalTransitions',
  'isLegalTransition',
  'transitionRuleId',
  'CANONICAL_TRANSITIONS',
  'WORKFLOW_STATES',
  'TERMINAL_STATES',
  'listContinuations',
];

/**
 * Model/provider/agent/AI entry points that may never be exported from
 * /workflow: the transition authority is deterministic, provider-independent
 * code; AI planning/routing remains Zeck-owned (Work Order forbidden zone).
 */
export const RESERVED_AI_WORKFLOW_EXPORTS: readonly string[] = [
  'aiWorkflowEngine',
  'modelWorkflowEngine',
  'providerWorkflowEngine',
  'agentWorkflowEngine',
  'llmWorkflowEngine',
  'aiPlanner',
  'aiRouter',
  'routeModel',
  'planExecution',
];

/**
 * Modules /workflow may never import: Zeck (the AI execution boundary —
 * Zeck results are transition inputs submitted through the public contract,
 * never a direct dependency of the authority), verticals/services/entities
 * (vertical-specific semantics stay external to horizontal authorities).
 */
export const WORKFLOW_FORBIDDEN_IMPORTS: readonly string[] = ['zeck', 'verticals', 'services', 'entities'];

const MODULE_WORKFLOW = 'workflow';
const MODULE_WORK = 'work';

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

/**
 * Extract sibling-module import specifiers from source text, as
 * (moduleName, rest) pairs: `../work/store.js` -> ('work', '/store.js'),
 * `../work/index.js` -> ('work', '/index.js'), `../policies` -> ('policies',
 * undefined). Platform imports (`../../platform/...`) never match — only
 * single-`../` specifiers refer to sibling modules. Self-module relative
 * imports (`./…`) are internal to /workflow and out of scope.
 */
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

export interface WorkflowBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
}

/**
 * Scan the module tree for workflow-authority boundary violations.
 * Returns an empty list when the boundaries hold.
 */
export function checkWorkflowBoundaries(options: WorkflowBoundaryCheckOptions): ArchitectureViolation[] {
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
      const isWorkflowModule = moduleName === MODULE_WORKFLOW;

      for (const name of exports) {
        if (!isWorkflowModule && RESERVED_WORKFLOW_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'workflow-engine-duplicate',
              `module /${moduleName} exports "${name}"; /workflow is the sole deterministic Service Work transition authority (architecture-lock #1) and other modules must consume its public contract`,
              file,
            ),
          );
        }
        if (isWorkflowModule && RESERVED_POLICY_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'policy-engine-in-workflow',
              `module /workflow exports "${name}"; /workflow consumes the /policies public contract for its policy gate and never reimplements policy logic (authority matrix: no duplicate policy engine)`,
              file,
            ),
          );
        }
        if (isWorkflowModule && RESERVED_AUTHORIZATION_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'authorization-in-workflow',
              `module /workflow exports "${name}"; authorization is the /organizations authority and the workflow never replaces it (Work Order forbidden surface)`,
              file,
            ),
          );
        }
        if (isWorkflowModule && RESERVED_CREDENTIAL_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'identity-engine-in-workflow',
              `module /workflow exports "${name}"; credential verification is the /auth authority`,
              file,
            ),
          );
        }
        if (isWorkflowModule && ROUTE_GUARD_FACTORY_PATTERN.test(name)) {
          violations.push(
            violation(
              'route-guard-in-workflow',
              `module /workflow exports "${name}"; the single route-guard factory chain belongs to /organizations`,
              file,
            ),
          );
        }
        if (isWorkflowModule && RESERVED_AI_WORKFLOW_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'ai-engine-in-workflow',
              `module /workflow exports "${name}"; the transition authority is deterministic provider-independent code and AI planning/routing remains Zeck-owned (Work Order forbidden surface)`,
              file,
            ),
          );
        }
      }

      if (isWorkflowModule) {
        // Zeck/vertical dependency discipline: the authority consults
        // neither AI execution state nor vertical semantics.
        for (const specifier of extractRelativeModuleImports(source)) {
          if (WORKFLOW_FORBIDDEN_IMPORTS.includes(specifier)) {
            violations.push(
              violation(
                'workflow-import-direction',
                `module /workflow imports /${specifier}; the transition authority consumes neither Zeck execution state (Zeck results are business inputs submitted through the public contract, AC-3) nor vertical/service semantics (Work Order forbidden surfaces)`,
                file,
              ),
            );
          }
        }
        // Cross-module calls use public interfaces: sibling modules may be
        // imported only through their public `index.js` surface.
        for (const { module: imported, rest } of extractSiblingModuleImports(source)) {
          if (imported !== MODULE_WORKFLOW && rest !== undefined && rest !== '/index.js') {
            violations.push(
              violation(
                'workflow-internal-import',
                `module /workflow imports the internal file "../${imported}${rest}"; cross-module calls use public interfaces only (architecture.md §6)`,
                file,
              ),
            );
          }
        }
      } else if (moduleName !== MODULE_WORK) {
        // The status column belongs to the /workflow authority alone
        // (/work's own status-write prohibition is enforced by the
        // WORK-003 checks with their dedicated violation code).
        if (WORK_STATUS_MUTATION_PATTERN.test(source)) {
          violations.push(
            violation(
              'work-status-mutation-outside-workflow',
              `module /${moduleName} mutates Service Work state (UPDATE work_service_works … status); the status column is written only by the /workflow transition authority (WORK-004)`,
              file,
            ),
          );
        }
      }
    }
  }

  return violations;
}
