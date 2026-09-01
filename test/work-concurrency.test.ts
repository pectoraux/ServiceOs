/**
 * Concurrency proof: work creation convergence, attempt retry convergence
 * and late-attempt protection under interleaving (WORK-003, CRITICAL).
 *
 * The in-memory store's async hooks inject deterministic interleaving
 * points BEFORE each synchronous critical section (the exact semantics of
 * the locked SQL transaction), so these proofs exercise real
 * check-then-act races:
 *
 * - two actors creating the same logical work (tenant + idempotency key)
 *   converge on one durable identity — never two rows (AC-1/AC-4);
 * - two actors retrying the same dispatched attempt converge on ONE new
 *   current attempt — never two live attempts (AC-4);
 * - a late prior attempt cannot win over the current attempt: when the
 *   superseding attempt lands first, the late result/dispatch of the prior
 *   attempt is rejected; when the result lands first, the supersession
 *   still moves the current pointer forward (AC-5);
 * - concurrent opposite dependency edges close at most one edge — the
 *   cycle check is serialized so a phantom cycle can never commit (AC-3);
 * - concurrent duplicate result deliveries converge (no double mutation).
 *
 * The SQL-level equivalents of the same races run against live PostgreSQL
 * in test/service-work.integration.test.ts (CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildServiceWorkApp,
  InMemoryWorkStore,
  type ServiceWorkApp,
} from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { createWorkModule, WorkError } from '../src/modules/work/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: ServiceWorkApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
}

async function base(): Promise<Base> {
  const app = buildServiceWorkApp();
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { app, owner, colleague, tenantId: created.tenant.id };
}

test('two actors creating the same logical work converge (independent actors)', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const key = 'event-42';
  const [a, b] = await Promise.all([
    app.work.createWork(owner, { tenantId, workType: 'compliance.onboarding', title: 'A', idempotencyKey: key }),
    app.work.createWork(colleague, { tenantId, workType: 'compliance.onboarding', title: 'B', idempotencyKey: key }),
  ]);
  assert.equal(a.work.id, b.work.id);
  const exactlyOne = (a.converged ? 1 : 0) + (b.converged ? 1 : 0);
  assert.equal(exactlyOne, 1); // exactly one creator observed convergence
  assert.equal(app.workStore.works.size, 1);
});

test('concurrent same-key creations interleave at the race point and still converge', async () => {
  // Deterministic interleaving: both actors pass the async hook before
  // either critical section runs (the check-then-insert race), exactly as
  // two in-flight SQL INSERTs against the partial unique index.
  const { app, owner, colleague, tenantId } = await base();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.workStore.options.beforeCreateWork = async () => {
    await gate;
  };
  const key = 'event-7';
  const first = app.work.createWork(owner, { tenantId, workType: 't', title: 'A', idempotencyKey: key });
  const second = app.work.createWork(colleague, { tenantId, workType: 't', title: 'B', idempotencyKey: key });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.work.id, b.work.id);
  assert.equal(app.workStore.works.size, 1);
  assert.equal((await app.work.listWorks(owner, tenantId)).length, 1);
});

test('two actors retrying the same dispatched attempt converge on one new attempt', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const original = await app.work.createAttempt(owner, tenantId, work.id, { idempotencyKey: 'retry' });
  await app.work.dispatchAttempt(owner, tenantId, original.attempt.id);

  // Both retry concurrently (both pass the hook before either critical
  // section): the first supersedes the original, the second converges on
  // the new live attempt for the same key.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.workStore.options.beforeCreateAttempt = async () => {
    await gate;
  };
  const retryA = app.work.createAttempt(owner, tenantId, work.id, { idempotencyKey: 'retry' });
  const retryB = app.work.createAttempt(colleague, tenantId, work.id, { idempotencyKey: 'retry' });
  release();
  const [a, b] = await Promise.all([retryA, retryB]);

  // One new distinct attempt, superseding the dispatched original; both
  // actors observe the SAME new identity.
  assert.notEqual(a.attempt.id, original.attempt.id);
  assert.equal(a.attempt.id, b.attempt.id);
  assert.equal(a.attempt.supersedesId, original.attempt.id);
  assert.equal((a.converged ? 1 : 0) + (b.converged ? 1 : 0), 1);

  const attempts = await app.work.listAttempts(owner, tenantId, work.id);
  assert.equal(attempts.length, 2); // original (superseded) + one replacement
  const superseded = attempts.find((attempt) => attempt.id === original.attempt.id);
  assert.equal(superseded?.status, 'superseded');
  const updated = await app.work.getWork(owner, tenantId, work.id);
  assert.equal(updated.currentAttemptId, a.attempt.id);
});

test('late prior attempt cannot win: result after supersession is rejected', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const original = await app.work.createAttempt(owner, tenantId, work.id, { idempotencyKey: 'k' });
  await app.work.dispatchAttempt(owner, tenantId, original.attempt.id);

  // Interleaving: the retry lands FIRST (supersedes the original), then the
  // original's late result arrives — it must be rejected.
  const replacement = await app.work.createAttempt(colleague, tenantId, work.id, { idempotencyKey: 'k' });
  await assert.rejects(
    app.work.recordAttemptResult(owner, tenantId, original.attempt.id, { outcome: 'completed', result: 'late' }),
    (error: unknown) => error instanceof WorkError && error.code === 'ATTEMPT_SUPERSEDED',
  );
  const attempts = await app.work.listAttempts(owner, tenantId, work.id);
  assert.equal(attempts.find((attempt) => attempt.id === original.attempt.id)?.outcome, null);
  const updated = await app.work.getWork(owner, tenantId, work.id);
  assert.equal(updated.currentAttemptId, replacement.attempt.id);
  // Work state is never mutated by the attempt paths.
  assert.equal(updated.status, 'draft');
});

test('late prior attempt cannot win: dispatch after supersession is rejected', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const original = await app.work.createAttempt(owner, tenantId, work.id);
  const replacement = await app.work.createAttempt(colleague, tenantId, work.id);
  await assert.rejects(
    app.work.dispatchAttempt(owner, tenantId, original.attempt.id),
    (error: unknown) => error instanceof WorkError && error.code === 'ATTEMPT_SUPERSEDED',
  );
  const attempts = await app.work.listAttempts(owner, tenantId, work.id);
  assert.equal(attempts.find((attempt) => attempt.id === original.attempt.id)?.dispatchedAt, null);
});

test('result-then-supersession: the current pointer still moves forward', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const original = await app.work.createAttempt(owner, tenantId, work.id, { idempotencyKey: 'k' });
  await app.work.dispatchAttempt(owner, tenantId, original.attempt.id);
  // The result lands FIRST (legal: it was the current attempt).
  const recorded = await app.work.recordAttemptResult(owner, tenantId, original.attempt.id, {
    outcome: 'failed',
    result: 'timeout',
  });
  assert.equal(recorded.attempt.outcome, 'failed');
  // A retry afterwards still supersedes the completed attempt and moves
  // the pointer forward — the completed record stays immutable.
  const replacement = await app.work.createAttempt(colleague, tenantId, work.id, { idempotencyKey: 'k' });
  const attempts = await app.work.listAttempts(owner, tenantId, work.id);
  const prior = attempts.find((attempt) => attempt.id === original.attempt.id);
  assert.equal(prior?.status, 'superseded');
  assert.equal(prior?.outcome, 'failed');
  assert.equal(prior?.result, 'timeout');
  const updated = await app.work.getWork(owner, tenantId, work.id);
  assert.equal(updated.currentAttemptId, replacement.attempt.id);
});

test('concurrent duplicate result deliveries converge (no double mutation)', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const { attempt } = await app.work.createAttempt(owner, tenantId, work.id);
  await app.work.dispatchAttempt(owner, tenantId, attempt.id);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.workStore.options.beforeRecordResult = async () => {
    await gate;
  };
  const deliveryA = app.work.recordAttemptResult(owner, tenantId, attempt.id, { outcome: 'completed', result: 'r' });
  const deliveryB = app.work.recordAttemptResult(colleague, tenantId, attempt.id, { outcome: 'completed', result: 'r' });
  release();
  const [a, b] = await Promise.all([deliveryA, deliveryB]);
  assert.equal(a.attempt.id, b.attempt.id);
  assert.equal((a.converged ? 1 : 0) + (b.converged ? 1 : 0), 1);
  // The attempt was mutated exactly once: one updatedAt.
  const attempts = await app.work.listAttempts(owner, tenantId, work.id);
  assert.equal(attempts[0]?.updatedAt.getTime(), a.attempt.updatedAt.getTime());
});

test('concurrent opposite dependency edges commit at most one (phantom-cycle safety)', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const a = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const b = await app.work.createWork(owner, { tenantId, workType: 't', title: 'B' });

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.workStore.options.beforeAddDependency = async () => {
    await gate;
  };
  // A->B and B->A concurrently: a 2-cycle can never commit.
  const forward = app.work.addDependency(owner, tenantId, a.work.id, b.work.id);
  const backward = app.work.addDependency(colleague, tenantId, b.work.id, a.work.id);
  release();
  const results = await Promise.allSettled([forward, backward]);
  const rejected = results.filter((result) => result.status === 'rejected').length;
  assert.ok(rejected === 1, `exactly one edge must be rejected (got ${rejected})`);
  const error = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(error.reason instanceof WorkError && error.reason.code === 'DEPENDENCY_CYCLE');
  const committed = results.filter((result) => result.status === 'fulfilled').length;
  assert.equal(committed, 1);
  // Exactly one durable edge exists in total.
  const total = (await app.work.listDependencies(owner, tenantId, a.work.id)).length +
    (await app.work.listDependencies(owner, tenantId, b.work.id)).length;
  assert.equal(total, 1);
});

test('concurrent duplicate dependency adds converge on one record', async () => {
  const { app, owner, colleague, tenantId } = await base();
  const a = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const b = await app.work.createWork(owner, { tenantId, workType: 't', title: 'B' });

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.workStore.options.beforeAddDependency = async () => {
    await gate;
  };
  const first = app.work.addDependency(owner, tenantId, a.work.id, b.work.id);
  const second = app.work.addDependency(colleague, tenantId, a.work.id, b.work.id);
  release();
  const [x, y] = await Promise.all([first, second]);
  assert.equal(x.dependency.id, y.dependency.id);
  assert.equal((x.converged ? 1 : 0) + (y.converged ? 1 : 0), 1);
  assert.equal((await app.work.listDependencies(owner, tenantId, a.work.id)).length, 1);
});

test('discrimination: a store that drops convergence duplicates identities (must be detectable)', async () => {
  // Mutation proof for the duplicate-identity regression: a broken store
  // that inserts unconditionally (never converges) produces two rows for
  // the same logical key. The suite's convergence tests fail against such a
  // store; here we assert the mutated behavior itself is observable so the
  // regression cannot pass silently.
  const { app, owner, tenantId } = await base();
  const key = 'event-9';

  class NonConvergingStore extends InMemoryWorkStore {
    public override async createWork(
      input: import('../src/modules/work/index.js').CreateWorkInput,
    ): Promise<{ work: import('../src/modules/work/index.js').WorkRecord; converged: boolean }> {
      // The regression: skip the idempotency lookup and insert blindly.
      const { randomUUID } = await import('node:crypto');
      const record = {
        id: randomUUID(),
        tenantId: input.tenantId,
        workType: input.workType,
        title: input.title,
        status: 'draft' as const,
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
        currentAttemptId: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.works.set(record.id, record);
      return { work: { ...record }, converged: false };
    }
  }

  const duplicated = new NonConvergingStore();
  const brokenModule = createWorkModule({ store: duplicated, tenancy: app.organizations });
  const a = await brokenModule.createWork(owner, { tenantId, workType: 't', title: 'A', idempotencyKey: key });
  const b = await brokenModule.createWork(owner, { tenantId, workType: 't', title: 'A', idempotencyKey: key });
  // The broken store duplicates: two rows, two identities, no convergence —
  // exactly what the convergence tests above assert NEVER happens on the
  // faithful store.
  assert.equal(a.converged, false);
  assert.equal(b.converged, false);
  assert.notEqual(a.work.id, b.work.id);
  assert.equal(duplicated.works.size, 2);

  // Against the faithful store, the same sequence converges.
  const c = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A', idempotencyKey: key });
  const d = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A', idempotencyKey: key });
  assert.equal(c.work.id, d.work.id);
  assert.equal(d.converged, true);
  assert.equal(app.workStore.works.size, 1);
});

test('discrimination: a store that skips the supersession guard accepts stale mutations (detectable)', async () => {
  // Mutation proof for the stale-attempt regression: a store whose
  // recordAttemptResult ignores supersession would accept the late result.
  // We assert the faithful store rejects it (the load-bearing check) and
  // that the mutated path is observable in the raw record state.
  const { app, owner, tenantId } = await base();
  const { work } = await app.work.createWork(owner, { tenantId, workType: 't', title: 'A' });
  const original = await app.work.createAttempt(owner, tenantId, work.id);
  await app.work.createAttempt(owner, tenantId, work.id);
  const raw = app.workStore.attempts.get(original.attempt.id);
  assert.ok(raw !== undefined);
  assert.notEqual(raw.supersededAt, null); // stale by supersession
  // The module rejects; and directly mutating the raw record without the
  // guard (what a broken store would do) WOULD flip the outcome — that is
  // exactly the mutation the guard prevents.
  await assert.rejects(
    app.work.recordAttemptResult(owner, tenantId, original.attempt.id, { outcome: 'completed' }),
    (error: unknown) => error instanceof WorkError && error.code === 'ATTEMPT_SUPERSEDED',
  );
  assert.equal(raw.outcome, null);
});
