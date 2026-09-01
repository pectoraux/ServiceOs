/**
 * Concurrency proof: deterministic transition application under
 * interleaving (WORK-004, CRITICAL).
 *
 * The in-memory store's async hook injects a deterministic interleaving
 * point BEFORE each synchronous critical section (the exact semantics of
 * the work-row FOR UPDATE lock in the SQL store), so these proofs exercise
 * real check-then-act races:
 *
 * - concurrent transitions from the same state: one commits, the other
 *   fails deterministically with TRANSITION_CONFLICT (never a lost update,
 *   never a double mutation) — AC-2/concurrency proof;
 * - concurrent same-key submissions converge on ONE durable transition
 *   (exactly one actor observes convergence) — AC-4;
 * - a dependency added while a draft -> ready transition is in flight is
 *   observed by the gate (the authoritative in-transaction evaluation);
 * - discrimination: a store that skips the current-status re-validation
 *   accepts BOTH competing transitions (double ledger rows for one
 *   from-state) — the anomaly the guarded store prevents is detectable.
 *
 * The SQL-level equivalents of the same races run against live PostgreSQL
 * in test/workflow.integration.test.ts (CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkflowApp,
  InMemoryWorkflowStore,
  type WorkflowApp,
} from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import {
  createWorkflowModule,
  hashTransitionRecord,
  WorkflowError,
  WorkflowStoreRuleError,
  type ApplyTransitionInput,
  type TransitionRecord,
  type WorkflowStoreRule,
} from '../src/modules/workflow/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: WorkflowApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
}

async function base(): Promise<Base> {
  const app = buildWorkflowApp();
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

test('concurrent transitions from the same state: one commits, the other fails deterministically', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  // Deterministic interleaving: both actors read the draft snapshot and
  // pass the canonical check before either critical section runs — the
  // exact check-then-act race two in-flight FOR UPDATE transactions would
  // interleave through.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  b.app.workflowStore.options.beforeApplyTransition = async () => {
    await gate;
  };
  const toReady = b.app.workflow
    .submitTransition(b.owner, b.tenantId, workId, { to: 'ready' })
    .then((result) => ({ kind: 'ok' as const, result }));
  const toCancelled = b.app.workflow
    .submitTransition(b.colleague, b.tenantId, workId, { to: 'cancelled' })
    .then((result) => ({ kind: 'ok' as const, result }))
    .catch((error: unknown) => ({ kind: 'err' as const, error }));
  release();
  const [ready, cancelled] = await Promise.all([toReady, toCancelled]);

  // Exactly one committed; the other failed deterministically.
  const okResults = [ready, cancelled].filter((entry) => entry.kind === 'ok');
  const errResults = [ready, cancelled].filter((entry) => entry.kind === 'err');
  assert.equal(okResults.length, 1);
  assert.equal(errResults.length, 1);
  const failure = errResults[0];
  assert.ok(failure !== undefined && failure.kind === 'err');
  assert.ok(failure.error instanceof WorkflowError);
  assert.equal(failure.error.code, 'TRANSITION_CONFLICT');
  // The winner's status is durable and exactly one ledger row exists.
  const status = (await b.app.work.getWork(b.owner, b.tenantId, workId)).status;
  assert.ok(status === 'ready' || status === 'cancelled');
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, workId)).length, 1);
});

test('concurrent unkeyed submissions of the SAME target converge or fail deterministically', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  b.app.workflowStore.options.beforeApplyTransition = async () => {
    await gate;
  };
  const submissions = [
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready' }),
    b.app.workflow.submitTransition(b.colleague, b.tenantId, workId, { to: 'ready' }),
  ];
  release();
  const results = await Promise.allSettled(submissions);
  const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
  const rejected = results.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const rejection = rejected[0];
  assert.ok(rejection !== undefined && rejection.status === 'rejected');
  assert.ok(rejection.reason instanceof WorkflowError);
  assert.equal(rejection.reason.code, 'TRANSITION_CONFLICT');
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'ready');
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, workId)).length, 1);
});

test('concurrent same-key submissions converge on one durable transition (exactly one convergence)', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  b.app.workflowStore.options.beforeApplyTransition = async () => {
    await gate;
  };
  const submissions = [
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready', idempotencyKey: 'race-key' }),
    b.app.workflow.submitTransition(b.colleague, b.tenantId, workId, { to: 'ready', idempotencyKey: 'race-key' }),
  ];
  release();
  const [a, b2] = await Promise.all(submissions);
  assert.equal(a.transition.id, b2.transition.id);
  const convergenceCount = (a.converged ? 1 : 0) + (b2.converged ? 1 : 0);
  assert.equal(convergenceCount, 1); // exactly one actor observed convergence
  assert.equal(b.app.workflowStore.transitions.size, 1);
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'ready');
});

test('a dependency added while a draft->ready transition is in flight is observed by the gate', async () => {
  const b = await base();
  const dependent = await createDraftWork(b, 'Dependent');
  const prerequisite = await createDraftWork(b, 'Prerequisite');

  // Interleaving: the transition starts (snapshot read: no dependencies),
  // the dependency is added concurrently, THEN the critical section runs —
  // the authoritative in-transaction gate observes the committed edge and
  // fails closed.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  b.app.workflowStore.options.beforeApplyTransition = async () => {
    await gate;
  };
  const transition = b.app.workflow.submitTransition(b.owner, b.tenantId, dependent, { to: 'ready' });
  const edge = b.app.work.addDependency(b.owner, b.tenantId, dependent, prerequisite);
  release();
  await edge;
  await assert.rejects(transition, (error: unknown) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, 'PRECONDITION_DEPENDENCIES');
    return true;
  });
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, dependent)).status, 'draft');
});

/**
 * Discrimination: a store that skips the current-status re-validation (the
 * work-row lock's check) accepts BOTH competing transitions — the double
 * ledger anomaly is detectable, proving the guard is load-bearing.
 */
class UnvalidatedWorkflowStore extends InMemoryWorkflowStore {
  public override async applyTransition(
    input: ApplyTransitionInput,
  ): Promise<{ transition: TransitionRecord; converged: boolean }> {
    // The regression: this full copy of the store's critical section SKIPS
    // the expected-status validation (the work-row lock's check).
    const { randomUUID } = await import('node:crypto');
    await this.options.beforeApplyTransition?.();
    if (input.idempotencyKey !== null) {
      const existingId = this.transitionsByIdempotency.get(`${input.tenantId}:${input.idempotencyKey}`);
      if (existingId !== undefined) {
        const existing = this.transitions.get(existingId);
        if (existing !== undefined) {
          if (existing.inputHash !== input.inputHash) {
            throw new WorkflowStoreRuleError(
              `idempotency key "${input.idempotencyKey}" was already used for a different transition input`,
              'transition-input-conflict',
            );
          }
          return { transition: { ...existing, preconditions: existing.preconditions }, converged: true };
        }
      }
    }
    const works = (this as unknown as {
      workStore: { works: Map<string, { id: string; tenantId: string; workType: string; status: TransitionRecord['toState']; updatedAt: Date }> };
    }).workStore.works;
    const work = works.get(input.workId);
    if (work === undefined || work.tenantId !== input.tenantId) {
      throw new WorkflowStoreRuleError(`work ${input.workId} does not exist in this tenant`, 'transition-conflict');
    }
    // MUTANT: the current-status re-validation is SKIPPED — a stale
    // expectedFrom is accepted as truth.
    let dependencies = { evaluated: false, satisfied: true };
    const preconditions = { dependencies, policy: input.policy };
    const seq = [...this.transitions.values()].filter((transition) => transition.workId === input.workId).length + 1;
    const recordHash = hashTransitionRecord({
      tenantId: input.tenantId,
      workId: input.workId,
      seq,
      fromState: input.expectedFrom,
      toState: input.to,
      ruleId: input.ruleId,
      preconditions,
      reason: input.reason,
      transitionedBy: input.transitionedBy,
      idempotencyKey: input.idempotencyKey,
      inputHash: input.inputHash,
      createdAt: input.now.toISOString(),
    });
    const transition = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workId: input.workId,
      seq,
      fromState: input.expectedFrom,
      toState: input.to,
      ruleId: input.ruleId,
      preconditions,
      reason: input.reason,
      transitionedBy: input.transitionedBy,
      idempotencyKey: input.idempotencyKey,
      inputHash: input.inputHash,
      recordHash,
      createdAt: input.now,
    };
    this.transitions.set(transition.id, transition);
    if (input.idempotencyKey !== null) {
      this.transitionsByIdempotency.set(`${input.tenantId}:${input.idempotencyKey}`, transition.id);
    }
    work.status = input.to;
    work.updatedAt = input.now;
    return { transition: { ...transition, preconditions }, converged: false };
  }
}

test('discrimination: a store that skips the status re-validation accepts the double transition (detectable)', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  // Rebuild the app with the mutant store over the same identity substrate.
  const mutantStore = new UnvalidatedWorkflowStore(b.app.workStore, {});
  const mutantModule = createWorkflowModule({
    store: mutantStore,
    tenancy: b.app.organizations,
    policies: b.app.policies,
  });

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutantStore.options.beforeApplyTransition = async () => {
    await gate;
  };
  const submissions = [
    mutantModule.submitTransition(b.owner, b.tenantId, workId, { to: 'ready' }).then((r) => ({ ok: true as const, r })),
    mutantModule.submitTransition(b.colleague, b.tenantId, workId, { to: 'cancelled' }).then((r) => ({ ok: true as const, r })),
  ];
  release();
  const results = await Promise.all(submissions);
  // The mutant accepted BOTH transitions from 'draft': the anomaly exists
  // (two ledger rows with fromState 'draft') — this is what the guarded
  // store rejects, and why the guard is load-bearing.
  const ledger = await mutantModule.listTransitions(b.owner, b.tenantId, workId);
  assert.equal(ledger.length, 2);
  assert.equal(ledger.filter((entry) => entry.fromState === 'draft').length, 2);
  assert.equal(results.length, 2);
  assert.ok(results.every((entry) => entry.ok));
});

test('the guarded store rejects what the mutant accepts (the same race, correct behavior)', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  b.app.workflowStore.options.beforeApplyTransition = async () => {
    await gate;
  };
  const submissions = [
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready' }).then((r) => ({ ok: true as const, r })),
    b.app.workflow.submitTransition(b.colleague, b.tenantId, workId, { to: 'cancelled' }).then((r) => ({ ok: true as const, r })),
  ];
  release();
  const results = await Promise.allSettled(submissions);
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(results.filter((entry) => entry.status === 'rejected').length, 1);
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, workId)).length, 1);
});

test('store rule errors carry the guarded transition rules (typed surface)', async () => {
  const rules: WorkflowStoreRule[] = [
    'transition-conflict',
    'transition-input-conflict',
    'precondition-dependencies',
    'transition-record-tampered',
    'sla-deadline-conflict',
  ];
  for (const rule of rules) {
    const error = new WorkflowStoreRuleError('proof', rule);
    assert.equal(error.rule, rule);
    assert.equal(error.name, 'WorkflowStoreRuleError');
  }
});

test('regression (CI live-DB defect): a keyed retry whose snapshot observes the winner\'s commit converges', async () => {
  // The race the live PostgreSQL proof caught: the loser's keyed lookup
  // runs BEFORE the winner's commit (misses it), and its work snapshot runs
  // AFTER it (observes the target state, making the derived transition an
  // illegal self-loop). The keyed re-check on the illegal path converges on
  // the durable transition instead of rejecting the retry.
  const b = await base();
  const workId = await createDraftWork(b);
  let winnerStarted = false;
  b.app.workflowStore.options.beforeGetWorkSnapshot = async () => {
    if (winnerStarted) return;
    winnerStarted = true;
    // The winner commits while the loser is between its keyed lookup and
    // its snapshot read.
    await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
      to: 'ready',
      idempotencyKey: 'race-key',
    });
  };
  // The loser (colleague) starts; its snapshot hook runs the winner first.
  const loser = await b.app.workflow.submitTransition(b.colleague, b.tenantId, workId, {
    to: 'ready',
    idempotencyKey: 'race-key',
  });
  assert.equal(loser.converged, true);
  // Exactly one durable transition; the work state is the winner's.
  assert.equal(b.app.workflowStore.transitions.size, 1);
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'ready');
});

test('regression (CI live-DB defect): a divergent keyed retry on the raced path still fails closed', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  let winnerStarted = false;
  b.app.workflowStore.options.beforeGetWorkSnapshot = async () => {
    if (winnerStarted) return;
    winnerStarted = true;
    await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
      to: 'ready',
      idempotencyKey: 'race-key',
    });
  };
  // The loser carries the same key but a DIFFERENT target: the raced
  // re-check must fail closed as an input conflict, never converge.
  await assert.rejects(
    b.app.workflow.submitTransition(b.colleague, b.tenantId, workId, {
      to: 'cancelled',
      idempotencyKey: 'race-key',
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TRANSITION_INPUT_CONFLICT',
  );
  assert.equal(b.app.workflowStore.transitions.size, 1);
});
