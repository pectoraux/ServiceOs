/**
 * Behavioral + discrimination proofs for the /zeck integration boundary
 * (WORK-005, required classes `dynamic` + `discrimination`).
 *
 * Behavioral:
 * - an AI Execution Intent submits through ONE provider-neutral port
 *   (AC-1): durable registration, gateway dispatch outside the store
 *   transactions, reference attachment in one serialized section;
 * - retries consult the durable correlation record FIRST (contract §5):
 *   a converged reference means NO second external request;
 * - the closed composition (no gateway) and gateway failures are
 *   TRUTHFUL (contract §7): typed errors, the intent stays durable and
 *   unreferenced, nothing fabricates success;
 * - callbacks translate into durable observations (AC-5): accepted
 *   events carry the translated payload and advance the intent's
 *   last-seen cursor; identical replays converge;
 * - reads round-trip (intents, events, filters);
 *
 * Discrimination / mutation:
 * - a Zeck success NEVER completes Service Work (AC-5): after a full
 *   submit + accepted `execution.completed` callback, the Service Work
 *   record and its attempt are UNCHANGED (business verification belongs
 *   to the business authorities);
 * - rejections fail closed WITH durable evidence: unknown event type,
 *   invalid payload, uncorrelated execution, conflicting correlation —
 *   each a typed error plus a retrievable rejected delivery row; replay
 *   of a rejection is idempotent; divergent replays conflict;
 * - same-key divergent content, foreign attempts, dead attempts, a
 *   second key on a linked attempt, forbidden capability-selection
 *   fields and malformed input ALL fail closed with typed codes;
 * - authorization happens BEFORE any domain data access.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZeckBoundaryApp, type ZeckBoundaryApp } from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { createZeckModule, ZeckError, createInMemoryZeckGateway, type ZeckGatewayDouble } from '../src/modules/zeck/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: ZeckBoundaryApp;
  gateway: ZeckGatewayDouble;
  owner: Principal;
  outsider: Principal;
  tenantId: string;
  otherTenantId: string;
  workId: string;
  attemptId: string;
}

async function base(): Promise<Base> {
  const gateway = createInMemoryZeckGateway();
  const app = buildZeckBoundaryApp({ now: () => new Date('2026-09-02T12:00:00.000Z'), gateway });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const outsider = await app.auth.registerHuman({ email: 'owner@b.com', password: PASSWORD, displayName: 'Outsider' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  const other = await app.organizations.createOrganization(outsider, { slug: 'beta-org', displayName: 'Beta' });
  const { work } = await app.work.createWork(owner, {
    tenantId: created.tenant.id,
    workType: 'AssessDocument',
    title: 'Assess the insurance certificate',
  });
  const { attempt } = await app.work.createAttempt(owner, created.tenant.id, work.id, { idempotencyKey: 'attempt-1' });
  return {
    app,
    gateway,
    owner,
    outsider,
    tenantId: created.tenant.id,
    otherTenantId: other.tenant.id,
    workId: work.id,
    attemptId: attempt.id,
  };
}

function intentInput(tenantId: string, workId: string, attemptId: string, key: string) {
  return {
    tenantId,
    serviceWorkId: workId,
    workAttemptId: attemptId,
    objective: 'Assess whether the uploaded certificate satisfies the compliance policy',
    inputArtifactRefs: ['artifact://insurance-certificate.pdf'],
    businessContext: { domain: 'construction', jurisdiction: 'EU' },
    requiredCapabilities: [{ capability: 'document.reasoning', minQuality: 0.8, maxLatencyMs: 60000 }],
    businessConstraints: { privacy: 'no-cross-tenant-data', retention: '30d' },
    outputContract: { schemaRef: 'schema://compliance-assessment.v1', description: 'The assessment verdict with evidence references' },
    idempotencyKey: key,
  };
}

function callbackInput(eventId: string, executionId: string) {
  return {
    eventId,
    eventType: 'execution.completed',
    zeckExecutionId: executionId,
    occurredAt: new Date('2026-09-02T12:05:00.000Z'),
    payload: {
      summary: 'The certificate satisfies every required clause',
      artifactRefs: ['artifact://assessment-report.pdf'],
      evidenceRefs: ['evidence://clause-matrix.json'],
      provenanceRef: 'provenance://run-42',
      warnings: [],
      reportedCostRef: 'cost://statement-2026-09-42',
      reportedLatencyMs: 4200,
    },
  };
}

async function zeckError<T>(promise: Promise<T>): Promise<ZeckError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ZeckError, `expected a ZeckError, got ${(error as Error).message}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the call to fail closed' });
}

// ---------------------------------------------------------------------------
// Behavioral: the one port (AC-1/AC-2/AC-6)
// ---------------------------------------------------------------------------

test('an AI Execution Intent submits through the one port and pins the foreign reference', async () => {
  const { app, owner, tenantId, workId, attemptId, gateway } = await base();
  const result = await app.zeck.submitExecutionIntent(owner, intentInput(tenantId, workId, attemptId, 'intent-1'));
  assert.equal(result.intentConverged, false);
  assert.equal(result.dispatched, true);
  assert.ok(result.intent.zeckExecutionId !== null);
  assert.equal(result.intent.submittedBy, owner.id);
  assert.ok(result.intent.submittedAt !== null);
  assert.equal(gateway.submissions.length, 1);
  assert.equal(gateway.submissions[0]?.request.idempotencyKey, result.intent.id);
  // The request carries NO model/provider selection surface — only the
  // capability REQUIREMENTS (the frozen declaration contract).
  assert.deepEqual(gateway.submissions[0]?.request.requiredCapabilities, [
    { capability: 'document.reasoning', minQuality: 0.8, maxLatencyMs: 60000 },
  ]);
  // The durable correlation identity (AC-2).
  assert.equal(result.intent.serviceWorkId, workId);
  assert.equal(result.intent.workAttemptId, attemptId);
  const read = await app.zeck.getExecutionIntent(owner, tenantId, result.intent.id);
  assert.equal(read.zeckExecutionId, result.intent.zeckExecutionId);
});

test('a retried submit consults the durable correlation record first: no second external request (contract §5)', async () => {
  const { app, owner, tenantId, workId, attemptId, gateway } = await base();
  const first = await app.zeck.submitExecutionIntent(owner, intentInput(tenantId, workId, attemptId, 'intent-1'));
  const retry = await app.zeck.submitExecutionIntent(owner, intentInput(tenantId, workId, attemptId, 'intent-1'));
  assert.equal(retry.intentConverged, true);
  assert.equal(retry.dispatched, false);
  assert.equal(retry.intent.id, first.intent.id);
  assert.equal(retry.intent.zeckExecutionId, first.intent.zeckExecutionId);
  assert.equal(gateway.submissions.length, 1, 'the retry must not re-dispatch when the reference is durable');
});

test('the closed composition (no gateway) is truthfully unavailable: typed error, durable unreferenced intent', async () => {
  const app = buildZeckBoundaryApp({ now: () => new Date('2026-09-02T12:00:00.000Z') });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  const { work } = await app.work.createWork(owner, { tenantId: created.tenant.id, workType: 'T', title: 'Work' });
  const { attempt } = await app.work.createAttempt(owner, created.tenant.id, work.id);
  const error = await zeckError(
    app.zeck.submitExecutionIntent(owner, intentInput(created.tenant.id, work.id, attempt.id, 'intent-closed')),
  );
  assert.equal(error.code, 'ZECK_GATEWAY_UNAVAILABLE');
  // The intent is durable and unreferenced — truthful state, no fabrication.
  const intents = await app.zeck.listExecutionIntents(owner, created.tenant.id);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.zeckExecutionId, null);
  // A later composition with a gateway converges the SAME logical intent
  // and dispatches (the durable identity survives the closed era).
  const gateway = createInMemoryZeckGateway();
  const reopened = createZeckModule({
    store: app.zeckStore,
    tenancy: app.organizations,
    work: app.work,
    gateway,
    now: () => new Date('2026-09-02T13:00:00.000Z'),
  });
  const result = await reopened.submitExecutionIntent(owner, intentInput(created.tenant.id, work.id, attempt.id, 'intent-closed'));
  assert.equal(result.intent.id, intents[0]?.id);
  assert.equal(result.intentConverged, true);
  assert.equal(result.dispatched, true);
  assert.ok(result.intent.zeckExecutionId !== null);
  assert.equal(gateway.submissions.length, 1);
});

test('a failing gateway is honest: typed transport error, durable unreferenced intent, retry re-attempts through the same key', async () => {
  const unavailable = createInMemoryZeckGateway({ unavailable: true });
  const app = buildZeckBoundaryApp({ now: () => new Date('2026-09-02T12:00:00.000Z'), gateway: unavailable });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  const { work } = await app.work.createWork(owner, { tenantId: created.tenant.id, workType: 'T', title: 'Work' });
  const { attempt } = await app.work.createAttempt(owner, created.tenant.id, work.id);
  const input = intentInput(created.tenant.id, work.id, attempt.id, 'intent-flaky');
  const error = await zeckError(app.zeck.submitExecutionIntent(owner, input));
  assert.equal(error.code, 'ZECK_GATEWAY_ERROR');
  const intents = await app.zeck.listExecutionIntents(owner, created.tenant.id);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.zeckExecutionId, null);
  // The Zeck-side window closes: a healthy gateway converges the SAME
  // logical intent (idempotency by the deterministic intent identity).
  const healthy = createInMemoryZeckGateway();
  const recovered = createZeckModule({
    store: app.zeckStore,
    tenancy: app.organizations,
    work: app.work,
    gateway: healthy,
    now: () => new Date('2026-09-02T13:00:00.000Z'),
  });
  const result = await recovered.submitExecutionIntent(owner, input);
  assert.equal(result.intent.id, intents[0]?.id);
  assert.ok(result.intent.zeckExecutionId !== null);
  assert.equal(result.dispatched, true);
});

test('one intent per work attempt: a second key on the same attempt fails closed (AC-2 correlation identity)', async () => {
  const { app, owner, tenantId, workId, attemptId } = await base();
  await app.zeck.submitExecutionIntent(owner, intentInput(tenantId, workId, attemptId, 'intent-a'));
  const error = await zeckError(app.zeck.submitExecutionIntent(owner, intentInput(tenantId, workId, attemptId, 'intent-b')));
  assert.equal(error.code, 'ATTEMPT_ALREADY_LINKED');
  assert.equal((await app.zeck.listExecutionIntents(owner, tenantId)).length, 1);
});

// ---------------------------------------------------------------------------
// Behavioral: callback translation (AC-5; contract §4/§6)
// ---------------------------------------------------------------------------

async function submitted(base_: Base): Promise<{ intentId: string; executionId: string }> {
  const { app, owner, tenantId, workId, attemptId } = base_;
  const { intent } = await app.zeck.submitExecutionIntent(owner, intentInput(tenantId, workId, attemptId, 'intent-1'));
  assert.ok(intent.zeckExecutionId !== null);
  return { intentId: intent.id, executionId: intent.zeckExecutionId };
}

test('a translated callback is a durable observation that advances the ingestion cursor', async () => {
  const base_ = await base();
  const { app, owner, tenantId } = base_;
  const { intentId, executionId } = await submitted(base_);
  const { event, converged } = await app.zeck.ingestCallback(owner, tenantId, callbackInput('evt-1', executionId));
  assert.equal(converged, false);
  assert.equal(event.disposition, 'accepted');
  assert.equal(event.intentId, intentId);
  assert.ok(event.observed !== null);
  assert.equal(event.observed.summary, 'The certificate satisfies every required clause');
  assert.equal(event.observed.reportedCostRef, 'cost://statement-2026-09-42');
  const intent = await app.zeck.getExecutionIntent(owner, tenantId, intentId);
  assert.equal(intent.lastSeenEventId, 'evt-1');
  assert.ok(intent.lastSeenAt !== null);
  const read = await app.zeck.getCallbackEvent(owner, tenantId, 'evt-1');
  assert.equal(read.id, event.id);
  const listed = await app.zeck.listCallbackEvents(owner, tenantId, { disposition: 'accepted' });
  assert.equal(listed.length, 1);
});

test('an identical callback replay converges: one delivery record, no cursor re-advance (contract §5)', async () => {
  const base_ = await base();
  const { app, owner, tenantId } = base_;
  const { executionId } = await submitted(base_);
  const first = await app.zeck.ingestCallback(owner, tenantId, callbackInput('evt-1', executionId));
  const replay = await app.zeck.ingestCallback(owner, tenantId, callbackInput('evt-1', executionId));
  assert.equal(replay.converged, true);
  assert.equal(replay.event.id, first.event.id);
  assert.equal((await app.zeck.listCallbackEvents(owner, tenantId)).length, 1);
  const intentBefore = await app.zeck.getExecutionIntent(owner, tenantId, (await app.zeck.listExecutionIntents(owner, tenantId))[0]!.id);
  const cursorAt = intentBefore.lastSeenAt;
  await app.zeck.ingestCallback(owner, tenantId, callbackInput('evt-1', executionId));
  const intentAfter = await app.zeck.getExecutionIntent(owner, tenantId, intentBefore.id);
  assert.equal(intentAfter.lastSeenAt?.getTime(), cursorAt?.getTime(), 'a converged replay never re-touches the cursor');
});

test('a Zeck success NEVER completes Service Work (AC-5 discrimination: transport/business separation)', async () => {
  const base_ = await base();
  const { app, owner, tenantId, workId, attemptId } = base_;
  const { executionId } = await submitted(base_);
  await app.zeck.ingestCallback(owner, tenantId, callbackInput('evt-1', executionId));
  // The Service Work record is UNTOUCHED: the work stays in its created
  // state and the attempt carries no outcome — the business pipeline
  // (business evidence -> verification -> workflow transition) belongs
  // to the business authorities, never to the AI boundary.
  const work = await app.work.getWork(owner, tenantId, workId);
  assert.equal(work.status, 'draft');
  const attempts = await app.work.listAttempts(owner, tenantId, workId);
  const attempt = attempts.find((entry) => entry.id === attemptId);
  assert.ok(attempt !== undefined);
  assert.equal(attempt.outcome, null);
  assert.equal(attempt.result, null);
});

test('a divergent replay of the same event identity fails closed (EVENT_CONFLICT)', async () => {
  const base_ = await base();
  const { app, owner, tenantId } = base_;
  const { executionId } = await submitted(base_);
  await app.zeck.ingestCallback(owner, tenantId, callbackInput('evt-1', executionId));
  const divergent = callbackInput('evt-1', executionId);
  (divergent.payload as { summary: string }).summary = 'A DIFFERENT claim for the same event identity';
  const error = await zeckError(app.zeck.ingestCallback(owner, tenantId, divergent));
  assert.equal(error.code, 'EVENT_CONFLICT');
  assert.equal((await app.zeck.listCallbackEvents(owner, tenantId)).length, 1, 'the durable row is the evidence');
});

test('an unknown event type is rejected with durable evidence (typed error + retrievable rejected row)', async () => {
  const base_ = await base();
  const { app, owner, tenantId } = base_;
  const { executionId } = await submitted(base_);
  const delivery = callbackInput('evt-unknown', executionId);
  (delivery as { eventType: string }).eventType = 'execution.progress';
  const error = await zeckError(app.zeck.ingestCallback(owner, tenantId, delivery));
  assert.equal(error.code, 'CALLBACK_UNKNOWN_EVENT_TYPE');
  const row = await app.zeck.getCallbackEvent(owner, tenantId, 'evt-unknown');
  assert.equal(row.disposition, 'rejected');
  assert.equal(row.rejectionCode, 'unknown_event_type');
  // The rejection replay is idempotent: same typed error, still ONE row.
  const replayError = await zeckError(app.zeck.ingestCallback(owner, tenantId, delivery));
  assert.equal(replayError.code, 'CALLBACK_UNKNOWN_EVENT_TYPE');
  assert.equal((await app.zeck.listCallbackEvents(owner, tenantId)).length, 1);
});

test('a malformed payload is rejected with durable evidence', async () => {
  const base_ = await base();
  const { app, owner, tenantId } = base_;
  const { executionId } = await submitted(base_);
  const delivery = callbackInput('evt-bad-payload', executionId);
  (delivery as { payload: unknown }).payload = { artifactRefs: 'not-an-array' };
  const error = await zeckError(app.zeck.ingestCallback(owner, tenantId, delivery));
  assert.equal(error.code, 'CALLBACK_INVALID_PAYLOAD');
  const row = await app.zeck.getCallbackEvent(owner, tenantId, 'evt-bad-payload');
  assert.equal(row.disposition, 'rejected');
  assert.equal(row.rejectionCode, 'invalid_payload');
});

test('an uncorrelated execution reference is rejected with durable evidence', async () => {
  const base_ = await base();
  const { app, owner, tenantId } = base_;
  await submitted(base_);
  const error = await zeckError(app.zeck.ingestCallback(owner, tenantId, callbackInput('evt-orphan', 'zeck-exec-unknown')));
  assert.equal(error.code, 'CALLBACK_UNCORRELATED');
  const row = await app.zeck.getCallbackEvent(owner, tenantId, 'evt-orphan');
  assert.equal(row.disposition, 'rejected');
  assert.equal(row.rejectionCode, 'uncorrelated');
});

test('a conflicting explicit correlation is rejected with durable evidence', async () => {
  const base_ = await base();
  const { app, owner, tenantId, workId } = base_;
  const { executionId } = await submitted(base_);
  const delivery = {
    ...callbackInput('evt-conflict', executionId),
    correlation: { serviceWorkId: workId, workAttemptId: '00000000-0000-4000-8000-000000000000' },
  };
  const error = await zeckError(app.zeck.ingestCallback(owner, tenantId, delivery));
  assert.equal(error.code, 'CALLBACK_CONFLICTING_CORRELATION');
  const row = await app.zeck.getCallbackEvent(owner, tenantId, 'evt-conflict');
  assert.equal(row.disposition, 'rejected');
  assert.equal(row.rejectionCode, 'conflicting_correlation');
});

test('a matching explicit correlation is accepted (the intent correlation is the truth)', async () => {
  const base_ = await base();
  const { app, owner, tenantId, workId, attemptId } = base_;
  const { executionId } = await submitted(base_);
  const delivery = {
    ...callbackInput('evt-match', executionId),
    correlation: { serviceWorkId: workId, workAttemptId: attemptId },
  };
  const { event } = await app.zeck.ingestCallback(owner, tenantId, delivery);
  assert.equal(event.disposition, 'accepted');
});

// ---------------------------------------------------------------------------
// Discrimination: input validation and correlation hygiene
// ---------------------------------------------------------------------------

test('same idempotency key with divergent content fails closed', async () => {
  const { app, owner, tenantId, workId, attemptId } = await base();
  await app.zeck.submitExecutionIntent(owner, intentInput(tenantId, workId, attemptId, 'intent-1'));
  const divergent = intentInput(tenantId, workId, attemptId, 'intent-1');
  (divergent as { objective: string }).objective = 'A materially different objective under the same key';
  const error = await zeckError(app.zeck.submitExecutionIntent(owner, divergent));
  assert.equal(error.code, 'IDEMPOTENCY_INPUT_CONFLICT');
});

test('capability declarations carrying model/provider selection are rejected (AC-4 surface)', async () => {
  const { app, owner, tenantId, workId, attemptId } = await base();
  for (const forbidden of [
    { capability: 'document.reasoning', model: 'gpt-5' },
    { capability: 'document.reasoning', provider: 'openai' },
    { capability: 'document.reasoning', temperature: 0.7 },
  ]) {
    const input = intentInput(tenantId, workId, attemptId, `intent-${JSON.stringify(forbidden).length}`);
    (input as { requiredCapabilities: unknown[] }).requiredCapabilities = [forbidden];
    const error = await zeckError(app.zeck.submitExecutionIntent(owner, input));
    assert.equal(error.code, 'AI_SELECTION_FORBIDDEN');
  }
});

test('unknown work / foreign attempts / dead attempts fail closed with typed codes', async () => {
  const { app, owner, tenantId, workId, attemptId } = await base();
  const unknownWork = await zeckError(
    app.zeck.submitExecutionIntent(
      owner,
      intentInput(tenantId, '00000000-0000-4000-8000-000000000000', attemptId, 'intent-x1'),
    ),
  );
  assert.equal(unknownWork.code, 'WORK_NOT_FOUND');
  const unknownAttempt = await zeckError(
    app.zeck.submitExecutionIntent(
      owner,
      intentInput(tenantId, workId, '00000000-0000-4000-8000-000000000000', 'intent-x2'),
    ),
  );
  assert.equal(unknownAttempt.code, 'ATTEMPT_NOT_FOUND');
  // A completed attempt can never carry a NEW logical AI execution: the
  // /work retry protocol creates a new attempt.
  const { work: second } = await app.work.createWork(owner, { tenantId, workType: 'T', title: 'Second' });
  const { attempt: dead } = await app.work.createAttempt(owner, tenantId, second.id);
  await app.work.recordAttemptResult(owner, tenantId, dead.id, { outcome: 'failed', result: 'machine legible failure' });
  const deadAttempt = await zeckError(app.zeck.submitExecutionIntent(owner, intentInput(tenantId, second.id, dead.id, 'intent-x3')));
  assert.equal(deadAttempt.code, 'ATTEMPT_NOT_SUBMITTABLE');
});

test('malformed submit input fails closed before any durable effect', async () => {
  const { app, owner, tenantId, workId, attemptId } = await base();
  const cases: unknown[] = [
    { ...intentInput(tenantId, workId, attemptId, 'k'), idempotencyKey: '' },
    { ...intentInput(tenantId, workId, attemptId, 'k'), objective: '   ' },
    { ...intentInput(tenantId, workId, attemptId, 'k'), inputArtifactRefs: 'not-an-array' },
    { ...intentInput(tenantId, workId, attemptId, 'k'), outputContract: { schemaRef: 'not checked yet', extra: 1 } },
    { ...intentInput('not-a-uuid', workId, attemptId, 'k') },
  ];
  for (const input of cases) {
    const error = await zeckError(app.zeck.submitExecutionIntent(owner, input as never));
    assert.equal(error.code, 'INVALID_INPUT');
  }
  assert.equal((await app.zeck.listExecutionIntents(owner, tenantId)).length, 0);
});

test('out-of-band mutation of stored rows is detected on read (tamper-evident surface)', async () => {
  const base_ = await base();
  const { app, owner, tenantId } = base_;
  const { intentId, executionId } = await submitted(base_);
  await app.zeck.ingestCallback(owner, tenantId, callbackInput('evt-tamper-env', executionId));
  // Intent content tamper: a schema-legal, hash-covered column.
  const stored = app.zeckStore.intents.get(intentId);
  assert.ok(stored !== undefined);
  stored.objective = 'A tampered objective';
  const intentError = await zeckError(app.zeck.getExecutionIntent(owner, tenantId, intentId));
  assert.equal(intentError.code, 'INTENT_RECORD_TAMPERED');
  stored.objective = 'Assess whether the uploaded certificate satisfies the compliance policy';
  // Reference/ingestion tamper: the record hash covers the foreign
  // reference state and the last-seen cursor.
  stored.lastSeenEventId = 'evt-forged';
  const cursorError = await zeckError(app.zeck.listExecutionIntents(owner, tenantId));
  assert.equal(cursorError.code, 'INTENT_RECORD_TAMPERED');
  stored.lastSeenEventId = 'evt-tamper-env';
  // Event payload tamper: the immutable delivery row is hash-verified.
  const eventId = app.zeckStore.eventsByEventId.get(`${tenantId}:evt-tamper-env`);
  assert.ok(eventId !== undefined);
  const storedEvent = app.zeckStore.events.get(eventId);
  assert.ok(storedEvent !== undefined);
  storedEvent.observed = { artifactRefs: [], evidenceRefs: [], warnings: [] };
  const eventError = await zeckError(app.zeck.listCallbackEvents(owner, tenantId));
  assert.equal(eventError.code, 'EVENT_RECORD_TAMPERED');
});

test('reads distinguish missing from present', async () => {
  const { app, owner, tenantId } = await base();
  const intentError = await zeckError(app.zeck.getExecutionIntent(owner, tenantId, '00000000-0000-4000-8000-000000000000'));
  assert.equal(intentError.code, 'INTENT_NOT_FOUND');
  const eventError = await zeckError(app.zeck.getCallbackEvent(owner, tenantId, 'no-such-event'));
  assert.equal(eventError.code, 'EVENT_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Tenancy (authorization before any domain data access)
// ---------------------------------------------------------------------------

test('authorization happens BEFORE any domain data access (single chain, fail closed)', async () => {
  const { app, outsider, tenantId, workId, attemptId } = await base();
  const readsBefore = { ...app.zeckStore.reads };
  const error = await zeckError(app.zeck.submitExecutionIntent(outsider, intentInput(tenantId, workId, attemptId, 'intent-no')));
  assert.equal(error.code, 'TENANT_FORBIDDEN');
  assert.deepEqual(app.zeckStore.reads, readsBefore, 'a denied request never touches domain data');
  const callbackError = await zeckError(
    app.zeck.ingestCallback(outsider, tenantId, callbackInput('evt-no', 'zeck-exec-1')),
  );
  assert.equal(callbackError.code, 'TENANT_FORBIDDEN');
  const readError = await zeckError(app.zeck.listExecutionIntents(outsider, tenantId));
  assert.equal(readError.code, 'TENANT_FORBIDDEN');
});

test('cross-tenant isolation: another tenant never observes intents or events', async () => {
  const base_ = await base();
  const { app, owner, outsider, tenantId, otherTenantId, workId, attemptId } = base_;
  const { executionId } = await submitted(base_);
  await app.zeck.ingestCallback(owner, tenantId, callbackInput('evt-iso', executionId));
  assert.deepEqual(await app.zeck.listExecutionIntents(outsider, otherTenantId), []);
  assert.deepEqual(await app.zeck.listCallbackEvents(outsider, otherTenantId), []);
  // The outsider authorizes fine against THEIR OWN tenant — the
  // cross-tenant WORK reference is what fails closed: the work lookup
  // carries its own tenant predicate, so tenant A's work identity is
  // invisible from tenant B (isolation at every layer).
  const crossError = await zeckError(
    app.zeck.submitExecutionIntent(outsider, intentInput(otherTenantId, workId, attemptId, 'intent-cross')),
  );
  assert.equal(crossError.code, 'WORK_NOT_FOUND');
});
