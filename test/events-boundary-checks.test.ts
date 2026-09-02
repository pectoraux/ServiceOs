/**
 * Structural + discrimination proof: the durable event substrate's
 * authority boundaries (WORK-006, static class — the Work Order
 * verification requirement "no direct external calls from domain
 * modules"; activation invariants 1–7).
 *
 * Proves:
 * - the REAL tree passes all event boundary checks (static) and the
 *   real /interactions module implements and exports the event
 *   substrate's public contract;
 * - the migration pins the closed event vocabularies (source taxonomy,
 *   rejection codes, lifecycles, the outbound event type), the stable
 *   identity unique index, the keyed outbox index and the lifecycle
 *   shape CHECKs (an inconsistent row is physically impossible);
 * - the check-CLI wiring includes the event boundary checks (the
 *   governance surface stays complete);
 * - synthetic MUTATED trees are rejected with the exact violation codes
 *   (discrimination): a second event authority, a second event delivery
 *   surface, a second event consumer surface, and AI/credential columns
 *   inside the event tables.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  checkEventBoundaries,
  RESERVED_EVENT_AUTHORITY_EXPORTS,
} from '../src/platform/governance/events-boundary-checks.js';
import { checkWorkBoundaries } from '../src/platform/governance/work-boundary-checks.js';
import { makeTempTree, moduleFile } from './helpers/tree.js';
import {
  INBOUND_EVENT_TYPES,
  OUTBOUND_EVENT_TYPES,
  createInteractionsModule,
  createInMemoryEventDelivery,
  InteractionsError,
} from '../src/modules/interactions/index.js';

const REAL_SRC_ROOT = resolve(process.cwd(), 'src');
const REAL_MIGRATIONS = resolve(process.cwd(), 'db/migrations');
const REAL_MIGRATION_FILE = join(REAL_MIGRATIONS, '0011_event_substrate.sql');

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

/** A minimal conforming module tree plus the real event migration. */
function conformingTree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of BASE_MODULES) {
    files[`src/modules/${name}/index.ts`] = moduleFile(name);
  }
  files['db/migrations/0001_identity_tenancy.sql'] = 'CREATE TABLE org_organizations (id UUID);';
  files['db/migrations/0011_event_substrate.sql'] = readFileSync(REAL_MIGRATION_FILE, 'utf8');
  return files;
}

function runCheck(files: Record<string, string>): { code: string; detail: string; file?: string }[] {
  const { root, cleanup } = makeTempTree(files);
  try {
    return checkEventBoundaries({
      srcRoot: resolve(root, 'src'),
      migrationsDir: resolve(root, 'db', 'migrations'),
    });
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
// The real tree conforms (static)
// ---------------------------------------------------------------------------

test('the REAL module tree passes all event boundary checks', () => {
  const violations = checkEventBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS });
  assert.deepEqual(violations, []);
});

test('the real migration passes the table-prefix allowlist (event_ admitted by WORK-006)', () => {
  const violations = checkWorkBoundaries({ srcRoot: REAL_SRC_ROOT, migrationsDir: REAL_MIGRATIONS });
  const prefixViolations = violations.filter((violation) => violation.code === 'unknown-migration-table-prefix');
  assert.deepEqual(prefixViolations, []);
});

test('the real /interactions module implements the event substrate contract (closed delivery boundary included)', async () => {
  // The frozen vocabularies are exported and horizontal.
  assert.deepEqual(INBOUND_EVENT_TYPES, ['interaction.delivery_result']);
  assert.deepEqual(OUTBOUND_EVENT_TYPES, ['interaction.observed']);
  // The delivery double is contract-conformant: identity-idempotent by
  // durable event identity, honest failures.
  const delivery = createInMemoryEventDelivery();
  const request = {
    tenantId: 't',
    eventId: 'e1',
    eventType: 'interaction.observed' as const,
    destination: 'd',
    payload: {},
  };
  const first = await delivery.deliverEvent(request);
  const second = await delivery.deliverEvent(request);
  assert.equal(second.providerReference, first.providerReference);
  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.attemptsFor('e1'), 2);
  // The module factory requires the event substrate seam (fail-closed
  // composition discipline).
  assert.throws(
    () =>
      createInteractionsModule({
        tenancy: null as never,
        policies: null as never,
        sink: null as never,
      }),
    (error: unknown) => (error as InteractionsError).code === 'INVALID_INPUT',
  );
});

// ---------------------------------------------------------------------------
// The migration pins the durable surface (static: closed vocabularies,
// stable identity, lifecycle shapes)
// ---------------------------------------------------------------------------

test('the migration pins the closed source taxonomy, lifecycles and rejection vocabulary', () => {
  const sql = readFileSync(REAL_MIGRATION_FILE, 'utf8');
  // The inbox source taxonomy = the /integrations capability classes
  // (Zeck deliberately absent — its callbacks keep their own boundary).
  for (const capability of ['email', 'sms', 'voice', 'accounting_erp', 'crm', 'construction_management', 'property_management', 'procurement', 'payment', 'document_storage', 'government_portal']) {
    assert.ok(new RegExp(`'${capability}'`).test(sql), `source taxonomy includes ${capability}`);
  }
  assert.ok(!/zeck/.test(sql.replace(/--.*$/gm, '')), 'the event tables never name Zeck (its callbacks keep their own boundary)');
  // The closed lifecycles.
  assert.ok(/CHECK \(state IN \('received','processing','consumed','failed','rejected'\)\)/.test(sql));
  assert.ok(/CHECK \(state IN \('intended','dispatching','dispatched','failed'\)\)/.test(sql));
  // The closed rejection vocabulary (the /zeck disposition discipline).
  assert.ok(/CHECK \(rejection_code IN \('unknown_event_type','invalid_payload','uncorrelated'\)\)/.test(sql));
  // The closed outbound event vocabulary (horizontal only).
  assert.ok(/CHECK \(event_type IN \('interaction.observed'\)\)/.test(sql));
  // The stable identity: one durable inbox record per (tenant, source,
  // external event id) — duplicate inbound events converge.
  assert.ok(/CREATE UNIQUE INDEX event_inbox_stable_identity\n\s+ON event_inbox \(tenant_id, source, external_event_id\)/.test(sql));
  // The keyed outbox identity.
  assert.ok(/CREATE UNIQUE INDEX event_outbox_tenant_idempotency_key/.test(sql));
  // The recoverable crash-window scan surfaces.
  assert.ok(/event_inbox_recoverable_idx/.test(sql) && /WHERE state = 'processing'/.test(sql));
  assert.ok(/event_outbox_recoverable_idx/.test(sql) && /WHERE state = 'dispatching'/.test(sql));
});

test('the migration pins the lifecycle shape invariants (schema-level backstops)', () => {
  const sql = readFileSync(REAL_MIGRATION_FILE, 'utf8');
  const inboxChecks = sql.match(/CHECK \(\(state = 'received'\).*?\n.*?\n.*?\)/s);
  assert.ok(inboxChecks !== null, 'the received-nothing-set shape CHECK exists');
  assert.ok(/\(state = 'consumed'\) = \(consumer_result IS NOT NULL AND consumed_by IS NOT NULL AND consumed_at IS NOT NULL\)/.test(sql));
  assert.ok(/\(state = 'failed'\) = \(failure_code IS NOT NULL AND failure_message IS NOT NULL AND failure_failed_at IS NOT NULL\)/.test(sql));
  assert.ok(/\(state = 'dispatched'\) = \(provider IS NOT NULL AND dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL\)/.test(sql));
  // The rejected-rows-carry-no-processing-state invariant is a
  // ONE-DIRECTIONAL implication: a biconditional would wrongly require
  // RECEIVED rows to carry the claim/consumption/failure columns (the
  // CI-found defect — received rows also carry them null).
  assert.ok(
    /CONSTRAINT event_inbox_rejected_unprocessed CHECK \(state <> 'rejected' OR \(claimed_by IS NULL AND claimed_at IS NULL/.test(sql),
    'the rejected-unprocessed invariant is the one-directional implication',
  );
  assert.ok(!/\(state = 'rejected'\) = \(claimed_by IS NULL/.test(sql), 'the biconditional form of the rejected-unprocessed invariant is gone');
  // The constraints are explicitly named (self-documenting violations).
  for (const name of [
    'event_inbox_source_domain',
    'event_inbox_state_domain',
    'event_inbox_rejection_code_domain',
    'event_inbox_received_shape',
    'event_inbox_rejection_present',
    'event_inbox_claim_present',
    'event_inbox_rejected_unprocessed',
    'event_inbox_consumed_shape',
    'event_inbox_failed_shape',
    'event_outbox_event_type_domain',
    'event_outbox_state_domain',
    'event_outbox_intended_shape',
    'event_outbox_claim_present',
    'event_outbox_dispatched_shape',
    'event_outbox_failed_shape',
    'event_outbox_provider_reference_pairing',
    'event_outbox_policy_pairing',
  ]) {
    assert.ok(new RegExp(`CONSTRAINT ${name}`).test(sql), `constraint ${name} is explicitly named`);
  }
  // Tenancy discipline: both tables carry the tenant FK.
  assert.ok(/event_inbox[\s\S]*tenant_id\s+UUID NOT NULL REFERENCES org_service_tenants \(id\)/.test(sql));
  assert.ok(/event_outbox[\s\S]*tenant_id\s+UUID NOT NULL REFERENCES org_service_tenants \(id\)/.test(sql));
});

// ---------------------------------------------------------------------------
// Synthetic mutated trees are rejected (discrimination)
// ---------------------------------------------------------------------------

test('DISCRIMINATION: a second event authority export is rejected (event-authority-duplicate)', () => {
  const files = conformingTree();
  files['src/modules/work/index.ts'] = moduleFile(
    'work',
    `\nexport async function ingestExternalEvent(): Promise<void> {}\n`,
  );
  assertRejected(files, ['event-authority-duplicate'], 'work exports ingestExternalEvent');
});

test('DISCRIMINATION: a second event authority in /zeck, /notifications and /verticals is rejected', () => {
  for (const [module, entry] of [
    ['zeck', 'processInboxEvents'],
    ['notifications', 'eventOutboxLedger'],
    ['verticals', 'recordOutboundEvent'],
  ] as const) {
    const files = conformingTree();
    files[`src/modules/${module}/index.ts`] = moduleFile(module, `\nexport const ${entry} = (): void => undefined;\n`);
    assertRejected(files, ['event-authority-duplicate'], `${module} exports ${entry}`);
  }
});

test('DISCRIMINATION: every reserved event authority entry point is enforced', () => {
  // Each reserved name, exported from a foreign module, is rejected.
  for (const name of RESERVED_EVENT_AUTHORITY_EXPORTS) {
    const files = conformingTree();
    files['src/modules/billing/index.ts'] = moduleFile('billing', `\nexport const ${name} = (): void => undefined;\n`);
    assertRejected(files, ['event-authority-duplicate'], `billing exports ${name}`);
  }
});

test('DISCRIMINATION: a second event delivery surface is rejected (event-delivery-surface-duplicate)', () => {
  const files = conformingTree();
  files['src/modules/entities/index.ts'] = moduleFile(
    'entities',
    `\nexport function createEventDelivery(): void {}\n`,
  );
  assertRejected(files, ['event-delivery-surface-duplicate'], 'entities exports createEventDelivery');
});

test('DISCRIMINATION: a second event consumer surface is rejected (event-consumer-surface-duplicate)', () => {
  const files = conformingTree();
  files['src/modules/workflow/index.ts'] = moduleFile(
    'workflow',
    `\nexport function consumeInboxEvent(): void {}\n`,
  );
  assertRejected(files, ['event-consumer-surface-duplicate'], 'workflow exports consumeInboxEvent');
});

test('DISCRIMINATION: AI/model columns inside the event tables are rejected (event-ai-delivery-schema)', () => {
  const base = readFileSync(REAL_MIGRATION_FILE, 'utf8');
  for (const column of ['model', 'agent', 'prompt', 'api_key', 'credential']) {
    const files = conformingTree();
    files['db/migrations/0011_event_substrate.sql'] = base.replace(
      /CREATE TABLE event_inbox \(\n/,
      `CREATE TABLE event_inbox (\n  ${column} TEXT,\n`,
    );
    assertRejected(files, ['event-ai-delivery-schema'], `event_inbox declares ${column}`);
  }
});

test('DISCRIMINATION: credential columns inside the outbox tables are rejected', () => {
  const base = readFileSync(REAL_MIGRATION_FILE, 'utf8');
  const files = conformingTree();
  files['db/migrations/0011_event_substrate.sql'] = base.replace(
    /CREATE TABLE event_outbox \(\n/,
    `CREATE TABLE event_outbox (\n  token TEXT,\n`,
  );
  assertRejected(files, ['event-ai-delivery-schema'], 'event_outbox declares token');
});

test('a conforming synthetic tree passes (no false positives)', () => {
  const violations = runCheck(conformingTree());
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// The check-CLI wiring stays complete (the governance surface)
// ---------------------------------------------------------------------------

test('the check CLI includes the event boundary checks in its summary', () => {
  const cli = readFileSync(resolve(process.cwd(), 'src/cli/check.ts'), 'utf8');
  assert.ok(cli.includes('checkEventBoundaries'), 'the CLI runs the event boundary checks');
  assert.ok(/events: single durable event inbox\/outbox authority/.test(cli), 'the CLI reports the event check line');
  const governanceIndex = readFileSync(resolve(process.cwd(), 'src/platform/governance/index.ts'), 'utf8');
  assert.ok(governanceIndex.includes('checkEventBoundaries'), 'the governance index exports the check');
});
