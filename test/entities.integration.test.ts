/**
 * Optional live-PostgreSQL integration proof for the /entities authority
 * and the Construction Subcontractor Compliance flow (WORK-010,
 * CRITICAL). Runs ONLY when SERVICEOS_TEST_DATABASE_URL points at a
 * disposable PostgreSQL database; otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001..0012 apply in order and are idempotent, and
 *   migration 0012 pins the entity invariants: the keyed identity
 *   unique index, the immutability CHECK (updated_at = created_at), and
 *   NO lifecycle/policy/provider/foreign-AI columns;
 * - the full entity flow works over real SQL: package-validated creation
 *   through /verticals' registered declaration, keyed convergence,
 *   divergent same-key fail-closed, tamper detection on read (real rows
 *   mutated out of band), and mandatory tenant predicates (a foreign
 *   tenant's row is indistinguishable from a missing one);
 * - the Construction compliance flow end-to-end over real SQL: onboarding
 *   (entities + work + attempt + transitions + the durable collection
 *   contact), document receipt (entity + evidence + resume), the
 *   deterministic evaluation (validation evidence + the /evidence
 *   verification decision + the completed transition), the governed
 *   chase follow-up (chase work + ONE keyed contact), and the auditable
 *   compliance package (deterministic hash over the assembled authority
 *   state);
 * - duplicate document callbacks converge over real rows: parallel
 *   same-key receipts converge on ONE entity + ONE evidence row;
 * - concurrent follow-up workers do not double-contact the vendor: the
 *   keyed interaction identity converges with exactly ONE accepted
 *   dispatch;
 * - the SQL entity store's mutation paths run on ONE pinned client: a
 *   pool with a SINGLE connection completes the flows only if no
 *   statement escapes the transaction (the /work, /workflow, /evidence
 *   and /zeck live-verification discipline).
 *
 * Each proof runs against its OWN disposable database (node:test
 * executes test files concurrently; sharing one database would collide
 * through the migration history).
 *
 * This environment has no local PostgreSQL, so these proofs execute in
 * CI (the governance workflow provisions a PostgreSQL service).
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
import { createPoliciesModule } from '../src/modules/policies/index.js';
import { createWorkflowModule } from '../src/modules/workflow/index.js';
import { createWorkModule } from '../src/modules/work/index.js';
import { createVerticalsModule } from '../src/modules/verticals/index.js';
import { createEntitiesModule, createConstructionCompliance, constructionVerticalPackage, EntitiesError } from '../src/modules/entities/index.js';
import { createEvidenceModule } from '../src/modules/evidence/index.js';
import { createApprovalsModule } from '../src/modules/approvals/index.js';
import {
  createInteractionsModule,
  createInMemoryEventDelivery,
} from '../src/modules/interactions/index.js';
import { createInMemoryProviderAdapter, createAdapterRegistry, createEffectSink } from '../src/modules/integrations/index.js';
import { createZeckModule } from '../src/modules/zeck/index.js';
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
    '0007_billing_economics.sql',
    '0008_zeck_integration_boundary.sql',
    '0009_business_evidence.sql',
    '0010_business_approvals.sql',
    '0011_event_substrate.sql',
    '0012_construction_entities.sql',
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
  policies: ReturnType<typeof createPoliciesModule>;
  workflow: ReturnType<typeof createWorkflowModule>;
  work: ReturnType<typeof createWorkModule>;
  verticals: ReturnType<typeof createVerticalsModule>;
  entities: ReturnType<typeof createEntitiesModule>;
  evidence: ReturnType<typeof createEvidenceModule>;
  approvals: ReturnType<typeof createApprovalsModule>;
  interactions: ReturnType<typeof createInteractionsModule>;
  zeck: ReturnType<typeof createZeckModule>;
  construction: ReturnType<typeof createConstructionCompliance>;
  owner: Principal;
  outsider: Principal;
  tenantId: string;
  otherTenantId: string;
  projectId: string;
  now: () => Date;
}

/** The default clock ADVANCES one second per read (deterministic ordering). */
function advancingClock(): () => Date {
  const base = new Date('2026-09-02T12:00:00.000Z').getTime();
  let tick = 0;
  return () => new Date(base + tick++ * 1000);
}

async function liveApp(poolOptions: { max?: number } = {}, now: () => Date = advancingClock()): Promise<LiveApp> {
  const live = await createLiveTestDatabase();
  const pool = createTestPool({ connectionString: live.dsn, max: 8, ...poolOptions });
  await applyMigrationsPinned(pool, migrations());
  const executor = poolExecutor(pool);
  const auth = createAuthModule({ executor });
  const organizations = createOrganizationsModule({ executor, authenticator: auth.authenticate, identity: auth });
  const policies = createPoliciesModule({ executor, tenancy: organizations, now });
  const workflow = createWorkflowModule({ executor, tenancy: organizations, policies, now });
  const work = createWorkModule({ executor, tenancy: organizations, now });
  const { adapter: emailAdapter } = createInMemoryProviderAdapter('email');
  const registry = createAdapterRegistry();
  registry.register(emailAdapter);
  registry.seal();
  const effectSink = createEffectSink(registry);
  const interactions = createInteractionsModule({
    executor,
    tenancy: organizations,
    policies,
    sink: effectSink,
    eventDelivery: createInMemoryEventDelivery({ now }),
    now,
  });
  const verticals = createVerticalsModule({ executor, tenancy: organizations, now });
  const zeck = createZeckModule({ executor, tenancy: organizations, work, now });
  const evidence = createEvidenceModule({ executor, tenancy: organizations, work, now });
  const approvals = createApprovalsModule({ executor, tenancy: organizations, work, policies, now });
  const entities = createEntitiesModule({ executor, tenancy: organizations, verticals, now });
  const construction = createConstructionCompliance({
    entities,
    verticals,
    work,
    workflow,
    evidence,
    interactions,
    zeck,
    approvals,
    now,
  });
  const owner = await auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const outsider = await auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Outsider' });
  const created = await organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  const other = await organizations.createOrganization(outsider, { slug: 'beta-org', displayName: 'Beta' });
  // The operator registers the Construction v1 package in the tenant.
  await verticals.registerVerticalPackage(owner, {
    ...constructionVerticalPackage(created.tenant.id),
    idempotencyKey: 'construction-package:1',
  });
  const project = await entities.createEntityInstance(owner, {
    tenantId: created.tenant.id,
    packageId: 'construction',
    packageVersion: 1,
    entityType: 'Project',
    fields: {
      name: 'Riverside Tower',
      minGlPerOccurrenceUsd: 1_000_000,
      minUmbrellaAggregateUsd: 2_000_000,
      expiryLeadDays: 30,
      projectNamedAdditionalInsured: true,
      requireW9: true,
      requireLicense: true,
    },
    idempotencyKey: 'project-riverside',
  });
  return {
    live,
    pool,
    auth,
    organizations,
    policies,
    workflow,
    work,
    verticals,
    entities,
    evidence,
    approvals,
    interactions,
    zeck,
    construction,
    owner,
    outsider,
    tenantId: created.tenant.id,
    otherTenantId: other.tenant.id,
    projectId: project.instance.id,
    now,
  };
}

async function withLive(
  run: (app: LiveApp) => Promise<void>,
  poolOptions: { max?: number } = {},
  now: () => Date = advancingClock(),
): Promise<void> {
  const app = await liveApp(poolOptions, now);
  try {
    await run(app);
  } finally {
    await app.pool.end();
    await app.live.drop();
  }
}

const COMPLIANT_INSURANCE = {
  glPerOccurrenceUsd: 2_000_000,
  umbrellaAggregateUsd: 4_000_000,
  expiresAt: '2027-06-30T00:00:00.000Z',
  additionalInsured: 'Riverside Tower',
  certificateHolder: 'Riverside Tower GC',
};

async function onboard(app: LiveApp, key: string) {
  return app.construction.onboardSubcontractor(app.owner, {
    tenantId: app.tenantId,
    packageVersion: 1,
    projectInstanceId: app.projectId,
    subcontractor: { name: 'Acme Electrical', contactEmail: 'vendor@acme.com', taxId: '12-3456789', trade: 'electrical' },
    idempotencyKey: key,
  });
}

// ---------------------------------------------------------------------------
// Migrations + schema
// ---------------------------------------------------------------------------

test('migrations 0001..0012 apply in order and are idempotent; migration 0012 pins the entity invariants', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    // Idempotent re-run over the applied chain.
    await applyMigrationsPinned(app.pool, migrations());
    // The keyed identity unique index exists.
    const index = await app.pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'entity_instances' AND indexname = 'entity_instances_tenant_idempotency_key'`,
    );
    assert.equal(index.rows.length, 1);
    // The immutability CHECK exists (updated_at = created_at).
    const check = await app.pool.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'entity_instances'::regclass AND conname = 'entity_instances_immutable'`,
    );
    assert.equal(check.rows.length, 1);
    // No lifecycle/policy/provider/AI columns (the frozen column set).
    const columns = await app.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'entity_instances'`,
    );
    const names = columns.rows.map((row) => String((row as { column_name: string }).column_name));
    assert.deepEqual(names.sort(), [
      'content_hash',
      'created_at',
      'created_by',
      'entity_type',
      'fields',
      'id',
      'idempotency_key',
      'package_id',
      'package_version',
      'record_hash',
      'tenant_id',
      'updated_at',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The entity authority over real SQL
// ---------------------------------------------------------------------------

test('the entity flow works over real SQL: validation, convergence, tamper detection, tenant predicates', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    // Package-validated creation through the registered declaration.
    const fields = {
      glPerOccurrenceUsd: 2_000_000,
      umbrellaAggregateUsd: 4_000_000,
      expiresAt: '2027-06-30T00:00:00.000Z',
      additionalInsured: 'Riverside Tower',
      certificateHolder: 'Riverside Tower GC',
    };
    const created = await app.entities.createEntityInstance(app.owner, {
      tenantId: app.tenantId,
      packageId: 'construction',
      packageVersion: 1,
      entityType: 'InsuranceCertificate',
      fields,
      idempotencyKey: 'cert-1',
    });
    assert.equal(created.converged, false);
    // Keyed convergence on the same content.
    const retry = await app.entities.createEntityInstance(app.owner, {
      tenantId: app.tenantId,
      packageId: 'construction',
      packageVersion: 1,
      entityType: 'InsuranceCertificate',
      fields,
      idempotencyKey: 'cert-1',
    });
    assert.equal(retry.converged, true);
    assert.equal(retry.instance.id, created.instance.id);
    // Divergent same-key input fails closed.
    await assert.rejects(
      app.entities.createEntityInstance(app.owner, {
        tenantId: app.tenantId,
        packageId: 'construction',
        packageVersion: 1,
        entityType: 'InsuranceCertificate',
        fields: { ...fields, glPerOccurrenceUsd: 1 },
        idempotencyKey: 'cert-1',
      }),
      (error: unknown) => error instanceof EntitiesError && error.code === 'ENTITY_INPUT_CONFLICT',
    );
    // Cross-tenant read: a foreign tenant sees the row as missing.
    await assert.rejects(
      app.entities.getEntityInstance(app.outsider, app.otherTenantId, created.instance.id),
      (error: unknown) => error instanceof EntitiesError && error.code === 'ENTITY_NOT_FOUND',
    );
    // Out-of-band tampering is detected on read (integrity hash).
    await app.pool.query(`UPDATE entity_instances SET record_hash = '0' WHERE id = $1`, [created.instance.id]);
    await assert.rejects(
      app.entities.getEntityInstance(app.owner, app.tenantId, created.instance.id),
      (error: unknown) => error instanceof EntitiesError && error.code === 'ENTITY_RECORD_TAMPERED',
    );
  });
});

// ---------------------------------------------------------------------------
// The Construction compliance flow end-to-end over real SQL
// ---------------------------------------------------------------------------

test('the full construction compliance journey over real SQL: onboarding -> documents -> verification -> package', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const onboarding = await onboard(app, 'live-onboard-1');
    assert.equal(onboarding.serviceWork.status, 'waiting_information');
    assert.equal(onboarding.collectionRequest.state, 'dispatched');
    // The three required documents arrive.
    for (const [kind, document, key] of [
      ['insurance_certificate', COMPLIANT_INSURANCE, 'live-doc-ins'],
      ['w9', { taxId: '12-3456789' }, 'live-doc-w9'],
      ['license', { licenseNumber: 'GC-90210', jurisdiction: 'CA', expiresAt: '2027-03-31T00:00:00.000Z', active: true }, 'live-doc-lic'],
    ] as const) {
      await app.construction.receiveVendorDocument(app.owner, {
        tenantId: app.tenantId,
        serviceWorkId: onboarding.serviceWork.id,
        kind,
        document,
        receivedAt: app.now(),
        idempotencyKey: key,
      });
    }
    const evaluation = await app.construction.evaluateCompliance(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'live-eval-1',
    });
    assert.equal(evaluation.verdict, 'satisfied');
    assert.equal(evaluation.compliant, true);
    assert.equal(evaluation.serviceWork.status, 'completed');
    // The auditable package over real rows.
    const pack = await app.construction.assembleCompliancePackage(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'live-package-1',
    });
    assert.equal(pack.packageHash.length, 64);
    assert.equal((pack.packageDocument as Record<string, unknown>).workState, 'completed');
    // Replay convergence over real SQL: the same onboarding key converges.
    const replay = await app.construction.onboardSubcontractor(app.owner, {
      tenantId: app.tenantId,
      packageVersion: 1,
      projectInstanceId: app.projectId,
      subcontractor: { name: 'Acme Electrical', contactEmail: 'vendor@acme.com', taxId: '12-3456789', trade: 'electrical' },
      idempotencyKey: 'live-onboard-1',
    });
    assert.equal(replay.serviceWork.id, onboarding.serviceWork.id);
    assert.equal(replay.collectionRequest.id, onboarding.collectionRequest.id);
  });
});

test('missing documents over real SQL: governed chase work + ONE durable contact', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const onboarding = await onboard(app, 'live-onboard-chase');
    const evaluation = await app.construction.evaluateCompliance(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'live-eval-chase-1',
    });
    assert.equal(evaluation.compliant, false);
    const chase = await app.construction.chaseMissingDocuments(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      round: 1,
    });
    assert.equal(chase.followUpWork.workType, 'construction.chase_missing_document');
    assert.equal(chase.followUpWork.status, 'in_progress');
    assert.equal(chase.chase.state, 'dispatched');
    // The retry converges on the SAME identities over real rows.
    const retry = await app.construction.chaseMissingDocuments(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      round: 1,
    });
    assert.equal(retry.chase.id, chase.chase.id);
    assert.equal(retry.followUpWork.id, chase.followUpWork.id);
  });
});

// ---------------------------------------------------------------------------
// Concurrency over real rows
// ---------------------------------------------------------------------------

test('parallel duplicate document callbacks converge over real SQL', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const onboarding = await onboard(app, 'live-onboard-dup');
    const input = {
      tenantId: app.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'insurance_certificate' as const,
      document: COMPLIANT_INSURANCE,
      receivedAt: app.now(),
      idempotencyKey: 'live-doc-dup',
    };
    const results = await Promise.all([
      app.construction.receiveVendorDocument(app.owner, input),
      app.construction.receiveVendorDocument(app.owner, { ...input, receivedAt: input.receivedAt }),
      app.construction.receiveVendorDocument(app.owner, { ...input, receivedAt: input.receivedAt }),
    ]);
    const evidenceIds = new Set(results.map((result) => result.evidence.id));
    assert.equal(evidenceIds.size, 1);
    const evidence = await app.evidence.listEvidence(app.owner, app.tenantId, {
      serviceWorkId: onboarding.serviceWork.id,
      requirement: 'construction.insurance_certificate',
    });
    assert.equal(evidence.length, 1);
    const instances = await app.entities.listEntityInstances(app.owner, app.tenantId, { entityType: 'InsuranceCertificate' });
    assert.equal(instances.length, 1);
  });
});

test('concurrent follow-up workers converge on ONE contact over real SQL', { skip: SKIP }, async () => {
  await withLive(async (app) => {
    const onboarding = await onboard(app, 'live-onboard-chase-race');
    await app.construction.evaluateCompliance(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'live-eval-chase-race',
    });
    const workers = await Promise.allSettled([
      app.construction.chaseMissingDocuments(app.owner, { tenantId: app.tenantId, serviceWorkId: onboarding.serviceWork.id, round: 1 }),
      app.construction.chaseMissingDocuments(app.owner, { tenantId: app.tenantId, serviceWorkId: onboarding.serviceWork.id, round: 1 }),
    ]);
    const fulfilled = workers.filter((result) => result.status === 'fulfilled');
    assert.equal(fulfilled.length >= 1, true);
    for (const outcome of workers) {
      if (outcome.status === 'rejected') {
        const code = (outcome.reason as { code?: string }).code;
        assert.ok(
          code === 'DISPATCH_IN_PROGRESS' || code === 'INTERACTION_INPUT_CONFLICT' || code === 'TRANSITION_CONFLICT',
          `a concurrent chase loser must fail closed with a typed recoverable code, received: ${String(code)}`,
        );
      }
    }
    // ONE chase work + ONE round-1 interaction over real rows.
    const chaseWorks = (await app.work.listWorks(app.owner, app.tenantId)).filter(
      (work) => work.workType === 'construction.chase_missing_document',
    );
    assert.equal(chaseWorks.length, 1);
    const chases = await app.interactions.listInteractions(app.owner, app.tenantId, {
      correlation: { key: 'serviceWorkId', value: onboarding.serviceWork.id },
    });
    const round1 = chases.filter((interaction) => interaction.correlation.round === '1');
    assert.equal(round1.length, 1);
    assert.equal(round1[0]?.state, 'dispatched');
  });
});

// ---------------------------------------------------------------------------
// Transaction-scope discipline
// ---------------------------------------------------------------------------

test('the SQL entity store completes the flow on ONE pinned client (no statement escapes the transaction)', { skip: SKIP }, async () => {
  // A SINGLE-connection pool: the entity critical sections and every
  // composed authority's writes interleave correctly only if each
  // transaction returns its client before the next statement.
  await withLive(async (app) => {
    const onboarding = await onboard(app, 'live-onboard-pinned');
    assert.equal(onboarding.serviceWork.status, 'waiting_information');
    await app.construction.receiveVendorDocument(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      kind: 'insurance_certificate',
      document: COMPLIANT_INSURANCE,
      receivedAt: app.now(),
      idempotencyKey: 'live-doc-pinned',
    });
    const evaluation = await app.construction.evaluateCompliance(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: onboarding.serviceWork.id,
      idempotencyKey: 'live-eval-pinned',
    });
    assert.equal(evaluation.insuranceValidation?.compliant, true);
    assert.equal(evaluation.compliant, false, 'w9/license are still missing in this engagement');
  }, { max: 1 });
});
