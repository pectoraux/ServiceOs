/**
 * Optional live-PostgreSQL integration proof for the /approvals
 * authority runtime (WORK-008). Runs ONLY when
 * SERVICEOS_TEST_DATABASE_URL points at a disposable PostgreSQL
 * database; otherwise it is skipped.
 *
 * When the variable is present this file proves the REAL durable layer:
 * - migrations 0001..0010 apply in order and are idempotent;
 * - schema backstops hold: the keyed request identity, the keyed
 *   decision identity, THE one-terminal-decision unique index, and the
 *   closed status/verdict enumerations (direct SQL violations of the
 *   backstops are rejected by the database itself);
 * - the full approval flow works over real SQL: an explicit request
 *   bound to real work/attempt and policy (the admission decision
 *   pinned through /policies' public hook; deny fails closed with no
 *   durable request), the explicit HUMAN decision (approve/reject), the
 *   review reads, and the re-observation convergence discipline;
 * - a machine principal can create requests but NEVER decide (typed
 *   DECIDER_NOT_HUMAN — an AI/agent result is never approval);
 * - a decided approval NEVER mutates the Service Work record;
 * - TRUE parallel actors (separate pooled clients) arbitrate
 *   deterministically: simultaneous approve/reject produces exactly ONE
 *   terminal decision row (the loser fails closed typed
 *   APPROVAL_DECISION_CONFLICT), simultaneous same-key decisions
 *   converge on ONE row, and concurrent same-key request creation
 *   converges on ONE row;
 * - after-the-fact mutation of stored rows is DETECTED on read
 *   (integrity hash recomputation against real rows);
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
import { createPoliciesModule } from '../src/modules/policies/index.js';
import {
  createApprovalsModule,
  ApprovalError,
  type DecideApprovalInput,
  type RequestApprovalInput,
} from '../src/modules/approvals/index.js';
import { createLiveTestDatabase, createTestPool, liveDatabaseRequested, type LiveDatabase } from './helpers/live-database.js';
import type { Principal } from '../src/modules/auth/index.js';

const SKIP = !liveDatabaseRequested();
const PASSWORD = 'correct horse battery 7';
const POLICY_KEY = 'approval.test.request-guard';

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
  policies: ReturnType<typeof createPoliciesModule>;
  approvals: ReturnType<typeof createApprovalsModule>;
  owner: Principal;
  colleague: Principal;
  outsider: Principal;
  tenantId: string;
  otherTenantId: string;
  workId: string;
  attemptId: string;
}

/**
 * The default clock ADVANCES one second per read: every durable write
 * pins a distinct instant, so ledger order (request order, decision
 * order — `ORDER BY <instant>, id`) is deterministic instead of
 * tie-breaking on random surrogate ids (the CI live-verification
 * defect class).
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
  const policies = createPoliciesModule({ executor, tenancy: organizations });
  const approvals = createApprovalsModule({ executor, tenancy: organizations, work, policies, now });
  const owner = await auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const outsider = await auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Outsider' });
  const created = await organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  const other = await organizations.createOrganization(outsider, { slug: 'beta-org', displayName: 'Beta' });
  const createdWork = await work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'CollectComplianceDocuments',
    title: 'Collect the compliance package',
  });
  const attempt = await work.createAttempt(owner, created.tenant.id, createdWork.work.id, { idempotencyKey: 'attempt-1' });
  // The applicable policy: an active base contract that allows the
  // request gate.
  const { contract } = await policies.createPolicyVersion(owner, {
    tenantId: created.tenant.id,
    policyKey: POLICY_KEY,
    scope: 'base',
    rules: [
      {
        id: 'allow-compliance-requests',
        when: { kind: 'attribute', name: 'workType', operator: 'eq', value: 'CollectComplianceDocuments' },
        effect: 'allow',
      },
    ],
    defaultEffect: 'allow',
  });
  await policies.activatePolicyVersion(owner, created.tenant.id, contract.id);
  return {
    live,
    pool,
    auth,
    organizations,
    work,
    policies,
    approvals,
    owner,
    colleague,
    outsider,
    tenantId: created.tenant.id,
    otherTenantId: other.tenant.id,
    workId: createdWork.work.id,
    attemptId: attempt.attempt.id,
  };
}

async function teardown(app: LiveApp): Promise<void> {
  await app.pool.end();
  await app.live.drop();
}

function requestInput(app: LiveApp, key: string, over: Partial<RequestApprovalInput> = {}): RequestApprovalInput {
  return {
    tenantId: app.tenantId,
    serviceWorkId: app.workId,
    policyKey: POLICY_KEY,
    subject: { summary: 'Approve the compliance package release', amount: 4200 },
    idempotencyKey: key,
    ...over,
  };
}

function decideInput(app: LiveApp, requestId: string, key: string, over: Partial<DecideApprovalInput> = {}): DecideApprovalInput {
  return {
    tenantId: app.tenantId,
    requestId,
    decision: 'approve',
    reason: 'Package verified against the checklist',
    idempotencyKey: key,
    ...over,
  };
}

/**
 * A SYNCHRONOUS rejection validator for assert.rejects: asserts the
 * typed code and returns true. (Node's assert.rejects does NOT await
 * an async validation function — it requires a truthy synchronous
 * return; an async validator returns a Promise object and fails with
 * "The validation function is expected to return 'true'" even when
 * the caught error matched — the CI live-verification defect class of
 * the first two runs, 33659722044 and 33660272203.)
 */
function expectCode(error: unknown, code: string): boolean {
  assert.ok(error instanceof ApprovalError, `expected ApprovalError, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
}

async function pendingRequest(app: LiveApp, key = 'request-1'): Promise<string> {
  const { request } = await app.approvals.requestApproval(app.owner, requestInput(app, key));
  return request.id;
}

// ---------------------------------------------------------------------------
// Migrations + schema backstops
// ---------------------------------------------------------------------------

test('migrations 0001..0010 apply in order and re-running is a no-op', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const again = await applyMigrationsPinned(app.pool, migrations());
    assert.equal(again.applied.length, 0);
    assert.equal(again.skipped, 10);
  } finally {
    await teardown(app);
  }
});

test('the schema backstops hold over real SQL (one terminal decision, closed enumerations)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const requestId = await pendingRequest(app);
    await app.approvals.decideApproval(app.colleague, decideInput(app, requestId, 'decision-1'));
    // THE one-terminal-decision backstop: a second decision row for
    // the same request cannot even be INSERTed.
    await assert.rejects(
      app.pool.query(
        `INSERT INTO approval_decisions
           (tenant_id, request_id, service_work_id, decision, reason, idempotency_key, content_hash, record_hash, decided_by, decided_at)
         VALUES ($1, $2, $3, 'reject', NULL, 'manual-1', 'x', 'y', $4, now())`,
        [app.tenantId, requestId, app.workId, app.colleague.id],
      ),
      (error: unknown) => {
        const pgError = error as { code?: string; constraint?: string };
        assert.equal(pgError.code, '23505');
        assert.equal(pgError.constraint, 'approval_decisions_request_terminal');
        return true;
      },
    );
    // The closed enumerations are schema-level.
    await assert.rejects(
      app.pool.query(`UPDATE approval_requests SET status = 'partially_approved' WHERE tenant_id = $1 AND id = $2`, [
        app.tenantId,
        requestId,
      ]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23514');
        return true;
      },
    );
    await assert.rejects(
      app.pool.query(`UPDATE approval_decisions SET decision = 'maybe' WHERE tenant_id = $1 AND request_id = $2`, [
        app.tenantId,
        requestId,
      ]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23514');
        return true;
      },
    );
  } finally {
    await teardown(app);
  }
});

// ---------------------------------------------------------------------------
// The lifecycle over real SQL
// ---------------------------------------------------------------------------

test('the full request/approve/review flow works over real SQL (AC-1/AC-3)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const { request, converged } = await app.approvals.requestApproval(
      app.owner,
      requestInput(app, 'request-1', { workAttemptId: app.attemptId }),
    );
    assert.equal(converged, false);
    assert.equal(request.status, 'pending');
    assert.equal(request.serviceWorkId, app.workId);
    assert.equal(request.workAttemptId, app.attemptId);
    assert.equal(request.policyKey, POLICY_KEY);
    // The admission decision is pinned on the durable row.
    const pinned = await app.policies.getDecision(app.owner, app.tenantId, request.policyDecisionId);
    assert.equal(pinned.outcome, 'allow');
    assert.equal(pinned.input.action, 'approval.request');
    // Approve.
    const decided = await app.approvals.decideApproval(app.colleague, decideInput(app, request.id, 'decision-1'));
    assert.equal(decided.request.status, 'approved');
    assert.equal(decided.request.decisionId, decided.decision.id);
    assert.equal(decided.decision.decidedBy, app.colleague.id);
    assert.equal(decided.decision.serviceWorkId, app.workId);
    // Review reads round-trip over real rows.
    const reread = await app.approvals.getApprovalRequest(app.owner, app.tenantId, request.id);
    assert.equal(reread.status, 'approved');
    const terminal = await app.approvals.getTerminalApprovalDecision(app.owner, app.tenantId, request.id);
    assert.equal(terminal.id, decided.decision.id);
    assert.equal((await app.approvals.listApprovalDecisions(app.owner, app.tenantId)).length, 1);
    assert.equal((await app.approvals.listApprovalRequests(app.owner, app.tenantId, { status: 'approved' })).length, 1);
    // A pending review is distinguishable (lock #30).
    const second = await app.approvals.requestApproval(app.owner, requestInput(app, 'request-2'));
    await assert.rejects(
      app.approvals.getTerminalApprovalDecision(app.owner, app.tenantId, second.request.id),
      (error: unknown) => expectCode(error, 'APPROVAL_DECISION_NOT_FOUND'),
    );
  } finally {
    await teardown(app);
  }
});

test('the reject path and the request policy gate work over real SQL', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const requestId = await pendingRequest(app, 'request-1');
    const decided = await app.approvals.decideApproval(
      app.owner,
      decideInput(app, requestId, 'decision-1', { decision: 'reject', reason: 'Certificate expired' }),
    );
    assert.equal(decided.request.status, 'rejected');
    assert.equal(decided.decision.decision, 'reject');
    assert.equal(decided.decision.reason, 'Certificate expired');
    // A policy deny fails closed with NO durable request.
    const { contract } = await app.policies.createPolicyVersion(app.owner, {
      tenantId: app.tenantId,
      policyKey: 'approval.test.deny-guard',
      scope: 'base',
      rules: [
        {
          id: 'deny-all',
          when: { kind: 'attribute', name: 'workType', operator: 'eq', value: 'CollectComplianceDocuments' },
          effect: 'deny',
        },
      ],
      defaultEffect: 'allow',
    });
    await app.policies.activatePolicyVersion(app.owner, app.tenantId, contract.id);
    await assert.rejects(
      app.approvals.requestApproval(
        app.owner,
        requestInput(app, 'request-denied', { policyKey: 'approval.test.deny-guard' }),
      ),
      (error: unknown) => expectCode(error, 'POLICY_DENIED'),
    );
    const rows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM approval_requests WHERE tenant_id = $1`, [app.tenantId]);
    assert.equal((rows.rows[0] as { n: number }).n, 1, 'a denied request is never created');
  } finally {
    await teardown(app);
  }
});

test('a machine principal can request but NEVER decide over real SQL (AC-4)', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const account = await app.organizations.createServiceAccount(app.owner, 'alpha-org', {
      displayName: 'workflow-engine',
      role: 'member',
    });
    const machine = account.member.principal;
    const requestId = await pendingRequest(app, 'request-1');
    void machine;
    // The machine principal can create another request.
    const { request } = await app.approvals.requestApproval(machine, requestInput(app, 'request-machine'));
    assert.equal(request.status, 'pending');
    // But never decide.
    await assert.rejects(
      app.approvals.decideApproval(machine, decideInput(app, requestId, 'decision-1')),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalError);
        assert.equal(error.code, 'DECIDER_NOT_HUMAN');
        return true;
      },
    );
    // No decision row exists; the request is untouched.
    const decisionRows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM approval_decisions WHERE tenant_id = $1`, [app.tenantId]);
    assert.equal((decisionRows.rows[0] as { n: number }).n, 0);
    const reread = await app.approvals.getApprovalRequest(app.owner, app.tenantId, requestId);
    assert.equal(reread.status, 'pending');
  } finally {
    await teardown(app);
  }
});

test('a decided approval never mutates the Service Work record over real SQL', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const workBefore = await app.work.getWork(app.owner, app.tenantId, app.workId);
    const requestId = await pendingRequest(app, 'request-1');
    await app.approvals.decideApproval(app.colleague, decideInput(app, requestId, 'decision-1'));
    const workAfter = await app.work.getWork(app.owner, app.tenantId, app.workId);
    assert.deepEqual(workAfter, workBefore);
    assert.equal(workAfter.status, workBefore.status);
  } finally {
    await teardown(app);
  }
});

test('keyed convergence and conflicts over real rows', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const requestId = await pendingRequest(app, 'request-1');
    const first = await app.approvals.decideApproval(app.colleague, decideInput(app, requestId, 'decision-1'));
    // Same-key retry (the crash window): converges on the same row.
    const retry = await app.approvals.decideApproval(app.owner, decideInput(app, requestId, 'decision-1'));
    assert.equal(retry.converged, true);
    assert.equal(retry.decision.id, first.decision.id);
    // Divergent same-key input fails closed.
    await assert.rejects(
      app.approvals.decideApproval(app.owner, decideInput(app, requestId, 'decision-1', { decision: 'reject' })),
      (error: unknown) => expectCode(error, 'APPROVAL_DECISION_INPUT_CONFLICT'),
    );
    // Divergent verdict under a different key: terminal arbitration.
    await assert.rejects(
      app.approvals.decideApproval(app.owner, decideInput(app, requestId, 'decision-2', { decision: 'reject' })),
      (error: unknown) => expectCode(error, 'APPROVAL_DECISION_CONFLICT'),
    );
    // Identical verdict under a different key: re-observes the durable
    // decision with attribution preserved.
    const reobserved = await app.approvals.decideApproval(app.owner, decideInput(app, requestId, 'decision-3'));
    assert.equal(reobserved.converged, true);
    assert.equal(reobserved.decision.id, first.decision.id);
    assert.equal(reobserved.decision.decidedBy, app.colleague.id);
    // Exactly one decision row, ever.
    const rows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM approval_decisions WHERE tenant_id = $1`, [app.tenantId]);
    assert.equal((rows.rows[0] as { n: number }).n, 1);
    // Request keyed convergence.
    const requestRetry = await app.approvals.requestApproval(app.owner, requestInput(app, 'request-1'));
    assert.equal(requestRetry.converged, true);
    await assert.rejects(
      app.approvals.requestApproval(app.owner, requestInput(app, 'request-1', { subject: { summary: 'Different' } })),
      (error: unknown) => expectCode(error, 'APPROVAL_REQUEST_INPUT_CONFLICT'),
    );
    const requestRows = await app.pool.query(`SELECT COUNT(*)::int AS n FROM approval_requests WHERE tenant_id = $1`, [app.tenantId]);
    assert.equal((requestRows.rows[0] as { n: number }).n, 1);
  } finally {
    await teardown(app);
  }
});

test('after-the-fact mutation of stored rows is DETECTED on read over real SQL', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const requestId = await pendingRequest(app, 'request-1');
    const { decision } = await app.approvals.decideApproval(app.colleague, decideInput(app, requestId, 'decision-1'));
    // A direct persistence-layer edit of the request row.
    await app.pool.query(
      `UPDATE approval_requests SET subject = jsonb_build_object('summary', 'Tampered') WHERE tenant_id = $1 AND id = $2`,
      [app.tenantId, requestId],
    );
    await assert.rejects(
      app.approvals.getApprovalRequest(app.owner, app.tenantId, requestId),
      (error: unknown) => expectCode(error, 'APPROVAL_REQUEST_RECORD_TAMPERED'),
    );
    // Restore a consistent subject hash? Impossible without the module:
    // the record hash covers the row core; only the module's own paths
    // can rewrite it coherently. A decision-row edit is detected too.
    await app.pool.query(`UPDATE approval_decisions SET reason = 'Tampered' WHERE tenant_id = $1 AND id = $2`, [
      app.tenantId,
      decision.id,
    ]);
    await assert.rejects(
      app.approvals.getApprovalDecision(app.owner, app.tenantId, decision.id),
      (error: unknown) => expectCode(error, 'APPROVAL_DECISION_RECORD_TAMPERED'),
    );
  } finally {
    await teardown(app);
  }
});

test('cross-tenant reads carry the tenant predicate against real rows', { skip: SKIP }, async () => {
  const app = await liveApp();
  try {
    const requestId = await pendingRequest(app, 'request-1');
    // A request in tenant A is invisible to tenant B (the outsider is
    // authorized in their own tenant).
    await assert.rejects(
      app.approvals.getApprovalRequest(app.outsider, app.otherTenantId, requestId),
      (error: unknown) => expectCode(error, 'APPROVAL_REQUEST_NOT_FOUND'),
    );
    // And the outsider cannot even see the tenant A ledger.
    await assert.rejects(
      app.approvals.listApprovalRequests(app.outsider, app.tenantId),
      (error: unknown) => expectCode(error, 'TENANT_FORBIDDEN'),
    );
    assert.equal((await app.approvals.listApprovalRequests(app.outsider, app.otherTenantId)).length, 0);
  } finally {
    await teardown(app);
  }
});

// ---------------------------------------------------------------------------
// TRUE parallel actors over independent pooled clients
// ---------------------------------------------------------------------------

test('TRUE parallel approve/reject over real SQL: ONE terminal decision, the loser fails closed typed (invariant 6)', { skip: SKIP }, async () => {
  const app = await liveApp();
  const poolB = createTestPool({ connectionString: app.live.dsn, max: 2 });
  const executorB = poolExecutor(poolB);
  const authB = createAuthModule({ executor: executorB });
  const organizationsB = createOrganizationsModule({ executor: executorB, authenticator: authB.authenticate, identity: authB });
  const workB = createWorkModule({ executor: executorB, tenancy: organizationsB });
  const policiesB = createPoliciesModule({ executor: executorB, tenancy: organizationsB });
  const approvalsB = createApprovalsModule({
    executor: executorB,
    tenancy: organizationsB,
    work: workB,
    policies: policiesB,
    now: () => new Date('2026-09-02T12:00:00.000Z'),
  });
  try {
    const requestId = await pendingRequest(app, 'request-race');
    const [approveResult, rejectResult] = await Promise.allSettled([
      app.approvals.decideApproval(app.owner, decideInput(app, requestId, 'decision-a', { decision: 'approve', reason: 'approve by owner' })),
      approvalsB.decideApproval(app.colleague, decideInput(app, requestId, 'decision-b', { decision: 'reject', reason: 'reject by colleague' })),
    ]);
    const fulfilled = [approveResult, rejectResult].filter((result) => result.status === 'fulfilled');
    const failed = [approveResult, rejectResult].filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one decision wins');
    assert.equal(failed.length, 1, 'exactly one decision loses');
    if (failed[0]?.status === 'rejected') {
      expectCode(failed[0].reason, 'APPROVAL_DECISION_CONFLICT');
    }
    // EXACTLY one decision row exists — the unique backstop held under
    // a true race.
    const rows = await app.pool.query(
      `SELECT COUNT(*)::int AS n FROM approval_decisions WHERE tenant_id = $1 AND request_id = $2`,
      [app.tenantId, requestId],
    );
    assert.equal((rows.rows[0] as { n: number }).n, 1);
    // The request terminalized consistently.
    const request = await app.approvals.getApprovalRequest(app.owner, app.tenantId, requestId);
    assert.notEqual(request.status, 'pending');
    const terminal = await app.approvals.getTerminalApprovalDecision(app.owner, app.tenantId, requestId);
    assert.equal(request.decisionId, terminal.id);
    assert.equal(
      request.status === 'approved' ? terminal.decision : 'reject',
      terminal.decision,
      'the terminal status matches the recorded decision',
    );
  } finally {
    await poolB.end();
    await teardown(app);
  }
});

test('TRUE parallel same-key decisions converge on ONE row over real SQL', { skip: SKIP }, async () => {
  const app = await liveApp();
  const poolB = createTestPool({ connectionString: app.live.dsn, max: 2 });
  const executorB = poolExecutor(poolB);
  const authB = createAuthModule({ executor: executorB });
  const organizationsB = createOrganizationsModule({ executor: executorB, authenticator: authB.authenticate, identity: authB });
  const workB = createWorkModule({ executor: executorB, tenancy: organizationsB });
  const policiesB = createPoliciesModule({ executor: executorB, tenancy: organizationsB });
  const approvalsB = createApprovalsModule({
    executor: executorB,
    tenancy: organizationsB,
    work: workB,
    policies: policiesB,
    now: () => new Date('2026-09-02T12:00:00.000Z'),
  });
  try {
    const requestId = await pendingRequest(app, 'request-same-key');
    const input = decideInput(app, requestId, 'decision-1');
    const [a, b] = await Promise.all([
      app.approvals.decideApproval(app.colleague, input),
      approvalsB.decideApproval(app.owner, input),
    ]);
    assert.equal(a.decision.id, b.decision.id, 'ONE durable decision row');
    assert.equal(a.converged !== b.converged, true);
    const rows = await app.pool.query(
      `SELECT COUNT(*)::int AS n FROM approval_decisions WHERE tenant_id = $1 AND request_id = $2`,
      [app.tenantId, requestId],
    );
    assert.equal((rows.rows[0] as { n: number }).n, 1);
  } finally {
    await poolB.end();
    await teardown(app);
  }
});

test('TRUE parallel same-key request creation converges on ONE row over real SQL', { skip: SKIP }, async () => {
  const app = await liveApp();
  const poolB = createTestPool({ connectionString: app.live.dsn, max: 2 });
  const executorB = poolExecutor(poolB);
  const authB = createAuthModule({ executor: executorB });
  const organizationsB = createOrganizationsModule({ executor: executorB, authenticator: authB.authenticate, identity: authB });
  const workB = createWorkModule({ executor: executorB, tenancy: organizationsB });
  const policiesB = createPoliciesModule({ executor: executorB, tenancy: organizationsB });
  const approvalsB = createApprovalsModule({
    executor: executorB,
    tenancy: organizationsB,
    work: workB,
    policies: policiesB,
    now: () => new Date('2026-09-02T12:00:00.000Z'),
  });
  try {
    const input = requestInput(app, 'parallel-request');
    const [a, b] = await Promise.all([
      app.approvals.requestApproval(app.owner, input),
      approvalsB.requestApproval(app.colleague, input),
    ]);
    assert.equal(a.request.id, b.request.id, 'ONE durable request row');
    assert.equal(a.converged !== b.converged, true);
    const rows = await app.pool.query(
      `SELECT COUNT(*)::int AS n FROM approval_requests WHERE tenant_id = $1 AND idempotency_key = 'parallel-request'`,
      [app.tenantId],
    );
    assert.equal((rows.rows[0] as { n: number }).n, 1);
  } finally {
    await poolB.end();
    await teardown(app);
  }
});
