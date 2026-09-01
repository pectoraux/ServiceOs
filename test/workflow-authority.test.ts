/**
 * Dynamic proof: the /workflow authority behavioral surface (WORK-004,
 * CRITICAL).
 *
 * Proves against the composed in-memory app (identity -> tenancy -> work ->
 * policies -> workflow):
 * - submitTransition applies legal transitions, mutates the work status
 *   through the single transition authority, and persists an append-only,
 *   attributable audit record atomically with the state write;
 * - illegal transitions are rejected (AC-2) and fail without mutating
 *   anything;
 * - the dependency precondition gates draft -> ready (fail closed until
 *   every dependency work is terminal-completed; only `completed` counts);
 * - the policy precondition consumes /policies' public contract (deny fails
 *   closed; allow pins decision provenance into the transition record);
 * - Zeck/attempt execution facts NEVER directly mutate Service Work state
 *   (AC-3): recording a completed attempt outcome leaves the work state
 *   untouched; state moves only through an explicit business submission;
 * - the audit surface is tamper-evident (record hash verified on read);
 * - the continuation hook derives the admissible continuations of the
 *   current state deterministically;
 * - the SLA hooks: deadline upsert, keyed convergence/divergence, and the
 *   deterministic breach evaluation whose enforcement still flows through
 *   the transition authority (EXPIRED via submitTransition);
 * - authorization precedes any domain data access (denials never touch the
 *   store).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkflowApp,
  type WorkflowApp,
} from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { WorkError } from '../src/modules/work/index.js';
import {
  createWorkflowModule,
  WorkflowError,
  type TransitionRecord,
  type WorkStatus,
} from '../src/modules/workflow/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: WorkflowApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
}

async function base(options: { now?: () => Date } = {}): Promise<Base> {
  const app = buildWorkflowApp(options);
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { app, owner, colleague, tenantId: created.tenant.id };
}

async function createDraftWork(b: Base, title = 'Work'): Promise<string> {
  const { work } = await b.app.work.createWork(b.owner, {
    tenantId: b.tenantId,
    workType: 'compliance.onboarding',
    title,
  });
  return work.id;
}

/** Drive one work through a chain of legal transitions (test scaffolding). */
async function moveTo(
  b: Base,
  workId: string,
  states: readonly WorkStatus[],
  actor?: Principal,
): Promise<void> {
  for (const to of states) {
    await b.app.workflow.submitTransition(actor ?? b.owner, b.tenantId, workId, { to });
  }
}

async function activatePolicy(
  b: Base,
  policyKey: string,
  rules: readonly unknown[],
  defaultEffect: 'allow' | 'deny' = 'allow',
): Promise<string> {
  const { contract } = await b.app.policies.createPolicyVersion(b.owner, {
    tenantId: b.tenantId,
    policyKey,
    scope: 'base',
    rules: rules as never,
    defaultEffect,
  });
  await b.app.policies.activatePolicyVersion(b.owner, b.tenantId, contract.id);
  return contract.id;
}

// ---------------------------------------------------------------------------
// submitTransition: legal path + audit record + status mutation
// ---------------------------------------------------------------------------

test('a legal transition mutates the work status and persists an attributable audit record', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const { transition, converged } = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
    to: 'ready',
    reason: 'dependencies satisfied, ready to start',
  });

  assert.equal(converged, false);
  assert.equal(transition.tenantId, b.tenantId);
  assert.equal(transition.workId, workId);
  assert.equal(transition.fromState, 'draft');
  assert.equal(transition.toState, 'ready');
  assert.equal(transition.ruleId, 'canonical:draft->ready');
  assert.equal(transition.transitionedBy, b.owner.id);
  assert.equal(transition.reason, 'dependencies satisfied, ready to start');
  // The dependency gate was evaluated for draft -> ready and satisfied.
  assert.deepEqual(transition.preconditions.dependencies, { evaluated: true, satisfied: true });
  assert.equal(transition.preconditions.policy, null);
  // The status actually moved (read through /work's record surface).
  const work = await b.app.work.getWork(b.owner, b.tenantId, workId);
  assert.equal(work.status, 'ready');
  assert.equal(work.updatedAt.getTime(), transition.createdAt.getTime());
});

test('the full lifecycle works end-to-end and the ledger accumulates in order', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await moveTo(b, workId, ['ready', 'accepted', 'in_progress', 'waiting_information', 'in_progress', 'waiting_approval', 'in_progress', 'blocked', 'in_progress', 'verifying', 'in_progress', 'verifying', 'completed']);
  const work = await b.app.work.getWork(b.owner, b.tenantId, workId);
  assert.equal(work.status, 'completed');
  const ledger = await b.app.workflow.listTransitions(b.owner, b.tenantId, workId);
  assert.equal(ledger.length, 13);
  assert.equal(ledger[0]?.fromState, 'draft');
  assert.equal(ledger[12]?.toState, 'completed');
  // Strict per-work ledger order: sequences are 1..13 without gaps, and the
  // chain is continuous (each transition starts where the prior ended).
  for (let i = 0; i < ledger.length; i += 1) {
    assert.equal(ledger[i]?.seq, i + 1);
    if (i > 0) {
      const prev = ledger[i - 1] as TransitionRecord;
      const curr = ledger[i] as TransitionRecord;
      assert.equal(curr.fromState, prev.toState);
    }
  }
});

// ---------------------------------------------------------------------------
// Illegal transitions rejected (AC-2)
// ---------------------------------------------------------------------------

test('illegal transitions are rejected without mutating anything', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  // draft -> in_progress skips ready/accepted.
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'in_progress' }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, 'ILLEGAL_TRANSITION');
      assert.match(error.message, /draft -> in_progress/);
      return true;
    },
  );
  // Nothing changed: no ledger rows, status still draft.
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, workId)).length, 0);
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'draft');
});

test('completion must pass through verifying; terminal states are absorbing', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await moveTo(b, workId, ['ready', 'accepted', 'in_progress']);
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'completed' }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'ILLEGAL_TRANSITION',
  );
  await moveTo(b, workId, ['verifying', 'completed']);
  for (const to of ['ready', 'in_progress', 'cancelled', 'expired', 'draft'] as const) {
    await assert.rejects(
      b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, 'ILLEGAL_TRANSITION');
        assert.match(error.message, /terminal/);
        return true;
      },
    );
  }
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'completed');
});

test('invalid inputs fail closed before any data access', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'deleted' as WorkStatus }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, 'not-a-uuid', { to: 'ready' }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready', reason: 'x'.repeat(10001) }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'INVALID_INPUT',
  );
});

test('an unknown work fails closed with WORK_NOT_FOUND', async () => {
  const b = await base();
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, '00000000-0000-4000-8000-000000000000', { to: 'ready' }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'WORK_NOT_FOUND',
  );
});

// ---------------------------------------------------------------------------
// Authorization precedes domain data access (single chain)
// ---------------------------------------------------------------------------

test('a principal without membership is denied before any domain data access', async () => {
  const b = await base();
  const outsider = await b.app.auth.registerHuman({ email: 'outsider@a.com', password: PASSWORD, displayName: 'Outsider' });
  const workId = await createDraftWork(b);
  const snapshotReadsBefore = b.app.workflowStore.reads.workSnapshot;
  await assert.rejects(
    b.app.workflow.submitTransition(outsider, b.tenantId, workId, { to: 'ready' }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TENANT_FORBIDDEN',
  );
  // The denial never touched the domain store.
  assert.equal(b.app.workflowStore.reads.workSnapshot, snapshotReadsBefore);
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'draft');
});

// ---------------------------------------------------------------------------
// Transition preconditions: the dependency gate (draft -> ready)
// ---------------------------------------------------------------------------

test('the dependency gate fails closed until every dependency work is completed', async () => {
  const b = await base();
  const prerequisite = await createDraftWork(b, 'Prerequisite');
  const dependent = await createDraftWork(b, 'Dependent');
  await b.app.work.addDependency(b.owner, b.tenantId, dependent, prerequisite);

  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, dependent, { to: 'ready' }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, 'PRECONDITION_DEPENDENCIES');
      assert.match(error.message, /1 dependency/);
      return true;
    },
  );
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, dependent)).status, 'draft');
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, dependent)).length, 0);

  // Completing the prerequisite satisfies the gate.
  await moveTo(b, prerequisite, ['ready', 'accepted', 'in_progress', 'verifying', 'completed']);
  const { transition } = await b.app.workflow.submitTransition(b.owner, b.tenantId, dependent, { to: 'ready' });
  assert.deepEqual(transition.preconditions.dependencies, { evaluated: true, satisfied: true });
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, dependent)).status, 'ready');
});

test('only terminal-completed satisfies the gate: cancelled/failed/expired dependencies stay closed', async () => {
  const b = await base();
  for (const terminal of ['cancelled', 'failed', 'expired'] as const) {
    const prerequisite = await createDraftWork(b, `P-${terminal}`);
    const dependent = await createDraftWork(b, `D-${terminal}`);
    await b.app.work.addDependency(b.owner, b.tenantId, dependent, prerequisite);
    await moveTo(b, prerequisite, [terminal]);
    await assert.rejects(
      b.app.workflow.submitTransition(b.owner, b.tenantId, dependent, { to: 'ready' }),
      (error: unknown) => error instanceof WorkflowError && error.code === 'PRECONDITION_DEPENDENCIES',
    );
  }
});

test('the dependency gate is scoped to draft -> ready only (terminal exits are ungated)', async () => {
  const b = await base();
  const prerequisite = await createDraftWork(b, 'P');
  const dependent = await createDraftWork(b, 'D');
  await b.app.work.addDependency(b.owner, b.tenantId, dependent, prerequisite);
  // An unmet dependency cannot STOP a business cancellation of the work.
  const { transition } = await b.app.workflow.submitTransition(b.owner, b.tenantId, dependent, { to: 'cancelled' });
  assert.deepEqual(transition.preconditions.dependencies, { evaluated: false, satisfied: true });
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, dependent)).status, 'cancelled');
});

// ---------------------------------------------------------------------------
// Transition preconditions: the policy gate (consumes /policies)
// ---------------------------------------------------------------------------

test('the policy gate denies a transition and fails closed without mutating anything', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await activatePolicy(b, 'workflow.test.cancel-guard', [
    { id: 'deny-cancel', when: { kind: 'attribute', name: 'to', operator: 'eq', value: 'cancelled' }, effect: 'deny' },
  ]);
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
      to: 'cancelled',
      policyKey: 'workflow.test.cancel-guard',
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, 'POLICY_DENIED');
      // Provenance: the denial names the durable decision record.
      assert.match(error.message, /decision [0-9a-f-]{36}/);
      return true;
    },
  );
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'draft');
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, workId)).length, 0);
});

test('an allowed policy gate pins the consulted decision provenance into the transition record', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await activatePolicy(b, 'workflow.test.ready-guard', [
    { id: 'deny-waiting', when: { kind: 'attribute', name: 'to', operator: 'eq', value: 'waiting_information' }, effect: 'deny' },
  ]);
  const { transition } = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
    to: 'ready',
    policyKey: 'workflow.test.ready-guard',
  });
  assert.ok(transition.preconditions.policy !== null);
  assert.equal(transition.preconditions.policy.policyKey, 'workflow.test.ready-guard');
  const decisionId = transition.preconditions.policy.decisionId;
  // The pinned decision is retrievable and revision-bound through /policies.
  const decision = await b.app.policies.getDecision(b.owner, b.tenantId, decisionId);
  assert.equal(decision.outcome, 'allow');
  assert.equal(decision.input.action, 'workflow.transition');
  assert.deepEqual(decision.input.attributes, {
    workType: 'compliance.onboarding',
    from: 'draft',
    to: 'ready',
  });
});

test('a policy key with no active policy fails closed (deny by construction)', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
      to: 'ready',
      policyKey: 'workflow.test.missing-policy',
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'POLICY_DENIED',
  );
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'draft');
});

test('ungated transitions consult no policy at all', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const { transition } = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready' });
  assert.equal(transition.preconditions.policy, null);
  assert.equal(b.app.policyStore.reads.decisionById, 0);
});

// ---------------------------------------------------------------------------
// AC-3: Zeck/execution facts never directly mutate Service Work state
// ---------------------------------------------------------------------------

test('a completed attempt outcome never mutates the work state; transitions are explicit business decisions', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const { attempt } = await b.app.work.createAttempt(b.owner, b.tenantId, workId);
  await b.app.work.dispatchAttempt(b.owner, b.tenantId, attempt.id);
  // An execution-side completed outcome is recorded as a FACT...
  await b.app.work.recordAttemptResult(b.owner, b.tenantId, attempt.id, { outcome: 'completed', result: 'ok' });
  // ...and the business state is untouched: only /workflow writes status.
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'draft');
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, workId)).length, 0);
  // The business decision to complete still has to pass the canonical
  // machine (draft -> completed is illegal regardless of attempt outcome).
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'completed' }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'ILLEGAL_TRANSITION',
  );
  // An explicit business transition remains legal and is the only path.
  await moveTo(b, workId, ['ready', 'accepted', 'in_progress', 'verifying', 'completed']);
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'completed');
});

// ---------------------------------------------------------------------------
// Audit surface: reads + tamper detection (AC-5)
// ---------------------------------------------------------------------------

test('getTransition returns the durable record; unknown ids fail closed', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const { transition } = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready' });
  const fetched = await b.app.workflow.getTransition(b.owner, b.tenantId, transition.id);
  assert.equal(fetched.id, transition.id);
  assert.equal(fetched.recordHash, transition.recordHash);
  await assert.rejects(
    b.app.workflow.getTransition(b.owner, b.tenantId, '00000000-0000-4000-8000-000000000000'),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TRANSITION_NOT_FOUND',
  );
});

test('after-the-fact mutation of a transition record is detected on read (tamper-evident ledger)', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const { transition } = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready' });
  // Out-of-band mutation of the durable record core (simulated row tamper).
  const stored = b.app.workflowStore.transitions.get(transition.id);
  assert.ok(stored !== undefined);
  stored.ruleId = 'canonical:draft->accepted';
  await assert.rejects(
    b.app.workflow.getTransition(b.owner, b.tenantId, transition.id),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TRANSITION_RECORD_TAMPERED',
  );
  await assert.rejects(
    b.app.workflow.listTransitions(b.owner, b.tenantId, workId),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TRANSITION_RECORD_TAMPERED',
  );
});

// ---------------------------------------------------------------------------
// Continuation hook
// ---------------------------------------------------------------------------

test('listContinuations derives the admissible continuations of the current state', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const initial = await b.app.workflow.listContinuations(b.owner, b.tenantId, workId);
  assert.equal(initial.from, 'draft');
  assert.deepEqual(
    initial.continuations.map((c) => c.to),
    ['ready', 'cancelled', 'failed', 'expired'],
  );
  await moveTo(b, workId, ['ready']);
  const afterReady = await b.app.workflow.listContinuations(b.owner, b.tenantId, workId);
  assert.equal(afterReady.from, 'ready');
  assert.deepEqual(
    afterReady.continuations.map((c) => c.to),
    ['accepted', 'cancelled', 'failed', 'expired'],
  );
  await moveTo(b, workId, ['cancelled']);
  const terminal = await b.app.workflow.listContinuations(b.owner, b.tenantId, workId);
  assert.equal(terminal.from, 'cancelled');
  assert.deepEqual(terminal.continuations, []);
});

// ---------------------------------------------------------------------------
// SLA / continuation orchestration hooks
// ---------------------------------------------------------------------------

test('SLA deadline hooks: upsert, keyed convergence and divergence', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const deadline = new Date('2026-09-02T12:00:00.000Z');
  const first = await b.app.workflow.setSlaDeadline(b.owner, b.tenantId, workId, {
    state: 'draft',
    deadlineAt: deadline,
    idempotencyKey: 'sla-1',
  });
  assert.equal(first.converged, false);
  // Keyed re-set with the same input converges on the durable record.
  const retry = await b.app.workflow.setSlaDeadline(b.owner, b.tenantId, workId, {
    state: 'draft',
    deadlineAt: deadline,
    idempotencyKey: 'sla-1',
  });
  assert.equal(retry.converged, true);
  assert.equal(retry.deadline.id, first.deadline.id);
  // Same key, divergent input fails closed.
  await assert.rejects(
    b.app.workflow.setSlaDeadline(b.owner, b.tenantId, workId, {
      state: 'draft',
      deadlineAt: new Date('2026-09-03T12:00:00.000Z'),
      idempotencyKey: 'sla-1',
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'SLA_DEADLINE_CONFLICT',
  );
  // Unkeyed re-set is the deliberate extension path (latest wins).
  const extended = await b.app.workflow.setSlaDeadline(b.owner, b.tenantId, workId, {
    state: 'draft',
    deadlineAt: new Date('2026-09-04T12:00:00.000Z'),
  });
  assert.equal(extended.deadline.id, first.deadline.id);
  assert.equal(extended.deadline.deadlineAt.getTime(), new Date('2026-09-04T12:00:00.000Z').getTime());
  const deadlines = await b.app.workflow.listSlaDeadlines(b.owner, b.tenantId, workId);
  assert.equal(deadlines.length, 1);
  assert.equal(deadlines[0]?.state, 'draft');
});

test('SLA deadlines validate their inputs and fail closed', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await assert.rejects(
    b.app.workflow.setSlaDeadline(b.owner, b.tenantId, workId, {
      state: 'completed',
      deadlineAt: new Date(),
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.workflow.setSlaDeadline(b.owner, b.tenantId, workId, {
      state: 'draft',
      deadlineAt: new Date('not a date'),
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.workflow.setSlaDeadline(b.owner, b.tenantId, '00000000-0000-4000-8000-000000000000', {
      state: 'draft',
      deadlineAt: new Date(),
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'WORK_NOT_FOUND',
  );
});

test('SLA breach evaluation is deterministic and enforcement flows through the transition authority', async () => {
  const clock = {
    value: new Date('2026-09-01T10:00:00.000Z'),
  };
  const b = await base({ now: () => clock.value });
  const breached = await createDraftWork(b, 'Breached');
  const healthy = await createDraftWork(b, 'Healthy');

  await b.app.workflow.setSlaDeadline(b.owner, b.tenantId, breached, {
    state: 'draft',
    deadlineAt: new Date('2026-09-01T09:00:00.000Z'),
  });
  await b.app.workflow.setSlaDeadline(b.owner, b.tenantId, healthy, {
    state: 'draft',
    deadlineAt: new Date('2026-09-01T11:00:00.000Z'),
  });

  let breaches = await b.app.workflow.listSlaBreaches(b.owner, b.tenantId);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0]?.workId, breached);
  assert.equal(breaches[0]?.state, 'draft');
  assert.equal(breaches[0]?.deadlineAt.getTime(), new Date('2026-09-01T09:00:00.000Z').getTime());

  // Advance the clock: the healthy work's deadline passes too.
  clock.value = new Date('2026-09-01T11:30:00.000Z');
  breaches = await b.app.workflow.listSlaBreaches(b.owner, b.tenantId);
  assert.deepEqual(
    breaches.map((entry) => entry.workId).sort(),
    [breached, healthy].sort(),
  );

  // Enforcement: the EXPIRED transition is an explicit business submission
  // through the single authority — the hook itself never mutates state.
  await b.app.workflow.submitTransition(b.owner, b.tenantId, breached, { to: 'expired', reason: 'SLA breach' });
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, breached)).status, 'expired');
  // Once the work left the state, its deadline no longer breaches.
  breaches = await b.app.workflow.listSlaBreaches(b.owner, b.tenantId);
  assert.deepEqual(breaches.map((entry) => entry.workId), [healthy]);
});

test('breaches only count for the CURRENT state (a state left behind stops breaching)', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await b.app.workflow.setSlaDeadline(b.owner, b.tenantId, workId, {
    state: 'draft',
    deadlineAt: new Date('2020-01-01T00:00:00.000Z'),
  });
  // A long-past draft deadline breaches while the work is still draft...
  assert.equal((await b.app.workflow.listSlaBreaches(b.owner, b.tenantId)).length, 1);
  // ...and stops breaching once the work moves on (deadline is state-bound).
  await moveTo(b, workId, ['ready']);
  assert.equal((await b.app.workflow.listSlaBreaches(b.owner, b.tenantId)).length, 0);
});

// ---------------------------------------------------------------------------
// Composition guard
// ---------------------------------------------------------------------------

test('createWorkflowModule requires exactly one of executor or store', () => {
  const b = { tenancy: null, policies: null } as unknown as Parameters<typeof createWorkflowModule>[0];
  assert.throws(
    () => createWorkflowModule({ ...b, executor: undefined, store: undefined }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'INVALID_INPUT',
  );
});

test('work records stay tenant-bound across the workflow surface (smoke)', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await moveTo(b, workId, ['ready']);
  // The /work record surface (a different module) observes the same durable
  // tenant-bound row the workflow authority mutated.
  const record = await b.app.work.getWork(b.colleague, b.tenantId, workId);
  assert.equal(record.status, 'ready');
  assert.equal(record.tenantId, b.tenantId);
});

test('the workflow module shares the single authorization chain with /work (member can act)', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const { transition } = await b.app.workflow.submitTransition(b.colleague, b.tenantId, workId, { to: 'ready' });
  assert.equal(transition.transitionedBy, b.colleague.id);
});
