/**
 * Dynamic proof: transition identity is idempotent (WORK-004 AC-4).
 *
 * Proves against the composed in-memory app:
 * - a keyed submission and its retry converge on ONE durable transition
 *   (the retry re-observes the original record; nothing doubles);
 * - a keyed retry converges EVEN AFTER the work progressed further (the
 *   recorded from/to are authoritative; the from-state is not part of the
 *   submission identity);
 * - a divergent re-use of the same key fails closed
 *   (TRANSITION_INPUT_CONFLICT — different target, or different policyKey);
 * - an unkeyed re-submission of the same target is rejected as illegal
 *   (self-loops do not exist; the state machine itself is the unkeyed
 *   deduplication);
 * - repeatable loop edges (in_progress <-> waiting_information) create
 *   DISTINCT durable transitions per application — no collapse, no skip;
 * - a gated keyed retry does not re-evaluate the policy decision (the
 *   keyed fast-path precedes the policy gate; the decision count stays 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowApp, type WorkflowApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { WorkflowError } from '../src/modules/workflow/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: WorkflowApp;
  owner: Principal;
  tenantId: string;
}

async function base(): Promise<Base> {
  const app = buildWorkflowApp();
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  return { app, owner, tenantId: created.tenant.id };
}

async function createDraftWork(b: Base, title = 'Work'): Promise<string> {
  const { work } = await b.app.work.createWork(b.owner, {
    tenantId: b.tenantId,
    workType: 'compliance.onboarding',
    title,
  });
  return work.id;
}

test('a keyed submission and its retry converge on one durable transition', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const first = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
    to: 'ready',
    idempotencyKey: 'transition-42',
  });
  assert.equal(first.converged, false);
  const retry = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
    to: 'ready',
    idempotencyKey: 'transition-42',
  });
  assert.equal(retry.converged, true);
  assert.equal(retry.transition.id, first.transition.id);
  // One durable record, one ledger row, no double mutation.
  assert.equal(b.app.workflowStore.transitions.size, 1);
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, workId)).length, 1);
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'ready');
});

test('a keyed retry converges even after the work progressed further', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const first = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
    to: 'ready',
    idempotencyKey: 'go-ready',
  });
  // The work moves on through further transitions...
  for (const to of ['accepted', 'in_progress', 'waiting_information'] as const) {
    await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to });
  }
  // ...and the original keyed submission still converges on its record
  // (the re-observed from/to are the recorded ones, not the current state).
  const retry = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
    to: 'ready',
    idempotencyKey: 'go-ready',
  });
  assert.equal(retry.converged, true);
  assert.equal(retry.transition.id, first.transition.id);
  assert.equal(retry.transition.fromState, 'draft');
  assert.equal(retry.transition.toState, 'ready');
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'waiting_information');
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, workId)).length, 4);
});

test('a divergent re-use of the same idempotency key fails closed', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
    to: 'ready',
    idempotencyKey: 'key-1',
  });
  // Different target state for the same key.
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'cancelled', idempotencyKey: 'key-1' }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TRANSITION_INPUT_CONFLICT',
  );
  // Different policyKey for the same key+target (the gate is part of the
  // submission identity).
  await b.app.policies.createPolicyVersion(b.owner, {
    tenantId: b.tenantId,
    policyKey: 'workflow.test.gate',
    scope: 'base',
    rules: [{ id: 'allow-all', when: { kind: 'always' }, effect: 'allow' }],
    defaultEffect: 'allow',
  });
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
      to: 'ready',
      policyKey: 'workflow.test.gate',
      idempotencyKey: 'key-1',
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'TRANSITION_INPUT_CONFLICT',
  );
});

test('an unkeyed re-submission of the same target state is rejected (no self-loops)', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready' });
  // Someone else moved the work to ready first (unkeyed): re-submitting the
  // same target is the illegal self-loop ready -> ready.
  await assert.rejects(
    b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'ready' }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, 'ILLEGAL_TRANSITION');
      assert.match(error.message, /ready -> ready/);
      return true;
    },
  );
  assert.equal((await b.app.workflow.listTransitions(b.owner, b.tenantId, workId)).length, 1);
});

test('repeatable loop edges create distinct durable transitions per application', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  for (const to of ['ready', 'accepted', 'in_progress'] as const) {
    await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to });
  }
  // The waiting loop is repeatable: each application is a new durable,
  // sequenced audit record (no convergence collapse, no skipped records).
  await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'waiting_information' });
  await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'in_progress' });
  await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'waiting_information' });
  await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, { to: 'in_progress' });
  const ledger = await b.app.workflow.listTransitions(b.owner, b.tenantId, workId);
  assert.equal(ledger.length, 7);
  for (let i = 0; i < ledger.length; i += 1) {
    assert.equal(ledger[i]?.seq, i + 1);
  }
  assert.equal((await b.app.work.getWork(b.owner, b.tenantId, workId)).status, 'in_progress');
});

test('a keyed gated retry does not re-evaluate the policy decision', async () => {
  const b = await base();
  const workId = await createDraftWork(b);
  const { contract } = await b.app.policies.createPolicyVersion(b.owner, {
    tenantId: b.tenantId,
    policyKey: 'workflow.test.gate',
    scope: 'base',
    rules: [{ id: 'allow-all', when: { kind: 'always' }, effect: 'allow' }],
    defaultEffect: 'allow',
  });
  await b.app.policies.activatePolicyVersion(b.owner, b.tenantId, contract.id);

  const first = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
    to: 'ready',
    policyKey: 'workflow.test.gate',
    idempotencyKey: 'gated-1',
  });
  assert.ok(first.transition.preconditions.policy !== null);
  const decisionsAfterFirst = b.app.policyStore.decisions.size;
  assert.equal(decisionsAfterFirst, 1);

  // The keyed retry converges BEFORE the policy gate: the durable decision
  // is re-observed through the transition record, not re-evaluated.
  const retry = await b.app.workflow.submitTransition(b.owner, b.tenantId, workId, {
    to: 'ready',
    policyKey: 'workflow.test.gate',
    idempotencyKey: 'gated-1',
  });
  assert.equal(retry.converged, true);
  assert.equal(retry.transition.preconditions.policy?.decisionId, first.transition.preconditions.policy?.decisionId);
  assert.equal(b.app.policyStore.decisions.size, 1);
});
