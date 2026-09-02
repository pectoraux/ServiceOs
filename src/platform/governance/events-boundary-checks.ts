/**
 * ServiceOS event-substrate boundary checks (WORK-006 governance wiring).
 *
 * Machine-enforced structural invariants for the frozen Work Order
 * scope ("event inbox/outbox, durable event ingestion and dispatch,
 * worker dispatch, callback ingestion, idempotent event consumers,
 * provider-independent event contracts"; activation invariants 1–7):
 *
 * - ONE EVENT INBOX/OUTBOX AUTHORITY (architecture.md §14; the /zeck
 *   precedent of ONE durable-ingestion surface per authority): the
 *   event-substrate entry points (ingestion, inbox processing, outbox
 *   intent/dispatch, recovery and the event read surfaces) may be
 *   exported only from /interactions — the module §6 owns "external
 *   communications". Any other module exporting one is a duplicate
 *   event authority (violation `event-authority-duplicate`) — the
 *   machine-enforced form of "business modules do not call providers
 *   directly" for the event surface (activation invariant 2): the
 *   durable event boundary is consumed through its public contract,
 *   never around it.
 *
 * - THE EVENT DELIVERY SURFACE STAYS CONTAINED (activation invariant 2):
 *   the provider-neutral event delivery port and its doubles are
 *   exported only from /interactions (violation
 *   `event-delivery-surface-duplicate`) — the same containment the
 *   /integrations adapter registry has behind /interactions. No
 *   business module ever touches a delivery adapter directly.
 *
 * - THE DURABLE SURFACE STAYS EVENT-SHAPED, NOT AI-SHAPED (activation
 *   invariant 7: no AI execution engine, no provider/model/agent
 *   ownership): the `event_` tables may never declare typed
 *   AI/model/agent/LLM columns or credential columns (violation
 *   `event-ai-delivery-schema`) — the event substrate moves durable
 *   events; it never selects models, plans or executes AI work (Zeck
 *   is the sole AI execution authority), and no event surface is ever
 *   a secrets surface.
 *
 * - NO SECOND EVENT-CONSUMER AUTHORITY FOR THE OBSERVATION FACT: the
 *   inbox's consumer vocabulary stays observation-shaped — modules
 *   other than /interactions may not export inbox-consumer entry
 *   points (violation `event-consumer-surface-duplicate`): the ONE
 *   idempotent consumer of `interaction.delivery_result` events is
 *   composed inside /interactions over its own observation authority
 *   (no second observation path — architecture.md §2.11).
 *
 * - THE EVENT VOCABULARIES STAY FROZEN AND HORIZONTAL: the event tables'
 *   type/source enumerations are pinned by the migration CHECKs and
 *   the boundary tests (discrimination); vertical event meanings are
 *   the forbidden surface (checked by the closed enumeration pins —
 *   extension happens only through a future Work Order's frozen scope).
 *
 * Like the other governance checks, violations carry stable codes so
 * discrimination tests can prove a mutated tree is rejected.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GovernanceError } from './program-state.js';
import { extractExportNames } from './identity-boundary-checks.js';
import { extractCreatedColumns, extractCreatedTables, listSqlFiles, stripSqlComments } from './work-boundary-checks.js';
import type { ArchitectureViolation } from './architecture-checks.js';

/**
 * Event-substrate entry points reserved to /interactions: the ingestion,
 * worker-dispatch, outbox intent/dispatch, recovery and read surfaces.
 */
export const RESERVED_EVENT_AUTHORITY_EXPORTS: readonly string[] = [
  'ingestExternalEvent',
  'ingestEvent',
  'processInboxEvents',
  'processEvent',
  'retryInboxEvent',
  'recoverInboxEvent',
  'listRecoverableInboxEvents',
  'listInboxEvents',
  'getInboxEvent',
  'eventInbox',
  'inboxLedger',
  'eventInboxLedger',
  'recordOutboundEvent',
  'emitEvent',
  'dispatchOutboxEvent',
  'dispatchOutbox',
  'recoverOutboxEvent',
  'listRecoverableOutboxEvents',
  'listOutboxEvents',
  'getOutboxEvent',
  'eventOutbox',
  'outboxLedger',
  'eventOutboxLedger',
  'eventSubstrate',
];

/**
 * Provider-neutral event delivery entry points reserved to
 * /interactions: the delivery port, its factories and its contract
 * doubles (the containment discipline of the /integrations adapter
 * surface behind /interactions).
 */
export const RESERVED_EVENT_DELIVERY_EXPORTS: readonly string[] = [
  'createEventDelivery',
  'registerEventDelivery',
  'eventDeliverySink',
  'createEventDeliveryPort',
  'eventDeliveryRegistry',
];

/**
 * Inbox-consumer entry points reserved to /interactions: the ONE
 * idempotent consumer of interaction delivery-result events is composed
 * inside the event authority over its own observation surface — no
 * second observation/consumer path for the same fact.
 */
export const RESERVED_EVENT_CONSUMER_EXPORTS: readonly string[] = [
  'consumeInboxEvent',
  'registerEventConsumer',
  'eventConsumerRegistry',
  'consumeEvent',
  'createEventConsumer',
];

/**
 * Columns the `event_` tables may never declare: a typed
 * AI-execution/model/agent/LLM column would make the event substrate an
 * AI execution surface (activation invariant 7 — Zeck is the sole AI
 * execution authority; the forbidden "AI execution engine"); a
 * credential column would make the event surface a secrets surface (no
 * credentials in ServiceOS-adjacent authority state).
 */
export const EVENT_SCHEMA_COLUMN_DENYLIST: readonly string[] = [
  'ai_verdict',
  'ai_decision',
  'ai_event',
  'agent',
  'agent_id',
  'agent_verdict',
  'agent_decision',
  'model',
  'model_id',
  'model_name',
  'provider_id',
  'llm',
  'prompt',
  'api_key',
  'secret',
  'token',
  'credential',
  'password',
];

const MODULE_INTERACTIONS = 'interactions';

function* walkTsFiles(root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (stats.isFile() && entry.endsWith('.ts')) {
      yield full;
    }
  }
}

function violation(code: string, detail: string, file?: string): ArchitectureViolation {
  return { code, detail, file };
}

export interface EventBoundaryCheckOptions {
  /** Root of the TypeScript source tree to scan (contains `modules/`). */
  srcRoot: string;
  /** Directory holding the SQL migrations (default: `<srcRoot>/../../db/migrations`). */
  migrationsDir?: string;
}

/**
 * Scan the module tree and migrations for event-substrate boundary
 * violations. Returns an empty list when the boundaries hold.
 */
export function checkEventBoundaries(options: EventBoundaryCheckOptions): ArchitectureViolation[] {
  const modulesRoot = join(options.srcRoot, 'modules');
  let modules: string[];
  try {
    modules = readdirSync(modulesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    throw new GovernanceError(
      `cannot scan module tree ${modulesRoot}: ${(cause as Error).message}`,
      'module-tree-unreadable',
    );
  }

  const violations: ArchitectureViolation[] = [];

  for (const moduleName of modules) {
    const isInteractionsModule = moduleName === MODULE_INTERACTIONS;

    for (const file of walkTsFiles(join(modulesRoot, moduleName))) {
      const source = readFileSync(file, 'utf8');
      const exports = extractExportNames(source);

      for (const name of exports) {
        if (!isInteractionsModule && RESERVED_EVENT_AUTHORITY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'event-authority-duplicate',
              `module /${moduleName} exports "${name}"; /interactions is the sole durable event inbox/outbox authority (architecture.md §14; WORK-006 protected surface) — business modules consume the event boundary through its public contract, never around it`,
              file,
            ),
          );
        }
        if (!isInteractionsModule && RESERVED_EVENT_DELIVERY_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'event-delivery-surface-duplicate',
              `module /${moduleName} exports "${name}"; the provider-neutral event delivery surface is contained behind /interactions (activation invariant 2: business modules do not call providers directly)`,
              file,
            ),
          );
        }
        if (!isInteractionsModule && RESERVED_EVENT_CONSUMER_EXPORTS.includes(name)) {
          violations.push(
            violation(
              'event-consumer-surface-duplicate',
              `module /${moduleName} exports "${name}"; the ONE idempotent inbox consumer for interaction delivery-result events is composed inside /interactions over its own observation authority — no second observation path (architecture.md §2.11)`,
              file,
            ),
          );
        }
      }
    }
  }

  // NOTE: import discipline for the event files is owned by the WORK-015
  // checks (interaction-import-direction, adapter-surface-outside-
  // interactions, interaction-surface-outside-notifications), which scan
  // the WHOLE /interactions module tree — the event substrate lives
  // inside /interactions, so its imports are already constrained to
  // /integrations, /auth, /organizations and /policies, and consumers of
  // the event surface reach it only through the module's public index
  // (frontier-relative INTERACTIONS_IMPORTERS).

  // The durable surface: the `event_` tables stay event-shaped, not
  // AI-shaped and not credential-shaped (the owned migration is
  // admitted by checkWorkBoundaries' prefix allowlist — the `event_`
  // entry WORK-006 adds — and the deep shape rules live here).
  const migrationsDir = options.migrationsDir ?? join(options.srcRoot, '..', '..', 'db', 'migrations');
  for (const migrationFile of listSqlFiles(migrationsDir)) {
    const sql = stripSqlComments(readFileSync(migrationFile, 'utf8'));
    const tables = extractCreatedTables(sql);
    for (const table of tables) {
      if (!table.startsWith('event_')) {
        continue;
      }
      for (const column of extractCreatedColumns(sql, table)) {
        if (EVENT_SCHEMA_COLUMN_DENYLIST.includes(column)) {
          violations.push(
            violation(
              'event-ai-delivery-schema',
              `table "${table}" declares column "${column}"; the durable event substrate moves events — a typed AI-execution/model/agent or credential column would make it an AI execution or secrets surface (WORK-006 forbidden surfaces; activation invariant 7: Zeck is the sole AI execution authority)`,
              migrationFile,
            ),
          );
        }
      }
    }
  }

  return violations;
}
