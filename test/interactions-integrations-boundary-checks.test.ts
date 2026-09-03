/**
 * Structural + discrimination proof: /integrations, /interactions and
 * /notifications authority boundaries (WORK-015, static class — AC-2/AC-6
 * and the Work Order verification requirement "no provider SDKs in domain
 * modules; one interaction authority; no direct side effect from
 * workflow/vertical modules").
 *
 * Proves:
 * - the REAL tree passes all external-interaction boundary checks
 *   (static);
 * - the real modules implement and export their public contracts and the
 *   migration pins the closed capability/state/channel enumerations, the
 *   lifecycle shape invariants, the tenant FKs and the keyed partial
 *   unique indexes;
 * - the notification channel list is a PROJECTION of the frozen
 *   capability taxonomy (the decoupling property the module claims);
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): a second interaction ledger, a second adapter
 *   authority, a second notification authority, a provider SDK import in
 *   a business module, the adapter surface imported outside
 *   /interactions, /workflow or /verticals importing the interaction
 *   surface (direct side effect), forbidden import directions inside the
 *   three new modules, internal cross-module imports, and an AI engine
 *   export inside the new modules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  checkExternalInteractionBoundaries,
  PROVIDER_SDK_PACKAGES,
} from '../src/platform/governance/interactions-boundary-checks.js';
import { makeTempTree, moduleFile } from './helpers/tree.js';
import {
  CAPABILITY_CLASSES,
  createAdapterRegistry,
  createInMemoryProviderAdapter,
} from '../src/modules/integrations/index.js';
import { NOTIFICATION_CHANNELS } from '../src/modules/notifications/index.js';
import { createInteractionsModule } from '../src/modules/interactions/index.js';
import { buildInteractionsApp } from './helpers/in-memory-stores.js';

const REAL_SRC_ROOT = resolve(process.cwd(), 'src');
const REAL_MIGRATIONS = resolve(process.cwd(), 'db/migrations');

const BASE_MODULES = [
  'auth',
  'organizations',
  'services',
  'verticals',
  'entities',
  'work',
  'workflow',
  'policies',
  'approvals',
  'interactions',
  'zeck',
  'evidence',
  'billing',
  'audit',
  'integrations',
  'notifications',
];

/** A minimal conforming module tree plus an empty migrations directory. */
function conformingTree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of BASE_MODULES) {
    files[`src/modules/${name}/index.ts`] = moduleFile(name);
  }
  files['db/migrations/0001_identity_tenancy.sql'] = 'CREATE TABLE org_organizations (id UUID);';
  return files;
}

function runCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkExternalInteractionBoundaries({ srcRoot: resolve(root, 'src') });
  } finally {
    cleanup();
  }
}

/** Assert the mutated tree is rejected with exactly the expected codes. */
function assertRejected(files: Record<string, string>, codes: readonly string[], label: string): void {
  const violations = runCheck(files);
  const seen = violations.map((violation) => violation.code);
  assert.deepEqual([...new Set(seen)].sort(), [...codes].sort(), `${label}: expected violation codes ${codes}, got ${seen}`);
}

// ---------------------------------------------------------------------------
// Static: the real tree conforms
// ---------------------------------------------------------------------------

test('the real module tree passes all external-interaction boundary checks', () => {
  const violations = checkExternalInteractionBoundaries({ srcRoot: REAL_SRC_ROOT });
  assert.deepEqual(violations, []);
});

test('the provider-SDK denylist is a non-empty frozen list', () => {
  assert.ok(PROVIDER_SDK_PACKAGES.length >= 20);
  assert.ok(PROVIDER_SDK_PACKAGES.includes('twilio'));
  assert.ok(PROVIDER_SDK_PACKAGES.includes('stripe'));
  assert.ok(PROVIDER_SDK_PACKAGES.includes('@sendgrid/mail'));
});

test('the real migration pins the closed enumerations, lifecycle shapes and keyed idempotency', () => {
  const sql = readFileSync(join(REAL_MIGRATIONS, '0005_external_interactions.sql'), 'utf8');
  // The frozen capability taxonomy (minus Zeck) at the schema level.
  for (const capability of CAPABILITY_CLASSES) {
    assert.ok(sql.includes(`'${capability}'`), `capability ${capability} must be pinned by the CHECK constraint`);
  }
  assert.ok(!sql.includes("'zeck'"), 'the Zeck capability class must NOT be in the interaction taxonomy (/zeck is WORK-005)');
  // The closed interaction lifecycle.
  for (const state of ['intended', 'dispatching', 'dispatched', 'observed']) {
    assert.ok(sql.includes(`'${state}'`), `interaction state ${state} must be pinned by the CHECK constraint`);
  }
  // The lifecycle shape invariants: 'intended' carries NO state at all
  // (every mutable state column), the acceptance biconditional (an
  // observed dispatch-stage failure is the acceptance-free terminal),
  // the provider-reference pairing, and the NULL-safe failure-stage
  // check (a failure stage presupposes a failed outcome).
  assert.match(sql, /CHECK \(\(state = 'intended'\) = \(claim_claimed_by IS NULL/);
  assert.match(sql, /CHECK \(\(state = 'intended'\) = \([\s\S]*?failure_stage IS NULL[\s\S]*?provider_observation IS NULL\)\)/);
  assert.match(
    sql,
    /CHECK \(\(provider IS NOT NULL AND dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL\)[\s\S]*?= \(state = 'dispatched' OR \(state = 'observed'[\s\S]*?failure_stage = 'provider'/,
  );
  assert.match(sql, /CHECK \(provider_reference IS NULL OR provider IS NOT NULL\)/);
  assert.match(sql, /CHECK \(\(state = 'observed'\) = \(outcome IS NOT NULL/);
  assert.match(sql, /CHECK \(failure_stage IS NULL OR \(outcome IS NOT NULL AND outcome = 'failed'\)\)/);
  // Tenant discipline + keyed idempotency + retry lineage.
  assert.match(sql, /CREATE TABLE interaction_effects \([\s\S]*tenant_id\s+UUID NOT NULL REFERENCES org_service_tenants \(id\)/);
  assert.match(sql, /CREATE UNIQUE INDEX interaction_effects_tenant_idempotency_key[\s\S]*WHERE idempotency_key IS NOT NULL/);
  assert.match(sql, /retry_of_interaction_id UUID REFERENCES interaction_effects \(id\)/);
  // The notification requests: channels, pointer, keyed idempotency, no
  // delivery-status column (status is derived through /interactions).
  const notificationTable = sql.slice(sql.indexOf('CREATE TABLE notification_requests'));
  for (const channel of NOTIFICATION_CHANNELS) {
    assert.ok(notificationTable.includes(`'${channel}'`), `channel ${channel} must be pinned by the CHECK constraint`);
  }
  assert.match(notificationTable, /current_interaction_id UUID REFERENCES interaction_effects \(id\)/);
  assert.match(notificationTable, /CREATE UNIQUE INDEX notification_requests_tenant_idempotency_key/);
  assert.ok(!/delivery_state|delivery_status/.test(notificationTable), 'notification table must NOT re-record delivery status (no second observation authority)');
});

test('the notification channels are a projection of the frozen capability taxonomy', () => {
  for (const channel of NOTIFICATION_CHANNELS) {
    assert.ok((CAPABILITY_CLASSES as readonly string[]).includes(channel), `channel ${channel} must be a capability class`);
  }
});

test('the real /integrations module exports the provider-neutral contracts and the registry', async () => {
  const module = await import('../src/modules/integrations/index.js');
  assert.equal(typeof module.createAdapterRegistry, 'function');
  assert.equal(typeof module.createEffectSink, 'function');
  assert.equal(typeof module.validateEffectParams, 'function');
  assert.equal(typeof module.isCapabilityClass, 'function');
  assert.equal(typeof module.createInMemoryProviderAdapter, 'function');
  assert.deepEqual([...module.CAPABILITY_CLASSES], [...CAPABILITY_CLASSES]);
});

// ---------------------------------------------------------------------------
// Registry contract (fail-closed selection; AC-2)
// ---------------------------------------------------------------------------

test('the adapter registry fails closed on duplicates, unknown classes and unregistered classes', async () => {
  const registry = createAdapterRegistry();
  const { adapter } = createInMemoryProviderAdapter('email');
  registry.register(adapter);
  const { adapter: secondEmail } = createInMemoryProviderAdapter('email', { providerName: 'other' });
  assert.throws(
    () => registry.register(secondEmail),
    (error: unknown) => (error as { code?: string })?.code === 'DUPLICATE_ADAPTER',
  );
  assert.throws(
    () => registry.resolve('sms' as never),
    (error: unknown) => (error as { code?: string })?.code === 'ADAPTER_NOT_REGISTERED',
  );
  assert.equal(registry.resolve('email'), adapter);
  registry.seal();
  const { adapter: voice } = createInMemoryProviderAdapter('voice');
  assert.throws(
    () => registry.register(voice),
    (error: unknown) => (error as { code?: string })?.code === 'REGISTRY_SEALED',
  );
  // Idempotent registration of the SAME adapter converges.
  const registry2 = createAdapterRegistry();
  registry2.register(adapter);
  registry2.register(adapter);
  assert.equal(registry2.describe().length, 1);
});

test('the sink resolves through the registry and propagates adapter acceptances', async () => {
  const registry = createAdapterRegistry();
  const { adapter, log } = createInMemoryProviderAdapter('sms');
  registry.register(adapter);
  registry.seal();
  const { createEffectSink } = await import('../src/modules/integrations/index.js');
  const sink = createEffectSink(registry);
  const acceptance = await sink.dispatchEffect({
    capability: 'sms',
    params: { to: '+15550001111', body: 'boundary proof' },
    identity: { interactionId: '00000000-0000-4000-8000-0000000000f1', tenantId: '00000000-0000-4000-8000-0000000000aa' },
  });
  assert.equal(acceptance.provider, 'in-memory-double');
  assert.equal(acceptance.providerReference, 'double-00000000-0000-4000-8000-0000000000f1');
  assert.equal(log.count(), 1);
});

// ---------------------------------------------------------------------------
// Discrimination: mutated trees are rejected with exact codes
// ---------------------------------------------------------------------------

test('a second interaction ledger export is rejected (interaction-authority-duplicate)', () => {
  const files = conformingTree();
  files['src/modules/work/index.ts'] = moduleFile(
    'work',
    `\nexport async function createInteraction(): Promise<void> {}\n`,
  );
  assertRejected(files, ['interaction-authority-duplicate'], 'createInteraction in /work');
});

test('a second adapter authority export is rejected (adapter-authority-duplicate)', () => {
  const files = conformingTree();
  files['src/modules/notifications/index.ts'] = moduleFile(
    'notifications',
    `\nexport function createAdapterRegistry(): unknown { return {}; }\n`,
  );
  assertRejected(files, ['adapter-authority-duplicate'], 'createAdapterRegistry in /notifications');
});

test('a second notification authority export is rejected (notification-authority-duplicate)', () => {
  const files = conformingTree();
  files['src/modules/work/index.ts'] = moduleFile(
    'work',
    `\nexport async function requestNotification(): Promise<void> {}\n`,
  );
  assertRejected(files, ['notification-authority-duplicate'], 'requestNotification in /work');
});

test('a provider SDK import in a business module is rejected (provider-sdk-import, AC-6)', () => {
  for (const [specifier, label] of [
    ["import Twilio from 'twilio';", 'twilio'],
    ["import sg from '@sendgrid/mail';", '@sendgrid/mail'],
    ["const stripe = require('stripe');", 'stripe (require)'],
    ["import { SES } from '@aws-sdk/client-ses';", '@aws-sdk scoped'],
    ["import * as googleapis from 'googleapis';", 'googleapis'],
  ] as const) {
    const files = conformingTree();
    files['src/modules/verticals/index.ts'] = moduleFile('verticals', `\n${specifier}\n`);
    assertRejected(files, ['provider-sdk-import'], `provider SDK import (${label})`);
  }
  // The same import inside /integrations is rejected identically: SDKs
  // belong inside provider ADAPTERS, and no adapter ships in this tree.
  const files = conformingTree();
  files['src/modules/integrations/index.ts'] = moduleFile('integrations', `\nimport Twilio from 'twilio';\n`);
  assertRejected(files, ['provider-sdk-import'], 'provider SDK import in /integrations');
});

test('the adapter surface imported outside /interactions is rejected (adapter-surface-outside-interactions)', () => {
  for (const moduleName of ['work', 'notifications', 'verticals', 'workflow', 'billing']) {
    const files = conformingTree();
    files[`src/modules/${moduleName}/index.ts`] = moduleFile(
      moduleName,
      `\nimport type { AdapterRegistry } from '../integrations/index.js';\n`,
    );
    // /notifications violates its own import direction instead (it must
    // consume the interaction boundary, never the adapter surface).
    const expected = moduleName === 'notifications'
      ? ['notification-import-direction']
      : ['adapter-surface-outside-interactions'];
    assertRejected(files, expected, `/integrations import from /${moduleName}`);
  }
});

test('the interaction surface imported outside /notifications and /entities is rejected (interaction-surface-outside-notifications)', () => {
  // WORK-010 extends the frontier: /entities (the construction compliance
  // flow) is an authorized consumer of the interaction surface; every
  // other module still fails closed.
  for (const moduleName of ['workflow', 'verticals', 'services', 'work', 'zeck']) {
    const files = conformingTree();
    files[`src/modules/${moduleName}/index.ts`] = moduleFile(
      moduleName,
      `\nimport type { InteractionsModule } from '../interactions/index.js';\n`,
    );
    assertRejected(files, ['interaction-surface-outside-notifications'], `/interactions import from /${moduleName}`);
  }
});

test('/integrations importing a sibling business module is rejected (integration-import-direction)', () => {
  const files = conformingTree();
  files['src/modules/integrations/index.ts'] = moduleFile(
    'integrations',
    `\nimport type { Principal } from '../auth/index.js';\n`,
  );
  assertRejected(files, ['integration-import-direction'], '/auth import in /integrations');
});

test('/interactions importing business state, Zeck or the notification surface is rejected (interaction-import-direction)', () => {
  for (const moduleName of ['work', 'workflow', 'zeck', 'verticals', 'services', 'entities', 'notifications', 'billing']) {
    const files = conformingTree();
    files['src/modules/interactions/index.ts'] = moduleFile(
      'interactions',
      `\nimport type { Something } from '../${moduleName}/index.js';\n`,
    );
    assertRejected(files, ['interaction-import-direction'], `/${moduleName} import in /interactions`);
  }
});

test('/notifications importing the adapter surface, business state or the policy engine is rejected (notification-import-direction)', () => {
  for (const moduleName of ['integrations', 'work', 'workflow', 'policies', 'zeck', 'verticals', 'billing']) {
    const files = conformingTree();
    files['src/modules/notifications/index.ts'] = moduleFile(
      'notifications',
      `\nimport type { Something } from '../${moduleName}/index.js';\n`,
    );
    const expected = ['notification-import-direction'];
    assertRejected(files, expected, `/${moduleName} import in /notifications`);
  }
});

test('internal cross-module imports from the new modules are rejected', () => {
  const files = conformingTree();
  files['src/modules/interactions/index.ts'] = moduleFile(
    'interactions',
    `\nimport type { Something } from '../auth/store.js';\n`,
  );
  files['src/modules/notifications/index.ts'] = moduleFile(
    'notifications',
    `\nimport type { Something } from '../interactions/store.js';\n`,
  );
  assertRejected(
    files,
    ['interactions-internal-import', 'notifications-internal-import'],
    'internal imports',
  );
});

test('an AI engine export inside the new modules is rejected (ai-engine-in-<module>)', () => {
  for (const moduleName of ['interactions', 'integrations', 'notifications']) {
    const files = conformingTree();
    files[`src/modules/${moduleName}/index.ts`] = moduleFile(
      moduleName,
      `\nexport function aiRouter(): unknown { return {}; }\n`,
    );
    assertRejected(files, [`ai-engine-in-${moduleName}`], `aiRouter in /${moduleName}`);
  }
});

test('a workflow/Zeck-lifecycle export inside the new modules is rejected (workflow-engine-in-<module>)', () => {
  for (const moduleName of ['interactions', 'integrations', 'notifications']) {
    const files = conformingTree();
    files[`src/modules/${moduleName}/index.ts`] = moduleFile(
      moduleName,
      `\nexport function submitTransition(): unknown { return {}; }\n`,
    );
    assertRejected(files, [`workflow-engine-in-${moduleName}`], `submitTransition in /${moduleName}`);
  }
});

test('an authorization export inside the new modules is rejected (authorization-in-<module>)', () => {
  for (const moduleName of ['interactions', 'integrations', 'notifications']) {
    const files = conformingTree();
    files[`src/modules/${moduleName}/index.ts`] = moduleFile(
      moduleName,
      `\nexport function authorize(): unknown { return {}; }\n`,
    );
    assertRejected(files, [`authorization-in-${moduleName}`], `authorize in /${moduleName}`);
  }
});

// ---------------------------------------------------------------------------
// Construction-time fail-closed (module factory discipline)
// ---------------------------------------------------------------------------

test('the interactions module fails closed at construction without exactly one persistence seam', async () => {
  const app = buildInteractionsApp();
  assert.throws(
    () => createInteractionsModule({ tenancy: app.organizations, policies: app.policies, sink: app.sink }),
    (error: unknown) => (error as { code?: string })?.code === 'INVALID_INPUT',
  );
});
