/**
 * ServiceOS composition root (WORK-001 foundation, WORK-002 identity wiring).
 *
 * This is the only place outside the module tree that composes business
 * modules. It wires:
 *   configuration -> persistence boundary -> identity/tenancy modules
 *                 -> module registry -> guarded customer routes -> HTTP server
 *
 * Composition facts (WORK-002):
 * - /auth owns credential verification; /organizations consumes its public
 *   interface (`authenticate` + identity operations) — injected here, never
 *   re-implemented there, so the authorization chain stays singular.
 * - Every customer route reaches the server only through the modules' route
 *   descriptors, whose non-public entries require the guard resolved
 *   server-side (fail-closed at composition).
 *
 * The server does NOT auto-initialize durable state: schema migrations are an
 * explicit operator action (`npm run migrate`). PostgreSQL must be configured
 * (fail-closed configuration) for the runtime to start.
 */
import { loadConfig } from './platform/config/index.js';
import { createLogger } from './platform/logging/index.js';
import { createPersistence } from './platform/persistence/index.js';
import { registerModules, type ServiceModule } from './platform/module-registry/index.js';
import { composeServer } from './platform/http/index.js';
import { createAuthModule } from './modules/auth/index.js';
import { createOrganizationsModule } from './modules/organizations/index.js';
import { createWorkModule } from './modules/work/index.js';
import { createPoliciesModule } from './modules/policies/index.js';
import { createWorkflowModule } from './modules/workflow/index.js';
import { createAdapterRegistry, createEffectSink } from './modules/integrations/index.js';
import { createInteractionsModule } from './modules/interactions/index.js';
import { createNotificationsModule } from './modules/notifications/index.js';
import { createVerticalsModule } from './modules/verticals/index.js';
import { createZeckModule } from './modules/zeck/index.js';
import { createServicesModule } from './modules/services/index.js';
import { createBillingModule } from './modules/billing/index.js';
import { createEvidenceModule } from './modules/evidence/index.js';
import { createApprovalsModule } from './modules/approvals/index.js';

import auth from './modules/auth/index.js';
import organizations from './modules/organizations/index.js';
import services from './modules/services/index.js';
import verticals from './modules/verticals/index.js';
import entities from './modules/entities/index.js';
import work from './modules/work/index.js';
import workflow from './modules/workflow/index.js';
import policies from './modules/policies/index.js';
import approvals from './modules/approvals/index.js';
import interactions from './modules/interactions/index.js';
import zeck from './modules/zeck/index.js';
import evidence from './modules/evidence/index.js';
import billing from './modules/billing/index.js';
import audit from './modules/audit/index.js';
import integrations from './modules/integrations/index.js';
import notifications from './modules/notifications/index.js';

/**
 * All business modules, in architecture.md §6 order. The module registry
 * validates uniqueness; the architecture structural check validates that the
 * set matches the frozen architecture.
 */
export const SERVICE_MODULES: readonly ServiceModule[] = [
  auth,
  organizations,
  services,
  verticals,
  entities,
  work,
  workflow,
  policies,
  approvals,
  interactions,
  zeck,
  evidence,
  billing,
  audit,
  integrations,
  notifications,
];

export async function main(): Promise<void> {
  const config = loadConfig(process.env, { requireDatabase: true });
  const logger = createLogger(config.logLevel, { service: 'serviceos' });

  const persistence = createPersistence({ databaseUrl: config.databaseUrl });
  const executor = persistence.transactional();

  // Identity substrate (/auth) and tenancy authority (/organizations). The
  // organizations module receives /auth's public interface — the single
  // credential-verification entry point — so its guard composes one
  // authorization chain: authenticate -> server-side resolve -> roleAllows.
  const authModule = createAuthModule({ executor });
  const organizationsModule = createOrganizationsModule({
    executor,
    authenticator: authModule.authenticate,
    identity: authModule,
  });

  // Service Work authority (/work, WORK-003): consumes the single
  // authorization chain from /organizations' public interface (tenant
  // scope resolved server-side before any work data access). /work exposes
  // the programmatic work/attempt/dependency contract; its HTTP surface is
  // owned by WORK-012.
  const workModule = createWorkModule({ executor, tenancy: organizationsModule });

  // Business-policy authority (/policies, WORK-014): consumes the single
  // authorization chain from /organizations' public interface exactly like
  // /work (authorization stays separate from business policy). The
  // deterministic evaluation hooks (resolvePolicy / evaluatePolicy) are the
  // public policy contract the future workflow authority (WORK-004) and
  // side-effect authorities (WORK-008) consume; /policies owns no HTTP
  // surface (WORK-012 owns the control-plane API).
  const policiesModule = createPoliciesModule({ executor, tenancy: organizationsModule });

  // Business workflow authority (/workflow, WORK-004): the single
  // deterministic Service Work transition authority. It consumes the single
  // authorization chain from /organizations' public interface exactly like
  // /work and /policies, and its transition policy gate consumes /policies'
  // public evaluation contract (never a duplicate policy engine). The
  // transition ledger + SLA hook persistence are owned by the /workflow SQL
  // store; it is the only writer of work_service_works.status. /workflow
  // exposes the programmatic transition contract; its HTTP surface is owned
  // by WORK-012.
  const workflowModule = createWorkflowModule({
    executor,
    tenancy: organizationsModule,
    policies: policiesModule,
  });

  // External-effect boundary (WORK-015): the provider-neutral adapter
  // registry. No real provider adapter ships in this Work Order — the
  // registry composes EMPTY and SEALED, so the dispatch surface stays
  // CLOSED (fail-closed ADAPTER_UNAVAILABLE) until the Work Order that
  // owns provider configuration registers real adapters: "premature
  // external effects" are impossible by construction. The contract
  // conformance of future adapters is pinned by the /integrations test
  // doubles (identity-idempotent dispatch, honest failures).
  const adapterRegistry = createAdapterRegistry();
  adapterRegistry.seal();
  const effectSink = createEffectSink(adapterRegistry);

  // External interaction authority (/interactions, WORK-015 + WORK-006
  // durable event substrate): the ONE
  // durable business side-effect boundary (authorization -> durable
  // intent -> dispatch -> observed result; business outcome authority
  // decides separately). It consumes the single authorization chain and
  // /policies' evaluation contract exactly like /work, /policies and
  // /workflow, and holds the /integrations sink as its only provider
  // surface. No HTTP surface (WORK-012 owns the control-plane API).
  const interactionsModule = createInteractionsModule({
    executor,
    tenancy: organizationsModule,
    policies: policiesModule,
    sink: effectSink,
  });

  // Vertical-package registration authority (/verticals, WORK-009): the
  // tenant-bound, versioned domain catalog. It consumes the single
  // authorization chain from /organizations' public interface exactly like
  // /work, /policies, /workflow and imports no other business authority
  // (checked structurally): packages are declarative data — vertical
  // workflow logic cannot leak into horizontal authorities by construction.
  // No HTTP surface (WORK-012 owns the control-plane API).
  const verticalsModule = createVerticalsModule({ executor, tenancy: organizationsModule });

  // Zeck integration boundary (/zeck, WORK-005): the thin AI execution
  // boundary — ONE provider-neutral port, durable intent/reference
  // linkage, translated callback observations. It consumes the single
  // authorization chain, /work's public read (correlation validation,
  // read-only) and /verticals' frozen capability-requirement contract
  // (never re-implemented). NO gateway is composed in this Work Order:
  // the boundary stays CLOSED and submissions fail closed
  // ZECK_GATEWAY_UNAVAILABLE (truthful unavailability — no fabricated
  // success, no credentials in ServiceOS, no premature external AI
  // requests until the Work Order owning Zeck connection configuration
  // registers a real gateway). A Zeck acceptance or a translated result
  // NEVER completes Service Work (the business authorities decide
  // through their own surfaces). No HTTP surface (WORK-012).
  const zeckModule = createZeckModule({
    executor,
    tenancy: organizationsModule,
    work: workModule,
  });

  // Service-definition authority (/services, WORK-009): the binding layer.
  // It consumes the single authorization chain, /verticals' public package
  // registry (registration pinning + declaration cross-validation, never a
  // second registry) and /workflow's frozen canonical machine (every
  // workflow-definition binding is validated against legal transitions —
  // service data can never weaken the horizontal lifecycle authority).
  // Customer configurations are validated weakening-free before
  // persistence (AC-3). No HTTP surface (WORK-012).
  const servicesModule = createServicesModule({
    executor,
    tenancy: organizationsModule,
    verticals: verticalsModule,
  });

  // Billing & service economics authority (/billing, WORK-011): the
  // customer ledger. It consumes the single authorization chain, the
  // service catalog through /services' public interface (subscription
  // binding + pinned-version pricing validation — never a second
  // definition registry) and /work's public read for metering real work
  // identities. The AI cost authority stays external: cost data arrives
  // ONLY as validated non-authoritative references (margin inputs).
  // No HTTP surface (WORK-012 owns the control-plane API).
  const billingModule = createBillingModule({
    executor,
    tenancy: organizationsModule,
    services: servicesModule,
    work: workModule,
  });

  // Notification authority (/notifications, WORK-015): delivery
  // request/status through its owned interface, consuming the interaction
  // boundary's public contract for the external effects (no second
  // interaction ledger, no provider surface). No HTTP surface (WORK-012).
  const notificationsModule = createNotificationsModule({
    executor,
    tenancy: organizationsModule,
    interactions: interactionsModule,
  });

  // Business evidence & outcome-verification authority (/evidence,
  // WORK-007; architecture-lock #4): the immutable attributable
  // business-evidence ledger + the deterministic outcome-verification
  // decision ledger. It consumes the single authorization chain and
  // /work's public read (attribution validation, read-only — /evidence
  // never mutates work state). Business verification is a ServiceOS
  // business authority concept: no AI evaluator surface, no foreign AI
  // execution state (a foreign execution claim can be cited only as an
  // opaque provenance reference; a successful AI execution NEVER
  // becomes a satisfied business outcome by itself). No HTTP surface
  // (WORK-012 owns the control-plane API).
  const evidenceModule = createEvidenceModule({
    executor,
    tenancy: organizationsModule,
    work: workModule,
  });

  // Business/human approval authority (/approvals, WORK-008;
  // architecture-lock #3: the SOLE ServiceOS authority for
  // business/human approval state): the explicit approval request
  // ledger + the one-terminal-decision immutable decision ledger.
  // It consumes the single authorization chain, /work's public read
  // (request binding validation, read-only — /approvals never mutates
  // work state) and /policies' public evaluation hook (the applicable-
  // policy binding; a deny fails closed and the request is never
  // created — never a duplicate policy engine). Approval is an
  // EXPLICIT HUMAN authority: only authenticated human principals
  // decide (the module rejects machine principals before any durable
  // effect — an AI result is never approval); simultaneous
  // approve/reject converges deterministically to ONE terminal
  // decision. Zeck's own human-escalation primitive is untouched (no
  // /zeck import). No HTTP surface (WORK-012 owns the control-plane
  // API — its approval views consume this public contract).
  const approvalsModule = createApprovalsModule({
    executor,
    tenancy: organizationsModule,
    work: workModule,
    policies: policiesModule,
  });

  const modules = registerModules(SERVICE_MODULES);
  const server = composeServer({
    modules,
    readiness: persistence,
    config,
    logger,
    customerRoutes: [...authModule.routes(), ...organizationsModule.routes()],
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    try {
      await server.stop();
      await persistence.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const { port } = await server.start();
  logger.info('serviceos listening', {
    port,
    nodeEnv: config.nodeEnv,
    modules: modules.names().length,
    customerRoutes: [...authModule.routes(), ...organizationsModule.routes()].length,
    persistenceConfigured: persistence.isConfigured(),
    workAuthority: workModule !== null ? 'composed' : 'missing',
    policyAuthority: policiesModule !== null ? 'composed' : 'missing',
    workflowAuthority: workflowModule !== null ? 'composed' : 'missing',
    interactionsAuthority: interactionsModule !== null ? 'composed' : 'missing',
    eventSubstrate: 'composed (inbox + outbox; delivery closed: no port)',
    notificationsAuthority: notificationsModule !== null ? 'composed' : 'missing',
    verticalsAuthority: verticalsModule !== null ? 'composed' : 'missing',
    servicesAuthority: servicesModule !== null ? 'composed' : 'missing',
    billingAuthority: billingModule !== null ? 'composed' : 'missing',
    zeckBoundary: zeckModule !== null ? 'composed (closed: no gateway)' : 'missing',
    evidenceAuthority: evidenceModule !== null ? 'composed' : 'missing',
    registeredAdapterCapabilities: adapterRegistry.describe().length,
  });
}

// Entry point guard: only start when executed directly.
if (process.argv[1] !== undefined && process.argv[1].endsWith('main.js')) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', msg: 'fatal startup failure', error: (error as Error).message }));
    process.exit(1);
  });
}
