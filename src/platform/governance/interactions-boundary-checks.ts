/**
 * ServiceOS external-interaction boundary checks (WORK-015 governance
 * wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order scope:
 *
 * - ONE INTERACTION AUTHORITY (AC-1/AC-3): interaction-ledger entry points
 *   (createInteraction, dispatchInteraction, recoverInteraction,
 *   recordObservedResult, …) may be exported only from /interactions. Any
 *   other module exporting one is a duplicate interaction ledger
 *   (violation `interaction-authority-duplicate`) — the machine-enforced
 *   form of the authority matrix's forbidden "direct provider mutation
 *   from domain module".
 *
 * - ONE ADAPTER/CAPABILITY AUTHORITY (AC-2): the provider-neutral
 *   capability taxonomy and the adapter-selection registry may be exported
 *   only from /integrations (violation `adapter-authority-duplicate`).
 *   Additionally, the adapter surface is contained: no module other than
 *   /interactions may import /integrations at all (violation
 *   `adapter-surface-outside-interactions`) — business modules dispatch
 *   through the interaction boundary, never around it.
 *
 * - ONE NOTIFICATION AUTHORITY: notification request/delivery entry
 *   points may be exported only from /notifications (violation
 *   `notification-authority-duplicate`).
 *
 * - NO PROVIDER SDK IMPORTS ANYWHERE (AC-6): no file under src/modules
 *   may import a provider SDK package (email/SMS/voice/payment/
 *   business-system SDKs; violation `provider-sdk-import`). Direct
 *   provider SDK usage from business modules is the Work Order's first
 *   forbidden surface; the package.json dependency allowlist (WORK-001
 *   architecture checks) already rejects adding the packages themselves.
 *
 * - IMPORT DIRECTION (verification requirement: "no direct side effect
 *   from workflow/vertical modules"; architecture.md §6):
 *   - /integrations imports NO sibling business module at all (violation
 *     `integration-import-direction`): the provider contracts are
 *     business-agnostic by construction.
 *   - /interactions imports only /integrations, /auth, /organizations and
 *     /policies (the consumed public contracts; violation
 *     `interaction-import-direction`): it must never import /work,
 *     /workflow (the business outcome authority decides AFTER observing —
 *     the interaction authority cannot reach into business state), /zeck,
 *     /notifications or any vertical surface.
 *   - /notifications imports only /auth, /organizations and
 *     /interactions (violation `notification-import-direction`): no
 *     /integrations (adapters are selected behind the interaction
 *     boundary), no /workflow//work (no direct side effect from workflow
 *     consumers), no /policies (the policy gate runs inside
 *     /interactions' intent creation).
 *   - The /interactions surface itself is contained: only /notifications
 *     may import it in the current frontier (violation
 *     `interaction-surface-outside-notifications`); future Work Orders
 *     (WORK-006/010/012) extend this allowlist through their own frozen
 *     scopes, exactly like the migration-prefix allowlist.
 *
 * - NO ENGINE DUPLICATION IN THE NEW MODULES: /interactions,
 *   /integrations and /notifications never export authorization,
 *   identity, route-guard, policy-engine, workflow-engine, transition or
 *   Zeck-lifecycle entry points (violations `authorization-in-<m>`,
 *   `identity-engine-in-<m>`, `route-guard-in-<m>`,
 *   `policy-engine-in-<m>`, `workflow-engine-in-<m>`,
 *   `zeck-lifecycle-in-<m>`), and never export AI engine entry points
 *   (violation `ai-engine-in-<m>`): AI execution infrastructure stays
 *   outside ServiceOS entirely (Zeck is the sole AI execution authority).
 *
 * - CROSS-MODULE CALLS USE PUBLIC INTERFACES (architecture.md §6): files
 *   of the three new modules may import sibling modules only through
 *   their public `index.js` surface (violation
 *   `<m>-internal-import`).
 *
 * Like the WORK-001/002/003/014/004 governance checks, violations carry
 * stable codes so discrimination tests prove a mutated tree is rejected
 * ("direct provider SDK import must fail"; "provider call before durable
 * intent fails the structural/dynamic proof").
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
import { extractRelativeModuleImports, RESERVED_TRANSITION_EXPORTS, RESERVED_ZECK_LIFECYCLE_EXPORTS } from './work-boundary-checks.js';
import { RESERVED_POLICY_AUTHORITY_EXPORTS } from './policies-boundary-checks.js';
import type { ArchitectureViolation } from './architecture-checks.js';

/**
 * Interaction-ledger entry points that may never be exported from any
 * module other than /interactions (the external side-effect boundary).
 */
export const RESERVED_INTERACTION_AUTHORITY_EXPORTS: readonly string[] = [
  'createInteraction',
  'dispatchInteraction',
  'recoverInteraction',
  'recordObservedResult',
  'listInteractions',
  'listRecoverableDispatches',
  'getInteraction',
  'interactionLedger',
  'createInteractionStore',
];

/**
 * Adapter/capability authority entry points that may never be exported
 * from any module other than /integrations (provider-neutral contract
 * ownership + adapter selection).
 */
export const RESERVED_ADAPTER_AUTHORITY_EXPORTS: readonly string[] = [
  'createAdapterRegistry',
  'createEffectSink',
  'registerAdapter',
  'resolveAdapter',
  'adapterRegistry',
  'CAPABILITY_CLASSES',
  'isCapabilityClass',
  'validateEffectParams',
  'listCapabilities',
];

/** Notification authority entry points reserved to /notifications. */
export const RESERVED_NOTIFICATION_AUTHORITY_EXPORTS: readonly string[] = [
  'requestNotification',
  'dispatchNotification',
  'retryNotification',
  'listNotifications',
  'getNotification',
  'notificationService',
  'createNotificationStore',
];

/**
 * Model/provider/agent/AI engine entry points that may never be exported
 * from the three WORK-015 modules: AI execution infrastructure remains
 * outside ServiceOS (Zeck is the sole AI execution authority).
 */
export const RESERVED_AI_EXTERNAL_EXPORTS: readonly string[] = [
  'aiEngine',
  'modelEngine',
  'providerEngine',
  'agentEngine',
  'llmEngine',
  'aiPlanner',
  'aiRouter',
  'routeModel',
  'planExecution',
  'compileContext',
];

/**
 * Provider SDK packages whose import from any ServiceOS module is
 * structurally rejected (AC-6): provider-specific SDKs live only inside
 * real provider adapters (registered through /integrations' registry;
 * none ship in this Work Order). AI provider SDKs are additionally
 * covered by the WORK-001 FORBIDDEN_AI_PACKAGES list.
 */
export const PROVIDER_SDK_PACKAGES: readonly string[] = [
  '@sendgrid/mail',
  'sendgrid',
  'twilio',
  'stripe',
  'plaid',
  'vonage',
  'nexmo',
  'messagebird',
  'mailgun',
  'mandrill',
  'postmark',
  '@postmark/client',
  'aws-sdk',
  '@aws-sdk/client-ses',
  '@aws-sdk/client-sns',
  '@aws-sdk/client-pinpoint',
  '@aws-sdk/client-sqs',
  'googleapis',
  'firebase-admin',
  'docusign-esign',
  'dropbox',
  'box-node-sdk',
  'hubspot-api-client',
  'sf-jwt-refresh',
  'jsforce',
  'checkr-node',
  'lob',
  'easy-post',
  '@easypost/api',
];

/** Scoped package prefixes that are provider SDKs (AWS/Google/Azure/Slack…). */
export const PROVIDER_SDK_PACKAGE_PREFIXES: readonly string[] = [
  '@aws-sdk/',
  '@google-cloud/',
  '@azure/',
  '@slack/',
  '@firebase/',
  '@twilio/',
  '@sendgrid/',
];

/** Modules allowed to import /integrations: the interaction authority only. */
export const INTEGRATIONS_IMPORTERS: readonly string[] = ['interactions'];

/** Modules allowed to import /interactions: the notification authority only (frontier-relative; WORK-006/010/012 extend through their own scopes). */
// WORK-010 extends the frontier: /entities (the construction
// compliance flow) creates/dispatches vendor document requests and
// follow-ups through /interactions' public interface.
export const INTERACTIONS_IMPORTERS: readonly string[] = ['notifications', 'entities'];

/** Sibling modules /integrations may import (none: the contracts are business-agnostic). */
export const INTEGRATIONS_ALLOWED_IMPORTS: readonly string[] = [];

/** Sibling modules /interactions may import (consumed public contracts only). */
export const INTERACTIONS_ALLOWED_IMPORTS: readonly string[] = ['integrations', 'auth', 'organizations', 'policies'];

/** Sibling modules /notifications may import (the effect boundary + identity/tenancy). */
export const NOTIFICATIONS_ALLOWED_IMPORTS: readonly string[] = ['auth', 'organizations', 'interactions'];

const MODULE_INTEGRATIONS = 'integrations';
const MODULE_INTERACTIONS = 'interactions';
const MODULE_NOTIFICATIONS = 'notifications';

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
 * `../work/index.js` -> ('work', '/index.js'). Platform imports
 * (`../../platform/...`) never match — only single-`../` specifiers refer
 * to sibling modules.
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

/** Extract bare package import specifiers from source text (deduped). */
function extractPackageImports(source: string): string[] {
  const packages: string[] = [];
  const pattern = /(?:from\s*|import\s*|require\s*\(\s*)['"]([@a-z0-9][^'"\s]*)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1] as string;
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
    if (specifier.startsWith('node:')) continue;
    if (!packages.includes(specifier)) packages.push(specifier);
  }
  return packages;
}

function isProviderSdkImport(specifier: string): string | null {
  if (PROVIDER_SDK_PACKAGES.includes(specifier)) return specifier;
  for (const prefix of PROVIDER_SDK_PACKAGE_PREFIXES) {
    if (specifier.startsWith(prefix)) return specifier;
  }
  // Subpath imports of exact-listed packages (e.g. twilio/lib/...).
  for (const pkg of PROVIDER_SDK_PACKAGES) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) return specifier;
  }
  return null;
}

export interface ExternalInteractionBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
}

/**
 * Scan the module tree for external-interaction boundary violations.
 * Returns an empty list when the boundaries hold.
 */
export function checkExternalInteractionBoundaries(
  options: ExternalInteractionBoundaryCheckOptions,
): ArchitectureViolation[] {
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
      const isIntegrationsModule = moduleName === MODULE_INTEGRATIONS;
      const isInteractionsModule = moduleName === MODULE_INTERACTIONS;
      const isNotificationsModule = moduleName === MODULE_NOTIFICATIONS;
      const isExternalModule = isIntegrationsModule || isInteractionsModule || isNotificationsModule;

      for (const name of exports) {
        if (!isInteractionsModule && RESERVED_INTERACTION_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'interaction-authority-duplicate',
              `module /${moduleName} exports "${name}"; /interactions is the sole external interaction ledger (the business side-effect boundary) and other modules must consume its public contract`,
              file,
            ),
          );
        }
        if (!isIntegrationsModule && RESERVED_ADAPTER_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'adapter-authority-duplicate',
              `module /${moduleName} exports "${name}"; /integrations is the sole provider-neutral capability/adapter authority (AC-2)`,
              file,
            ),
          );
        }
        if (!isNotificationsModule && RESERVED_NOTIFICATION_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'notification-authority-duplicate',
              `module /${moduleName} exports "${name}"; /notifications is the sole notification request/status authority`,
              file,
            ),
          );
        }

        if (isExternalModule) {
          const inModule = isIntegrationsModule ? 'integrations' : isInteractionsModule ? 'interactions' : 'notifications';
          if (RESERVED_AUTHORIZATION_EXPORTS.includes(name)) {
            violations.push(
              violation(
                `authorization-in-${inModule}`,
                `module /${inModule} exports "${name}"; authorization is the /organizations authority and is consumed, never replaced`,
                file,
              ),
            );
          }
          if (RESERVED_CREDENTIAL_EXPORTS.includes(name)) {
            violations.push(
              violation(
                `identity-engine-in-${inModule}`,
                `module /${inModule} exports "${name}"; credential verification is the /auth authority`,
                file,
              ),
            );
          }
          if (ROUTE_GUARD_FACTORY_PATTERN.test(name)) {
            violations.push(
              violation(
                `route-guard-in-${inModule}`,
                `module /${inModule} exports "${name}"; the single route-guard factory chain belongs to /organizations`,
                file,
              ),
            );
          }
          if (RESERVED_POLICY_AUTHORITY_EXPORTS.includes(name)) {
            violations.push(
              violation(
                `policy-engine-in-${inModule}`,
                `module /${inModule} exports "${name}"; the policy gate is /policies' authority, consumed through its public contract`,
                file,
              ),
            );
          }
          if (RESERVED_TRANSITION_EXPORTS.includes(name) || RESERVED_ZECK_LIFECYCLE_EXPORTS.includes(name)) {
            violations.push(
              violation(
                `workflow-engine-in-${inModule}`,
                `module /${inModule} exports "${name}"; Service Work transitions belong to /workflow and Zeck lifecycle state may never be shadowed here (a provider success is never an automatic business completion, AC-4)`,
                file,
              ),
            );
          }
          if (RESERVED_AI_EXTERNAL_EXPORTS.includes(name)) {
            violations.push(
              violation(
                `ai-engine-in-${inModule}`,
                `module /${inModule} exports "${name}"; AI execution infrastructure remains outside ServiceOS (Zeck is the sole AI execution authority; forbidden surface)`,
                file,
              ),
            );
          }
        }
      }

      // Provider SDK imports are rejected from EVERY business module
      // (AC-6) — they belong only inside real provider adapters, and no
      // real provider adapter ships in this Work Order.
      for (const specifier of extractPackageImports(source)) {
        const matched = isProviderSdkImport(specifier);
        if (matched !== null) {
          violations.push(
            violation(
              'provider-sdk-import',
              `module /${moduleName} imports provider SDK "${matched}"; provider SDKs live only inside provider adapters behind the /integrations registry and are structurally forbidden from business modules (AC-6)`,
              file,
            ),
          );
        }
      }

      // Import-direction discipline for the three new modules.
      if (isIntegrationsModule) {
        for (const specifier of extractRelativeModuleImports(source)) {
          if (!INTEGRATIONS_ALLOWED_IMPORTS.includes(specifier)) {
            violations.push(
              violation(
                'integration-import-direction',
                `module /integrations imports /${specifier}; the provider-neutral contracts and registry are business-agnostic and import no sibling module`,
                file,
              ),
            );
          }
        }
        for (const { module: imported, rest } of extractSiblingModuleImports(source)) {
          if (rest !== undefined && rest !== '/index.js') {
            violations.push(
              violation(
                'integrations-internal-import',
                `module /integrations imports the internal file "../${imported}${rest}"; cross-module calls use public interfaces only (architecture.md §6)`,
                file,
              ),
            );
          }
        }
      } else if (isInteractionsModule) {
        for (const specifier of extractRelativeModuleImports(source)) {
          if (!INTERACTIONS_ALLOWED_IMPORTS.includes(specifier)) {
            violations.push(
              violation(
                'interaction-import-direction',
                `module /interactions imports /${specifier}; the interaction authority consumes only the provider-neutral contracts (/integrations), identity/tenancy (/auth, /organizations) and the policy gate (/policies) — it must never reach business state (/work, /workflow), Zeck or verticals`,
                file,
              ),
            );
          }
        }
        for (const { module: imported, rest } of extractSiblingModuleImports(source)) {
          if (imported !== MODULE_INTERACTIONS && rest !== undefined && rest !== '/index.js') {
            violations.push(
              violation(
                'interactions-internal-import',
                `module /interactions imports the internal file "../${imported}${rest}"; cross-module calls use public interfaces only (architecture.md §6)`,
                file,
              ),
            );
          }
        }
      } else if (isNotificationsModule) {
        for (const specifier of extractRelativeModuleImports(source)) {
          if (!NOTIFICATIONS_ALLOWED_IMPORTS.includes(specifier)) {
            violations.push(
              violation(
                'notification-import-direction',
                `module /notifications imports /${specifier}; the notification authority consumes the interaction boundary (/interactions) and identity/tenancy — never the adapter surface (/integrations), business state (/work, /workflow) or the policy engine`,
                file,
              ),
            );
          }
        }
        for (const { module: imported, rest } of extractSiblingModuleImports(source)) {
          if (imported !== MODULE_NOTIFICATIONS && rest !== undefined && rest !== '/index.js') {
            violations.push(
              violation(
                'notifications-internal-import',
                `module /notifications imports the internal file "../${imported}${rest}"; cross-module calls use public interfaces only (architecture.md §6)`,
                file,
              ),
            );
          }
        }
      } else {
        // Adapter-surface containment: only /interactions may import
        // /integrations (the sink). Everything else dispatches through
        // the interaction boundary.
        for (const specifier of extractRelativeModuleImports(source)) {
          if (specifier === MODULE_INTEGRATIONS && !INTEGRATIONS_IMPORTERS.includes(moduleName)) {
            violations.push(
              violation(
                'adapter-surface-outside-interactions',
                `module /${moduleName} imports /integrations; the adapter surface is contained behind the /interactions boundary (business modules dispatch through the interaction ledger, never the registry)`,
                file,
              ),
            );
          }
          if (specifier === MODULE_INTERACTIONS && !INTERACTIONS_IMPORTERS.includes(moduleName)) {
            violations.push(
              violation(
                'interaction-surface-outside-notifications',
                `module /${moduleName} imports /interactions; in the current frontier only /notifications consumes the interaction surface (future Work Orders extend this allowlist through their own frozen scopes)`,
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
