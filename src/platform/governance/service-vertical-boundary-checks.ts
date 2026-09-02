/**
 * ServiceOS service/vertical boundary checks (WORK-009 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order scope
 * ("/services, /verticals, versioned service definitions and package
 * configuration"):
 *
 * - ONE VERTICAL REGISTRATION AUTHORITY (Work Order scope "vertical
 *   registration"): vertical-package registration entry points may be
 *   exported only from /verticals. Any other module exporting one is a
 *   duplicate vertical registry (violation `vertical-registry-duplicate`).
 *
 * - ONE SERVICE DEFINITION AUTHORITY (architecture.md §6 "/services:
 *   service definitions and service-package lifecycle"): service
 *   registration/lifecycle/configuration entry points may be exported
 *   only from /services (violation `service-authority-duplicate`).
 *
 * - NO AI EXECUTION INFRASTRUCTURE IN THE SERVICE RUNTIME (Work Order
 *   forbidden "AI engine implementation"; structural verification
 *   requirement "vertical package does not import AI provider
 *   infrastructure"; AC-4): /services and /verticals never export
 *   model/provider/agent/prompt/AI-runtime entry points (violation
 *   `ai-runtime-in-service-catalog`) and NEVER import /zeck (violation
 *   `ai-import-in-service-runtime`) — capability REQUIREMENTS are
 *   declarations consumed at execution time by the AI intent boundary;
 *   selection has no surface here.
 *
 * - VERTICALS STAY PURE (Work Order invariant "verticals specialize
 *   domain semantics"): /verticals imports only the identity/tenancy
 *   chain (violation `vertical-import-direction` for anything else) —
 *   the catalog declares domain semantics; binding to horizontal
 *   authorities is /services' job.
 *
 * - SERVICES BIND, NEVER REDEFINE (architecture-lock #31): /services may
 *   import only the identity/tenancy chain, /verticals (the package
 *   registry it binds) and /workflow (the frozen canonical machine it
 *   validates bindings against) — violation
 *   `service-import-direction`. Importing /work, /policies,
 *   /approvals, /interactions, /integrations, /entities or anything
 *   else would either duplicate a horizontal authority or leak binding
 *   responsibilities into redefinition.
 *
 * - FRONTIER-RELATIVE CONSUMERS: only /services imports /verticals
 *   (violation `vertical-import-direction` for other importers);
 *   nobody imports /services yet (WORK-010/012 extend through their own
 *   scopes; violation `service-import-direction`).
 *
 * - CROSS-MODULE CALLS USE PUBLIC INTERFACES: sibling imports from
 *   /services and /verticals must target a module's `index.js` (violation
 *   `service-catalog-internal-import`).
 *
 * Like the other governance checks, violations carry stable codes so
 * discrimination tests can prove a mutated tree is rejected.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GovernanceError } from './program-state.js';
import { extractExportNames } from './identity-boundary-checks.js';
import type { ArchitectureViolation } from './architecture-checks.js';

/** Vertical-package registration entry points reserved to /verticals. */
export const RESERVED_VERTICAL_AUTHORITY_EXPORTS: readonly string[] = [
  'registerVerticalPackage',
  'registerVertical',
  'createVerticalPackage',
  'verticalRegistry',
  'createVerticalStore',
  'verticalPackageRegistry',
  'registerVerticalVersion',
];

/** Service-definition/lifecycle/configuration entry points reserved to /services. */
export const RESERVED_SERVICE_AUTHORITY_EXPORTS: readonly string[] = [
  'registerServiceDefinition',
  'createServiceDefinition',
  'activateServiceDefinition',
  'serviceRegistry',
  'createServiceStore',
  'servicePackageRegistry',
  'servicePackageLifecycle',
  'configureService',
  'applyCustomerConfiguration',
  'registerCustomerConfiguration',
  'resolveServiceDefinition',
  'resolveActiveServiceDefinition',
];

/**
 * AI-infrastructure entry points that may never be exported from
 * /services or /verticals: the service runtime is a declarative catalog
 * and binding layer; AI execution (models, providers, agents, prompts,
 * routing, runtimes) is Zeck's authority (architecture.md §11).
 */
export const RESERVED_AI_SERVICE_RUNTIME_EXPORTS: readonly string[] = [
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
];

/** The only sibling modules /verticals may import (the identity/tenancy chain). */
export const VERTICALS_ALLOWED_IMPORTS: readonly string[] = ['auth', 'organizations'];

/**
 * The only sibling modules /services may import: the identity/tenancy
 * chain, the vertical package registry it binds, and the frozen
 * canonical workflow machine it validates bindings against.
 */
export const SERVICES_ALLOWED_IMPORTS: readonly string[] = ['auth', 'organizations', 'verticals', 'workflow'];

/** Modules allowed to import /verticals (frontier-relative). */
export const VERTICALS_IMPORTERS: readonly string[] = ['services'];

/** Modules allowed to import /services (frontier-relative). */
export const SERVICES_IMPORTERS: readonly string[] = ['billing'];

const MODULE_VERTICLES = 'verticals';
const MODULE_SERVICES = 'services';

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

export interface ServiceVerticalBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
}

/**
 * Scan the module tree for service/vertical boundary violations.
 * Returns an empty list when the boundaries hold.
 */
export function checkServiceVerticalBoundaries(options: ServiceVerticalBoundaryCheckOptions): ArchitectureViolation[] {
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
    const isVerticalsModule = moduleName === MODULE_VERTICLES;
    const isServicesModule = moduleName === MODULE_SERVICES;

    for (const file of walkTsFiles(join(modulesRoot, moduleName))) {
      const source = readFileSync(file, 'utf8');
      const exports = extractExportNames(source);

      for (const name of exports) {
        if (!isVerticalsModule && RESERVED_VERTICAL_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'vertical-registry-duplicate',
              `module /${moduleName} exports "${name}"; /verticals is the sole vertical-package registration authority and other modules must consume its public contract`,
              file,
            ),
          );
        }
        if (!isServicesModule && RESERVED_SERVICE_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'service-authority-duplicate',
              `module /${moduleName} exports "${name}"; /services is the sole service-definition/lifecycle/configuration authority and other modules must consume its public contract`,
              file,
            ),
          );
        }
        if ((isVerticalsModule || isServicesModule) && RESERVED_AI_SERVICE_RUNTIME_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'ai-runtime-in-service-catalog',
              `module /${moduleName} exports "${name}"; the service runtime is a declarative catalog/binding layer and AI execution infrastructure is Zeck's authority (Work Order forbidden surface; AC-4)`,
              file,
            ),
          );
        }
      }

      if (isVerticalsModule || isServicesModule) {
        const allowed = isVerticalsModule ? VERTICALS_ALLOWED_IMPORTS : SERVICES_ALLOWED_IMPORTS;
        for (const { module: imported, rest } of extractSiblingModuleImports(source)) {
          if (imported === 'zeck') {
            violations.push(
              violation(
                'ai-import-in-service-runtime',
                `module /${moduleName} imports /zeck; Zeck capability REQUIREMENTS are declarative (names + bounds) and model/provider selection has no surface in the service runtime (AC-4)`,
                file,
              ),
            );
            continue;
          }
          if (!allowed.includes(imported)) {
            violations.push(
              violation(
                `${isVerticalsModule ? 'vertical' : 'service'}-import-direction`,
                `module /${moduleName} imports /${imported}; ${
                  isVerticalsModule
                    ? `the vertical catalog imports only the identity/tenancy chain (${VERTICALS_ALLOWED_IMPORTS.join(', ')}) — it declares domain semantics and never binds horizontal authorities`
                    : `the service binding layer imports only the identity/tenancy chain, /verticals (the package registry it binds) and /workflow (the frozen machine it validates against) (${SERVICES_ALLOWED_IMPORTS.join(', ')})`
                }`,
                file,
              ),
            );
            continue;
          }
          // Cross-module calls use public interfaces only.
          if (imported !== moduleName && rest !== undefined && rest !== '/index.js') {
            violations.push(
              violation(
                'service-catalog-internal-import',
                `module /${moduleName} imports the internal file "../${imported}${rest}"; cross-module calls use public interfaces only (architecture.md §6)`,
                file,
              ),
            );
          }
        }
      } else {
        // Frontier-relative consumers: who may import /verticals or /services.
        for (const { module: imported } of extractSiblingModuleImports(source)) {
          if (imported === MODULE_VERTICLES && !VERTICALS_IMPORTERS.includes(moduleName)) {
            violations.push(
              violation(
                'vertical-import-direction',
                `module /${moduleName} imports /verticals; only the service binding layer consumes the vertical registry at this frontier (${VERTICALS_IMPORTERS.join(', ')})`,
                file,
              ),
            );
          }
          if (imported === MODULE_SERVICES && !SERVICES_IMPORTERS.includes(moduleName)) {
            violations.push(
              violation(
                'service-import-direction',
                `module /${moduleName} imports /services; only the billing authority consumes the service catalog at this frontier (${SERVICES_IMPORTERS.join(', ')})`,
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
