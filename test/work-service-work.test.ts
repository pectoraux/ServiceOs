/**
 * Behavioral proof: Service Work identity, WorkAttempt identity,
 * dependencies, retry protocol and supersession (WORK-003, dynamic class).
 *
 * Proves the module contract over a faithful in-memory store:
 * - create/read work: durable tenant-bound identity with provenance and
 *   timestamps (AC-1), and idempotent creation by logical key;
 * - attempt creation: attempts are durable identities DISTINCT from the
 *   work (own id, own numbering) and from any external execution (no
 *   execution references exist on them — AC-2);
 * - dependencies: durable, same-tenant, self/cycle-rejecting (AC-3);
 * - retry protocol: pre-dispatch retries converge on the original attempt
 *   identity; post-dispatch retries create a distinct superseding attempt;
 *   duplicated result delivery converges; divergent results conflict (AC-4);
 * - supersession: the current-attempt pointer only moves forward; a
 *   superseded attempt can neither dispatch nor record results; work state
 *   (status) is never mutated by attempt operations (AC-5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceWorkApp, type ServiceWorkApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { WorkError } from '../src/modules/work/index.js';

const PASSWORD = 'correct horse battery 7';

interface Scenario {
  app: ServiceWorkApp;
  owner: Principal;
  member: Principal;
  viewer: Principal;
  tenantId: string;
}

async function scenario(): Promise<Scenario> {
  const app = buildServiceWorkApp();
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const member = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const viewer = await app.auth.registerHuman({ email: 'viewer@a.com', password: PASSWORD, displayName: 'Viewer' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: member.id, role: 'member' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: viewer.id, role: 'viewer' });
  return { app, owner, member, viewer, tenantId: created.tenant.id };
}

test('createWork persists a durable tenant-bound identity (AC-1)', async () => {
  const { app, owner, tenantId } = await scenario();
  const { work, converged } = await app.work.createWork(owner, {
    tenantId,
    workType: 'compliance.document-collection',
    title: 'Collect insurance certificates',
  });
  assert.equal(converged, false);
  assert.ok(UUID(work.id));
  assert.equal(work.tenantId, tenantId);
  assert.equal(work.workType, 'compliance.document-collection');
  assert.equal(work.title, 'Collect insurance certificates');
  assert.equal(work.status, 'draft');
  assert.equal(work.createdBy, owner.id);
  assert.equal(work.currentAttemptId, null);
  assert.ok(work.createdAt instanceof Date);

  const read = await app.work.getWork(owner, tenantId, work.id);
  assert.deepEqual({ ...read, createdAt: read.createdAt.getTime() }, { ...work, createdAt: work.createdAt.getTime() });
  const listed = await app.work.listWorks(owner, tenantId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, work.id);
});

test('createWork converges on the durable identity for the same logical work', async () => {
  const { app, owner, tenantId } = await scenario();
  const first = await app.work.createWork(owner, {
    tenantId,
    workType: 'compliance.onboarding',
    title: 'Onboard subcontractor',
    idempotencyKey: 'ext-event-42',
  });
  const second = await app.work.createWork(owner, {
    tenantId,
    workType: 'compliance.onboarding',
    title: 'Onboard subcontractor (retry)',
    idempotencyKey: 'ext-event-42',
  });
  assert.equal(second.converged, true);
  assert.equal(second.work.id, first.work.id);
  // The durable identity wins: the converged read returns the original row.
  assert.equal(second.work.title, first.work.title);
  const listed = await app.work.listWorks(owner, tenantId);
  assert.equal(listed.length, 1);
});

test('createWork without a key creates distinct works', async () => {
  const { app, owner, tenantId } = await scenario();
  const a = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const b = await app.work.createWork(owner, { tenantId, workType: 't', title: 'B' });
  assert.notEqual(a.work.id, b.work.id);
  assert.equal((await app.work.listWorks(owner, tenantId)).length, 2);
});

test('createWork rejects invalid input', async () => {
  const { app, owner, tenantId } = await scenario();
  await assert.rejects(
    app.work.createWork(owner, { tenantId, workType: '', title: 'A' }),
    (error: unknown) => error instanceof WorkError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    app.work.createWork(owner, { tenantId, workType: 't', title: ' '.repeat(201) }),
    (error: unknown) => error instanceof WorkError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    app.work.createWork(owner, { tenantId, workType: 't', title: 'A', idempotencyKey: '' }),
    (error: unknown) => error instanceof WorkError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    app.work.createWork(owner, { tenantId: 'not-a-uuid', workType: 't', title: 'A' }),
    (error: unknown) => error instanceof WorkError && error.code === 'INVALID_INPUT',
  );
});

test('getWork distinguishes missing from present (404 semantics)', async () => {
  const { app, owner, tenantId } = await scenario();
  const missing = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  await app.work.createWork(owner, { tenantId, workType: 't', title: 'B' });
  await assert.rejects(
    app.work.getWork(owner, tenantId, '00000000-0000-4000-8000-000000000000'),
    (error: unknown) => error instanceof WorkError && error.code === 'WORK_NOT_FOUND',
  );
  void missing;
});

test('createAttempt creates a durable attempt identity distinct from the work (AC-2)', async () => {
  const { app, owner, tenantId } = await scenario();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const { attempt, converged } = await app.work.createAttempt(owner, tenantId, work.id, {
    idempotencyKey: 'attempt-1',
  });
  assert.equal(converged, false);
  assert.ok(UUID(attempt.id));
  assert.notEqual(attempt.id, work.id);
  assert.equal(attempt.workId, work.id);
  assert.equal(attempt.tenantId, tenantId);
  assert.equal(attempt.attemptNo, 1);
  assert.equal(attempt.status, 'pending');
  assert.equal(attempt.supersedesId, null);
  assert.equal(attempt.supersededAt, null);
  assert.equal(attempt.dispatchedAt, null);
  assert.equal(attempt.outcome, null);
  // The attempt carries no external-execution reference of any kind; its
  // shape contains only ServiceOS-owned identity/protocol fields.
  assert.deepEqual(Object.keys(attempt).sort(), [
    'attemptNo',
    'createdAt',
    'createdBy',
    'dispatchedAt',
    'id',
    'idempotencyKey',
    'outcome',
    'result',
    'status',
    'supersededAt',
    'supersedesId',
    'tenantId',
    'updatedAt',
    'workId',
  ]);

  const updated = await app.work.getWork(owner, tenantId, work.id);
  assert.equal(updated.currentAttemptId, attempt.id);
  // Work state is untouched by attempt creation (status remains 'draft').
  assert.equal(updated.status, 'draft');

  const attempts = await app.work.listAttempts(owner, tenantId, work.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.id, attempt.id);
});

test('createAttempt on a missing work fails closed', async () => {
  const { app, owner, tenantId } = await scenario();
  await assert.rejects(
    app.work.createAttempt(owner, tenantId, '00000000-0000-4000-8000-000000000000'),
    (error: unknown) => error instanceof WorkError && error.code === 'WORK_NOT_FOUND',
  );
});

test('retry protocol: pre-dispatch retries converge on the original attempt (AC-4)', async () => {
  const { app, owner, tenantId } = await scenario();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const first = await app.work.createAttempt(owner, tenantId, work.id, { idempotencyKey: 'retry-key' });
  const retry = await app.work.createAttempt(owner, tenantId, work.id, { idempotencyKey: 'retry-key' });
  assert.equal(retry.converged, true);
  assert.equal(retry.attempt.id, first.attempt.id);
  assert.equal(retry.attempt.attemptNo, 1);
  // No duplicate attempt was created.
  assert.equal((await app.work.listAttempts(owner, tenantId, work.id)).length, 1);
});

test('retry protocol: post-dispatch retries create a distinct superseding attempt (AC-4)', async () => {
  const { app, owner, tenantId } = await scenario();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const first = await app.work.createAttempt(owner, tenantId, work.id, { idempotencyKey: 'retry-key' });
  const dispatched = await app.work.dispatchAttempt(owner, tenantId, first.attempt.id);
  assert.equal(dispatched.converged, false);
  assert.equal(dispatched.attempt.status, 'dispatched');
  assert.ok(dispatched.attempt.dispatchedAt instanceof Date);

  const retry = await app.work.createAttempt(owner, tenantId, work.id, { idempotencyKey: 'retry-key' });
  assert.equal(retry.converged, false);
  assert.notEqual(retry.attempt.id, first.attempt.id);
  assert.equal(retry.attempt.attemptNo, 2);
  assert.equal(retry.attempt.status, 'pending');
  assert.equal(retry.attempt.supersedesId, first.attempt.id);

  const attempts = await app.work.listAttempts(owner, tenantId, work.id);
  assert.equal(attempts.length, 2);
  const superseded = attempts.find((a) => a.id === first.attempt.id);
  assert.equal(superseded?.status, 'superseded');
  assert.ok(superseded?.supersededAt instanceof Date);
  assert.equal(superseded?.dispatchedAt instanceof Date, true);

  const updated = await app.work.getWork(owner, tenantId, work.id);
  assert.equal(updated.currentAttemptId, retry.attempt.id);
  // Status untouched (transition authority is /workflow).
  assert.equal(updated.status, 'draft');
});

test('a new attempt without a key also supersedes the current one', async () => {
  const { app, owner, tenantId } = await scenario();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const a = await app.work.createAttempt(owner, tenantId, work.id);
  const b = await app.work.createAttempt(owner, tenantId, work.id);
  assert.notEqual(a.attempt.id, b.attempt.id);
  assert.equal(b.attempt.supersedesId, a.attempt.id);
  const attempts = await app.work.listAttempts(owner, tenantId, work.id);
  assert.equal(attempts.find((x) => x.id === a.attempt.id)?.status, 'superseded');
});

test('supersession: a superseded attempt can never dispatch or record results (AC-5)', async () => {
  const { app, owner, tenantId } = await scenario();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const first = await app.work.createAttempt(owner, tenantId, work.id, { idempotencyKey: 'k' });
  await app.work.dispatchAttempt(owner, tenantId, first.attempt.id);
  const second = await app.work.createAttempt(owner, tenantId, work.id, { idempotencyKey: 'k' });

  await assert.rejects(
    app.work.dispatchAttempt(owner, tenantId, first.attempt.id),
    (error: unknown) => error instanceof WorkError && error.code === 'ATTEMPT_SUPERSEDED',
  );
  await assert.rejects(
    app.work.recordAttemptResult(owner, tenantId, first.attempt.id, { outcome: 'completed', result: 'late result' }),
    (error: unknown) => error instanceof WorkError && error.code === 'ATTEMPT_SUPERSEDED',
  );
  // The late result was NOT recorded: the superseded attempt's record is
  // unchanged and only the current attempt holds results.
  const attempts = await app.work.listAttempts(owner, tenantId, work.id);
  assert.equal(attempts.find((a) => a.id === first.attempt.id)?.outcome, null);
  const recorded = await app.work.recordAttemptResult(owner, tenantId, second.attempt.id, {
    outcome: 'completed',
    result: 'current result',
  });
  assert.equal(recorded.attempt.outcome, 'completed');
  assert.equal(recorded.attempt.result, 'current result');
  assert.equal(recorded.attempt.status, 'completed');
});

test('recordAttemptResult is idempotent and conflicts on divergent results', async () => {
  const { app, owner, tenantId } = await scenario();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const { attempt } = await app.work.createAttempt(owner, tenantId, work.id);
  await app.work.dispatchAttempt(owner, tenantId, attempt.id);

  const first = await app.work.recordAttemptResult(owner, tenantId, attempt.id, {
    outcome: 'completed',
    result: 'ref-1',
  });
  assert.equal(first.converged, false);
  const duplicate = await app.work.recordAttemptResult(owner, tenantId, attempt.id, {
    outcome: 'completed',
    result: 'ref-1',
  });
  assert.equal(duplicate.converged, true);
  assert.equal(duplicate.attempt.id, first.attempt.id);
  await assert.rejects(
    app.work.recordAttemptResult(owner, tenantId, attempt.id, { outcome: 'completed', result: 'ref-2' }),
    (error: unknown) => error instanceof WorkError && error.code === 'ATTEMPT_RESULT_CONFLICT',
  );
  await assert.rejects(
    app.work.recordAttemptResult(owner, tenantId, attempt.id, { outcome: 'failed' }),
    (error: unknown) => error instanceof WorkError && error.code === 'ATTEMPT_RESULT_CONFLICT',
  );
});

test('dispatchAttempt is idempotent for an already-dispatched attempt', async () => {
  const { app, owner, tenantId } = await scenario();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const { attempt } = await app.work.createAttempt(owner, tenantId, work.id);
  const first = await app.work.dispatchAttempt(owner, tenantId, attempt.id);
  const second = await app.work.dispatchAttempt(owner, tenantId, attempt.id);
  assert.equal(second.converged, true);
  assert.equal(second.attempt.id, first.attempt.id);
  assert.equal(second.attempt.dispatchedAt?.getTime(), first.attempt.dispatchedAt?.getTime());
});

test('dispatchAttempt on a missing attempt fails closed', async () => {
  const { app, owner, tenantId } = await scenario();
  await assert.rejects(
    app.work.dispatchAttempt(owner, tenantId, '00000000-0000-4000-8000-000000000000'),
    (error: unknown) => error instanceof WorkError && error.code === 'ATTEMPT_NOT_FOUND',
  );
});

test('dependencies: durable, convergent, self/cycle-rejecting (AC-3)', async () => {
  const { app, owner, tenantId } = await scenario();
  const a = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const b = await app.work.createWork(owner, { tenantId, workType: 't', title: 'B' });
  const c = await app.work.createWork(owner, { tenantId, workType: 't', title: 'C' });

  // A depends on B; B depends on C: a chain.
  const ab = await app.work.addDependency(owner, tenantId, a.work.id, b.work.id);
  assert.equal(ab.converged, false);
  assert.equal(ab.dependency.workId, a.work.id);
  assert.equal(ab.dependency.dependsOnWorkId, b.work.id);
  assert.equal(ab.dependency.tenantId, tenantId);
  const bc = await app.work.addDependency(owner, tenantId, b.work.id, c.work.id);
  assert.equal(bc.converged, false);

  // Duplicate edge converges on the same durable record.
  const again = await app.work.addDependency(owner, tenantId, a.work.id, b.work.id);
  assert.equal(again.converged, true);
  assert.equal(again.dependency.id, ab.dependency.id);
  assert.equal((await app.work.listDependencies(owner, tenantId, a.work.id)).length, 1);

  // Self-dependency is rejected.
  await assert.rejects(
    app.work.addDependency(owner, tenantId, a.work.id, a.work.id),
    (error: unknown) => error instanceof WorkError && error.code === 'SELF_DEPENDENCY',
  );

  // Direct cycle: B -> A would close A->B->A? no: adding B->A when A->B
  // exists closes the 2-cycle.
  await assert.rejects(
    app.work.addDependency(owner, tenantId, b.work.id, a.work.id),
    (error: unknown) => error instanceof WorkError && error.code === 'DEPENDENCY_CYCLE',
  );

  // Transitive cycle: C -> A would close A->B->C->A.
  await assert.rejects(
    app.work.addDependency(owner, tenantId, c.work.id, a.work.id),
    (error: unknown) => error instanceof WorkError && error.code === 'DEPENDENCY_CYCLE',
  );

  // Missing endpoint fails closed.
  await assert.rejects(
    app.work.addDependency(owner, tenantId, a.work.id, '00000000-0000-4000-8000-000000000000'),
    (error: unknown) => error instanceof WorkError && error.code === 'WORK_NOT_FOUND',
  );
});

test('machine principals with write-capable roles can create work; viewer cannot', async () => {
  const { app, owner, viewer, tenantId } = await scenario();
  // Viewer role lacks 'write'.
  await assert.rejects(
    app.work.createWork(viewer, { tenantId, workType: 't', title: 'A' }),
    (error: unknown) => error instanceof WorkError && error.code === 'ROLE_FORBIDDEN',
  );
  // Machine service accounts hold at most 'member' (write-capable) — the
  // capability derives solely from the membership chain.
  const machine = await app.auth.createMachinePrincipal({ displayName: 'event-worker' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: machine.id, role: 'member' });
  const created = await app.work.createWork(machine, {
    tenantId,
    workType: 'compliance.event',
    title: 'Event-created work',
    idempotencyKey: 'event-7',
  });
  assert.equal(created.work.createdBy, machine.id);
});

function UUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
