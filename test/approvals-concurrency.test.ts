/**
 * Concurrency proof: the /approvals authority's deterministic terminal
 * arbitration under interleaving (WORK-008, required class
 * `concurrency`).
 *
 * The in-memory store's async hooks inject deterministic interleaving
 * points BEFORE each synchronous critical section (the exact semantics
 * of the advisory-locked SQL transactions), so these proofs exercise
 * real check-then-act races between INDEPENDENT actors:
 *
 * - SIMULTANEOUS APPROVE/REJECT (activation invariant 6): exactly ONE
 *   terminal decision exists afterwards; the request terminalizes to
 *   exactly one of approved/rejected; the losing side fails closed
 *   typed APPROVAL_DECISION_CONFLICT referencing the durable winner;
 *   every re-read is consistent (one row, one state, one decision);
 * - simultaneous SAME-KEY decisions converge on ONE immutable
 *   decision row;
 * - simultaneous same-key DIVERGENT decisions: one wins, one fails
 *   closed typed APPROVAL_DECISION_INPUT_CONFLICT;
 * - simultaneous same-outcome decisions under different keys: one row;
 *   the second converges on the recorded decision (attribution
 *   preserved);
 * - the crash window (the caller crashed after the durable commit and
 *   re-submits): the same-key retry converges on the same row, never a
 *   duplicate; a different-key retry of the same verdict re-observes
 *   the recorded decision;
 * - concurrent request creation: same key + identical content
 *   converges on ONE row; same key + divergent content produces
 *   exactly one typed conflict and one durable row;
 * - mutation discrimination: a store whose decide drops the
 *   terminal-state guard admits a SECOND decision row for one request
 *   (ambiguous terminal state) — the guard is load-bearing, and the
 *   faithful store never produces that state.
 *
 * The SQL-level equivalents of the same races run against live
 * PostgreSQL in test/approvals.integration.test.ts (CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApprovalsApp,
  InMemoryApprovalStore,
  type ApprovalAuthorityApp,
} from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import {
  ApprovalError,
  computeApprovalRequestRecordHash,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type DecideApprovalStoreInput,
} from '../src/modules/approvals/index.js';

const PASSWORD = 'correct horse battery 7';
const NOW = new Date('2026-09-02T12:00:00.000Z');
const POLICY_KEY = 'approval.test.request-guard';

/** Advancing clock: every write pins a distinct instant (durable order). */
function advancingClock(): () => Date {
  let tick = 0;
  return () => new Date(NOW.getTime() + tick++ * 1000);
}

interface Base {
  app: ApprovalAuthorityApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
  workId: string;
}

async function base(
  decideRace?: () => Promise<void>,
  createRace?: () => Promise<void>,
): Promise<Base> {
  const app = buildApprovalsApp({
    now: advancingClock(),
    approvalStoreOptions: { beforeDecide: decideRace, beforeCreateRequest: createRace },
  });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'colleague@a.com', password: PASSWORD, displayName: 'Colleague' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  const { work } = await app.work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'CollectComplianceDocuments',
    title: 'Collect the subcontractor compliance package',
  });
  const { contract } = await app.policies.createPolicyVersion(owner, {
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
  await app.policies.activatePolicyVersion(owner, created.tenant.id, contract.id);
  return { app, owner, colleague, tenantId: created.tenant.id, workId: work.id };
}

async function pendingRequest(b: Base, key = 'request-1'): Promise<string> {
  const { request } = await b.app.approvals.requestApproval(b.owner, {
    tenantId: b.tenantId,
    serviceWorkId: b.workId,
    policyKey: POLICY_KEY,
    subject: { summary: 'Approve the compliance package release', amount: 4200 },
    idempotencyKey: key,
  });
  return request.id;
}

function decide(b: Base, requestId: string, key: string, decision: 'approve' | 'reject') {
  return b.app.approvals.decideApproval(b.colleague, {
    tenantId: b.tenantId,
    requestId,
    decision,
    reason: `${decision} by colleague`,
    idempotencyKey: key,
  });
}

function decideAs(principal: Principal, b: Base, requestId: string, key: string, decision: 'approve' | 'reject') {
  return b.app.approvals.decideApproval(principal, {
    tenantId: b.tenantId,
    requestId,
    decision,
    reason: `${decision} decision`,
    idempotencyKey: key,
  });
}

/** Both racers pass the hook, then interleave into the critical section. */
function twoPhaseRace(): { race: () => Promise<void>; done: () => Promise<void> } {
  let waiting = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const race = async (): Promise<void> => {
    waiting += 1;
    if (waiting >= 2) {
      release();
    }
    await gate;
  };
  return { race, done: () => gate };
}

/** A safety timeout so a broken gate fails the test instead of hanging it. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
      timer.unref();
    }),
  ]);
}

// ---------------------------------------------------------------------------
// THE terminal arbitration races (activation invariant 6)
// ---------------------------------------------------------------------------

test('simultaneous approve/reject: ONE terminal decision, the loser fails closed typed (invariant 6)', async () => {
  const { race, done } = twoPhaseRace();
  const b = await base(race);
  const requestId = await pendingRequest(b);
  const approving = withTimeout(decideAs(b.owner, b, requestId, 'decision-a', 'approve'), 5000, 'approve racer');
  const rejecting = withTimeout(decideAs(b.colleague, b, requestId, 'decision-b', 'reject'), 5000, 'reject racer');
  await done;
  const results = await Promise.allSettled([approving, rejecting]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one decision wins');
  assert.equal(rejected.length, 1, 'exactly one decision loses');
  // The loser fails closed typed, referencing the durable winner.
  const loser = rejected[0]?.reason as ApprovalError;
  assert.ok(loser instanceof ApprovalError, `expected ApprovalError, got ${String(loser)}`);
  assert.equal(loser.code, 'APPROVAL_DECISION_CONFLICT');
  const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof decide>>>).value;
  assert.match(loser.message, new RegExp(winner.decision.id));
  // EXACTLY one decision row exists for the request — never two.
  assert.equal(b.app.approvalStore.decisions.size, 1);
  const terminalDecision = await b.app.approvals.getTerminalApprovalDecision(b.owner, b.tenantId, requestId);
  assert.equal(terminalDecision.id, winner.decision.id);
  // The request terminalized to exactly one state, consistent with the
  // recorded decision, on every read surface.
  const request = await b.app.approvals.getApprovalRequest(b.owner, b.tenantId, requestId);
  assert.equal(request.status, winner.decision.decision === 'approve' ? 'approved' : 'rejected');
  assert.equal(request.decisionId, winner.decision.id);
  assert.equal(request.status !== 'approved' || winner.decision.decision === 'approve', true);
});

test('simultaneous same-key decisions converge on ONE immutable row', async () => {
  const { race, done } = twoPhaseRace();
  const b = await base(race);
  const requestId = await pendingRequest(b);
  // Identical logical decision input (same verdict AND reason — the
  // keyed convergence comparison) submitted by two actors.
  const first = withTimeout(
    b.app.approvals.decideApproval(b.colleague, {
      tenantId: b.tenantId, requestId, decision: 'approve', reason: 'Package verified', idempotencyKey: 'decision-1',
    }),
    5000,
    'first same-key racer',
  );
  const second = withTimeout(
    b.app.approvals.decideApproval(b.owner, {
      tenantId: b.tenantId, requestId, decision: 'approve', reason: 'Package verified', idempotencyKey: 'decision-1',
    }),
    5000,
    'second same-key racer',
  );
  await done;
  const [a, c] = await Promise.all([first, second]);
  assert.equal(b.app.approvalStore.decisions.size, 1);
  assert.equal(a.decision.id, c.decision.id);
  assert.equal(a.converged !== c.converged, true, 'exactly one of the two created the row');
  assert.equal((await b.app.approvals.getApprovalRequest(b.owner, b.tenantId, requestId)).status, 'approved');
});

test('simultaneous same-key DIVERGENT decisions: one wins, one typed input conflict', async () => {
  const { race, done } = twoPhaseRace();
  const b = await base(race);
  const requestId = await pendingRequest(b);
  const approving = withTimeout(decide(b, requestId, 'decision-1', 'approve'), 5000, 'approve divergent racer');
  const rejecting = withTimeout(decideAs(b.owner, b, requestId, 'decision-1', 'reject'), 5000, 'reject divergent racer');
  await done;
  const results = await Promise.allSettled([approving, rejecting]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected')?.reason as ApprovalError;
  assert.ok(rejected instanceof ApprovalError);
  assert.equal(rejected.code, 'APPROVAL_DECISION_INPUT_CONFLICT');
  assert.equal(b.app.approvalStore.decisions.size, 1);
  const request = await b.app.approvals.getApprovalRequest(b.owner, b.tenantId, requestId);
  assert.ok(request.status === 'approved' || request.status === 'rejected');
  assert.notEqual(request.status, 'pending');
});

test('simultaneous same-outcome decisions under different keys: one row, the second converges with attribution preserved', async () => {
  const { race, done } = twoPhaseRace();
  const b = await base(race);
  const requestId = await pendingRequest(b);
  const approving = withTimeout(decide(b, requestId, 'decision-a', 'approve'), 5000, 'approve different-key racer');
  const alsoApproving = withTimeout(decideAs(b.owner, b, requestId, 'decision-b', 'approve'), 5000, 'second different-key racer');
  await done;
  const [a, c] = await Promise.all([approving, alsoApproving]);
  assert.equal(b.app.approvalStore.decisions.size, 1, 'one decision row, ever');
  assert.equal(a.decision.id, c.decision.id);
  assert.equal(a.converged !== c.converged, true);
  // The first decider keeps the attribution (the durable row is the
  // authority; the second re-observes it).
  const recorded = a.converged ? c.decision : a.decision;
  assert.equal(recorded.decidedBy, b.colleague.id);
  assert.equal(recorded.reason, 'approve by colleague');
});

// ---------------------------------------------------------------------------
// The crash window
// ---------------------------------------------------------------------------

test('the crash window: a retry after the durable commit converges, never a duplicate', async () => {
  const b = await base();
  const requestId = await pendingRequest(b);
  const first = await decide(b, requestId, 'decision-1', 'approve');
  // The caller crashed after commit and re-submits the SAME key.
  const retry = await decide(b, requestId, 'decision-1', 'approve');
  assert.equal(retry.converged, true);
  assert.equal(retry.decision.id, first.decision.id);
  assert.equal(b.app.approvalStore.decisions.size, 1);
  // A different-key retry of the same verdict re-observes the row.
  const otherKey = await decideAs(b.owner, b, requestId, 'decision-2', 'approve');
  assert.equal(otherKey.converged, true);
  assert.equal(otherKey.decision.id, first.decision.id);
  assert.equal(otherKey.decision.decidedBy, b.colleague.id);
  assert.equal(b.app.approvalStore.decisions.size, 1);
});

// ---------------------------------------------------------------------------
// Concurrent request creation
// ---------------------------------------------------------------------------

test('concurrent request creation: same key + identical content converges on ONE row', async () => {
  const { race, done } = twoPhaseRace();
  const b = await base(undefined, race);
  const subject = { summary: 'Approve the compliance package release', amount: 4200 };
  const first = withTimeout(b.app.approvals.requestApproval(b.owner, {
    tenantId: b.tenantId, serviceWorkId: b.workId, policyKey: POLICY_KEY, subject, idempotencyKey: 'request-1',
  }), 5000, 'first creator');
  const second = withTimeout(b.app.approvals.requestApproval(b.colleague, {
    tenantId: b.tenantId, serviceWorkId: b.workId, policyKey: POLICY_KEY, subject, idempotencyKey: 'request-1',
  }), 5000, 'second creator');
  await done;
  const [a, c] = await Promise.all([first, second]);
  assert.equal(b.app.approvalStore.requests.size, 1);
  assert.equal(a.request.id, c.request.id);
  assert.equal(a.converged !== c.converged, true);
  assert.equal((await b.app.approvals.listApprovalRequests(b.owner, b.tenantId)).length, 1);
});

test('concurrent request creation: same key + divergent content produces one row and one typed conflict', async () => {
  const { race, done } = twoPhaseRace();
  const b = await base(undefined, race);
  const first = withTimeout(b.app.approvals.requestApproval(b.owner, {
    tenantId: b.tenantId, serviceWorkId: b.workId, policyKey: POLICY_KEY,
    subject: { summary: 'Content A' }, idempotencyKey: 'request-1',
  }), 5000, 'first divergent creator');
  const second = withTimeout(b.app.approvals.requestApproval(b.colleague, {
    tenantId: b.tenantId, serviceWorkId: b.workId, policyKey: POLICY_KEY,
    subject: { summary: 'Content B' }, idempotencyKey: 'request-1',
  }), 5000, 'second divergent creator');
  await done;
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected')?.reason as ApprovalError;
  assert.ok(rejected instanceof ApprovalError);
  assert.equal(rejected.code, 'APPROVAL_REQUEST_INPUT_CONFLICT');
  assert.equal(b.app.approvalStore.requests.size, 1);
});

// ---------------------------------------------------------------------------
// Mutation discrimination: the guards are load-bearing
// ---------------------------------------------------------------------------

/**
 * A BROKEN store: its decide path re-opens the request (status back
 * to 'pending') before delegating, dropping the terminal-state
 * arbitration — the second divergent decision then "succeeds" and
 * lands a SECOND decision row for ONE request. Exactly the ambiguous
 * terminal state the faithful store's typed conflict makes
 * impossible.
 */
class GuardDroppingStore extends InMemoryApprovalStore {
  async decide(input: DecideApprovalStoreInput): Promise<{
    request: ApprovalRequestRecord;
    decision: ApprovalDecisionRecord;
    converged: boolean;
  }> {
    const stored = this.requests.get(input.requestId);
    if (stored !== undefined && stored.tenantId === input.tenantId && stored.status !== 'pending') {
      // The dropped guard: pretend the request is still pending.
      stored.status = 'pending';
      stored.decisionId = null;
      stored.recordHash = computeApprovalRequestRecordHash(stored);
    }
    return super.decide(input);
  }
}

test('mutation discrimination: a store that drops the terminal arbitration admits a divergent second decision (the guard is load-bearing)', async () => {
  const b = await base();
  const requestId = await pendingRequest(b);
  // The faithful store: the divergent second decision fails closed.
  await decide(b, requestId, 'decision-1', 'approve');
  await assert.rejects(
    decideAs(b.owner, b, requestId, 'decision-2', 'reject'),
    (error: unknown) => error instanceof ApprovalError && error.code === 'APPROVAL_DECISION_CONFLICT' && true,
  );
  assert.equal(b.app.approvalStore.decisions.size, 1, 'the faithful store never holds a second decision row');

  // The broken store: the arbitration is gone — a SECOND decision row
  // lands for ONE request and the terminal state flips. That is
  // exactly the ambiguous state the guard prevents.
  const brokenApp = buildApprovalsApp({ now: advancingClock() });
  const owner = await brokenApp.auth.registerHuman({ email: 'owner@x.com', password: PASSWORD, displayName: 'Owner' });
  const created = await brokenApp.organizations.createOrganization(owner, { slug: 'x-org', displayName: 'X' });
  const { work } = await brokenApp.work.createWork(owner, {
    tenantId: created.tenant.id, workType: 'CollectComplianceDocuments', title: 'X work',
  });
  const { contract } = await brokenApp.policies.createPolicyVersion(owner, {
    tenantId: created.tenant.id, policyKey: POLICY_KEY, scope: 'base',
    rules: [
      { id: 'allow', when: { kind: 'attribute', name: 'workType', operator: 'eq', value: 'CollectComplianceDocuments' }, effect: 'allow' },
    ],
    defaultEffect: 'allow',
  });
  await brokenApp.policies.activatePolicyVersion(owner, created.tenant.id, contract.id);
  const brokenStore = new GuardDroppingStore({ now: advancingClock() });
  const { createApprovalsModule } = await import('../src/modules/approvals/index.js');
  const approvals = createApprovalsModule({
    store: brokenStore,
    tenancy: brokenApp.organizations,
    work: brokenApp.work,
    policies: brokenApp.policies,
    now: advancingClock(),
  });
  const { request } = await approvals.requestApproval(owner, {
    tenantId: created.tenant.id, serviceWorkId: work.id, policyKey: POLICY_KEY,
    subject: { summary: 'Broken store proof' }, idempotencyKey: 'request-1',
  });
  const brokenFirst = await approvals.decideApproval(owner, {
    tenantId: created.tenant.id, requestId: request.id, decision: 'approve', reason: 'first', idempotencyKey: 'd-1',
  });
  assert.equal(brokenFirst.request.status, 'approved');
  const brokenSecond = await approvals.decideApproval(owner, {
    tenantId: created.tenant.id, requestId: request.id, decision: 'reject', reason: 'second', idempotencyKey: 'd-2',
  });
  // The broken store let the divergent decision through: TWO decision
  // rows exist for ONE request and the terminal state flipped — the
  // ambiguous state the faithful guard makes impossible.
  assert.equal(brokenStore.decisions.size, 2);
  assert.equal(brokenSecond.request.status, 'rejected');
});
