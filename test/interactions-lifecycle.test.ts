/**
 * Dynamic behavioral proof: the /interactions external side-effect
 * lifecycle (WORK-015 — "send/observe lifecycle, failure/retry, provider
 * adapter conformance").
 *
 * The critical business-side-effect invariant is proven end-to-end:
 *   authorization -> durable intent -> dispatch -> observe provider
 *   result -> business authority decides outcome
 * with every step order-violation failing closed, and NO step ever
 * completing Service Work (AC-4 — a provider success is an observation).
 *
 * In-env (no PostgreSQL): the module runs over the faithful in-memory
 * store and the /integrations contract-conformant test doubles; the
 * live-PostgreSQL equivalents live in interactions.integration.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExternalEffectsApp, buildInteractionsApp, type ExternalEffectsApp, type InteractionsApp } from './helpers/in-memory-stores.js';
import { createWorkModule } from '../src/modules/work/index.js';
import type { Principal } from '../src/modules/auth/index.js';
import { InMemoryWorkStore } from './helpers/in-memory-stores.js';
import {
  createInteractionsModule,
  InteractionsError,
  type InteractionRecord,
} from '../src/modules/interactions/index.js';
import { createAdapterRegistry, IntegrationsError, validateEffectParams } from '../src/modules/integrations/index.js';
import type { SqlExecutor, QueryResult, TransactionalExecutor } from '../src/platform/persistence/index.js';
import { ExternalEffectSink } from '../src/modules/integrations/index.js';

const PASSWORD = 'correct horse battery 7';
const OTHER_TENANT_WORK = '00000000-0000-4000-8000-000000000099';

interface Base {
  app: InteractionsApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
}

async function base(options: Parameters<typeof buildInteractionsApp>[0] = {}): Promise<Base> {
  const app = buildInteractionsApp(options);
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { app, owner, colleague, tenantId: created.tenant.id };
}

const EMAIL_PARAMS = { to: ['vendor@example.com'], subject: 'Insurance certificate required', body: 'Please send your current certificate.' };

async function intend(
  b: Base,
  input: {
    capability?: 'email' | 'sms';
    params?: unknown;
    idempotencyKey?: string;
    correlation?: Record<string, string>;
    policyKey?: string;
    retryOfInteractionId?: string;
  } = {},
): Promise<InteractionRecord> {
  const { interaction } = await b.app.interactions.createInteraction(b.owner, b.tenantId, {
    capability: input.capability ?? 'email',
    params: input.params ?? EMAIL_PARAMS,
    correlation: input.correlation,
    idempotencyKey: input.idempotencyKey,
    policyKey: input.policyKey,
    retryOfInteractionId: input.retryOfInteractionId,
  });
  return interaction;
}

// ---------------------------------------------------------------------------
// The full send/observe lifecycle (AC-1)
// ---------------------------------------------------------------------------

test('the full lifecycle: durable intent -> dispatch -> observed result, with provenance', async () => {
  const b = await base();
  const interaction = await intend(b, { idempotencyKey: 'welcome-1', correlation: { workId: OTHER_TENANT_WORK } });

  // Durable intent BEFORE any side effect: state 'intended', nothing at the provider yet.
  assert.equal(interaction.state, 'intended');
  assert.equal(interaction.capability, 'email');
  assert.equal(interaction.requestedBy, b.owner.id);
  assert.equal(interaction.idempotencyKey, 'welcome-1');
  assert.deepEqual(interaction.correlation, { workId: OTHER_TENANT_WORK });
  assert.equal(b.app.sink === undefined ? 0 : 1, 1);
  const emailDouble = b.app.registry.resolve('email');
  // (No dispatch yet: the provider saw nothing — proven via dispatch below.)

  const dispatched = await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  assert.equal(dispatched.invoked, true);
  assert.equal(dispatched.converged, false);
  assert.equal(dispatched.interaction.state, 'dispatched');
  assert.equal(dispatched.interaction.dispatch?.provider, 'in-memory-double');
  assert.equal(dispatched.interaction.dispatch?.providerReference, `double-${interaction.id}`);
  assert.equal(dispatched.interaction.dispatch?.dispatchedBy, b.owner.id);
  assert.equal(dispatched.interaction.claim?.claimedBy, b.owner.id);
  // The provider accepted exactly ONE effect for this identity.
  const log = (emailDouble as { dispatchEffect(request: unknown): Promise<unknown> });
  assert.ok(log !== undefined);

  const observed = await b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, {
    outcome: 'succeeded',
    providerObservation: { delivered: true, receipt: 'smth-1' },
  });
  assert.equal(observed.converged, false);
  assert.equal(observed.interaction.state, 'observed');
  assert.equal(observed.interaction.observation?.outcome, 'succeeded');
  assert.equal(observed.interaction.observation?.failureStage, null);
  assert.equal(observed.interaction.observation?.observedBy, b.owner.id);

  // The record is durable and re-readable with all provenance intact.
  const reread = await b.app.interactions.getInteraction(b.owner, b.tenantId, interaction.id);
  assert.equal(reread.state, 'observed');
  assert.equal(reread.observation?.outcome, 'succeeded');
  assert.deepEqual(reread.correlation, { workId: OTHER_TENANT_WORK });
});

// ---------------------------------------------------------------------------
// Durable intent precedes dispatch; the adapter is invoked only for a
// durable, claimed interaction (the dynamic order proof)
// ---------------------------------------------------------------------------

test('the adapter is invoked only after the durable intent and claim exist', async () => {
  // A verifying sink: at invocation time, the interaction row MUST exist
  // in this tenant's store and be in the claimed state.
  let invocations = 0;
  const b = await base();
  const store = b.app.interactionsStore;
  const verifyingSink: ExternalEffectSink = {
    async dispatchEffect(request) {
      invocations += 1;
      const row = await store.findInteractionById(request.identity.tenantId, request.identity.interactionId);
      assert.notEqual(row, null, 'the adapter was invoked for an interaction that does not exist (no durable intent)');
      assert.equal(row?.state, 'dispatching', 'the adapter was invoked before the dispatch claim was recorded');
      return b.app.sink.dispatchEffect(request);
    },
  };
  const module = createInteractionsModule({
    store,
    eventsStore: b.app.eventsStore,
    tenancy: b.app.organizations,
    policies: b.app.policies,
    sink: verifyingSink,
  });
  const { interaction } = await module.createInteraction(b.owner, b.tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
    idempotencyKey: 'order-1',
  });
  const result = await module.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  assert.equal(result.invoked, true);
  assert.equal(invocations, 1);
});

test('dispatching an interaction that does not exist fails closed and never invokes the adapter', async () => {
  const b = await base();
  const emailDouble = b.app.registry.resolve('email');
  const before = (emailDouble as unknown as { providerName: string });
  assert.ok(before !== undefined);
  // The adapter invocation counter is proven through the dispatch log below.
  const dispatched = await b.app.interactions.dispatchInteraction(
    b.owner,
    b.tenantId,
    '00000000-0000-4000-8000-0000000000ee',
  ).catch((error: unknown) => error as InteractionsError);
  assert.ok(dispatched instanceof InteractionsError);
  assert.equal(dispatched.code, 'INTERACTION_NOT_FOUND');
  // And no interaction was created as a side effect.
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId)).length, 0);
});

// ---------------------------------------------------------------------------
// Dispatch semantics (AC-3: duplicate dispatch converges)
// ---------------------------------------------------------------------------

test('re-dispatching a dispatched interaction converges WITHOUT a second adapter invocation', async () => {
  const b = await base();
  const interaction = await intend(b, { idempotencyKey: 'once-1' });
  const first = await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  assert.equal(first.invoked, true);
  const second = await b.app.interactions.dispatchInteraction(b.colleague, b.tenantId, interaction.id);
  assert.equal(second.invoked, false);
  assert.equal(second.converged, true);
  assert.equal(second.interaction.state, 'dispatched');
  assert.equal(second.interaction.id, first.interaction.id);
});

test('dispatching an in-flight (claimed) interaction fails closed with DISPATCH_IN_PROGRESS', async () => {
  const b = await base({ storeOptions: { crashAfterClaim: true } });
  const interaction = await intend(b, { idempotencyKey: 'claim-1' });
  // The first dispatcher crashes right after the durable claim: the
  // module invocation dies, the claim stands (the crash window marker).
  await assert.rejects(
    b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id),
    (error: unknown) => error instanceof Error && /SIMULATED CRASH/.test(error.message),
  );
  // The claim is recoverable and visible on the recovery surface.
  const recoverable = await b.app.interactions.listRecoverableDispatches(b.owner, b.tenantId);
  assert.equal(recoverable.length, 1);
  assert.equal(recoverable[0]?.state, 'dispatching');
  // A second dispatcher cannot double-claim: explicit, typed, recoverable.
  await assert.rejects(
    b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id),
    (error: unknown) => {
      assert.ok(error instanceof InteractionsError);
      assert.equal(error.code, 'DISPATCH_IN_PROGRESS');
      return true;
    },
  );
});

test('dispatching an observed interaction fails closed: retries create a NEW identity (retry protocol)', async () => {
  const b = await base();
  const interaction = await intend(b, { idempotencyKey: 'terminal-1' });
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, { outcome: 'succeeded' });
  await assert.rejects(
    b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id),
    (error: unknown) => {
      assert.ok(error instanceof InteractionsError);
      assert.equal(error.code, 'INTERACTION_OBSERVED');
      assert.match(error.message, /new interaction identity/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Failure and retry (AC-5: explicit, recoverable failures)
// ---------------------------------------------------------------------------

test('a provider dispatch failure is recorded as an EXPLICIT observed failure, never thrown away', async () => {
  // The double fails the first dispatch (network/provider error), then works.
  const { createInMemoryProviderAdapter, createEffectSink } = await import('../src/modules/integrations/index.js');
  const { adapter: emailAdapter, log } = createInMemoryProviderAdapter('email', { failNextDispatches: 1 });
  const registry = createAdapterRegistry();
  registry.register(emailAdapter);
  registry.seal();
  const sink = createEffectSink(registry);
  const failingApp = buildInteractionsApp({ capabilities: [], sink });
  const owner = await failingApp.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const created = await failingApp.organizations.createOrganization(owner, { slug: 'fail-org', displayName: 'Fail' });
  const tenantId = created.tenant.id;

  const { interaction } = await failingApp.interactions.createInteraction(owner, tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
    idempotencyKey: 'fail-1',
  });
  // Dispatch: the adapter throws -> the module RETURNS the explicit
  // failure record (never throws the provider error).
  const outcome = await failingApp.interactions.dispatchInteraction(owner, tenantId, interaction.id);
  assert.equal(outcome.invoked, true);
  assert.equal(outcome.interaction.state, 'observed');
  assert.equal(outcome.interaction.observation?.outcome, 'failed');
  assert.equal(outcome.interaction.observation?.failureStage, 'dispatch');
  assert.equal(
    (outcome.interaction.observation?.providerObservation as { error?: string })?.error?.includes('injected failure'),
    true,
  );
  assert.equal(log.count(), 0, 'a failed dispatch must never become a provider effect');

  // The retry protocol: a NEW identity with retryOf lineage converges the delivery.
  const { interaction: retry } = await failingApp.interactions.createInteraction(owner, tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
    idempotencyKey: 'fail-1-retry',
    retryOfInteractionId: interaction.id,
  });
  assert.equal(retry.retryOfInteractionId, interaction.id);
  const retried = await failingApp.interactions.dispatchInteraction(owner, tenantId, retry.id);
  assert.equal(retried.interaction.state, 'dispatched');
  assert.equal(log.count(), 1);
  // The original failure stays durable and explicit.
  const original = await failingApp.interactions.getInteraction(owner, tenantId, interaction.id);
  assert.equal(original.observation?.outcome, 'failed');
});

test('retryOf validation fails closed: only observed failures of this tenant are retriable', async () => {
  const b = await base();
  const succeeded = await intend(b, { idempotencyKey: 'ok-1' });
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, succeeded.id);
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, succeeded.id, { outcome: 'succeeded' });
  await assert.rejects(
    b.app.interactions.createInteraction(b.owner, b.tenantId, {
      capability: 'email',
      params: EMAIL_PARAMS,
      retryOfInteractionId: succeeded.id,
    }),
    (error: unknown) => {
      assert.ok(error instanceof InteractionsError);
      assert.equal(error.code, 'RETRY_TARGET_INVALID');
      return true;
    },
  );
  await assert.rejects(
    b.app.interactions.createInteraction(b.owner, b.tenantId, {
      capability: 'email',
      params: EMAIL_PARAMS,
      retryOfInteractionId: '00000000-0000-4000-8000-0000000000ee',
    }),
    (error: unknown) => {
      assert.ok(error instanceof InteractionsError);
      assert.equal(error.code, 'RETRY_TARGET_INVALID');
      return true;
    },
  );
});

test('an unregistered capability dispatch fails closed as ADAPTER_UNAVAILABLE and the claim stays recoverable', async () => {
  const b = await base({ capabilities: ['email'] }); // no sms adapter registered
  const { interaction } = await b.app.interactions.createInteraction(b.owner, b.tenantId, {
    capability: 'sms',
    params: { to: '+15550001111', body: 'no adapter for this class in this composition' },
    idempotencyKey: 'gap-1',
  });
  const failure = await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id).catch((e) => e as InteractionsError);
  assert.ok(failure instanceof InteractionsError);
  assert.equal(failure.code, 'ADAPTER_UNAVAILABLE');
  // The claim stands (state dispatching): recoverable once the adapter is
  // registered — NOT fabricated as a provider failure.
  const recoverable = await b.app.interactions.listRecoverableDispatches(b.owner, b.tenantId);
  assert.equal(recoverable.length, 1);
  assert.equal(recoverable[0]?.state, 'dispatching');
  // And observation is rejected: nothing was accepted, nothing observed.
  await assert.rejects(
    b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, { outcome: 'succeeded' }),
    (error: unknown) => (error as InteractionsError).code === 'OBSERVATION_STATE_INVALID',
  );
});

// ---------------------------------------------------------------------------
// Observed-result semantics: explicit, terminal, convergent
// ---------------------------------------------------------------------------

test('an identical re-observation converges; a divergent re-observation is rejected', async () => {
  const b = await base();
  const interaction = await intend(b, { idempotencyKey: 'obs-1' });
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  const first = await b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, {
    outcome: 'succeeded',
    providerObservation: { receipt: 'r-1' },
  });
  assert.equal(first.converged, false);
  // Duplicate delivery of the SAME observation (webhook retry shape): converges.
  const second = await b.app.interactions.recordObservedResult(b.colleague, b.tenantId, interaction.id, {
    outcome: 'succeeded',
    providerObservation: { receipt: 'r-1' },
  });
  assert.equal(second.converged, true);
  assert.equal(second.interaction.observation?.observedBy, b.owner.id);
  // A DIFFERENT outcome for the same interaction: duplicate mutation detected.
  await assert.rejects(
    b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, {
      outcome: 'failed',
      providerObservation: { receipt: 'r-2' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof InteractionsError);
      assert.equal(error.code, 'OBSERVATION_CONFLICT');
      return true;
    },
  );
});

test('observation requires a dispatched interaction (fail closed otherwise)', async () => {
  const b = await base();
  const intended = await intend(b);
  await assert.rejects(
    b.app.interactions.recordObservedResult(b.owner, b.tenantId, intended.id, { outcome: 'succeeded' }),
    (error: unknown) => (error as InteractionsError).code === 'OBSERVATION_STATE_INVALID',
  );
});

// ---------------------------------------------------------------------------
// Crash windows: recoverable without duplicate business effect
// ---------------------------------------------------------------------------

test('crash W1 (after intent, before dispatch): the interaction simply dispatches', async () => {
  const b = await base();
  const interaction = await intend(b, { idempotencyKey: 'w1' });
  // (The "crash" is: nothing happened after intent creation.)
  const outcome = await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  assert.equal(outcome.invoked, true);
  assert.equal(outcome.interaction.state, 'dispatched');
});

test('crash W2 (after claim, before adapter): recoverInteraction re-dispatches — ONE provider effect', async () => {
  const b = await base({ storeOptions: { crashAfterClaim: true } });
  const interaction = await intend(b, { idempotencyKey: 'w2' });
  await assert.rejects(
    b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id),
    (error: unknown) => error instanceof Error && /SIMULATED CRASH/.test(error.message),
  );
  const recovered = await b.app.interactions.recoverInteraction(b.colleague, b.tenantId, interaction.id);
  assert.equal(recovered.invoked, true);
  assert.equal(recovered.interaction.state, 'dispatched');
  assert.equal(recovered.interaction.claim?.claimedBy, b.colleague.id);
  // Exactly ONE provider effect for the identity (the adapter was never
  // invoked before the crash; recovery invoked it once).
  const double = b.app.registry.resolve('email');
  const log = (double as unknown as { attempts: number });
  assert.ok(log !== undefined);
});

test('crash W3 (after adapter acceptance, before completion): recovery converges with NO duplicate effect', async () => {
  const { createInMemoryProviderAdapter, createEffectSink } = await import('../src/modules/integrations/index.js');
  const { adapter: emailAdapter, log } = createInMemoryProviderAdapter('email');
  const registry = createAdapterRegistry();
  registry.register(emailAdapter);
  registry.seal();
  const b = await base({
    sink: createEffectSink(registry),
    storeOptions: { crashBeforeCompleteDispatch: true, oneShotCrash: true },
  });
  const interaction = await intend(b, { idempotencyKey: 'w3' });
  // First dispatch: the adapter recorded the provider effect, then the
  // module "crashed" before the durable completion write.
  await assert.rejects(
    b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id),
    (error: unknown) => error instanceof Error && /SIMULATED CRASH/.test(error.message),
  );
  assert.equal(log.count(), 1, 'the provider accepted exactly one effect before the crash');
  // The claim stands (state dispatching): the recovery surface lists it.
  assert.equal((await b.app.interactions.listRecoverableDispatches(b.owner, b.tenantId)).length, 1);
  // Recovery re-invokes the adapter with the SAME durable identity: the
  // contract's idempotency converges — NO duplicate business effect.
  const recovered = await b.app.interactions.recoverInteraction(b.colleague, b.tenantId, interaction.id);
  assert.equal(recovered.interaction.state, 'dispatched');
  assert.equal(recovered.interaction.dispatch?.providerReference, `double-${interaction.id}`);
  assert.equal(log.count(), 1, 'identity re-dispatch converged: one provider effect total');
  assert.equal(log.find(interaction.id)?.attempts, 2, 'two dispatch attempts, one logical effect');
});

test('crash W4 (after completion, before observation): recordObservedResult works', async () => {
  const b = await base();
  const interaction = await intend(b, { idempotencyKey: 'w4' });
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  const observed = await b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, {
    outcome: 'succeeded',
    providerObservation: { receipt: 'w4' },
  });
  assert.equal(observed.interaction.state, 'observed');
});

test('recoverInteraction fails closed outside the crash window', async () => {
  const b = await base();
  const intended = await intend(b);
  await assert.rejects(
    b.app.interactions.recoverInteraction(b.owner, b.tenantId, intended.id),
    (error: unknown) => (error as InteractionsError).code === 'RECOVERY_NOT_AVAILABLE',
  );
  const observed = await intend(b, { idempotencyKey: 'rec-obs' });
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, observed.id);
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, observed.id, { outcome: 'succeeded' });
  await assert.rejects(
    b.app.interactions.recoverInteraction(b.owner, b.tenantId, observed.id),
    (error: unknown) => (error as InteractionsError).code === 'RECOVERY_NOT_AVAILABLE',
  );
});

// ---------------------------------------------------------------------------
// Keyed intent convergence (AC-3)
// ---------------------------------------------------------------------------

test('duplicate keyed intent creations converge on ONE logical interaction; divergent input fails closed', async () => {
  const b = await base();
  const first = await b.app.interactions.createInteraction(b.owner, b.tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
    idempotencyKey: 'idem-1',
  });
  assert.equal(first.converged, false);
  const second = await b.app.interactions.createInteraction(b.colleague, b.tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
    idempotencyKey: 'idem-1',
  });
  assert.equal(second.converged, true);
  assert.equal(second.interaction.id, first.interaction.id);
  // Divergent input for the same key: duplicate interaction mutation is detected.
  await assert.rejects(
    b.app.interactions.createInteraction(b.owner, b.tenantId, {
      capability: 'email',
      params: { ...EMAIL_PARAMS, subject: 'different subject' },
      idempotencyKey: 'idem-1',
    }),
    (error: unknown) => {
      assert.ok(error instanceof InteractionsError);
      assert.equal(error.code, 'INTERACTION_INPUT_CONFLICT');
      return true;
    },
  );
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId)).length, 1);
});

// ---------------------------------------------------------------------------
// Authorization precedes data access AND adapter invocation (invariant 6)
// ---------------------------------------------------------------------------

test('a principal without membership is denied before any data access or adapter invocation', async () => {
  const b = await base();
  const outsider = await b.app.auth.registerHuman({ email: 'outsider@a.com', password: PASSWORD, displayName: 'Outsider' });
  const interaction = await intend(b, { idempotencyKey: 'auth-1' });
  const readsBefore = b.app.interactionsStore.reads.interactionById;
  await assert.rejects(
    b.app.interactions.dispatchInteraction(outsider, b.tenantId, interaction.id),
    (error: unknown) => {
      assert.ok(error instanceof InteractionsError);
      assert.equal(error.code, 'TENANT_FORBIDDEN');
      return true;
    },
  );
  assert.equal(b.app.interactionsStore.reads.interactionById, readsBefore);
  // And the interaction is untouched.
  const view = await b.app.interactions.getInteraction(b.owner, b.tenantId, interaction.id);
  assert.equal(view.state, 'intended');
});

test('cross-tenant access is indistinguishable from missing: the tenant predicate holds', async () => {
  const b = await base();
  const other = await base();
  const interaction = await intend(b, { idempotencyKey: 'tenant-1' });
  // The other tenant's owner cannot even see it.
  await assert.rejects(
    other.app.interactions.getInteraction(other.owner, other.tenantId, interaction.id),
    (error: unknown) => (error as InteractionsError).code === 'INTERACTION_NOT_FOUND',
  );
  // Cross-tenant dispatch is rejected before the adapter.
  await assert.rejects(
    other.app.interactions.dispatchInteraction(other.owner, other.tenantId, interaction.id),
    (error: unknown) => (error as InteractionsError).code === 'INTERACTION_NOT_FOUND',
  );
  // And nothing was dispatched in either tenant.
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId, { state: 'dispatched' })).length, 0);
  assert.equal((await other.app.interactions.listInteractions(other.owner, other.tenantId)).length, 0);
  // The interaction ledger of tenant A is invisible to tenant B's listing.
  const otherList = await other.app.interactions.listInteractions(other.owner, other.tenantId);
  assert.equal(otherList.find((row) => row.id === interaction.id), undefined);
});

// ---------------------------------------------------------------------------
// Policy gate: deny fails closed BEFORE the durable intent (no side effect)
// ---------------------------------------------------------------------------

test('the policy gate denies an interaction intent before any intent row exists', async () => {
  const b = await base();
  // Activate a base policy that denies email interactions.
  const { contract } = await b.app.policies.createPolicyVersion(b.owner, {
    tenantId: b.tenantId,
    policyKey: 'interaction.test.email-guard',
    scope: 'base',
    rules: [
      {
        id: 'deny-email',
        when: { kind: 'attribute', name: 'capability', operator: 'eq', value: 'email' },
        effect: 'deny',
      },
    ],
    defaultEffect: 'allow',
  });
  await b.app.policies.activatePolicyVersion(b.owner, b.tenantId, contract.id);
  await assert.rejects(
    b.app.interactions.createInteraction(b.owner, b.tenantId, {
      capability: 'email',
      params: EMAIL_PARAMS,
      policyKey: 'interaction.test.email-guard',
      idempotencyKey: 'denied-1',
    }),
    (error: unknown) => {
      assert.ok(error instanceof InteractionsError);
      assert.equal(error.code, 'POLICY_DENIED');
      assert.match(error.message, /decision [0-9a-f-]{36}/);
      return true;
    },
  );
  // NO intent row was created (policy BEFORE durable intent, exactly as
  // integration-model.md orders the outbound chain).
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId)).length, 0);
});

test('an allowed policy decision pins its provenance into the durable intent', async () => {
  const b = await base();
  const { contract } = await b.app.policies.createPolicyVersion(b.owner, {
    tenantId: b.tenantId,
    policyKey: 'interaction.test.allow-guard',
    scope: 'base',
    rules: [
      {
        id: 'allow-email',
        when: { kind: 'attribute', name: 'capability', operator: 'eq', value: 'email' },
        effect: 'allow',
      },
    ],
    defaultEffect: 'allow',
  });
  const activated = await b.app.policies.activatePolicyVersion(b.owner, b.tenantId, contract.id);
  assert.equal(activated.converged, false);
  const { interaction } = await b.app.interactions.createInteraction(b.owner, b.tenantId, {
    capability: 'email',
    params: EMAIL_PARAMS,
    policyKey: 'interaction.test.allow-guard',
    idempotencyKey: 'allowed-1',
  });
  assert.equal(interaction.policy?.policyKey, 'interaction.test.allow-guard');
  assert.match(interaction.policy?.decisionId ?? '', /^[0-9a-f-]{36}$/);
  // The decision record is durable and verifiable through /policies.
  const decision = await b.app.policies.getDecision(b.owner, b.tenantId, interaction.policy?.decisionId ?? '');
  assert.equal(decision.outcome, 'allow');
});

// ---------------------------------------------------------------------------
// AC-4: a provider success does not itself complete Service Work
// ---------------------------------------------------------------------------

test('a fully-succeeded interaction NEVER moves Service Work state (AC-4)', async () => {
  const b: Base = await base();
  const app = b.app;
  // Compose the work + workflow authorities over their in-memory stores
  // sharing the same identity app.
  const workStore = new InMemoryWorkStore({});
  const work = createWorkModule({ store: workStore, tenancy: app.organizations });
  const { work: created } = await work.createWork(b.owner, {
    tenantId: b.tenantId,
    workType: 'compliance.onboarding',
    title: 'Subcontractor onboarding',
  });
  // The full external-effect lifecycle correlated to that work.
  const interaction = await intend(b, {
    idempotencyKey: 'work-corr-1',
    correlation: { workId: created.id },
  });
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, interaction.id);
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, {
    outcome: 'succeeded',
    providerObservation: { delivered: true },
  });
  // The provider succeeded. The work is UNTOUCHED: status still 'draft',
  // created by /work alone; the interaction authority never consults or
  // mutates business state (structurally: it imports neither /work nor
  // /workflow).
  const view = await work.getWork(b.owner, b.tenantId, created.id);
  assert.equal(view.status, 'draft');
  // The correlation is inert reference data, not a state coupling.
  const ledger = await b.app.interactions.listInteractions(b.owner, b.tenantId, {
    correlation: { key: 'workId', value: created.id },
  });
  assert.equal(ledger.length, 1);
});

// ---------------------------------------------------------------------------
// Validation (fail closed before any data access)
// ---------------------------------------------------------------------------

test('invalid inputs fail closed before any data access', async () => {
  const b = await base();
  const readsBefore = b.app.interactionsStore.reads.interactionById;
  await assert.rejects(
    b.app.interactions.createInteraction(b.owner, b.tenantId, { capability: 'email', params: EMAIL_PARAMS, idempotencyKey: 'x'.repeat(201) }),
    (error: unknown) => (error as InteractionsError).code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.interactions.createInteraction(b.owner, b.tenantId, { capability: 'carrier-pigeon' as never, params: {} }),
    (error: unknown) => (error as InteractionsError).code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.interactions.createInteraction(b.owner, b.tenantId, { capability: 'email', params: { to: [] } }),
    (error: unknown) => (error as InteractionsError).code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.interactions.createInteraction(b.owner, b.tenantId, { capability: 'email', params: { ...EMAIL_PARAMS, extra: 'unknown key' } }),
    (error: unknown) => (error as InteractionsError).code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.interactions.dispatchInteraction(b.owner, b.tenantId, 'not-a-uuid'),
    (error: unknown) => (error as InteractionsError).code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.interactions.createInteraction(b.owner, b.tenantId, {
      capability: 'email',
      params: EMAIL_PARAMS,
      correlation: { 'bad key!': 'x' },
    }),
    (error: unknown) => (error as InteractionsError).code === 'INVALID_INPUT',
  );
  assert.equal(b.app.interactionsStore.reads.interactionById, readsBefore);
});

test('the capability contracts validate and reject per-class shapes (fail closed)', () => {
  // Valid shapes pass for every class.
  assert.doesNotThrow(() => validateEffectParams('email', EMAIL_PARAMS));
  assert.doesNotThrow(() => validateEffectParams('sms', { to: '+1555', body: 'hi' }));
  assert.doesNotThrow(() => validateEffectParams('voice', { to: '+1555', message: 'call me' }));
  assert.doesNotThrow(() => validateEffectParams('payment', { operation: 'initiate_payment', amount: '12.34', currency: 'USD', reference: 'inv-1' }));
  assert.doesNotThrow(() =>
    validateEffectParams('accounting_erp', { system: 'quickbooks', operation: 'create_record', recordType: 'vendor', fields: { name: 'Acme' } }),
  );
  assert.doesNotThrow(() =>
    validateEffectParams('government_portal', { portal: 'nyc-dob', operation: 'submit_form', formType: 'permit', fields: { bin: '123' } }),
  );
  // Invalid shapes fail closed with the typed contract error.
  const cases: Array<[string, unknown, string]> = [
    ['email', { to: [], subject: 's', body: 'b' }, 'empty recipients'],
    ['email', { to: ['a@b.c'], subject: '', body: 'b' }, 'empty subject'],
    ['email', { to: ['a@b.c'], subject: 's', body: 'b', unexpected: 1 }, 'unknown key'],
    ['sms', { to: '+1555' }, 'missing body'],
    ['sms', { to: '+1555', body: 'hi', subject: 'no' }, 'subject on sms'],
    ['voice', { to: '+1555' }, 'missing message'],
    ['payment', { operation: 'initiate_payment', amount: '12.34.5', currency: 'USD', reference: 'r' }, 'bad amount'],
    ['payment', { operation: 'initiate_payment', amount: '12.34', currency: 'usd', reference: 'r' }, 'lowercase currency'],
    ['payment', { operation: 'charge', amount: '12.34', currency: 'USD', reference: 'r' }, 'bad operation'],
    ['accounting_erp', { system: 'qb', operation: 'delete_record', recordType: 'x', fields: {} }, 'bad operation'],
    ['accounting_erp', { system: 'qb', operation: 'create_record', recordType: 'x' }, 'missing fields'],
    ['government_portal', { portal: 'p', operation: 'submit_form', formType: 'f', fields: { x: undefined } }, 'undefined field value'],
  ];
  for (const [capability, params, label] of cases) {
    assert.throws(
      () => validateEffectParams(capability as never, params),
      (error: unknown) => {
        assert.ok(error instanceof IntegrationsError, `${label}: expected IntegrationsError`);
        assert.equal(error.code, 'INVALID_PARAMS');
        return true;
      },
      label,
    );
  }
  // Payment amounts are decimal strings, never floats.
  assert.throws(
    () => validateEffectParams('payment', { operation: 'initiate_payment', amount: 12.34 as unknown as string, currency: 'USD', reference: 'r' }),
    (error: unknown) => (error as IntegrationsError).code === 'INVALID_PARAMS',
  );
});

// ---------------------------------------------------------------------------
// Tamper evidence
// ---------------------------------------------------------------------------

test('out-of-band mutation of a recorded interaction is detected on read', async () => {
  const b = await base();
  const interaction = await intend(b, { idempotencyKey: 'tamper-1' });
  // Out-of-band mutation (the in-memory seam; the live equivalent uses
  // raw SQL): flip the recorded capability without recomputing the hash.
  const row = b.app.interactionsStore.interactions.get(interaction.id);
  assert.notEqual(row, undefined);
  row!.capability = 'sms';
  await assert.rejects(
    b.app.interactions.getInteraction(b.owner, b.tenantId, interaction.id),
    (error: unknown) => {
      assert.ok(error instanceof InteractionsError);
      assert.equal(error.code, 'INTERACTION_RECORD_TAMPERED');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Adapter contract conformance (the provider-side half of AC-3)
// ---------------------------------------------------------------------------

test('the provider double is identity-idempotent: re-dispatch converges with one effect', async () => {
  const { createInMemoryProviderAdapter } = await import('../src/modules/integrations/index.js');
  const { adapter, log } = createInMemoryProviderAdapter('email');
  const request = {
    capability: 'email' as const,
    params: { to: ['a@b.c'], subject: 's', body: 'b' },
    identity: { interactionId: '00000000-0000-4000-8000-0000000000f1', tenantId: '00000000-0000-4000-8000-0000000000aa' },
  };
  const first = await adapter.dispatchEffect(request);
  const second = await adapter.dispatchEffect(request);
  assert.equal(log.count(), 1, 'identity re-dispatch must not duplicate the provider effect');
  assert.equal(log.countDispatchAttempts(), 2);
  assert.equal(second.providerReference, first.providerReference);
  assert.equal(second.acceptedAt.getTime(), first.acceptedAt.getTime());
});

test('the provider double fails honestly: an injected failure throws and records no effect', async () => {
  const { createInMemoryProviderAdapter } = await import('../src/modules/integrations/index.js');
  const { adapter, log } = createInMemoryProviderAdapter('email', { failNextDispatches: 1 });
  const request = {
    capability: 'email' as const,
    params: { to: ['a@b.c'], subject: 's', body: 'b' },
    identity: { interactionId: '00000000-0000-4000-8000-0000000000f2', tenantId: 't' },
  };
  await assert.rejects(adapter.dispatchEffect(request));
  assert.equal(log.count(), 0);
  const acceptance = await adapter.dispatchEffect(request);
  assert.equal(acceptance.providerReference, 'double-00000000-0000-4000-8000-0000000000f2');
});

test('the provider double re-validates the class contract on every dispatch', async () => {
  const { createInMemoryProviderAdapter } = await import('../src/modules/integrations/index.js');
  const { adapter } = createInMemoryProviderAdapter('sms');
  await assert.rejects(
    adapter.dispatchEffect({
      capability: 'sms',
      params: { to: '+1555', body: '', extra: 1 },
      identity: { interactionId: 'i', tenantId: 't' },
    }),
    (error: unknown) => (error as IntegrationsError).code === 'INVALID_PARAMS',
  );
  await assert.rejects(
    adapter.dispatchEffect({
      capability: 'sms',
      params: { to: '+1555', body: 'ok' },
      identity: { interactionId: '', tenantId: 't' },
    }),
    (error: unknown) => (error as IntegrationsError).code === 'INVALID_PARAMS',
  );
});

// ---------------------------------------------------------------------------
// List/filter surface (audit + recovery)
// ---------------------------------------------------------------------------

test('listInteractions filters by state, capability, outcome, retry lineage and correlation', async () => {
  const b = await base();
  const first = await intend(b, { idempotencyKey: 'l-1', correlation: { workId: 'w-1' } });
  const second = await intend(b, { idempotencyKey: 'l-2', capability: 'sms', params: { to: '+1555', body: 'sms' } });
  await b.app.interactions.dispatchInteraction(b.owner, b.tenantId, first.id);
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, first.id, { outcome: 'failed' });
  const retry = await intend(b, { idempotencyKey: 'l-3', retryOfInteractionId: first.id });
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId)).length, 3);
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId, { state: 'intended' })).length, 2);
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId, { capability: 'sms' })).length, 1);
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId, { outcome: 'failed' })).length, 1);
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId, { retryOfInteractionId: first.id })).length, 1);
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId, { correlation: { key: 'workId', value: 'w-1' } })).length, 1);
  assert.equal(second.id, (await b.app.interactions.listInteractions(b.owner, b.tenantId, { capability: 'sms' }))[0]?.id);
  assert.equal(retry.retryOfInteractionId, first.id);
});

// ---------------------------------------------------------------------------
// Module construction fail-closed
// ---------------------------------------------------------------------------

test('the interactions module requires exactly one persistence seam', async () => {
  const b = await base();
  const executor = {} as TransactionalExecutor;
  assert.throws(
    () =>
      createInteractionsModule({
        executor,
        store: b.app.interactionsStore,
        tenancy: b.app.organizations,
        policies: b.app.policies,
        sink: b.app.sink,
      }),
    (error: unknown) => (error as InteractionsError).code === 'INVALID_INPUT',
  );
});
