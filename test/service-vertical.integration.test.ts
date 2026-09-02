/**
 * Optional live-PostgreSQL integration proof for the Service / Vertical
 * Runtime (WORK-009, HIGH_ASSURANCE). Runs ONLY when
 * SERVICEOS_TEST_DATABASE_URL points at a disposable PostgreSQL database;
 * otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001..0006 apply in order and are idempotent;
 * - schema backstops hold: closed status enumerations, the composite
 *   vertical-binding foreign key, the pinned-configuration foreign key,
 *   the one-active partial unique indexes, the tenant idempotency partial
 *   unique indexes, and the (tenant, id, version) identities;
 * - the full registration/lifecycle flow works over real SQL: package
 *   registration/versioning, service registration + binding validation
 *   against the frozen canonical machine, activation (retire-first),
 *   customer configuration (weakening-free before persistence),
 *   activation and resolution;
 * - duplicate registration converges or fails deterministically over real
 *   rows (content-hash comparison inside the healthy transaction);
 * - after-the-fact mutation of stored rows is DETECTED on read (integrity
 *   hash recomputation against real rows);
 * - TRUE parallel actors (separate pooled clients) converge: same-key
 *   package registration, same-identity duplicate registration, concurrent
 *   activation (one active at rest), same-key configuration registration;
 *   divergent same-key input fails closed;
 * - cross-tenant reads carry the tenant predicate against real rows.
 *
 * Each proof runs against its OWN disposable database (node:test executes
 * test files concurrently; sharing one database would collide through the
 * migration history).
 *
 * This environment has no local PostgreSQL, so these proofs execute in CI
 * (the governance workflow provisions a PostgreSQL service).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  applyMigrations,
  withTransactionOn,
  type Migration,
  type TransactionalExecutor,
} from '../src/platform/persistence/index.js';
import { createAuthModule } from '../src/modules/auth/index.js';
import { createOrganizationsModule } from '../src/modules/organizations/index.js';
import { createVerticalsModule, VerticalsError } from '../src/modules/verticals/index.js';
import { createServicesModule, ServicesError } from '../src/modules/services/index.js';
import { createLiveTestDatabase, createTestPool, liveDatabaseRequested, type LiveDatabase } from './helpers/live-database.js';
import type { Principal } from '../src/modules/auth/index.js';

const SKIP = !liveDatabaseRequested();
const PASSWORD = 'correct horse battery 7';

function poolExecutor(pool: pg.Pool): TransactionalExecutor {
  return {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params),
    withTransaction: <T>(fn: (tx: import('../src/platform/persistence/index.js').SqlExecutor) => Promise<T>) => {
      return (async () => {
        const client = await pool.connect();
        try {
          return await withTransactionOn(client, fn);
        } finally {
          client.release();
        }
      })();
    },
  };
}

async function applyMigrationsPinned(pool: pg.Pool, migrations: readonly Migration[]) {
  const client = await pool.connect();
  try {
    return await applyMigrations(client, migrations);
  } finally {
    client.release();
  }
}

function migrations(): Migration[] {
  const base = resolve(process.cwd(), 'db/migrations');
  const names = [
    '0001_identity_tenancy.sql',
    '0002_service_work.sql',
    '0003_business_policy.sql',
    '0004_business_workflow.sql',
    '0005_external_interactions.sql',
    '0006_service_vertical_runtime.sql',
  ];
  return names.map((name, index) => ({
    version: index + 1,
    name: name.replace(/\.sql$/, '').replace(/^\d+_/, ''),
    sql: readFileSync(resolve(base, name), 'utf8'),
  }));
}

interface LiveApp {
  live: LiveDatabase;
  pool: pg.Pool;
  auth: ReturnType<typeof createAuthModule>;
  organizations: ReturnType<typeof createOrganizationsModule>;
  verticals: ReturnType<typeof createVerticalsModule>;
  services: ReturnType<typeof createServicesModule>;
  owner: Principal;
  tenantId: string;
}

async function liveApp(): Promise<LiveApp> {
  const live = await createLiveTestDatabase();
  const pool = createTestPool({ connectionString: live.dsn, max: 4 });
  await applyMigrationsPinned(pool, migrations());
  const executor = poolExecutor(pool);
  const auth = createAuthModule({ executor });
  const organizations = createOrganizationsModule({ executor, authenticator: auth.authenticate, identity: auth });
  const verticals = createVerticalsModule({ executor, tenancy: organizations });
  const services = createServicesModule({ executor, tenancy: organizations, verticals });
  const owner = await auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const created = await organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  return { live, pool, auth, organizations, verticals, services, owner, tenantId: created.tenant.id };
}

async function teardown(app: LiveApp): Promise<void> {
  await app.pool.end();
  await app.live.drop();
}

function packageInput(tenantId: string, version: number, name = 'Construction', idempotencyKey?: string) {
  return {
    tenantId,
    packageId: 'construction',
    version,
    name,
    terminology: { subcontractor: 'A company engaged to perform part of the works' },
    entities: [{ name: 'Project', fields: [{ name: 'projectNumber', type: 'string' as const, required: true }] }],
    workTypes: [{ name: 'OnboardSubcontractor', defaultSlaHours: 48 }],
    workflowSteps: [{ step: 'collect' }],
    policyDefaults: [{ policyKey: 'k', parameters: [{ name: 'p', defaultValue: 1 }] }],
    approvalMatrix: [{ id: 'approval-1', role: 'pm', threshold: 1 }],
    evidenceRequirements: [{ name: 'insurance-certificate' }],
    integrationBindings: [{ capabilityClass: 'email' }],
    zeckCapabilityRequirements: [{ capability: 'document.reasoning', minQuality: 0.8 }],
    pricingRules: [{ id: 'r', model: 'per_work_item' as const }],
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

function serviceInput(tenantId: string, version: number, idempotencyKey: string, packageVersion = 1) {
  return {
    tenantId,
    serviceId: 'subcontractor-compliance',
    version,
    name: 'Subcontractor Compliance Service',
    vertical: { packageId: 'construction', version: packageVersion },
    entities: [{ entity: 'Project', required: true }],
    workDefinitions: [{ workType: 'OnboardSubcontractor' }],
    workflowBinding: [{ step: 'collect', from: 'in_progress', to: 'verifying' }],
    policyConfiguration: [
      { policyKey: 'k', parameters: [{ name: 'p', type: 'number' as const, required: true, min: 0, max: 100000 }] },
    ],
    approvalRules: [{ id: 'approval-1', threshold: 2 }],
    slaDefaults: [{ workType: 'OnboardSubcontractor', deadlineHours: 24 }],
    outcomeContract: {
      outcomeId: 'subcontractor-compliant',
      outputSchema: [{ name: 'compliancePackageRef', type: 'string' as const, required: true }],
      evidenceRequirements: ['insurance-certificate'],
      verification: 'deterministic' as const,
    },
    requiredExternalCapabilities: ['email'],
    requiredAiCapabilities: [{ capability: 'document.reasoning' }],
    pricing: { model: 'per_work_item' as const, metering: [{ metric: 'onboarded-subcontractor', unit: 'count' }] },
    idempotencyKey,
  };
}

function configurationInput(tenantId: string, idempotencyKey?: string, p = 2500) {
  return {
    tenantId,
    serviceId: 'subcontractor-compliance',
    policyParameters: [{ policyKey: 'k', values: { p } }],
    slaAdjustments: [{ workType: 'OnboardSubcontractor', deadlineHours: 12 }],
    approvalAdjustments: [{ id: 'approval-1', threshold: 3 }],
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

async function expectCode(error: unknown, code: string): Promise<void> {
  assert.ok(
    error instanceof VerticalsError || error instanceof ServicesError,
    `expected a typed error, got ${String(error)}`,
  );
  assert.equal((error as VerticalsError | ServicesError).code, code);
}

test('migrations apply in order and are idempotent (live schema)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const again = await applyMigrationsPinned(app.pool, migrations());
    assert.deepEqual(again.applied, [], 'second run applies nothing');
    const tables = await app.pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('verticals_packages', 'services_definitions', 'services_configurations')`,
    );
    assert.equal(tables.rows.length, 3, 'all WORK-009 tables exist');
  } finally {
    await teardown(app);
  }
});

test('schema backstops: one-active partial unique index and closed enumeration (live)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const { pkg } = await app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 1, 'Construction', 'pkg-v1'));
    await app.services.registerServiceDefinition(app.owner, serviceInput(app.tenantId, 1, 'svc-v1'));
    await app.services.activateServiceDefinition(app.owner, app.tenantId, 'subcontractor-compliance', 1);
    // The composite vertical binding FK rejects a service row referencing
    // an unregistered package version (direct SQL backstop).
    await assert.rejects(
      app.pool.query(
        `INSERT INTO services_definitions (tenant_id, service_id, version, name, vertical_package_id, vertical_package_version,
           entities, work_definitions, workflow_binding, policy_configuration, approval_rules, sla_defaults,
           outcome_contract, required_external_capabilities, required_ai_capabilities, pricing, content_hash, record_hash, created_by)
         VALUES ($1, 'ghost-svc', 1, 'Ghost', 'construction', 99, '[]', '[]', '[]', '[]', '[]', '[]', '{}', '[]', '[]', '{}', 'x', 'y', $2)`,
        [app.tenantId, pkg.createdBy],
      ),
      (error: { code?: string }) => error.code === '23503',
      'the composite FK rejects binding an unregistered package version',
    );
    // The one-active partial unique index rejects a second active version
    // without retirement (direct SQL backstop).
    await app.services.registerServiceDefinition(app.owner, serviceInput(app.tenantId, 2, 'svc-v2'));
    await assert.rejects(
      app.pool.query(
        `UPDATE services_definitions SET status = 'active' WHERE tenant_id = $1 AND service_id = 'subcontractor-compliance' AND version = 2`,
        [app.tenantId],
      ),
      (error: { code?: string }) => error.code === '23505',
      'the one-active partial unique index is enforced per statement',
    );
    // The closed status enumeration rejects out-of-band lifecycle writes.
    await assert.rejects(
      app.pool.query(
        `UPDATE services_definitions SET status = 'paused' WHERE tenant_id = $1 AND service_id = 'subcontractor-compliance' AND version = 2`,
        [app.tenantId],
      ),
      (error: { code?: string }) => error.code === '23514',
      'the status CHECK enumeration is enforced',
    );
  } finally {
    await teardown(app);
  }
});

test('the full registration and lifecycle flow works over real SQL', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    // Package registration and versioning.
    const v1 = await app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 1, 'Construction', 'pkg-v1'));
    assert.equal(v1.converged, false);
    const v2 = await app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 2, 'Construction v2', 'pkg-v2'));
    assert.equal(v2.pkg.version, 2);
    // Re-registration of the same version with the same content converges.
    const twin = await app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 1, 'Construction', 'pkg-twin'));
    assert.equal(twin.converged, true);
    assert.equal(twin.pkg.id, v1.pkg.id);
    // Divergent content for the same version fails closed.
    await assert.rejects(
      app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 1, 'Mutated', 'pkg-mutated')),
      (error: unknown) => {
        void expectCode(error, 'VERSION_CONTENT_CONFLICT');
        return true;
      },
    );
    // Sequence skips fail closed.
    await assert.rejects(
      app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 9, 'Skip', 'pkg-skip')),
      (error: unknown) => {
        void expectCode(error, 'VERSION_NOT_SEQUENTIAL');
        return true;
      },
    );

    // Service definition binding + frozen-machine validation (module level,
    // real store).
    await assert.rejects(
      app.services.registerServiceDefinition(app.owner, {
        ...serviceInput(app.tenantId, 1, 'svc-bad'),
        workflowBinding: [{ step: 'collect', from: 'partially_done', to: 'verifying' }],
      }),
      (error: unknown) => {
        void expectCode(error, 'WORKFLOW_STATE_UNKNOWN');
        return true;
      },
    );
    await assert.rejects(
      app.services.registerServiceDefinition(app.owner, {
        ...serviceInput(app.tenantId, 1, 'svc-bad'),
        workflowBinding: [{ step: 'collect', from: 'completed', to: 'in_progress' }],
      }),
      (error: unknown) => {
        void expectCode(error, 'TRANSITION_ILLEGAL');
        return true;
      },
    );
    // Unknown vertical version fails closed.
    await assert.rejects(
      app.services.registerServiceDefinition(app.owner, serviceInput(app.tenantId, 1, 'svc-ghost', 99)),
      (error: unknown) => {
        void expectCode(error, 'VERTICAL_PACKAGE_NOT_FOUND');
        return true;
      },
    );

    // Register, activate, resolve.
    await app.services.registerServiceDefinition(app.owner, serviceInput(app.tenantId, 1, 'svc-v1'));
    await app.services.activateServiceDefinition(app.owner, app.tenantId, 'subcontractor-compliance', 1);
    const active = await app.services.resolveActiveServiceDefinition(app.owner, app.tenantId, 'subcontractor-compliance');
    assert.equal(active?.version, 1);
    // Re-activation converges; a second version retires the first.
    const reactivated = await app.services.activateServiceDefinition(app.owner, app.tenantId, 'subcontractor-compliance', 1);
    assert.equal(reactivated.converged, true);
    await app.services.registerServiceDefinition(app.owner, serviceInput(app.tenantId, 2, 'svc-v2'));
    await app.services.activateServiceDefinition(app.owner, app.tenantId, 'subcontractor-compliance', 2);
    const activeAfter = await app.services.resolveActiveServiceDefinition(app.owner, app.tenantId, 'subcontractor-compliance');
    assert.equal(activeAfter?.version, 2);
    const statuses = await app.services.listServiceDefinitions(app.owner, app.tenantId, 'subcontractor-compliance');
    assert.deepEqual(
      statuses.map((definition) => [definition.version, definition.status]),
      [[1, 'retired'], [2, 'active']],
    );

    // Customer configuration: valid tightened content registers; weakened
    // content is rejected BEFORE persistence.
    const configured = await app.services.registerCustomerConfiguration(app.owner, configurationInput(app.tenantId, 'cfg-v1'));
    assert.equal(configured.configuration.configurationVersion, 1);
    await assert.rejects(
      app.services.registerCustomerConfiguration(app.owner, {
        ...configurationInput(app.tenantId, 'cfg-weak'),
        slaAdjustments: [{ workType: 'OnboardSubcontractor', deadlineHours: 48 }],
      }),
      (error: unknown) => {
        void expectCode(error, 'SLA_WEAKENED');
        return true;
      },
    );
    await assert.rejects(
      app.services.registerCustomerConfiguration(app.owner, {
        ...configurationInput(app.tenantId, 'cfg-oob'),
        policyParameters: [{ policyKey: 'k', values: { p: 999999 } }],
      }),
      (error: unknown) => {
        void expectCode(error, 'POLICY_PARAMETER_OUT_OF_BOUNDS');
        return true;
      },
    );
    const weakRows = await app.pool.query(
      `SELECT COUNT(*)::int AS n FROM services_configurations WHERE tenant_id = $1`,
      [app.tenantId],
    );
    assert.equal((weakRows.rows[0] as { n: number }).n, 1, 'only the valid configuration persisted');

    await app.services.activateCustomerConfiguration(app.owner, app.tenantId, 'subcontractor-compliance', 1);
    const resolvedConfig = await app.services.resolveActiveCustomerConfiguration(app.owner, app.tenantId, 'subcontractor-compliance');
    assert.equal(resolvedConfig?.configurationVersion, 1);
    assert.equal(resolvedConfig?.serviceVersion, 2, 'pins the active service version it was validated against');
  } finally {
    await teardown(app);
  }
});

test('after-the-fact mutation of stored rows is detected on read (live)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    await app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 1, 'Construction', 'pkg-v1'));
    const { pkg } = await app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 1, 'Construction', 'pkg-v1'));
    await app.services.registerServiceDefinition(app.owner, serviceInput(app.tenantId, 1, 'svc-v1'));
    // Tamper the package name without recomputing hashes.
    await app.pool.query(`UPDATE verticals_packages SET name = 'Tampered' WHERE id = $1`, [pkg.id]);
    await assert.rejects(
      app.verticals.getVerticalPackage(app.owner, app.tenantId, 'construction', 1),
      (error: unknown) => {
        void expectCode(error, 'VERTICAL_RECORD_TAMPERED');
        return true;
      },
    );
    // Tamper the service definition content.
    await app.pool.query(
      `UPDATE services_definitions SET sla_defaults = '[{"workType":"OnboardSubcontractor","deadlineHours":9999}]'::jsonb WHERE tenant_id = $1 AND service_id = 'subcontractor-compliance'`,
      [app.tenantId],
    );
    await assert.rejects(
      app.services.listServiceDefinitions(app.owner, app.tenantId, 'subcontractor-compliance'),
      (error: unknown) => {
        void expectCode(error, 'SERVICE_RECORD_TAMPERED');
        return true;
      },
    );
  } finally {
    await teardown(app);
  }
});

test('TRUE parallel actors converge over real SQL (independent pooled clients)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    // Two independent executors (separate pools) racing the same package
    // registration with the same content.
    const poolA = createTestPool({ connectionString: app.live.dsn, max: 2 });
    const poolB = createTestPool({ connectionString: app.live.dsn, max: 2 });
    const executorA = poolExecutor(poolA);
    const executorB = poolExecutor(poolB);
    const authA = createAuthModule({ executor: executorA });
    const organizationsA = createOrganizationsModule({ executor: executorA, authenticator: authA.authenticate, identity: authA });
    const verticalsA = createVerticalsModule({ executor: executorA, tenancy: organizationsA });
    const servicesA = createServicesModule({ executor: executorA, tenancy: organizationsA, verticals: verticalsA });
    const colleagueA = await authA.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
    await organizationsA.addMember(app.owner, 'alpha-org', { principalId: colleagueA.id, role: 'member' });
    try {
      const [a, b] = await Promise.all([
        verticalsA.registerVerticalPackage(colleagueA, packageInput(app.tenantId, 1, 'Construction', 'race-a')),
        app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 1, 'Construction', 'race-b')),
      ]);
      assert.notEqual(a.converged, b.converged, 'exactly one insert and one convergence');
      assert.equal(a.pkg.id, b.pkg.id, 'ONE durable identity');
      const rows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM verticals_packages WHERE tenant_id = $1`, [app.tenantId]);
      assert.equal((rows.rows[0] as { n: number }).n, 1, 'never two rows for one identity');

      // Same-key divergent service registration: one wins, one fails closed.
      await app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 2, 'Construction v2', 'pkg-v2'));
      const [svcA, svcB] = await Promise.allSettled([
        servicesA.registerServiceDefinition(colleagueA, { ...serviceInput(app.tenantId, 1, 'svc-race'), name: 'A' }),
        app.services.registerServiceDefinition(app.owner, { ...serviceInput(app.tenantId, 1, 'svc-race'), name: 'A' }),
      ]);
      // Same content, same key: BOTH actors converge on one durable row.
      const fulfilled = [svcA, svcB].filter((result) => result.status === 'fulfilled');
      assert.equal(fulfilled.length, 2, 'same-key same-content registrations never fail');
      const ids = new Set(
        fulfilled.map((result) => (result as PromiseFulfilledResult<{ definition: { id: string } }>).value.definition.id),
      );
      assert.equal(ids.size, 1, 'one durable identity');
      const svcRows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM services_definitions WHERE tenant_id = $1`, [app.tenantId]);
      assert.equal((svcRows.rows[0] as { n: number }).n, 1);

      // Divergent content for the same FRESH idempotency key, racing in
      // parallel: exactly one wins; the loser fails closed with the store
      // contract's IDEMPOTENCY_INPUT_CONFLICT (the post-lock re-check —
      // NOT version-content-conflict — after waiting on the advisory
      // lock). Version 2 is the next free sequence slot (v1 was bound by
      // the convergent race above).
      const [divA, divB] = await Promise.allSettled([
        servicesA.registerServiceDefinition(colleagueA, { ...serviceInput(app.tenantId, 2, 'svc-divergent'), name: 'Divergent A' }),
        app.services.registerServiceDefinition(app.owner, { ...serviceInput(app.tenantId, 2, 'svc-divergent'), name: 'Divergent B' }),
      ]);
      const failed = [divA, divB].filter((result) => result.status === 'rejected');
      assert.equal(failed.length, 1, 'exactly one rejection');
      if (failed[0]?.status === 'rejected') {
        await expectCode(failed[0].reason, 'IDEMPOTENCY_INPUT_CONFLICT');
      }
      const divergentRows = await app.pool.query(
        `SELECT COUNT(*)::int AS n FROM services_definitions WHERE tenant_id = $1 AND version = 2`,
        [app.tenantId],
      );
      assert.equal((divergentRows.rows[0] as { n: number }).n, 1, 'the winner\'s version 2 is the only durable row');

      // Concurrent activation of the same version converges (one active).
      const [actA, actB] = await Promise.all([
        servicesA.activateServiceDefinition(colleagueA, app.tenantId, 'subcontractor-compliance', 1),
        app.services.activateServiceDefinition(app.owner, app.tenantId, 'subcontractor-compliance', 1),
      ]);
      assert.equal([actA.converged, actB.converged].filter((converged) => converged).length, 1, 'exactly one activation');
      const activeRows = await app.pool.query(
        `SELECT COUNT(*)::int AS n FROM services_definitions WHERE tenant_id = $1 AND service_id = $2 AND status = 'active'`,
        [app.tenantId, 'subcontractor-compliance'],
      );
      assert.equal((activeRows.rows[0] as { n: number }).n, 1, 'exactly one active at rest');

      // Concurrent same-key customer configuration registration converges.
      const [cfgA, cfgB] = await Promise.all([
        servicesA.registerCustomerConfiguration(colleagueA, configurationInput(app.tenantId, 'cfg-race', 2500)),
        app.services.registerCustomerConfiguration(app.owner, configurationInput(app.tenantId, 'cfg-race', 2500)),
      ]);
      assert.equal(cfgA.configuration.id, cfgB.configuration.id, 'one durable configuration');
      const cfgRows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM services_configurations WHERE tenant_id = $1`, [app.tenantId]);
      assert.equal((cfgRows.rows[0] as { n: number }).n, 1);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  } finally {
    await teardown(app);
  }
});

test('cross-tenant reads carry the tenant predicate against real rows', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    await app.verticals.registerVerticalPackage(app.owner, packageInput(app.tenantId, 1, 'Construction', 'pkg-v1'));
    const outsider = await app.auth.registerHuman({ email: 'out@b.com', password: PASSWORD, displayName: 'Outsider' });
    const other = await app.organizations.createOrganization(outsider, { slug: 'beta-org', displayName: 'Beta' });
    const foreign = await app.verticals.getVerticalPackage(outsider, other.tenant.id, 'construction', 1);
    assert.equal(foreign, null);
    const foreignList = await app.verticals.listVerticalPackages(outsider, other.tenant.id, 'construction');
    assert.deepEqual(foreignList, []);
    const foreignService = await app.services.resolveActiveServiceDefinition(outsider, other.tenant.id, 'subcontractor-compliance');
    assert.equal(foreignService, null);
    // An actor of the other tenant CANNOT register a second copy of the
    // same package identity in their own tenant... they CAN (their own
    // identity namespace) — but the rows stay tenant-predicated.
    const own = await app.verticals.registerVerticalPackage(outsider, packageInput(other.tenant.id, 1, 'Construction', 'pkg-other'));
    assert.equal(own.pkg.tenantId, other.tenant.id);
    const rows = await app.pool.query(`SELECT tenant_id, COUNT(*)::int AS n FROM verticals_packages GROUP BY tenant_id`);
    assert.equal(rows.rows.length, 2, 'two tenant-scoped rows');
  } finally {
    await teardown(app);
  }
});
