# WORK-006

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE
Activation Issue: #58
Implementation Branch: `feat/WORK-006-event-inbox-outbox`
Activation Baseline: `23f6d604d9d43f32b89ab5781a28b74975465046`

## Objective

Implement the durable event inbox/outbox used by ServiceOS to react to external systems and dispatch outbound provider events safely.

## Dependencies

Requires: WORK-004, WORK-015
Enables: WORK-010

## Scope

Allowed:
- event ingestion
- durable inbox/outbox
- idempotent event consumers
- provider-independent event contracts

Forbidden:
- vertical-specific event meanings
- AI execution engine

## Protected Surfaces

event inbox/outbox, worker dispatch, callback ingestion

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Inbound/outbound event processing is durable and idempotent; business modules do not call providers directly.

## Acceptance Criteria

- AC-1 Duplicate inbound events converge.
- AC-2 Outbound events are not silently lost after durable intent.
- AC-3 Event processing is isolated by tenant where applicable.
- AC-4 Zeck callbacks use the same durable ingestion guarantees.

## Verification Requirements

### Behavioral
- inbox/outbox lifecycle

### Structural
- no direct external calls from domain modules

### Discrimination / Mutation
- duplicate event regression

### Concurrency / Crash Safety
- two consumers of the same event do not produce duplicate domain effects
- crash between intent and dispatch converges

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-09-02.

- Branch: `feat/WORK-006-event-inbox-outbox`
- Activation baseline: `23f6d604d9d43f32b89ab5781a28b74975465046` (canonical main after WORK-008 finalization)
- Activation issue: `#58`
- Activation tip: `ef5df012028aa24379ab7c2f6a82fb2babee63c2`
- Assurance profile: `HIGH_ASSURANCE`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect

The activation decision was made from frozen v1.0 architecture and completed WORK-004 and WORK-015 state. No architecture change is authorized by this Work Order.

## Evidence

Status: implemented, local gates green; PR submitted for Architect review.

### What was implemented

- **The durable event substrate lives inside `/interactions`** (the module §6 owns "external communications"; the frozen module set is closed — a new module would require an ACR). New module files: `events.ts` (the substrate surface), `events-store.ts` (the store port + frozen vocabularies + records), `events-delivery.ts` (the provider-neutral `EventDeliveryPort` + the contract-conformant in-memory double), `events-sql-store.ts` (the authoritative SQL store), plus event hashing in `provenance.ts` and the composed surface in `index.ts` (the `InteractionsModule` interface now extends `EventSubstrateSurface`).
- **The inbox** (callback ingestion, AC-1): `ingestExternalEvent` validates the envelope against the frozen provider-independent contracts — sources are the 11 `/integrations` capability classes (Zeck deliberately absent), the event-type vocabulary is the frozen horizontal enumeration (`interaction.delivery_result` only) — pins the delivery hash over the canonical envelope, and persists ONE durable record per stable identity (tenant, source, external event id — the provider's identity verbatim, lock #20). Identical re-deliveries converge; divergent re-deliveries fail closed `EVENT_DELIVERY_CONFLICT`. Unknown types, non-conforming payloads and uncorrelated references (the interaction is not held by this tenant) are DURABLY RECORDED as rejected evidence with typed errors — the same disposition discipline as the /zeck callback ledger.
- **Worker dispatch + idempotent consumer**: `processInboxEvents` claims `received` events one atomic CAS at a time (`received -> processing`), invokes the composed idempotent consumer (the `interaction.delivery_result` consumer records the observation through the module's ONE observation path — `recordObservedResult`, convergent by interaction identity), and records the completion or the explicit typed retryable failure (`retryInboxEvent`). The crash window (`processing` claim left by a dead worker) is listed by `listRecoverableInboxEvents` and recovered through `recoverInboxEvent` (re-claim + re-invocation converges on ONE domain effect). Concurrent workers of the same event serialize on the claim CAS; the loser converges on the durable result or surfaces the typed in-progress state.
- **The outbox** (AC-2): `recordOutboundEvent` persists the durable outbound intent BEFORE any delivery — authorization first, an optional `/policies` gate that denies closed before the intent row exists (action `event.emit`, namespaced decision keys), and authority-DERIVED content: the `interaction.observed` payload is read from the interaction authority's terminal observation and pinned into the event (the caller supplies the subject and the destination, never the content — it cannot be fabricated). Keyed submissions converge; divergent ones fail closed `EVENT_INPUT_CONFLICT`.
- **Outbox dispatch**: `dispatchOutboxEvent` claims (`intended -> dispatching`), delivers through the injected provider-neutral `EventDeliveryPort` (identity-idempotent by durable event id — re-delivery converges on ONE provider-side event), and records the acceptance (`dispatched`) or the explicit dispatch failure (`failed`, terminal for the identity). NO delivery port is composed in production: the boundary ships CLOSED — dispatch fails closed `EVENT_DELIVERY_UNAVAILABLE` with the claim standing for recovery (truthful unavailability; real delivery adapters belong to the Work Order owning provider/destination configuration). The crash windows (claim-then-die; accepted-then-die) converge through `recoverOutboxEvent` with exactly one provider-side event.
- **AC-4 (Zeck callbacks use the same durable ingestion guarantees)**: the inbox's guarantee set mirrors the /zeck callback ledger guarantee-for-guarantee — durable record, stable-identity dedup, delivery-hash replay convergence, typed rejections durably recorded, tenant predicates. /zeck keeps its own translated-callback authority (nothing here modifies /zeck); the equivalence is proven behaviorally by driving BOTH paths side by side (duplicate replay converges, divergent replay fails closed `EVENT_CONFLICT` / `EVENT_DELIVERY_CONFLICT`), and the source taxonomy structurally excludes `zeck`.
- **Migration `0011_event_substrate.sql`** (`event_` prefix added to the migration allowlist — the sanctioned extension point): `event_inbox` (closed source/state/rejection enumerations, lifecycle shape CHECKs, UNIQUE (tenant, source, external event id), claimable + recoverable partial indexes) and `event_outbox` (closed outbound type vocabulary, lifecycle shape CHECKs, keyed partial unique index, recoverable partial index, correlation GIN index). No Service Work state, no business outcome state, no AI/Zeck lifecycle or credential columns.
- **Governance wiring**: `checkEventBoundaries` (one event inbox/outbox authority — the event surface entry points are reserved to `/interactions`; the event delivery surface stays contained; no second event-consumer authority for the observation fact; the `event_` tables deny AI/model/agent/credential columns), the `event_` migration-prefix entry, check-CLI wiring + summary line, governance index exports, composition-root note (the outbox ships closed) and the `1.1.0` module manifest bump.
- **Proofs**: `events-runtime` (25: the full inbox/outbox lifecycles, duplicate-delivery regression + divergent conflict, the durable rejection vocabulary with convergent replays, transient consumer failure + retry convergence, policy gate deny-before-row/allow-pins-provenance, tenant isolation, authorization-before-data with read counters, tamper evidence both sides, truthful unavailability with claim-standing + recovery, the AC-4 zeck/inbox guarantee-equivalence proof, frozen vocabularies, construction fail-closed), `events-concurrency` (11: TRUE-parallel duplicate ingest convergence, TRUE-parallel inbox workers with ONE consumer invocation and ONE domain effect, the inbox CAS-skipping store-mutant double-invocation discrimination, the inbox crash window + consumer-ran-but-completion-lost convergence, TRUE-parallel outbox dispatches with ONE port invocation, the outbox CAS-skipping mutant, parallel keyed intent convergence, the outbox claim-crash and accepted-crash windows, concurrent recovery), `events-boundary-checks` (14: the real tree passes; migration pins the closed vocabularies, stable identity, shape CHECKs, tenant FKs; synthetic trees rejected with exact codes — duplicate event authority per reserved name, duplicate delivery surface, duplicate consumer surface, AI/credential schema columns; check-CLI wiring), `events.integration` (11, CI-gated: migrations 0001..0011 idempotent, schema backstops over real rows, the full lifecycle over real SQL, TRUE-parallel duplicate ingest, TRUE-parallel processing serialization, the inbox crash window over real SQL, outbox parallel dispatch + both crash windows, the moving-clock record-hash regression, live tamper detection, cross-tenant predicates, single-connection-pool transaction scope). The faithful `InMemoryEventsStore` (race-injection + crash hooks) and the delivery double are shared through the test helpers.

### Verification results (local)

- `npm run build` — PASS.
- `npm run check` (EXPECT_BRANCH=feat/WORK-006-event-inbox-outbox) — PASS (all structural checks including the new event boundary checks; governance state internally consistent).
- `npm test` — 860 tests / 753 pass / 0 fail / 107 skipped (the live-PostgreSQL proofs execute in CI; 96 pre-existing + 11 new).

### Known limitations

- No real event delivery adapter ships in this Work Order (the outbox delivery boundary composes closed — `EVENT_DELIVERY_UNAVAILABLE` with the claim standing — until the Work Order owning provider/destination configuration registers one; the contract conformance is pinned by the in-memory double).
- No HTTP/webhook receiver surface (WORK-012 owns the control-plane API; the ingestion surface is programmatic).
- The inbound and outbound event vocabularies are seeded with the one horizontal type each that this frontier justifies (`interaction.delivery_result`, `interaction.observed`); future Work Orders extend the frozen enumerations through their own scopes (vertical-specific event meanings remain forbidden).
- The event-source taxonomy is the `/integrations` capability classes; Zeck callbacks keep their own boundary (AC-4 is satisfied by the same guarantees, not by re-routing /zeck).
- Live-PostgreSQL proofs execute in CI only (no local PostgreSQL in the implementation environment).
- Outbox retry-with-new-identity is the caller's protocol (the failed identity is terminal, like the interaction ledger's dispatch failures); a convenience wrapper can land with the Work Order that owns delivery configuration.
