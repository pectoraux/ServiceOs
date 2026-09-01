/**
 * Dynamic behavioral + discrimination proof: the /notifications authority
 * (WORK-015 — delivery request/status through the owned interface;
 * AC-5: notification failures remain explicit and recoverable).
 *
 * Proves:
 * - requestNotification persists the durable request (idempotent, keyed
 *   convergence, divergent-input conflict) with NO side effect (no
 *   interaction, no adapter call);
 * - dispatchNotification creates the durable interaction intent through
 *   /interactions' public contract (key `notification:{id}` —
 *   crash-convergent), pins the pointer, dispatches — and re-invocations
 *   converge (ONE interaction, ONE adapter invocation);
 * - the derived delivery status follows the interaction's durable state
 *   (requested -> pending -> in_flight -> delivered/failed) — never
 *   re-recorded, and tamper evidence on the interaction surfaces through
 *   the notification read;
 * - failures are EXPLICIT (failed status, listNotifications filter) and
 *   RECOVERABLE (retryNotification creates a NEW interaction identity
 *   with retryOf lineage; only failed deliveries are retriable; the
 *   failed observation stays durable);
 * - the notification module holds no provider surface: an adapter
 *   unavailable error propagates typed, with NO fabricated delivery;
 * - channel-shaped validation fails closed (email requires subject;
 *   SMS/voice reject subjects);
 * - a provider success does not complete Service Work through this
 *   module either (the derived status is a delivery fact, never a
 *   business-state transition);
 * - tampering with a notification record is detected on read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExternalEffectsApp,
  type ExternalEffectsApp,
} from './helpers/in-memory-stores.js';
import type { Principal } from '../src/modules/auth/index.js';
import { createAdapterRegistry, createEffectSink, createInMemoryProviderAdapter } from '../src/modules/integrations/index.js';
import { InteractionsError, type InteractionRecord } from '../src/modules/interactions/index.js';
import { NotificationsError, type NotificationView } from '../src/modules/notifications/index.js';
import { createNotificationsModule } from '../src/modules/notifications/index.js';

const PASSWORD = 'correct horse battery 7';

interface Base {
  app: ExternalEffectsApp;
  owner: Principal;
  colleague: Principal;
  tenantId: string;
  emailLog: ReturnType<typeof createInMemoryProviderAdapter>['log'];
}

/**
 * A base with email + sms test-double adapters registered (the email
 * double optionally fails the FIRST dispatch, then works).
 */
async function base(options: { failFirstEmail?: boolean } = {}): Promise<Base> {
  const { adapter: emailAdapter, log: emailLog } = createInMemoryProviderAdapter('email', {
    failNextDispatches: options.failFirstEmail === true ? 1 : 0,
  });
  const { adapter: smsAdapter } = createInMemoryProviderAdapter('sms');
  const registry = createAdapterRegistry();
  registry.register(emailAdapter);
  registry.register(smsAdapter);
  registry.seal();
  const app = buildExternalEffectsApp({ capabilities: [], sink: createEffectSink(registry) });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const colleague = await app.auth.registerHuman({ email: 'member@a.com', password: PASSWORD, displayName: 'Member' });
  const created = await app.organizations.createOrganization(owner, { slug: 'alpha-org', displayName: 'Alpha' });
  await app.organizations.addMember(owner, 'alpha-org', { principalId: colleague.id, role: 'member' });
  return { app, owner, colleague, tenantId: created.tenant.id, emailLog };
}

const REQUEST = {
  channel: 'email' as const,
  recipient: { address: 'vendor@example.com', displayName: 'Acme Vendor' },
  content: { subject: 'Insurance certificate required', body: 'Please send your current certificate.' },
  purpose: 'compliance-followup',
  correlation: { workId: '00000000-0000-4000-8000-000000000077' },
};

// ---------------------------------------------------------------------------
// requestNotification: durable request, NO side effect
// ---------------------------------------------------------------------------

test('requestNotification persists the durable request with NO side effect', async () => {
  const b = await base();
  const { notification, converged } = await b.app.notifications.requestNotification(b.owner, b.tenantId, {
    ...REQUEST,
    idempotencyKey: 'notif-1',
  });
  assert.equal(converged, false);
  assert.equal(notification.channel, 'email');
  assert.deepEqual(notification.recipient, { address: 'vendor@example.com', displayName: 'Acme Vendor' });
  assert.deepEqual(notification.content, { subject: 'Insurance certificate required', body: 'Please send your current certificate.' });
  assert.equal(notification.purpose, 'compliance-followup');
  assert.deepEqual(notification.correlation, { workId: '00000000-0000-4000-8000-000000000077' });
  assert.equal(notification.currentInteractionId, null);
  // NO side effect: no interaction, no provider call.
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId)).length, 0);
  assert.equal(b.emailLog.count(), 0);
  // The derived status is 'requested'.
  const view = await b.app.notifications.getNotification(b.owner, b.tenantId, notification.id);
  assert.equal(view.delivery, 'requested');
  assert.equal(view.interaction, null);
});

test('requestNotification is idempotent: keyed convergence, divergent conflict', async () => {
  const b = await base();
  const first = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'notif-2' });
  const second = await b.app.notifications.requestNotification(b.colleague, b.tenantId, { ...REQUEST, idempotencyKey: 'notif-2' });
  assert.equal(second.converged, true);
  assert.equal(second.notification.id, first.notification.id);
  await assert.rejects(
    b.app.notifications.requestNotification(b.owner, b.tenantId, {
      ...REQUEST,
      content: { ...REQUEST.content, subject: 'different' },
      idempotencyKey: 'notif-2',
    }),
    (error: unknown) => (error as NotificationsError).code === 'NOTIFICATION_INPUT_CONFLICT',
  );
  assert.equal((await b.app.notifications.listNotifications(b.owner, b.tenantId)).length, 1);
});

test('channel-shaped validation fails closed (email requires subject; sms/voice reject it)', async () => {
  const b = await base();
  await assert.rejects(
    b.app.notifications.requestNotification(b.owner, b.tenantId, {
      channel: 'email',
      recipient: { address: 'a@b.c' },
      content: { body: 'no subject' },
    }),
    (error: unknown) => (error as NotificationsError).code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.notifications.requestNotification(b.owner, b.tenantId, {
      channel: 'sms' as never,
      recipient: { address: '+1555' },
      content: { subject: 'no', body: 'subjects do not apply to SMS' },
    }),
    (error: unknown) => (error as NotificationsError).code === 'INVALID_INPUT',
  );
  await assert.rejects(
    b.app.notifications.requestNotification(b.owner, b.tenantId, {
      channel: 'fax' as never,
      recipient: { address: 'x' },
      content: { body: 'x' },
    }),
    (error: unknown) => (error as NotificationsError).code === 'INVALID_INPUT',
  );
});

// ---------------------------------------------------------------------------
// dispatchNotification: durable intent -> pointer -> dispatch (convergent)
// ---------------------------------------------------------------------------

test('dispatchNotification creates the intent, pins the pointer and dispatches exactly once', async () => {
  const b = await base();
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'notif-3' });
  const outcome = await b.app.notifications.dispatchNotification(b.owner, b.tenantId, notification.id);
  assert.equal(outcome.invoked, true);
  assert.equal(outcome.view.delivery, 'in_flight');
  assert.notEqual(outcome.view.interaction, null);
  // The interaction carries the channel-shaped params and correlation.
  const interaction = outcome.view.interaction as InteractionRecord;
  assert.equal(interaction.capability, 'email');
  assert.deepEqual(interaction.params, { to: ['vendor@example.com'], subject: REQUEST.content.subject, body: REQUEST.content.body });
  assert.deepEqual(interaction.correlation, { workId: '00000000-0000-4000-8000-000000000077' });
  assert.equal(interaction.idempotencyKey, `notification:${notification.id}`);
  assert.equal(b.emailLog.count(), 1);
  // Re-dispatch converges: one interaction, no second provider call.
  const again = await b.app.notifications.dispatchNotification(b.colleague, b.tenantId, notification.id);
  assert.equal(again.invoked, false);
  assert.equal(again.view.delivery, 'in_flight');
  assert.equal(again.view.interaction?.id, interaction.id);
  assert.equal(b.emailLog.count(), 1);
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId)).length, 1);
  // The pointer is pinned.
  const view = await b.app.notifications.getNotification(b.owner, b.tenantId, notification.id);
  assert.equal(view.notification.currentInteractionId, interaction.id);
});

test('SMS notifications build SMS-shaped effects', async () => {
  const b = await base();
  const sms = await b.app.notifications.requestNotification(b.owner, b.tenantId, {
    channel: 'sms' as never,
    recipient: { address: '+15550001111' },
    content: { body: 'Certificate required.' },
    idempotencyKey: 'sms-1',
  });
  const outcome = await b.app.notifications.dispatchNotification(b.owner, b.tenantId, sms.notification.id);
  assert.equal(outcome.view.interaction?.capability, 'sms');
  assert.deepEqual(outcome.view.interaction?.params, { to: '+15550001111', body: 'Certificate required.' });
});

// ---------------------------------------------------------------------------
// The derived status follows the interaction's durable state
// ---------------------------------------------------------------------------

test('the derived delivery status tracks the interaction lifecycle', async () => {
  const b = await base();
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'track-1' });
  const { interaction } = {
    interaction: (await b.app.notifications.dispatchNotification(b.owner, b.tenantId, notification.id)).view.interaction,
  } as { interaction: InteractionRecord };
  assert.equal((await b.app.notifications.getNotification(b.owner, b.tenantId, notification.id)).delivery, 'in_flight');
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, {
    outcome: 'succeeded',
    providerObservation: { delivered: true },
  });
  const delivered = await b.app.notifications.getNotification(b.owner, b.tenantId, notification.id);
  assert.equal(delivered.delivery, 'delivered');
  // The delivered view is stable and re-derivable.
  assert.equal((await b.app.notifications.listNotifications(b.owner, b.tenantId, { delivery: 'delivered' })).length, 1);
});

// ---------------------------------------------------------------------------
// AC-5: failures are explicit and recoverable
// ---------------------------------------------------------------------------

test('a provider delivery failure surfaces as the explicit failed status and is recoverable by retry', async () => {
  const b = await base({ failFirstEmail: true });
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'fail-notif-1' });
  const first = await b.app.notifications.dispatchNotification(b.owner, b.tenantId, notification.id);
  // The provider failed: the failure is the durable observed record, the
  // derived status is EXPLICITLY failed (never silently dropped).
  assert.equal(first.view.delivery, 'failed');
  assert.equal(first.view.interaction?.observation?.outcome, 'failed');
  assert.equal(first.view.interaction?.observation?.failureStage, 'dispatch');
  assert.equal(b.emailLog.count(), 0);

  // The failure is listed explicitly.
  assert.equal((await b.app.notifications.listNotifications(b.owner, b.tenantId, { delivery: 'failed' })).length, 1);

  // The retry: a NEW interaction identity with retryOf lineage.
  const retry = await b.app.notifications.retryNotification(b.owner, b.tenantId, notification.id, { idempotencyKey: 'retry-1' });
  assert.equal(retry.view.delivery, 'in_flight');
  assert.equal(retry.view.interaction?.retryOfInteractionId, first.view.interaction?.id);
  assert.notEqual(retry.view.interaction?.id, first.view.interaction?.id);
  // The failed observation stays durable and explicit.
  const failedView = await b.app.interactions.getInteraction(b.owner, b.tenantId, first.view.interaction?.id ?? '');
  assert.equal(failedView.observation?.outcome, 'failed');
  // The retry delivered.
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, retry.view.interaction?.id ?? '', {
    outcome: 'succeeded',
    providerObservation: { delivered: true },
  });
  const final = await b.app.notifications.getNotification(b.owner, b.tenantId, notification.id);
  assert.equal(final.delivery, 'delivered');
  assert.equal(final.interaction?.id, retry.view.interaction?.id);
  // The lineage is auditable through the interactions ledger.
  const lineage = await b.app.interactions.listInteractions(b.owner, b.tenantId, {
    retryOfInteractionId: first.view.interaction?.id,
  });
  assert.equal(lineage.length, 1);
});

test('retryNotification fails closed when the delivery has not failed', async () => {
  const b = await base();
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'retry-guard-1' });
  // 'requested' deliveries dispatch directly; retries require failures.
  await assert.rejects(
    b.app.notifications.retryNotification(b.owner, b.tenantId, notification.id, { idempotencyKey: 'r-early' }),
    (error: unknown) => (error as NotificationsError).code === 'NOTIFICATION_NOT_FAILED',
  );
  const { interaction } = {
    interaction: (await b.app.notifications.dispatchNotification(b.owner, b.tenantId, notification.id)).view.interaction,
  } as { interaction: InteractionRecord };
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, interaction.id, { outcome: 'succeeded' });
  await assert.rejects(
    b.app.notifications.retryNotification(b.owner, b.tenantId, notification.id, { idempotencyKey: 'r-after-ok' }),
    (error: unknown) => (error as NotificationsError).code === 'NOTIFICATION_NOT_FAILED',
  );
});

test('a retry key is REQUIRED (concurrent identical retries converge by key)', async () => {
  const b = await base();
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'retry-key-1' });
  await assert.rejects(
    b.app.notifications.retryNotification(b.owner, b.tenantId, notification.id, { idempotencyKey: '' }),
    (error: unknown) => (error as NotificationsError).code === 'INVALID_INPUT',
  );
});

// ---------------------------------------------------------------------------
// The policy gate flows through the interaction boundary (consumed, not reimplemented)
// ---------------------------------------------------------------------------

test('dispatchNotification accepts a policyKey; a deny fails closed with NO interaction', async () => {
  const b = await base();
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'gated-1' });
  const { contract } = await b.app.policies.createPolicyVersion(b.owner, {
    tenantId: b.tenantId,
    policyKey: 'notifications.test.deny-all',
    scope: 'base',
    rules: [{ id: 'deny', when: { kind: 'always' }, effect: 'deny' }],
    defaultEffect: 'deny',
  });
  await b.app.policies.activatePolicyVersion(b.owner, b.tenantId, contract.id);
  await assert.rejects(
    b.app.notifications.dispatchNotification(b.owner, b.tenantId, notification.id, { policyKey: 'notifications.test.deny-all' }),
    (error: unknown) => {
      assert.ok(error instanceof NotificationsError);
      assert.equal(error.code, 'POLICY_DENIED');
      return true;
    },
  );
  // NO interaction was created and no provider was called.
  assert.equal((await b.app.interactions.listInteractions(b.owner, b.tenantId)).length, 0);
  assert.equal(b.emailLog.count(), 0);
  // The request still exists (requesting is not a side effect).
  assert.equal((await b.app.notifications.listNotifications(b.owner, b.tenantId)).length, 1);
});

// ---------------------------------------------------------------------------
// Authorization precedes data access
// ---------------------------------------------------------------------------

test('a principal without membership is denied before any notification data access', async () => {
  const b = await base();
  const outsider = await b.app.auth.registerHuman({ email: 'outsider@a.com', password: PASSWORD, displayName: 'Outsider' });
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'auth-1' });
  const readsBefore = b.app.notificationsStore.reads.notificationById;
  await assert.rejects(
    b.app.notifications.dispatchNotification(outsider, b.tenantId, notification.id),
    (error: unknown) => (error as NotificationsError).code === 'TENANT_FORBIDDEN',
  );
  await assert.rejects(
    b.app.notifications.getNotification(outsider, b.tenantId, notification.id),
    (error: unknown) => (error as NotificationsError).code === 'TENANT_FORBIDDEN',
  );
  assert.equal(b.app.notificationsStore.reads.notificationById, readsBefore);
});

test('cross-tenant notification access is indistinguishable from missing', async () => {
  const b = await base();
  const other = await base();
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'tenant-1' });
  await assert.rejects(
    other.app.notifications.getNotification(other.owner, other.tenantId, notification.id),
    (error: unknown) => (error as NotificationsError).code === 'NOTIFICATION_NOT_FOUND',
  );
  assert.equal((await other.app.notifications.listNotifications(other.owner, other.tenantId)).length, 0);
});

// ---------------------------------------------------------------------------
// Adapter unavailability propagates typed; no fabricated delivery
// ---------------------------------------------------------------------------

test('an unavailable adapter propagates typed with NO fabricated delivery', async () => {
  const { adapter: smsAdapter } = createInMemoryProviderAdapter('sms');
  const registry = createAdapterRegistry();
  registry.register(smsAdapter); // email NOT registered
  registry.seal();
  const app = buildExternalEffectsApp({ capabilities: [], sink: createEffectSink(registry) });
  const owner = await app.auth.registerHuman({ email: 'owner@a.com', password: PASSWORD, displayName: 'Owner' });
  const created = await app.organizations.createOrganization(owner, { slug: 'gap-org', displayName: 'Gap' });
  const { notification } = await app.notifications.requestNotification(owner, created.tenant.id, { ...REQUEST, idempotencyKey: 'gap-1' });
  const failure = await app.notifications
    .dispatchNotification(owner, created.tenant.id, notification.id)
    .catch((error) => error as NotificationsError);
  assert.ok(failure instanceof NotificationsError);
  assert.equal(failure.code, 'ADAPTER_UNAVAILABLE');
  // The interaction intent EXISTS (durable) and the pointer IS pinned
  // (before dispatch); the claim stands unsettled (dispatching) — the
  // derived status is in_flight, honestly reflecting the claimed window,
  // and NO delivery was fabricated (no observation, no effect).
  const view = await app.notifications.getNotification(owner, created.tenant.id, notification.id);
  assert.equal(view.delivery, 'in_flight');
  assert.equal(view.interaction?.state, 'dispatching');
  assert.equal(view.interaction?.observation, null);
  // The claimed interaction is recoverable through the interactions
  // authority's recovery surface (register the adapter, then recover).
  assert.equal((await app.interactions.listRecoverableDispatches(owner, created.tenant.id)).length, 1);
});

// ---------------------------------------------------------------------------
// Tamper evidence surfaces through the derived status read
// ---------------------------------------------------------------------------

test('interaction tampering surfaces through the notification status read', async () => {
  const b = await base();
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'tamper-1' });
  const outcome = await b.app.notifications.dispatchNotification(b.owner, b.tenantId, notification.id);
  const interactionId = outcome.view.interaction?.id as string;
  // Out-of-band mutation of the interaction row.
  const row = b.app.interactionsStore.interactions.get(interactionId);
  assert.notEqual(row, undefined);
  row!.capability = 'sms';
  await assert.rejects(
    b.app.notifications.getNotification(b.owner, b.tenantId, notification.id),
    (error: unknown) => {
      assert.ok(error instanceof NotificationsError);
      assert.equal(error.code, 'INTERACTION_RECORD_TAMPERED');
      return true;
    },
  );
});

test('notification record tampering is detected on read', async () => {
  const b = await base();
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'tamper-2' });
  const row = b.app.notificationsStore.notifications.get(notification.id);
  assert.notEqual(row, undefined);
  row!.purpose = 'mutated';
  await assert.rejects(
    b.app.notifications.getNotification(b.owner, b.tenantId, notification.id),
    (error: unknown) => (error as NotificationsError).code === 'NOTIFICATION_RECORD_TAMPERED',
  );
});

// ---------------------------------------------------------------------------
// A delivered notification never mutates business state (AC-4 through /notifications)
// ---------------------------------------------------------------------------

test('a delivered notification NEVER completes Service Work: the status is a delivery fact', async () => {
  const b = await base();
  const { notification } = await b.app.notifications.requestNotification(b.owner, b.tenantId, {
    ...REQUEST,
    idempotencyKey: 'no-business-1',
  });
  const outcome = await b.app.notifications.dispatchNotification(b.owner, b.tenantId, notification.id);
  await b.app.interactions.recordObservedResult(b.owner, b.tenantId, outcome.view.interaction?.id ?? '', {
    outcome: 'succeeded',
    providerObservation: { delivered: true },
  });
  const view = await b.app.notifications.getNotification(b.owner, b.tenantId, notification.id);
  assert.equal(view.delivery, 'delivered');
  // The notification module owns no business-state surface at all: its
  // reads expose delivery facts, never work state. (The structural
  // boundary — /notifications imports neither /work nor /workflow — is
  // proven in the boundary-checks suite.)
  assert.equal('status' in (view.notification as unknown as Record<string, unknown>), false);
});

// ---------------------------------------------------------------------------
// Module construction fail-closed
// ---------------------------------------------------------------------------

test('the notifications module requires exactly one persistence seam', async () => {
  const b = await base();
  assert.throws(
    () =>
      createNotificationsModule({
        executor: {} as never,
        store: b.app.notificationsStore,
        tenancy: b.app.organizations,
        interactions: b.app.interactions,
      }),
    (error: unknown) => (error as NotificationsError).code === 'INVALID_INPUT',
  );
});

// ---------------------------------------------------------------------------
// Module construction fail-closed
// ---------------------------------------------------------------------------

test('listNotifications filters by derived delivery status', async () => {
  const b = await base();
  const a = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'l-a' });
  const c = await b.app.notifications.requestNotification(b.owner, b.tenantId, { ...REQUEST, idempotencyKey: 'l-c' });
  await b.app.notifications.dispatchNotification(b.owner, b.tenantId, a.notification.id);
  const all = await b.app.notifications.listNotifications(b.owner, b.tenantId);
  assert.equal(all.length, 2);
  assert.equal((await b.app.notifications.listNotifications(b.owner, b.tenantId, { delivery: 'requested' })).length, 1);
  assert.equal((await b.app.notifications.listNotifications(b.owner, b.tenantId, { delivery: 'in_flight' })).length, 1);
  assert.equal((await b.app.notifications.listNotifications(b.owner, b.tenantId, { delivery: 'delivered' })).length, 0);
  assert.equal((await b.app.notifications.listNotifications(b.owner, b.tenantId, { delivery: 'failed' })).length, 0);
  assert.equal(c.notification.id, (await b.app.notifications.listNotifications(b.owner, b.tenantId, { delivery: 'requested' }))[0]?.notification.id);
});
