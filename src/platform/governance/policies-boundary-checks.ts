/**
 * ServiceOS policies-boundary checks (WORK-014 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order scope:
 *
 * - ONE POLICY AUTHORITY (Work Order "exactly one policy authority";
 *   architecture-lock #2): policy-engine entry points may be exported only
 *   from /policies. Any other module exporting one is a duplicate policy
 *   engine (violation `policy-engine-duplicate`) — the forbidden pattern
 *   "workflow/vertical duplicate policy engine" from the authority matrix.
 *
 * - NO AUTHORIZATION ENGINE IN /POLICIES (Work Order forbidden:
 *   "authorization replacement"): /policies consumes the single
 *   authorization chain from /organizations; it never exports
 *   authorization/credential/guard entry points of its own (violations
 *   `authorization-in-policies`, `identity-engine-in-policies`,
 *   `route-guard-in-policies` — the reserved name lists are shared with
 *   the identity-boundary checks).
 *
 * - NO WORKFLOW STATE MACHINE IN /POLICIES (Work Order forbidden:
 *   "workflow state machine"): /policies never exports transition-engine
 *   entry points (violation `workflow-engine-in-policies`; the reserved
 *   list is shared with the work-boundary checks) and never imports
 *   /workflow — the dependency direction is /workflow -> /policies (the
 *   transition authority consumes policy through the public contract,
 *   AC-4), never the reverse.
 *
 * - NO AI/PROVIDER POLICY ENGINE IN /POLICIES (Work Order forbidden:
 *   "model/provider/agent/AI policy engines"): /policies never exports
 *   model/provider/agent-named policy entry points (violation
 *   `ai-policy-engine-in-policies`) and never imports /zeck (violation
 *   `policy-import-direction`) — AI policy/execution remains Zeck-owned.
 *
 * Like the WORK-001/002/003 governance checks, violations carry stable
 * codes so discrimination tests can prove a mutated tree is rejected.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GovernanceError } from './program-state.js';
import { extractExportNames, RESERVED_AUTHORIZATION_EXPORTS, RESERVED_CREDENTIAL_EXPORTS, ROUTE_GUARD_FACTORY_PATTERN } from './identity-boundary-checks.js';
import { RESERVED_TRANSITION_EXPORTS, extractRelativeModuleImports } from './work-boundary-checks.js';
import type { ArchitectureViolation } from './architecture-checks.js';

/**
 * Policy-authority entry points that may never be exported from any module
 * other than /policies. Workflow and side-effect authorities CONSUME
 * policy through the /policies public contract (AC-4); reimplementing any
 * of these entry points elsewhere is a duplicate policy engine.
 */
export const RESERVED_POLICY_AUTHORITY_EXPORTS: readonly string[] = [
  'evaluatePolicy',
  'evaluateBusinessPolicy',
  'resolvePolicy',
  'resolvePolicyVersion',
  'resolveActivePolicy',
  'createPolicyStore',
  'policyEngine',
  'evaluatePolicyContract',
  'evaluatePolicyRules',
  'policyResolutionEngine',
];

/**
 * Model/provider/agent/AI policy-engine entry points that may never be
 * exported from /policies: the policy evaluator is provider-independent
 * deterministic code; AI policy/execution belongs to Zeck.
 */
export const RESERVED_AI_POLICY_EXPORTS: readonly string[] = [
  'aiPolicyEngine',
  'modelPolicyEngine',
  'providerPolicyEngine',
  'agentPolicyEngine',
  'llmPolicyEngine',
  'evaluateWithModel',
  'evaluateWithProvider',
  'policyModelRouter',
  'routePolicyModel',
  'policyProviderAdapter',
];

const MODULE_POLICIES = 'policies';

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

export interface PoliciesBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
}

/**
 * Scan the module tree for policy-authority boundary violations.
 * Returns an empty list when the boundaries hold.
 */
export function checkPoliciesBoundaries(options: PoliciesBoundaryCheckOptions): ArchitectureViolation[] {
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
      const isPoliciesModule = moduleName === MODULE_POLICIES;

      for (const name of exports) {
        if (!isPoliciesModule && RESERVED_POLICY_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'policy-engine-duplicate',
              `module /${moduleName} exports "${name}"; /policies is the sole business-policy authority (architecture-lock #2) and other modules must consume its public contract (AC-4)`,
              file,
            ),
          );
        }
        if (isPoliciesModule && RESERVED_AUTHORIZATION_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'authorization-in-policies',
              `module /policies exports "${name}"; authorization is the /organizations authority and policy never replaces it (Work Order forbidden surface)`,
              file,
            ),
          );
        }
        if (isPoliciesModule && RESERVED_CREDENTIAL_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'identity-engine-in-policies',
              `module /policies exports "${name}"; credential verification is the /auth authority`,
              file,
            ),
          );
        }
        if (isPoliciesModule && ROUTE_GUARD_FACTORY_PATTERN.test(name)) {
          violations.push(
            violation(
              'route-guard-in-policies',
              `module /policies exports "${name}"; the single route-guard factory chain belongs to /organizations`,
              file,
            ),
          );
        }
        if (isPoliciesModule && RESERVED_TRANSITION_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'workflow-engine-in-policies',
              `module /policies exports "${name}"; the Service Work state-transition engine belongs exclusively to /workflow (WORK-004)`,
              file,
            ),
          );
        }
        if (isPoliciesModule && RESERVED_AI_POLICY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'ai-policy-engine-in-policies',
              `module /policies exports "${name}"; the policy evaluator is provider-independent deterministic code and AI policy/execution remains Zeck-owned`,
              file,
            ),
          );
        }
      }

      if (isPoliciesModule) {
        for (const specifier of extractRelativeModuleImports(source)) {
          if (specifier === 'workflow' || specifier === 'zeck') {
            violations.push(
              violation(
                'policy-import-direction',
                `module /policies imports /${specifier}; the dependency direction is ${
                  specifier === 'workflow'
                    ? '/workflow -> /policies (the transition authority consumes policy through the public contract, AC-4)'
                    : '/zeck stays an integration boundary and never feeds policy evaluation (AI policy is Zeck-owned)'
                }, never the reverse`,
                file,
              ),
            );
          }
        }
      }
    }
  }

  return violations;
}
