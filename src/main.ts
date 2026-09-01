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
  });
}

// Entry point guard: only start when executed directly.
if (process.argv[1] !== undefined && process.argv[1].endsWith('main.js')) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', msg: 'fatal startup failure', error: (error as Error).message }));
    process.exit(1);
  });
}
