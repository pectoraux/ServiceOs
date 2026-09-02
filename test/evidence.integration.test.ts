/**
 * Optional live-PostgreSQL integration proof for the /evidence
 * authority runtime (WORK-007, CRITICAL). Runs ONLY when
 * SERVICEOS_TEST_DATABASE_URL points at a disposable PostgreSQL
 * database; otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001..0009 apply in order and are idempotent;
 * - schema backstops hold: the keyed evidence identity, the ONE-row-
 *   per-evidence-fact content identity, the closed verdict and
 *   business-verification-mode enumerations, the provenance-shape
 *   CHECK, and the keyed decision identity;
 * - the full evidence flow works over real SQL: attributable attach
 *   (validated against /work's public read), the deterministic
 *   outcome verification computed inside the serialized critical
 *   section (satisfied only when every requirement has evidence of
 *   THIS work item; missing evidence is not_satisfied with the missing
 *   requirements listed), the immutable decision ledger, the
 *   latest-decision read, and the re-verification discipline (same key
 *   over a changed evidence state fails closed; a new key records the
 *   fresh deterministic decision);
 * - wrong-work evidence never satisfies another work item's outcome
 *   (invariant 5) and the evidence/verification flow never mutates the
 *   Service Work record;
 * - duplicate attachment converges over real rows: same-key retry and
 *   the same fact under a different key converge on ONE durable row;
 *   same-key divergent input fails closed WITH exactly one typed
 *   conflict;
 * - after-the-fact mutation of stored rows is DETECTED on read
 *   (integrity hash recomputation against real rows);
 * - TRUE parallel actors (separate pooled clients) converge: same-key
 *   attaches converge on ONE row, same-key divergent attaches produce
 *   exactly one typed conflict, the same fact under different keys
 *   converges on ONE row, concurrent same-key verifications converge on
 *   ONE decision row, and a verification racing an attach decides over
 *   exactly one consistent evidence state (the work-state lock domain);
 * - a moving clock never breaks read-side integrity;
 * - cross-tenant reads carry the tenant predicate against real rows.
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
import { createWorkModule } from '../src/modules/work/index.js';
import {
  createEvidenceModule,
  EvidenceError,
  type AttachEvidenceInput,
  type OutcomeContractInput,
} from '../src/modules/evidence/index.js';
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
  work: ReturnType<typeof createWorkModule>;
  evidence: ReturnType<typeof createEvidenceModule>;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
  workId: string;
  attemptId: string;
  otherWorkId: string;
}

/**
 * The default clock ADVANCES one second per read: every durable write
 * pins a distinct instant, so ledger order (attachment order, decision
 * order — `ORDER BY <instant>, id`) is deterministic instead of
 * tie-breaking on random surrogate ids (the CI live-verification
 * defect class). The moving-clock proof injects its own real clock.
 */
function advancingClock(): () => Date {
  const base = new Date('2026-09-02T12:00:00.000Z').getTime();
  let tick = 0;
  return () => new Date(base + tick++ * 1000);
}

async function liveApp(now: () => Date = advancingClock()): Promise<LiveApp> {
  const live = await createLiveTestDatabase();
  const pool = createTestPool({ connectionString: live.dsn, max: 4 });
  await applyMigrationsPinned(pool, migrations());
  const executor = poolExecutor(pool);
  const auth = createAuthModule({ executor });
  const organizations = createOrganizationsModule({ executor, authenticator: auth.authenticate, identity: auth });
  const work = createWorkModule({ executor, tenancy: organizations });
  const evidence = createEvidenceModule({ executor, tenancy: organizations, work, now });
  const owner = await auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  const createdWork = await work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'CollectComplianceDocuments',
    title: 'Collect the compliance package',
  });
  const attempt = await work.createAttempt(owner, created.tenant.id, createdWork.work.id, { idempotencyKey: 'attempt-1' });
  const otherWork = await work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'ValidateInsuranceCertificate',
    title: 'Another work item',
  });
  return {
    live,
    pool,
    auth,
    organizations,
    work,
    evidence,
    owner,
    colleague,
    tenantId: created.tenant.id,
    workId: createdWork.work.id,
    attemptId: attempt.attempt.id,
    otherWorkId: otherWork.work.id,
  };
}

async function teardown(app: LiveApp): Promise<void> {
  await app.pool.end();
  await app.live.drop();
}

function evidenceInput(app: LiveApp, key: string, over: Partial<AttachEvidenceInput> = {}): AttachEvidenceInput {
  return {
    tenantId: app.tenantId,
    serviceWorkId: app.workId,
    requirement: 'insurance_certificate_on_file',
    provenance: {
      kind: 'external_record',
      source: 'carrier-portal-api',
      refs: ['carrier://certificate/acme-2026-0001'],
    },
    payload: { carrier: 'Acme Mutual', policy: 'GL-2026-8899', coverage: 2000000, expiresOn: '2027-03-01' },
    observedAt: new Date('2026-09-01T09:30:00.000Z'),
    idempotencyKey: key,
    ...over,
  };
}

function contractInput(evidenceRequirements: string[], over: Partial<OutcomeContractInput> = {}): OutcomeContractInput {
  return {
    outcomeId: 'compliance_package_complete',
    verification: 'deterministic',
    evidenceRequirements,
    ...over,
  };
}

async function expectCode(error: unknown, code: string): Promise<void> {
  assert.ok(error instanceof EvidenceError, `expected an EvidenceError, got ${(error as Error)?.message}`);
  assert.equal((error as EvidenceError).code, code);
}

async function evidenceError<T>(promise: Promise<T>): Promise<EvidenceError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EvidenceError, `expected an EvidenceError, got ${(error as Error)?.message}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the call to fail closed' });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('migrations apply in order and are idempotent (live schema)', { skip: SKIP }, async () => {
  const live = await createLiveTestDatabase();
  const pool = createTestPool({ connectionString: live.dsn, max: 2 });
  try {
    const first = await applyMigrationsPinned(pool, migrations());
    assert.equal(first.applied.length, 9, 'all nine migrations apply');
    const again = await applyMigrationsPinned(pool, migrations());
    assert.equal(again.applied.length, 0, 'the migration history is honored (idempotent re-run)');
    assert.equal(again.skipped, 9);
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('evidence_records', 'evidence_outcome_verifications')`,
    );
    assert.equal(tables.rowCount, 2);
  } finally {
    await pool.end();
    await live.drop();
  }
});

test('schema backstops: the content identity, closed enumerations and provenance shape hold at the database level', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const attached = await app.evidence.attachEvidence(app.owner, evidenceInput(app, 'backstop-1'));
    // ONE row per evidence fact per work item: a second INSERT of the
    // same fact (any key) violates the unique index.
    await assert.rejects(
      app.pool.query(
        `INSERT INTO evidence_records
           (tenant_id, service_work_id, requirement, provenance, payload, observed_at,
            idempotency_key, content_hash, record_hash, attached_by, attached_at)
         VALUES ($1, $2, 'insurance_certificate_on_file', '{"kind":"external_record","source":"x","refs":[]}'::jsonb, '{}'::jsonb, $3,
                 'other-key', $4, 'r', $5, $6)`,
        [
          app.tenantId,
          app.workId,
          new Date('2026-09-01T09:30:00.000Z'),
          attached.evidence.contentHash,
          app.owner.id,
          new Date('2026-09-02T12:00:00.000Z'),
        ],
      ),
      /duplicate key value violates unique constraint "evidence_records_tenant_work_content"/,
    );
    // The keyed identity also holds.
    await assert.rejects(
      app.pool.query(
        `INSERT INTO evidence_records
           (tenant_id, service_work_id, requirement, provenance, payload, observed_at,
            idempotency_key, content_hash, record_hash, attached_by, attached_at)
         VALUES ($1, $2, 'another_requirement', '{"kind":"external_record","source":"x","refs":[]}'::jsonb, '{}'::jsonb, $3,
                 $4, 'other-content', 'r', $5, $6)`,
        [
          app.tenantId,
          app.workId,
          new Date('2026-09-01T09:30:00.000Z'),
          'backstop-1',
          app.owner.id,
          new Date('2026-09-02T12:00:00.000Z'),
        ],
      ),
      /duplicate key value violates unique constraint "evidence_records_tenant_idempotency_key"/,
    );
    // The closed verdict enumeration.
    await assert.rejects(
      app.pool.query(
        `INSERT INTO evidence_outcome_verifications
           (tenant_id, service_work_id, outcome_id, verification_mode, requirements, verdict, requirement_results,
            idempotency_key, content_hash, record_hash, decided_by, decided_at)
         VALUES ($1, $2, 'o', 'deterministic', '[]'::jsonb, 'maybe', '[]'::jsonb, 'k', 'c', 'r', $3, $4)`,
        [app.tenantId, app.workId, app.owner.id, new Date('2026-09-02T12:00:00.000Z')],
      ),
      /violates check constraint "evidence_outcome_verifications_verdict_check"/,
    );
    // The closed business-verification-mode enumeration (an AI execution
    // concept has no schema surface).
    await assert.rejects(
      app.pool.query(
        `INSERT INTO evidence_outcome_verifications
           (tenant_id, service_work_id, outcome_id, verification_mode, requirements, verdict, requirement_results,
            idempotency_key, content_hash, record_hash, decided_by, decided_at)
         VALUES ($1, $2, 'o', 'ai_execution', '[]'::jsonb, 'satisfied', '[]'::jsonb, 'k2', 'c', 'r', $3, $4)`,
        [app.tenantId, app.workId, app.owner.id, new Date('2026-09-02T12:00:00.000Z')],
      ),
      /violates check constraint "evidence_outcome_verifications_verification_mode_check"/,
    );
    // The provenance shape CHECK (kind/source/refs present).
    await assert.rejects(
      app.pool.query(
        `INSERT INTO evidence_records
           (tenant_id, service_work_id, requirement, provenance, payload, observed_at,
            idempotency_key, content_hash, record_hash, attached_by, attached_at)
         VALUES ($1, $2, 'r', '{}'::jsonb, '{}'::jsonb, $3, 'shape-key', 'c', 'r', $4, $5)`,
        [app.tenantId, app.workId, new Date('2026-09-01T09:30:00.000Z'), app.owner.id, new Date('2026-09-02T12:00:00.000Z')],
      ),
      /violates check constraint "evidence_records_provenance_check"/,
    );
  } finally {
    await teardown(app);
  }
});

// ---------------------------------------------------------------------------
// The full flow over real SQL
// ---------------------------------------------------------------------------

test('the full evidence flow works over real SQL: attach, deterministic verification, re-verification, no work mutation', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const workBefore = await app.work.getWork(app.owner, app.tenantId, app.workId);
    const attached = await app.evidence.attachEvidence(
      app.owner,
      evidenceInput(app, 'flow-1', { workAttemptId: app.attemptId }),
    );
    assert.equal(attached.converged, false);
    // A first verification over the partial evidence state.
    const partial = await app.evidence.verifyOutcome(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: app.workId,
      contract: contractInput(['insurance_certificate_on_file', 'license_validated']),
      idempotencyKey: 'verify-1',
    });
    assert.equal(partial.verification.verdict, 'not_satisfied');
    assert.deepEqual(
      partial.verification.requirementResults.map((result) => [result.requirement, result.satisfied]),
      [['insurance_certificate_on_file', true], ['license_validated', false]],
    );
    // The missing evidence arrives; a re-verification uses a NEW key.
    await app.evidence.attachEvidence(
      app.owner,
      evidenceInput(app, 'flow-2', {
        requirement: 'license_validated',
        provenance: { kind: 'system_observation', source: 'license-check-worker', refs: [] },
        payload: { state: 'CA', valid: true },
      }),
    );
    const sameKey = await evidenceError(
      app.evidence.verifyOutcome(app.owner, {
        tenantId: app.tenantId,
        serviceWorkId: app.workId,
        contract: contractInput(['insurance_certificate_on_file', 'license_validated']),
        idempotencyKey: 'verify-1',
      }),
    );
    assert.equal(sameKey.code, 'VERIFICATION_INPUT_CONFLICT');
    const satisfied = await app.evidence.verifyOutcome(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: app.workId,
      contract: contractInput(['insurance_certificate_on_file', 'license_validated']),
      idempotencyKey: 'verify-2',
    });
    assert.equal(satisfied.verification.verdict, 'satisfied');
    assert.deepEqual(
      satisfied.verification.requirementResults.map((result) => [result.requirement, result.evidenceIds.length]),
      [['insurance_certificate_on_file', 1], ['license_validated', 1]],
    );
    // The same verification re-run converges.
    const retry = await app.evidence.verifyOutcome(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: app.workId,
      contract: contractInput(['insurance_certificate_on_file', 'license_validated']),
      idempotencyKey: 'verify-2',
    });
    assert.equal(retry.converged, true);
    assert.equal(retry.verification.id, satisfied.verification.id);
    // The latest-decision read reflects the newest state; the ledger
    // keeps both decisions.
    const latest = await app.evidence.getLatestOutcomeVerification(
      app.owner,
      app.tenantId,
      app.workId,
      'compliance_package_complete',
    );
    assert.equal(latest.id, satisfied.verification.id);
    const ledger = await app.evidence.listOutcomeVerifications(app.owner, app.tenantId, { serviceWorkId: app.workId });
    assert.equal(ledger.length, 2);
    // The Service Work record is UNCHANGED by the whole flow.
    assert.deepEqual(await app.work.getWork(app.owner, app.tenantId, app.workId), workBefore);
    void attached;
  } finally {
    await teardown(app);
  }
});

test('wrong-work evidence never satisfies another work item over real SQL (invariant 5)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    await app.evidence.attachEvidence(app.owner, { ...evidenceInput(app, 'wrong-1'), serviceWorkId: app.otherWorkId });
    const verified = await app.evidence.verifyOutcome(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: app.workId,
      contract: contractInput(['insurance_certificate_on_file']),
      idempotencyKey: 'verify-wrong',
    });
    assert.equal(verified.verification.verdict, 'not_satisfied');
    assert.deepEqual(verified.verification.requirementResults, [
      { requirement: 'insurance_certificate_on_file', satisfied: false, evidenceIds: [] },
    ]);
    // The other work item IS satisfied by its own evidence.
    const other = await app.evidence.verifyOutcome(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: app.otherWorkId,
      contract: contractInput(['insurance_certificate_on_file']),
      idempotencyKey: 'verify-other',
    });
    assert.equal(other.verification.verdict, 'satisfied');
  } finally {
    await teardown(app);
  }
});

test('duplicate attachment converges over real rows; divergent same-key input fails closed', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const first = await app.evidence.attachEvidence(app.owner, evidenceInput(app, 'dup-1'));
    // Same-key retry (the crash window).
    const retry = await app.evidence.attachEvidence(app.owner, evidenceInput(app, 'dup-1'));
    assert.equal(retry.converged, true);
    assert.equal(retry.evidence.id, first.evidence.id);
    // The same FACT under a different key.
    const content = await app.evidence.attachEvidence(app.colleague, evidenceInput(app, 'dup-other-key'));
    assert.equal(content.converged, true);
    assert.equal(content.evidence.id, first.evidence.id);
    // Exactly one durable row.
    const rows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM evidence_records WHERE tenant_id = $1`, [app.tenantId]);
    assert.equal((rows.rows[0] as { n: number }).n, 1);
    // Same-key DIVERGENT input fails closed.
    const error = await evidenceError(
      app.evidence.attachEvidence(
        app.owner,
        evidenceInput(app, 'dup-1', {
          payload: { carrier: 'Forged Mutual', policy: 'XX', coverage: 1, expiresOn: '2030-01-01' },
        }),
      ),
    );
    assert.equal(error.code, 'EVIDENCE_INPUT_CONFLICT');
  } finally {
    await teardown(app);
  }
});

test('after-the-fact mutation of stored rows is detected on read (live tamper evidence)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const attached = await app.evidence.attachEvidence(app.owner, evidenceInput(app, 'tamper-1'));
    const verified = await app.evidence.verifyOutcome(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: app.workId,
      contract: contractInput(['insurance_certificate_on_file']),
      idempotencyKey: 'verify-tamper',
    });
    // Evidence payload tamper.
    await app.pool.query(`UPDATE evidence_records SET payload = '{"carrier":"Forged"}'::jsonb WHERE id = $1`, [
      attached.evidence.id,
    ]);
    const tamperedEvidence = await evidenceError(app.evidence.getEvidence(app.owner, app.tenantId, attached.evidence.id));
    assert.equal(tamperedEvidence.code, 'EVIDENCE_RECORD_TAMPERED');
    // Provenance tamper.
    await app.pool.query(
      `UPDATE evidence_records SET payload = $1::jsonb, provenance = '{"kind":"external_record","source":"fabricated","refs":[]}'::jsonb WHERE id = $2`,
      [JSON.stringify(attached.evidence.payload), attached.evidence.id],
    );
    const tamperedProvenance = await evidenceError(
      app.evidence.listEvidence(app.owner, app.tenantId, { serviceWorkId: app.workId }),
    );
    assert.equal(tamperedProvenance.code, 'EVIDENCE_RECORD_TAMPERED');
    // Decision verdict tamper.
    await app.pool.query(
      `UPDATE evidence_records SET provenance = $1::jsonb WHERE id = $2`,
      [JSON.stringify(attached.evidence.provenance), attached.evidence.id],
    );
    await app.pool.query(`UPDATE evidence_outcome_verifications SET verdict = 'not_satisfied' WHERE id = $1`, [
      verified.verification.id,
    ]);
    const tamperedDecision = await evidenceError(
      app.evidence.getOutcomeVerification(app.owner, app.tenantId, verified.verification.id),
    );
    assert.equal(tamperedDecision.code, 'VERIFICATION_RECORD_TAMPERED');
  } finally {
    await teardown(app);
  }
});

// ---------------------------------------------------------------------------
// TRUE parallel actors over real SQL
// ---------------------------------------------------------------------------

test('TRUE parallel actors converge over real SQL (independent pooled clients)', { skip: SKIP }, async () => {
  const app = await liveApp();
  const poolB = createTestPool({ connectionString: app.live.dsn, max: 2 });
  const executorB = poolExecutor(poolB);
  const authB = createAuthModule({ executor: executorB });
  const organizationsB = createOrganizationsModule({ executor: executorB, authenticator: authB.authenticate, identity: authB });
  const workB = createWorkModule({ executor: executorB, tenancy: organizationsB });
  const evidenceB = createEvidenceModule({
    executor: executorB,
    tenancy: organizationsB,
    work: workB,
    now: () => new Date('2026-09-02T12:00:00.000Z'),
  });
  try {
    // Same-key attaches: ONE durable row.
    const [a, b] = await Promise.all([
      app.evidence.attachEvidence(app.owner, evidenceInput(app, 'parallel-same-key')),
      evidenceB.attachEvidence(app.colleague, evidenceInput(app, 'parallel-same-key')),
    ]);
    assert.equal(a.evidence.id, b.evidence.id, 'ONE durable evidence row');
    const sameKeyRows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM evidence_records WHERE tenant_id = $1 AND idempotency_key = 'parallel-same-key'`, [app.tenantId]);
    assert.equal((sameKeyRows.rows[0] as { n: number }).n, 1);

    // Same-key DIVERGENT attaches on a FRESH fact domain (a requirement
    // no earlier section attached — otherwise side A would legitimately
    // CONTENT-converge on an earlier row and both sides would succeed;
    // the WORK-005 fresh-slot lesson): exactly one rejection.
    const divergentFact = (claim: string) =>
      evidenceInput(app, 'parallel-divergent', {
        requirement: 'divergent_race_requirement',
        provenance: { kind: 'operator_attestation', source: 'operator@race', refs: [] },
        payload: { claim },
      });
    const [div1, div2] = await Promise.allSettled([
      app.evidence.attachEvidence(app.owner, divergentFact('A')),
      evidenceB.attachEvidence(app.colleague, divergentFact('B')),
    ]);
    const failed = [div1, div2].filter((result) => result.status === 'rejected');
    assert.equal(failed.length, 1, 'exactly one rejection');
    if (failed[0]?.status === 'rejected') {
      await expectCode(failed[0].reason, 'EVIDENCE_INPUT_CONFLICT');
    }

    // The same FACT under different keys (fresh requirement to keep the
    // content distinct from the races above): ONE durable row.
    const [fact1, fact2] = await Promise.all([
      app.evidence.attachEvidence(
        app.owner,
        evidenceInput(app, 'parallel-fact-a', {
          requirement: 'vendor_acknowledgement',
          provenance: { kind: 'customer_approval', source: 'customer-portal', refs: ['approval://42'] },
          payload: { acknowledged: true },
        }),
      ),
      evidenceB.attachEvidence(
        app.colleague,
        evidenceInput(app, 'parallel-fact-b', {
          requirement: 'vendor_acknowledgement',
          provenance: { kind: 'customer_approval', source: 'customer-portal', refs: ['approval://42'] },
          payload: { acknowledged: true },
        }),
      ),
    ]);
    assert.equal(fact1.evidence.id, fact2.evidence.id, 'ONE durable row per evidence fact');
    const factRows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM evidence_records WHERE tenant_id = $1 AND requirement = 'vendor_acknowledgement'`, [app.tenantId]);
    assert.equal((factRows.rows[0] as { n: number }).n, 1);

    // Attach evidence for the deterministic verification race below.
    await app.evidence.attachEvidence(app.owner, evidenceInput(app, 'parallel-verify-evidence'));

    // Concurrent same-key verifications converge on ONE decision row.
    const verifyInput = {
      tenantId: app.tenantId,
      serviceWorkId: app.workId,
      contract: contractInput(['insurance_certificate_on_file', 'vendor_acknowledgement']),
      idempotencyKey: 'verify-parallel',
    };
    const [v1, v2] = await Promise.all([
      app.evidence.verifyOutcome(app.owner, verifyInput),
      evidenceB.verifyOutcome(app.colleague, verifyInput),
    ]);
    assert.equal(v1.verification.id, v2.verification.id, 'ONE durable decision row');
    assert.equal(v1.verification.verdict, v2.verification.verdict);
    assert.equal((v1.converged ? 1 : 0) + (v2.converged ? 1 : 0), 1);
    const decisionRows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM evidence_outcome_verifications WHERE tenant_id = $1 AND idempotency_key = 'verify-parallel'`, [app.tenantId]);
    assert.equal((decisionRows.rows[0] as { n: number }).n, 1);

    // A verification racing an ATTACH decides over exactly ONE
    // consistent evidence state: attach the missing requirement
    // concurrently with a NEW verification; the verdict matches its
    // pinned snapshot (either both requirements present, or one).
    const [attachRace, verifyRace] = await Promise.all([
      app.evidence.attachEvidence(
        app.owner,
        evidenceInput(app, 'parallel-attach-race', {
          requirement: 'vendor_w9_on_file',
          provenance: { kind: 'external_record', source: 'vendor-portal', refs: ['vendor://w9'] },
          payload: { form: 'W-9', signed: true },
        }),
      ),
      evidenceB.verifyOutcome(app.colleague, {
        tenantId: app.tenantId,
        serviceWorkId: app.workId,
        contract: contractInput(['insurance_certificate_on_file', 'vendor_w9_on_file']),
        idempotencyKey: 'verify-attach-race',
      }),
    ]);
    void attachRace;
    const mapped = verifyRace.verification.requirementResults.map((result) => result.satisfied);
    if (verifyRace.verification.verdict === 'satisfied') {
      assert.deepEqual(mapped, [true, true]);
    } else {
      assert.deepEqual(mapped, [true, false]);
    }
    // The attached row always exists after the race.
    const w9Rows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM evidence_records WHERE tenant_id = $1 AND requirement = 'vendor_w9_on_file'`, [app.tenantId]);
    assert.equal((w9Rows.rows[0] as { n: number }).n, 1);
  } finally {
    await poolB.end();
    await teardown(app);
  }
});

// ---------------------------------------------------------------------------
// The moving clock and cross-tenant predicates
// ---------------------------------------------------------------------------

test('a moving clock never breaks read-side integrity (the record hash pins every state write)', { skip: SKIP }, async () => {
  const app = await liveApp(() => new Date());
  try {
    const first = await app.evidence.attachEvidence(app.owner, evidenceInput(app, 'clock-1'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await app.evidence.attachEvidence(
      app.owner,
      evidenceInput(app, 'clock-2', {
        requirement: 'license_validated',
        provenance: { kind: 'system_observation', source: 'license-check-worker', refs: [] },
        payload: { state: 'CA', valid: true },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const verified = await app.evidence.verifyOutcome(app.owner, {
      tenantId: app.tenantId,
      serviceWorkId: app.workId,
      contract: contractInput(['insurance_certificate_on_file', 'license_validated']),
      idempotencyKey: 'verify-clock',
    });
    assert.equal(verified.verification.verdict, 'satisfied');
    // Reads verify hashes over rows written at DIFFERENT real instants.
    const readFirst = await app.evidence.getEvidence(app.owner, app.tenantId, first.evidence.id);
    assert.equal(readFirst.id, first.evidence.id);
    const readSecond = await app.evidence.getEvidence(app.owner, app.tenantId, second.evidence.id);
    assert.equal(readSecond.id, second.evidence.id);
    const ledger = await app.evidence.listEvidence(app.owner, app.tenantId, { serviceWorkId: app.workId });
    assert.equal(ledger.length, 2);
    assert.ok(ledger[0]!.attachedAt <= ledger[1]!.attachedAt, 'attachment order is stable');
  } finally {
    await teardown(app);
  }
});

test('cross-tenant reads carry the tenant predicate against real rows', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const attached = await app.evidence.attachEvidence(app.owner, evidenceInput(app, 'iso-1'));
    const otherOwner = await app.auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Other' });
    const other = await app.organizations.createOrganization(otherOwner, { slug: 'beta-org', displayName: 'Beta' });
    assert.deepEqual(await app.evidence.listEvidence(otherOwner, other.tenant.id), []);
    const forbidden = await evidenceError(app.evidence.listEvidence(otherOwner, app.tenantId));
    assert.equal(forbidden.code, 'TENANT_FORBIDDEN');
    // Tenant A's work identity is INVISIBLE from tenant B: the cross
    // reference fails closed at the work-tenant predicate.
    const crossError = await evidenceError(
      app.evidence.attachEvidence(otherOwner, {
        ...evidenceInput(app, 'iso-cross'),
        tenantId: other.tenant.id,
      }),
    );
    assert.equal(crossError.code, 'WORK_NOT_FOUND');
    // The other tenant's OWN work is a legitimate evidence target.
    const otherWork = await app.work.createWork(otherOwner, { tenantId: other.tenant.id, workType: 'T', title: 'Other' });
    const legitimate = await app.evidence.attachEvidence(otherOwner, {
      ...evidenceInput(app, 'iso-legit'),
      tenantId: other.tenant.id,
      serviceWorkId: otherWork.work.id,
    });
    assert.equal(legitimate.converged, false);
    assert.deepEqual(await app.evidence.listEvidence(app.owner, app.tenantId), [
      await app.evidence.getEvidence(app.owner, app.tenantId, attached.evidence.id),
    ]);
    // Tenant A's evidence is invisible to tenant B by row predicate.
    const invisible = await evidenceError(app.evidence.getEvidence(otherOwner, other.tenant.id, attached.evidence.id));
    assert.equal(invisible.code, 'EVIDENCE_NOT_FOUND');
  } finally {
    await teardown(app);
  }
});
