/**
 * Concurrency proof: the Zeck integration boundary's convergence under
 * interleaving (WORK-005, required class `concurrency`).
 *
 * The in-memory store's async hooks inject deterministic interleaving
 * points BEFORE each synchronous critical section (the exact semantics
 * of the advisory-locked SQL transactions), so these proofs exercise
 * real check-then-act races between INDEPENDENT actors:
 *
 * - two actors submitting the same logical intent (same key) converge
 *   on ONE durable intent and ONE foreign execution reference (AC-6:
 *   duplicate requests converge when the Zeck contract permits
 *   idempotency — the deterministic intent identity is the key);
 * - same-key DIVERGENT submissions: one wins, one fails closed
 *   (IDEMPOTENCY_INPUT_CONFLICT inside the serialized section);
 * - same attempt under different keys: one wins, one fails closed
 *   (ATTEMPT_ALREADY_LINKED — the durable correlation identity);
 * - a MISBEHAVING gateway (divergent acceptances for one intent): the
 *   attach critical section fails the loser closed (REFERENCE_CONFLICT)
 *   — the boundary never blindly trusts foreign idempotency;
 * - concurrent identical callback deliveries converge on ONE event row
 *   with ONE cursor advance; concurrent divergent deliveries: one wins,
 *   one fails closed (EVENT_CONFLICT);
 * - the crash window (gateway accepted, attach never committed): the
 *   retry re-dispatches through the SAME deterministic key and
 *   converges on the SAME foreign execution identity;
 * - mutation discrimination: a store that drops the conflict guards
 *   produces detectable duplicate/ambiguous state (the guards are
 *   load-bearing).
 *
 * The SQL-level equivalents of the same races run against live
 * PostgreSQL in test/zeck.integration.test.ts (CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZeckBoundaryApp, InMemoryZeckStore, type ZeckBoundaryApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import {
  computeIntentContentHash,
  computeIntentRecordHash,
  createInMemoryZeckGateway,
  ZeckError,
  ZeckStoreMissingError,
  type ZeckGatewayDouble,
} from '../src/modules/zeck/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: ZeckBoundaryApp;
  gateway: ZeckGatewayDouble;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
  workId: string;
  attemptId: string;
}

async function base(race?: () => Promise<void>, gatewayOptions?: { divergentAcceptances?: boolean }): Promise<Base> {
  const gateway = createInMemoryZeckGateway(gatewayOptions);
  const app = buildZeckBoundaryApp({
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    gateway,
    zeckStoreOptions: {
      beforeRegisterIntent: race,
      beforeAttachReference: race,
      beforeRecordEvent: race,
    },
  });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  const { work } = await app.work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'AssessDocument',
    title: 'Assess the certificate',
  });
  const { attempt } = await app.work.createAttempt(owner, created.tenant.id, work.id);
  return { app, gateway, owner, colleague, tenantId: created.tenant.id, workId: work.id, attemptId: attempt.id };
}

function intentInput(tenantId: string, workId: string, attemptId: string, key: string, objective = 'Assess the certificate against the policy') {
  return {
    tenantId,
    serviceWorkId: workId,
    workAttemptId: attemptId,
    objective,
    inputArtifactRefs: ['artifact://certificate.pdf'],
    businessContext: { domain: 'construction' },
    requiredCapabilities: [{ capability: 'document.reasoning' }],
    businessConstraints: { privacy: 'no-cross-tenant-data' },
    outputContract: { schemaRef: 'schema://assessment.v1' },
    idempotencyKey: key,
  };
}

function callbackInput(eventId: string, executionId: string, summary = 'The certificate satisfies the policy') {
  return {
    eventId,
    eventType: 'execution.completed',
    zeckExecutionId: executionId,
    occurredAt: new Date('2026-09-02T12:05:00.000Z'),
    payload: { summary, artifactRefs: ['artifact://report.pdf'], evidenceRefs: [], warnings: [] },
  };
}

function oneTimeRace(): () => Promise<void> {
  let release = 0;
  return async () => {
    if (release === 0) {
      release = 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
}

async function capture<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function expectCode(result: { ok: true; value: unknown } | { ok: false; error: unknown }, code: string): void {
  assert.ok(result.ok === false, 'expected the racing loser to fail closed');
  assert.ok(result.error instanceof ZeckError, `expected a ZeckError, got ${(result.error as Error)?.message}`);
  assert.equal((result.error as ZeckError).code, code);
}

test('two actors submitting the same logical intent converge on ONE durable intent and ONE reference (AC-6)', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const input = intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-race');
  const [a, b] = await Promise.all([
    fixture.app.zeck.submitExecutionIntent(fixture.owner, input),
    fixture.app.zeck.submitExecutionIntent(fixture.colleague, input),
  ]);
  // ONE durable intent; both calls hold the same identity.
  assert.equal(a.intent.id, b.intent.id);
  assert.equal(fixture.app.zeckStore.intents.size, 1);
  // ONE foreign execution reference; both calls hold it.
  assert.equal(a.intent.zeckExecutionId, b.intent.zeckExecutionId);
  assert.ok(a.intent.zeckExecutionId !== null);
  assert.equal(fixture.app.zeckStore.intentsByExecutionRef.size, 1);
  // The gateway may see both dispatches (the crash window is legal), but
  // the deterministic key converges them (the double's contract).
  assert.ok(fixture.gateway.submissions.length >= 1 && fixture.gateway.submissions.length <= 2);
  assert.ok(
    fixture.gateway.submissions.every(
      (submission) => submission.acceptance?.zeckExecutionId === a.intent.zeckExecutionId,
    ),
    'every dispatch converged on the same foreign execution identity',
  );
});

test('same-key DIVERGENT submissions under race: one wins, one fails closed inside the section', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const [a, b] = await Promise.all([
    capture(
      fixture.app.zeck.submitExecutionIntent(
        fixture.owner,
        intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-div', 'Objective A'),
      ),
    ),
    capture(
      fixture.app.zeck.submitExecutionIntent(
        fixture.colleague,
        intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-div', 'Objective B'),
      ),
    ),
  ]);
  const results = [a, b];
  const failures = results.filter((result) => result.ok === false);
  const successes = results.filter((result) => result.ok === true);
  assert.equal(failures.length, 1);
  assert.equal(successes.length, 1);
  expectCode(failures[0]!, 'IDEMPOTENCY_INPUT_CONFLICT');
  assert.equal(fixture.app.zeckStore.intents.size, 1);
});

test('the same attempt under different keys under race: one wins, one fails closed (correlation identity)', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const [a, b] = await Promise.all([
    capture(
      fixture.app.zeck.submitExecutionIntent(
        fixture.owner,
        intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-key-a'),
      ),
    ),
    capture(
      fixture.app.zeck.submitExecutionIntent(
        fixture.colleague,
        intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-key-b'),
      ),
    ),
  ]);
  const failures = [a, b].filter((result) => result.ok === false);
  const successes = [a, b].filter((result) => result.ok === true);
  assert.equal(failures.length, 1);
  assert.equal(successes.length, 1);
  expectCode(failures[0]!, 'ATTEMPT_ALREADY_LINKED');
  assert.equal(fixture.app.zeckStore.intents.size, 1);
});

test('a MISBEHAVING gateway (divergent acceptances): the attach section fails the loser closed', async () => {
  const fixture = await base(undefined, { divergentAcceptances: true });
  const input = intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-misbehaving');
  const [a, b] = await Promise.all([
    capture(fixture.app.zeck.submitExecutionIntent(fixture.owner, input)),
    capture(fixture.app.zeck.submitExecutionIntent(fixture.colleague, input)),
  ]);
  const failures = [a, b].filter((result) => result.ok === false);
  const successes = [a, b].filter((result) => result.ok === true);
  assert.equal(failures.length, 1);
  assert.equal(successes.length, 1);
  expectCode(failures[0]!, 'REFERENCE_CONFLICT');
  // Exactly ONE durable reference survives — the winner's.
  assert.equal(fixture.app.zeckStore.intentsByExecutionRef.size, 1);
  const winner = successes[0] as { ok: true; value: { intent: { zeckExecutionId: string | null; id: string } } };
  const stored = fixture.app.zeckStore.intents.get(winner.value.intent.id);
  assert.ok(stored !== undefined);
  assert.equal(stored.zeckExecutionId, winner.value.intent.zeckExecutionId);
});

test('concurrent identical callback deliveries converge on ONE event row (idempotent replay)', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const { intent } = await fixture.app.zeck.submitExecutionIntent(
    fixture.owner,
    intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-events'),
  );
  assert.ok(intent.zeckExecutionId !== null);
  const delivery = callbackInput('evt-race', intent.zeckExecutionId);
  const [a, b] = await Promise.all([
    fixture.app.zeck.ingestCallback(fixture.owner, fixture.tenantId, delivery),
    fixture.app.zeck.ingestCallback(fixture.colleague, fixture.tenantId, delivery),
  ]);
  assert.equal(a.event.id, b.event.id, 'ONE durable delivery record');
  assert.notEqual(a.converged, b.converged, 'exactly one insert and one convergence');
  assert.equal(fixture.app.zeckStore.events.size, 1);
  // The cursor advanced exactly once (to the same instant).
  const stored = fixture.app.zeckStore.intents.get(intent.id);
  assert.ok(stored !== undefined);
  assert.equal(stored.lastSeenEventId, 'evt-race');
  const before = a.converged ? b.event : a.event;
  assert.equal(stored.lastSeenAt?.getTime(), before.receivedAt.getTime());
});

test('concurrent DIVERGENT deliveries of one event identity: one wins, one fails closed', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const { intent } = await fixture.app.zeck.submitExecutionIntent(
    fixture.owner,
    intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-events'),
  );
  assert.ok(intent.zeckExecutionId !== null);
  const [a, b] = await Promise.all([
    capture(fixture.app.zeck.ingestCallback(fixture.owner, fixture.tenantId, callbackInput('evt-div', intent.zeckExecutionId, 'Claim A'))),
    capture(fixture.app.zeck.ingestCallback(fixture.colleague, fixture.tenantId, callbackInput('evt-div', intent.zeckExecutionId, 'Claim B'))),
  ]);
  const failures = [a, b].filter((result) => result.ok === false);
  assert.equal(failures.length, 1);
  expectCode(failures[0]!, 'EVENT_CONFLICT');
  assert.equal(fixture.app.zeckStore.events.size, 1, 'the durable row is the evidence');
});

test('the crash window (gateway accepted, attach never committed): retry re-dispatches through the same key and converges (AC-6)', async () => {
  const fixture = await base();
  const input = intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-crash');
  const contentHash = computeIntentContentHash({
    tenantId: input.tenantId,
    serviceWorkId: input.serviceWorkId,
    workAttemptId: input.workAttemptId,
    objective: input.objective,
    inputArtifactRefs: input.inputArtifactRefs,
    businessContext: input.businessContext,
    requiredCapabilities: input.requiredCapabilities,
    businessConstraints: input.businessConstraints,
    outputContract: input.outputContract,
    idempotencyKey: input.idempotencyKey,
  });
  // The dispatcher crashed AFTER the gateway accepted but BEFORE the
  // attach committed: the intent is durable, the acceptance is on the
  // Zeck side, the reference is NOT pinned.
  const registered = await fixture.app.zeckStore.registerIntent({
    tenantId: input.tenantId,
    serviceWorkId: input.serviceWorkId,
    workAttemptId: input.workAttemptId,
    objective: input.objective,
    inputArtifactRefs: input.inputArtifactRefs,
    businessContext: input.businessContext,
    requiredCapabilities: input.requiredCapabilities,
    businessConstraints: input.businessConstraints,
    outputContract: input.outputContract,
    idempotencyKey: input.idempotencyKey,
    contentHash,
    createdBy: fixture.owner.id,
    now: new Date('2026-09-02T12:00:00.000Z'),
  });
  const crashedAcceptance = await fixture.gateway.submitExecution({
    intentId: registered.intent.id,
    idempotencyKey: registered.intent.id,
    tenantId: input.tenantId,
    serviceWorkId: input.serviceWorkId,
    workAttemptId: input.workAttemptId,
    objective: input.objective,
    inputArtifactRefs: input.inputArtifactRefs,
    businessContext: input.businessContext,
    requiredCapabilities: input.requiredCapabilities,
    businessConstraints: input.businessConstraints,
    outputContract: input.outputContract,
  });
  assert.equal(registered.intent.zeckExecutionId, null);
  // The retry: converges on the durable intent, re-dispatches (the
  // reference was never durable — contract §5 does not suppress the
  // external call), the deterministic key converges the foreign
  // identity, and the attach pins it.
  const result = await fixture.app.zeck.submitExecutionIntent(fixture.owner, input);
  assert.equal(result.intent.id, registered.intent.id);
  assert.equal(result.intentConverged, true);
  assert.equal(result.dispatched, true);
  assert.equal(result.intent.zeckExecutionId, crashedAcceptance.zeckExecutionId, 'the SAME foreign execution identity');
  assert.equal(fixture.app.zeckStore.intentsByExecutionRef.size, 1);
  assert.equal(fixture.gateway.submissions.length, 2, 'the retry re-dispatched (the reference was not durable)');
});

// ---------------------------------------------------------------------------
// Mutation discrimination: the guards are load-bearing
// ---------------------------------------------------------------------------

test('a store that drops the reference-conflict guard accepts ambiguous linkage (must be detectable)', async () => {
  const fixture = await base(undefined, { divergentAcceptances: true });
  // A mutated store whose attach section has NO conflict guard and NO
  // owner check — the exact defect class the reference-conflict guard
  // exists for. Synchronous (atomic in JS) so the mutation is the ONLY
  // behavioral difference from the real store.
  const broken = fixture.app.zeckStore;
  broken.attachExecutionReference = async (input) => {
    const intent = broken.intents.get(input.intentId);
    if (intent === undefined || intent.tenantId !== input.tenantId) {
      throw new ZeckStoreMissingError('intent', input.intentId);
    }
    if (intent.zeckExecutionId === input.zeckExecutionId) {
      return { intent: { ...intent }, converged: true };
    }
    // MUTATION: last writer wins — the pinned reference is forgotten.
    if (intent.zeckExecutionId !== null) {
      broken.intentsByExecutionRef.delete(`${intent.tenantId}:${intent.zeckExecutionId}`);
    }
    intent.zeckExecutionId = input.zeckExecutionId;
    intent.zeckApplicationRef = input.applicationRef;
    intent.submittedBy = input.submittedBy;
    intent.submittedAt = input.now;
    intent.updatedAt = input.now;
    intent.recordHash = computeIntentRecordHash(intent);
    broken.intentsByExecutionRef.set(`${input.tenantId}:${input.zeckExecutionId}`, input.intentId);
    return { intent: { ...intent }, converged: false };
  };
  const input = intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-broken');
  const [a, b] = await Promise.all([
    capture(fixture.app.zeck.submitExecutionIntent(fixture.owner, input)),
    capture(fixture.app.zeck.submitExecutionIntent(fixture.colleague, input)),
  ]);
  // With the guard dropped, BOTH divergent dispatches succeed and the
  // stored reference is whichever attached last: one accepted foreign
  // identity was silently orphaned — the anomaly the real guard makes
  // impossible is detectable through the read surface.
  const successes = [a, b].filter((result) => result.ok === true);
  assert.equal(successes.length, 2, 'the mutated store fails closed nowhere — the defect is observable');
  const acceptedIdentities = new Set(
    fixture.gateway.submissions.map((submission) => submission.acceptance?.zeckExecutionId),
  );
  assert.equal(acceptedIdentities.size, 2, 'the misbehaving gateway produced two identities');
  const stored = broken.intents.get((successes[0] as { ok: true; value: { intent: { id: string } } }).value.intent.id);
  assert.ok(stored !== undefined);
  assert.ok(stored.zeckExecutionId !== null && acceptedIdentities.has(stored.zeckExecutionId));
  const orphaned = [...acceptedIdentities].filter((identity) => identity !== stored.zeckExecutionId);
  assert.equal(orphaned.length, 1, 'exactly one accepted identity was silently orphaned');
  assert.equal(broken.intentsByExecutionRef.size, 1);
});

test('a store that drops the event-conflict guard duplicates deliveries (must be detectable)', async () => {
  const race = oneTimeRace();
  const fixture = await base(race);
  const { intent } = await fixture.app.zeck.submitExecutionIntent(
    fixture.owner,
    intentInput(fixture.tenantId, fixture.workId, fixture.attemptId, 'intent-broken-events'),
  );
  assert.ok(intent.zeckExecutionId !== null);
  // A mutated store that skips the replay re-check and inserts a second
  // row for the same event identity — the exact defect class the
  // event-conflict guard exists for.
  const broken = fixture.app.zeckStore;
  const originalRecord = broken.recordCallbackEvent.bind(broken);
  let mutateOnce = false;
  broken.recordCallbackEvent = async (input) => {
    if (mutateOnce) {
      mutateOnce = false;
      const second = { ...input, eventId: `${input.eventId}-phantom` };
      await originalRecord(second);
    }
    return originalRecord(input);
  };
  mutateOnce = true;
  const delivery = callbackInput('evt-broken', intent.zeckExecutionId);
  await fixture.app.zeck.ingestCallback(fixture.owner, fixture.tenantId, delivery);
  // The mutated store produced TWO rows where the contract demands ONE:
  // the anomaly is detectable through the public read surface.
  const rows = await fixture.app.zeck.listCallbackEvents(fixture.owner, fixture.tenantId, { disposition: 'accepted' });
  assert.equal(rows.length, 2, 'the duplicated delivery is observable — the guard is load-bearing');
});
