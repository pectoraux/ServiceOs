/**
 * Behavioral + discrimination proofs for the /approvals authority
 * (WORK-008, required classes `dynamic` + `discrimination`).
 *
 * Behavioral (request/approve/reject/review lifecycle):
 * - a request is created PENDING, bound to a REAL Service Work (and,
 *   optionally, one of its attempts) and to the applicable business
 *   policy with the admission decision pinned (AC-1; invariant 2);
 * - the policy gate composes through /policies' public hook: allow
 *   pins the decision, deny fails closed with NO durable request, and
 *   a policy key with no active version fails closed (fail-closed
 *   with no base policy);
 * - an authorized HUMAN decides: approve terminalizes to 'approved',
 *   reject to 'rejected', the decision row is durable, attributable
 *   and immutable with its reason (AC-3);
 * - review reads round-trip: get/list with filters, the terminal
 *   decision of a request, and a PENDING review is distinguishable
 *   from a decided one and from a missing request (lock #30);
 * - keyed convergence: the same request key + content converges; the
 *   same decision key + input converges; a crash-window retry
 *   converges on the durable row.
 *
 * Discrimination / mutation:
 * - AN AI RESULT DOES NOT EQUAL APPROVAL (AC-4; invariants 3/5): an
 *   authorized MACHINE principal can create requests but NEVER decide
 *   (typed DECIDER_NOT_HUMAN before any durable effect — there is no
 *   path from an agent claim to a decision); a subject citing foreign
 *   AI execution references stays opaque DATA under approval and the
 *   request stays PENDING until an explicit human decision;
 * - a divergent decision against the recorded terminal decision fails
 *   closed (invariant 6 arbitration, sequential form); an identical
 *   verdict re-observes the durable decision;
 * - a decided approval NEVER mutates Service Work state (/workflow
 *   owns transitions);
 * - after-the-fact mutation of stored rows is DETECTED on read
 *   (tamper-evident surface);
 * - authorization happens BEFORE any domain data access (denials
 *   never touch domain data — store read counters prove it);
 * - malformed inputs, foreign works/attempts and cross-tenant reads
 *   all fail closed with typed codes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovalsApp, type ApprovalAuthorityApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import {
  ApprovalError,
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATUSES,
  type DecideApprovalInput,
  type RequestApprovalInput,
} from '../src/modules/approvals/index.js';

const PASSWORD = 'correct horse battery 7';
const NOW = new Date('2026-09-02T12:00:00.000Z');
const MISSING_UUID = '00000000-0000-4000-8000-000000000000';
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
  outsider: Principal;
  tenantId: string;
  otherTenantId: string;
  workId: string;
  attemptId: string;
  otherWorkId: string;
}

async function base(): Promise<Base> {
  const app = buildApprovalsApp({ now: advancingClock() });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'colleague@a.com', password: PASSWORD, displayName: 'Colleague' });
  const outsider = await app.auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Outsider' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  const other = await app.organizations.createOrganization(outsider, { slug: 'beta-org', displayName: 'Beta' });
  const { work } = await app.work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'CollectComplianceDocuments',
    title: 'Collect the subcontractor compliance package',
  });
  const { attempt } = await app.work.createAttempt(owner, created.tenant.id, work.id, { idempotencyKey: 'attempt-1' });
  const { work: otherWork } = await app.work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'ValidateInsuranceCertificate',
    title: 'A different work item',
  });
  // The applicable policy: an active base contract that allows the
  // request gate (created through /policies' own public surface).
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
  return {
    app,
    owner,
    colleague,
    outsider,
    tenantId: created.tenant.id,
    otherTenantId: other.tenant.id,
    workId: work.id,
    attemptId: attempt.id,
    otherWorkId: otherWork.id,
  };
}

function requestInput(
  tenantId: string,
  serviceWorkId: string,
  key: string,
  over: Partial<RequestApprovalInput> = {},
): RequestApprovalInput {
  return {
    tenantId,
    serviceWorkId,
    policyKey: POLICY_KEY,
    subject: { summary: 'Approve the compliance package release', amount: 4200 },
    idempotencyKey: key,
    ...over,
  };
}

function decideInput(
  tenantId: string,
  requestId: string,
  key: string,
  over: Partial<DecideApprovalInput> = {},
): DecideApprovalInput {
  return {
    tenantId,
    requestId,
    decision: 'approve',
    reason: 'Package verified against the checklist',
    idempotencyKey: key,
    ...over,
  };
}

function assertTyped(error: unknown, code: string): ApprovalError {
  assert.ok(error instanceof ApprovalError, `expected ApprovalError, got ${String(error)}`);
  assert.equal(error.code, code);
  return error;
}

// ---------------------------------------------------------------------------
// Behavioral: request/approve/reject/review lifecycle
// ---------------------------------------------------------------------------

test('a request is created pending, bound to work, attempt and the applicable policy (AC-1)', async () => {
  const b = await base();
  const { request, converged } = await b.app.approvals.requestApproval(
    b.owner,
    requestInput(b.tenantId, b.workId, 'request-1', { workAttemptId: b.attemptId }),
  );
  assert.equal(converged, false);
  assert.equal(request.status, 'pending');
  assert.equal(request.tenantId, b.tenantId);
  assert.equal(request.serviceWorkId, b.workId);
  assert.equal(request.workAttemptId, b.attemptId);
  assert.equal(request.policyKey, POLICY_KEY);
  assert.deepEqual(request.subject, { summary: 'Approve the compliance package release', amount: 4200 });
  assert.equal(request.requestedBy, b.owner.id);
  assert.equal(request.decisionId, null);
  assert.ok(request.id.length > 0 && request.recordHash.length > 0 && request.contentHash.length > 0);
  // The admission decision is pinned: /policies' own ledger holds it.
  const pinned = await b.app.policies.getDecision(b.owner, b.tenantId, request.policyDecisionId);
  assert.equal(pinned.outcome, 'allow');
  assert.equal(pinned.input.action, 'approval.request');
  assert.equal(pinned.idempotencyKey, `approval.request:request-1`);
  // The row is the only one.
  const listed = await b.app.approvals.listApprovalRequests(b.owner, b.tenantId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, request.id);
});

test('work-level requests carry a null attempt attribution', async () => {
  const b = await base();
  const { request } = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-1'));
  assert.equal(request.workAttemptId, null);
});

test('the policy gate composes through /policies: a deny fails closed with NO durable request', async () => {
  const b = await base();
  // An active base contract that DENIES the approval request gate.
  const { contract } = await b.app.policies.createPolicyVersion(b.owner, {
    tenantId: b.tenantId,
    policyKey: 'approval.test.deny-guard',
    scope: 'base',
    rules: [
      {
        id: 'deny-all-requests',
        when: { kind: 'attribute', name: 'workType', operator: 'eq', value: 'CollectComplianceDocuments' },
        effect: 'deny',
      },
    ],
    defaultEffect: 'allow',
  });
  await b.app.policies.activatePolicyVersion(b.owner, b.tenantId, contract.id);
  await assert.rejects(
    b.app.approvals.requestApproval(
      b.owner,
      requestInput(b.tenantId, b.workId, 'request-denied', { policyKey: 'approval.test.deny-guard' }),
    ),
    (error: unknown) => {
      const typed = assertTyped(error, 'POLICY_DENIED');
      assert.match(typed.message, /approval policy gate denied/);
      return true;
    },
  );
  assert.equal(b.app.approvalStore.requests.size, 0, 'a denied request is never created');
});

test('a policy key with no active version fails closed (fail-closed deny with no base policy)', async () => {
  const b = await base();
  await assert.rejects(
    b.app.approvals.requestApproval(
      b.owner,
      requestInput(b.tenantId, b.workId, 'request-nopolicy', { policyKey: 'approval.test.missing-guard' }),
    ),
    (error: unknown) => {
      // /policies composes fail-closed with no base policy: the gate
      // returns a DENY decision, which this module surfaces as
      // POLICY_DENIED (the request is never created).
      const typed = assertTyped(error, 'POLICY_DENIED');
      assert.match(typed.message, /approval policy gate denied/);
      return true;
    },
  );
  assert.equal(b.app.approvalStore.requests.size, 0);
});

test('a genuine policy evaluation failure fails closed wrapped as POLICY_EVALUATION_FAILED', async () => {
  const b = await base();
  // A contract whose evaluation genuinely fails: an ordered comparison
  // on the string workType attribute is a type drift, not a policy
  // outcome (the policies evaluator fails closed TYPE_MISMATCH).
  const { contract } = await b.app.policies.createPolicyVersion(b.owner, {
    tenantId: b.tenantId,
    policyKey: 'approval.test.type-drift',
    scope: 'base',
    rules: [
      {
        id: 'type-drift',
        when: { kind: 'attribute', name: 'workType', operator: 'gt', value: 5 },
        effect: 'deny',
      },
    ],
    defaultEffect: 'allow',
  });
  await b.app.policies.activatePolicyVersion(b.owner, b.tenantId, contract.id);
  await assert.rejects(
    b.app.approvals.requestApproval(
      b.owner,
      requestInput(b.tenantId, b.workId, 'request-type-drift', { policyKey: 'approval.test.type-drift' }),
    ),
    (error: unknown) => {
      const typed = assertTyped(error, 'POLICY_EVALUATION_FAILED');
      assert.match(typed.message, /policy gate for key "approval.test.type-drift" failed/);
      return true;
    },
  );
  assert.equal(b.app.approvalStore.requests.size, 0);
});

test('approve terminalizes the request and records the durable human decision (AC-3)', async () => {
  const b = await base();
  const { request } = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-1'));
  const decided = await b.app.approvals.decideApproval(
    b.colleague,
    decideInput(b.tenantId, request.id, 'decision-1', {
      decision: 'approve',
      reason: 'Checked every document in the package',
    }),
  );
  assert.equal(decided.converged, false);
  // The request terminalized exactly once.
  assert.equal(decided.request.status, 'approved');
  assert.equal(decided.request.id, request.id);
  assert.equal(decided.request.decisionId, decided.decision.id);
  // The decision row: explicit, attributable, immutable.
  assert.equal(decided.decision.decision, 'approve');
  assert.equal(decided.decision.decidedBy, b.colleague.id);
  assert.equal(decided.decision.reason, 'Checked every document in the package');
  assert.equal(decided.decision.requestId, request.id);
  assert.equal(decided.decision.serviceWorkId, b.workId);
  assert.ok(decided.decision.recordHash.length > 0);
  // The re-read agrees (durable, not a projection).
  const reread = await b.app.approvals.getApprovalRequest(b.owner, b.tenantId, request.id);
  assert.equal(reread.status, 'approved');
  assert.equal(reread.decisionId, decided.decision.id);
});

test('reject terminalizes the request with the reject verdict', async () => {
  const b = await base();
  const { request } = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-1'));
  const decided = await b.app.approvals.decideApproval(
    b.colleague,
    decideInput(b.tenantId, request.id, 'decision-1', { decision: 'reject', reason: 'Certificate expired' }),
  );
  assert.equal(decided.request.status, 'rejected');
  assert.equal(decided.decision.decision, 'reject');
  assert.equal(decided.decision.reason, 'Certificate expired');
});

test('review reads round-trip: get, list with filters, and the terminal decision (lock #30)', async () => {
  const b = await base();
  const first = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-1'));
  const second = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.otherWorkId, 'request-2'));
  await b.app.approvals.decideApproval(b.colleague, decideInput(b.tenantId, first.request.id, 'decision-1'));
  // getApprovalRequest
  assert.equal((await b.app.approvals.getApprovalRequest(b.owner, b.tenantId, first.request.id)).status, 'approved');
  assert.equal((await b.app.approvals.getApprovalRequest(b.owner, b.tenantId, second.request.id)).status, 'pending');
  // listApprovalRequests filters
  assert.equal((await b.app.approvals.listApprovalRequests(b.owner, b.tenantId)).length, 2);
  assert.equal((await b.app.approvals.listApprovalRequests(b.owner, b.tenantId, { status: 'pending' })).length, 1);
  assert.equal((await b.app.approvals.listApprovalRequests(b.owner, b.tenantId, { status: 'approved' })).length, 1);
  assert.equal(
    (await b.app.approvals.listApprovalRequests(b.owner, b.tenantId, { serviceWorkId: b.otherWorkId })).length,
    1,
  );
  assert.equal(
    (await b.app.approvals.listApprovalRequests(b.owner, b.tenantId, { requestedBy: b.owner.id })).length,
    2,
  );
  // The terminal decision of a request
  const terminal = await b.app.approvals.getTerminalApprovalDecision(b.owner, b.tenantId, first.request.id);
  assert.equal(terminal.requestId, first.request.id);
  assert.equal(terminal.decision, 'approve');
  // A PENDING review is distinguishable from a decided one
  await assert.rejects(
    b.app.approvals.getTerminalApprovalDecision(b.owner, b.tenantId, second.request.id),
    (error: unknown) => {
      const typed = assertTyped(error, 'APPROVAL_DECISION_NOT_FOUND');
      assert.match(typed.message, /still pending/);
      return true;
    },
  );
  // and from a missing request
  await assert.rejects(
    b.app.approvals.getTerminalApprovalDecision(b.owner, b.tenantId, MISSING_UUID),
    (error: unknown) => assertTyped(error, 'APPROVAL_REQUEST_NOT_FOUND') && true,
  );
  // listApprovalDecisions filters
  const decisions = await b.app.approvals.listApprovalDecisions(b.owner, b.tenantId);
  assert.equal(decisions.length, 1);
  assert.equal((await b.app.approvals.listApprovalDecisions(b.owner, b.tenantId, { decision: 'approve' })).length, 1);
  assert.equal((await b.app.approvals.listApprovalDecisions(b.owner, b.tenantId, { decision: 'reject' })).length, 0);
  assert.equal(
    (await b.app.approvals.listApprovalDecisions(b.owner, b.tenantId, { serviceWorkId: b.otherWorkId })).length,
    0,
  );
  // getApprovalDecision
  const byId = await b.app.approvals.getApprovalDecision(b.owner, b.tenantId, decisions[0]?.id as string);
  assert.equal(byId.id, decisions[0]?.id);
  await assert.rejects(
    b.app.approvals.getApprovalDecision(b.owner, b.tenantId, MISSING_UUID),
    (error: unknown) => assertTyped(error, 'APPROVAL_DECISION_NOT_FOUND') && true,
  );
});

test('keyed convergence: the same request key + content converges; divergent content fails closed', async () => {
  const b = await base();
  const first = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-1'));
  const retry = await b.app.approvals.requestApproval(b.colleague, requestInput(b.tenantId, b.workId, 'request-1'));
  assert.equal(retry.converged, true);
  assert.equal(retry.request.id, first.request.id);
  assert.equal(b.app.approvalStore.requests.size, 1);
  await assert.rejects(
    b.app.approvals.requestApproval(
      b.owner,
      requestInput(b.tenantId, b.workId, 'request-1', { subject: { summary: 'Different content' } }),
    ),
    (error: unknown) => assertTyped(error, 'APPROVAL_REQUEST_INPUT_CONFLICT') && true,
  );
  assert.equal(b.app.approvalStore.requests.size, 1);
});

test('decision keyed convergence: same key + input converges; same key + divergent input fails closed', async () => {
  const b = await base();
  const { request } = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-1'));
  const first = await b.app.approvals.decideApproval(
    b.colleague,
    decideInput(b.tenantId, request.id, 'decision-1', { decision: 'approve', reason: 'First reason' }),
  );
  assert.equal(first.converged, false);
  // The crash-window retry: same key, same input — one durable row.
  const retry = await b.app.approvals.decideApproval(
    b.owner,
    decideInput(b.tenantId, request.id, 'decision-1', { decision: 'approve', reason: 'First reason' }),
  );
  assert.equal(retry.converged, true);
  assert.equal(retry.decision.id, first.decision.id);
  assert.equal(b.app.approvalStore.decisions.size, 1);
  // Same key, different verdict.
  await assert.rejects(
    b.app.approvals.decideApproval(b.owner, decideInput(b.tenantId, request.id, 'decision-1', { decision: 'reject' })),
    (error: unknown) => assertTyped(error, 'APPROVAL_DECISION_INPUT_CONFLICT') && true,
  );
  // Same key, different reason (content identity includes the reason).
  await assert.rejects(
    b.app.approvals.decideApproval(
      b.owner,
      decideInput(b.tenantId, request.id, 'decision-1', { reason: 'Another reason' }),
    ),
    (error: unknown) => assertTyped(error, 'APPROVAL_DECISION_INPUT_CONFLICT') && true,
  );
  assert.equal(b.app.approvalStore.decisions.size, 1);
});

// ---------------------------------------------------------------------------
// Discrimination: the explicit human authority
// ---------------------------------------------------------------------------

test('an authorized MACHINE principal can request but NEVER decide (AC-2/AC-4; invariants 3/5)', async () => {
  const b = await base();
  const account = await b.app.organizations.createServiceAccount(b.owner, 'alpha-org', {
    displayName: 'workflow-engine',
    role: 'member',
  });
  const machine = account.member.principal;
  assert.equal(machine.kind, 'machine');
  // A machine principal (the workflow engine) may create requests.
  const { request } = await b.app.approvals.requestApproval(machine, requestInput(b.tenantId, b.workId, 'request-1'));
  assert.equal(request.status, 'pending');
  assert.equal(request.requestedBy, machine.id);
  // An authorized machine principal can NEVER decide: typed failure
  // BEFORE any durable effect (no path from an agent claim to a
  // decision; AI or agent output is never approval).
  const decisionsBefore = b.app.approvalStore.decisions.size;
  await assert.rejects(
    b.app.approvals.decideApproval(machine, decideInput(b.tenantId, request.id, 'decision-1')),
    (error: unknown) => {
      const typed = assertTyped(error, 'DECIDER_NOT_HUMAN');
      assert.match(typed.message, /explicit human authority/);
      assert.match(typed.message, /never approval/);
      return true;
    },
  );
  assert.equal(b.app.approvalStore.decisions.size, decisionsBefore, 'a machine decision has no durable effect');
  const unchanged = await b.app.approvals.getApprovalRequest(b.owner, b.tenantId, request.id);
  assert.equal(unchanged.status, 'pending', 'the request is untouched by the machine decision attempt');
  assert.equal(unchanged.decisionId, null);
});

test('a subject citing a foreign AI execution reference stays opaque DATA: the request stays pending until a human decides (AC-4)', async () => {
  const b = await base();
  // A "Zeck result" lands as subject content — data under approval.
  const { request } = await b.app.approvals.requestApproval(
    b.owner,
    requestInput(b.tenantId, b.workId, 'request-ai-subject', {
      subject: {
        summary: 'AI-executed document review completed',
        zeckExecutionRef: 'zeck-exec-9f31',
        aiVerdict: 'looks-good',
      },
    }),
  );
  // The foreign AI output does not terminalize anything.
  assert.equal(request.status, 'pending');
  assert.equal(b.app.approvalStore.decisions.size, 0);
  // No review surface exposes an approval.
  await assert.rejects(
    b.app.approvals.getTerminalApprovalDecision(b.owner, b.tenantId, request.id),
    (error: unknown) => assertTyped(error, 'APPROVAL_DECISION_NOT_FOUND') && true,
  );
  // Only the explicit human decision terminalizes — over the SAME
  // subject (the human takes responsibility for the cited content).
  const decided = await b.app.approvals.decideApproval(
    b.colleague,
    decideInput(b.tenantId, request.id, 'decision-1', { reason: 'I reviewed the package the AI summarized' }),
  );
  assert.equal(decided.request.status, 'approved');
  assert.equal(decided.decision.decidedBy, b.colleague.id);
});

test('a divergent decision against the recorded terminal decision fails closed; an identical verdict re-observes it (invariant 6)', async () => {
  const b = await base();
  const { request } = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-1'));
  const first = await b.app.approvals.decideApproval(
    b.colleague,
    decideInput(b.tenantId, request.id, 'decision-1', { decision: 'approve', reason: 'Colleague approved' }),
  );
  // A second human attempts to REJECT under a different key: the
  // durable terminal decision arbitrates — fail closed.
  await assert.rejects(
    b.app.approvals.decideApproval(
      b.owner,
      decideInput(b.tenantId, request.id, 'decision-2', { decision: 'reject', reason: 'Owner disagrees' }),
    ),
    (error: unknown) => {
      const typed = assertTyped(error, 'APPROVAL_DECISION_CONFLICT');
      assert.match(typed.message, /already terminally approved/);
      assert.match(typed.message, new RegExp(first.decision.id));
      return true;
    },
  );
  // Still exactly one decision row.
  assert.equal(b.app.approvalStore.decisions.size, 1);
  // An identical verdict (different key, different decider, different
  // reason) re-observes the durable decision — attribution preserved.
  const reobserved = await b.app.approvals.decideApproval(
    b.owner,
    decideInput(b.tenantId, request.id, 'decision-3', { decision: 'approve', reason: 'Owner agrees' }),
  );
  assert.equal(reobserved.converged, true);
  assert.equal(reobserved.decision.id, first.decision.id);
  assert.equal(reobserved.decision.decidedBy, b.colleague.id, 'the first decider keeps the attribution');
  assert.equal(reobserved.decision.reason, 'Colleague approved');
  assert.equal(b.app.approvalStore.decisions.size, 1);
});

test('a decided approval NEVER mutates Service Work state (the workflow authority owns transitions)', async () => {
  const b = await base();
  const workBefore = await b.app.work.getWork(b.owner, b.tenantId, b.workId);
  const attemptsBefore = await b.app.work.listAttempts(b.owner, b.tenantId, b.workId);
  const { request } = await b.app.approvals.requestApproval(
    b.owner,
    requestInput(b.tenantId, b.workId, 'request-1', { workAttemptId: b.attemptId }),
  );
  await b.app.approvals.decideApproval(b.colleague, decideInput(b.tenantId, request.id, 'decision-1'));
  const workAfter = await b.app.work.getWork(b.owner, b.tenantId, b.workId);
  const attemptsAfter = await b.app.work.listAttempts(b.owner, b.tenantId, b.workId);
  assert.deepEqual(workAfter, workBefore);
  assert.deepEqual(attemptsAfter, attemptsBefore);
});

// ---------------------------------------------------------------------------
// Discrimination: fail-closed surfaces
// ---------------------------------------------------------------------------

test('authorization happens BEFORE any domain data access: denials never touch domain data', async () => {
  const b = await base();
  const { request } = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-1'));
  const reads = () => ({ ...b.app.approvalStore.reads });
  // An outsider with no membership: tenant denial before data.
  const before = reads();
  await assert.rejects(
    b.app.approvals.requestApproval(b.outsider, requestInput(b.tenantId, b.workId, 'request-out')),
    (error: unknown) => assertTyped(error, 'TENANT_FORBIDDEN') && true,
  );
  await assert.rejects(
    b.app.approvals.getApprovalRequest(b.outsider, b.tenantId, request.id),
    (error: unknown) => assertTyped(error, 'TENANT_FORBIDDEN') && true,
  );
  await assert.rejects(
    b.app.approvals.decideApproval(b.outsider, decideInput(b.tenantId, request.id, 'decision-out')),
    (error: unknown) => assertTyped(error, 'TENANT_FORBIDDEN') && true,
  );
  assert.deepEqual(reads(), before, 'denials never touch domain data');
  // A made-up tenant: fail closed before data.
  await assert.rejects(
    b.app.approvals.listApprovalRequests(b.owner, MISSING_UUID),
    (error: unknown) => assertTyped(error, 'TENANT_NOT_FOUND') && true,
  );
  assert.deepEqual(reads(), before);
  // A viewer-role human deciding: the human check passes, the write
  // authorization denies (authorization is separate from the human
  // check — both must pass).
  const viewer = await b.app.auth.registerHuman({ email: 'viewer@a.com', password: PASSWORD, displayName: 'Viewer' });
  await b.app.organizations.addMember(b.owner, 'alpha-org', { principalId: viewer.id, role: 'viewer' });
  await assert.rejects(
    b.app.approvals.decideApproval(viewer, decideInput(b.tenantId, request.id, 'decision-viewer')),
    (error: unknown) => assertTyped(error, 'ROLE_FORBIDDEN') && true,
  );
  assert.deepEqual(reads(), before, 'the viewer-role denial never touched domain data');
  assert.equal(b.app.approvalStore.decisions.size, 0);
});

test('cross-tenant reads fail closed: the tenant predicate is mandatory', async () => {
  const b = await base();
  const { request } = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-1'));
  // The outsider reading TENANT A directly: not a member — denied
  // before any data.
  await assert.rejects(
    b.app.approvals.getApprovalRequest(b.outsider, b.tenantId, request.id),
    (error: unknown) => assertTyped(error, 'TENANT_FORBIDDEN') && true,
  );
  // The outsider reading their OWN tenant: tenant A's request is
  // invisible there — indistinguishable from missing.
  await assert.rejects(
    b.app.approvals.getApprovalRequest(b.outsider, b.otherTenantId, request.id),
    (error: unknown) => assertTyped(error, 'APPROVAL_REQUEST_NOT_FOUND') && true,
  );
  // Cross-tenant decide: the outsider is authorized in their OWN
  // tenant, but tenant A's request is invisible there — the tenant
  // predicate makes it indistinguishable from missing, and no
  // decision over it is possible.
  await assert.rejects(
    b.app.approvals.decideApproval(
      b.outsider,
      decideInput(b.otherTenantId, request.id, 'decision-cross', { decision: 'reject' }),
    ),
    (error: unknown) => assertTyped(error, 'APPROVAL_REQUEST_NOT_FOUND') && true,
  );
  // Even a forged tenant id: no data.
  await assert.rejects(
    b.app.approvals.getApprovalRequest(b.owner, MISSING_UUID, request.id),
    (error: unknown) => assertTyped(error, 'TENANT_NOT_FOUND') && true,
  );
  assert.equal(b.app.approvalStore.decisions.size, 0);
  assert.equal((await b.app.approvals.listApprovalRequests(b.outsider, b.otherTenantId)).length, 0);
});

test('work binding validation: foreign work and foreign attempts fail closed (AC-1)', async () => {
  const b = await base();
  await assert.rejects(
    b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, MISSING_UUID, 'request-x')),
    (error: unknown) => assertTyped(error, 'WORK_NOT_FOUND') && true,
  );
  await assert.rejects(
    b.app.approvals.requestApproval(
      b.owner,
      requestInput(b.tenantId, b.workId, 'request-x', { workAttemptId: MISSING_UUID }),
    ),
    (error: unknown) => assertTyped(error, 'ATTEMPT_NOT_FOUND') && true,
  );
  assert.equal(b.app.approvalStore.requests.size, 0);
});

test('deciding an unknown request fails closed', async () => {
  const b = await base();
  await assert.rejects(
    b.app.approvals.decideApproval(b.owner, decideInput(b.tenantId, MISSING_UUID, 'decision-x')),
    (error: unknown) => assertTyped(error, 'APPROVAL_REQUEST_NOT_FOUND') && true,
  );
});

test('after-the-fact mutation of stored rows is DETECTED on read (tamper-evident surface)', async () => {
  const b = await base();
  const { request } = await b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-1'));
  const { decision } = await b.app.approvals.decideApproval(
    b.colleague,
    decideInput(b.tenantId, request.id, 'decision-1', { decision: 'approve' }),
  );
  // Mutate the stored request row (a direct persistence-layer edit).
  const stored = b.app.approvalStore.requests.get(request.id);
  assert.ok(stored !== undefined);
  stored.subject = { summary: 'Tampered subject' };
  await assert.rejects(
    b.app.approvals.getApprovalRequest(b.owner, b.tenantId, request.id),
    (error: unknown) => assertTyped(error, 'APPROVAL_REQUEST_RECORD_TAMPERED') && true,
  );
  // Mutate the stored decision row.
  const storedDecision = b.app.approvalStore.decisions.get(decision.id);
  assert.ok(storedDecision !== undefined);
  storedDecision.reason = 'Tampered reason';
  await assert.rejects(
    b.app.approvals.getApprovalDecision(b.owner, b.tenantId, decision.id),
    (error: unknown) => assertTyped(error, 'APPROVAL_DECISION_RECORD_TAMPERED') && true,
  );
});

test('malformed inputs fail closed with typed codes (validation surface)', async () => {
  const b = await base();
  await assert.rejects(
    b.app.approvals.requestApproval(b.owner, { tenantId: 'not-a-uuid', serviceWorkId: b.workId, policyKey: POLICY_KEY, subject: {}, idempotencyKey: 'k' }),
    (error: unknown) => assertTyped(error, 'INVALID_INPUT') && true,
  );
  await assert.rejects(
    b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-x', { subject: undefined as never })),
    (error: unknown) => assertTyped(error, 'INVALID_INPUT') && true,
  );
  await assert.rejects(
    b.app.approvals.requestApproval(b.owner, requestInput(b.tenantId, b.workId, 'request-x', { policyKey: 'with space' })),
    (error: unknown) => assertTyped(error, 'INVALID_INPUT') && true,
  );
  await assert.rejects(
    b.app.approvals.decideApproval(b.owner, {
      tenantId: b.tenantId,
      requestId: 'not-a-uuid',
      decision: 'approve',
      idempotencyKey: 'k',
    }),
    (error: unknown) => assertTyped(error, 'INVALID_INPUT') && true,
  );
  await assert.rejects(
    b.app.approvals.decideApproval(
      b.owner,
      decideInput(b.tenantId, '00000000-0000-4000-8000-000000000000', 'k', { decision: 'approvee' as never }),
    ),
    (error: unknown) => {
      const typed = assertTyped(error, 'INVALID_INPUT');
      assert.match(typed.message, /decision must be one of/);
      return true;
    },
  );
  await assert.rejects(
    b.app.approvals.decideApproval(
      b.owner,
      decideInput(b.tenantId, '00000000-0000-4000-8000-000000000000', 'k', { reason: 'x'.repeat(2001) }),
    ),
    (error: unknown) => assertTyped(error, 'INVALID_INPUT') && true,
  );
  assert.equal(b.app.approvalStore.requests.size, 0);
  assert.equal(b.app.approvalStore.decisions.size, 0);
});

test('the frozen enumerations are closed and exported (vocabulary surface)', () => {
  assert.deepEqual([...APPROVAL_REQUEST_STATUSES], ['pending', 'approved', 'rejected']);
  assert.deepEqual([...APPROVAL_DECISIONS], ['approve', 'reject']);
});
