/**
 * ServiceOS composition root (WORK-001 foundation).
 *
 * This is the only place outside the module tree that composes business
 * modules. It wires:
 *   configuration -> persistence boundary -> module registry -> HTTP server
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
  const modules = registerModules(SERVICE_MODULES);
  const server = composeServer({ modules, readiness: persistence, config, logger });

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
    persistenceConfigured: persistence.isConfigured(),
  });
}

// Entry point guard: only start when executed directly.
if (process.argv[1] !== undefined && process.argv[1].endsWith('main.js')) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', msg: 'fatal startup failure', error: (error as Error).message }));
    process.exit(1);
  });
}
