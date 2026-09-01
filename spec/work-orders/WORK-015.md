# WORK-015

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE

## Objective

Implement the ServiceOS external-interaction authority and provider-neutral integration boundaries for business side effects and notifications.

## Context

ServiceOS must coordinate external systems without allowing provider SDKs to leak into domain authorities. Durable intent, authorization, idempotency and observed results form the business side-effect boundary.

## Dependencies

Requires: WORK-002, WORK-004
Enables: WORK-006, WORK-010, WORK-012

## Scope

Allowed:
- `/interactions`
- `/integrations`
- `/notifications`
- provider-neutral email/SMS/voice/business-system/payment interfaces
- durable interaction identity and result recording
- adapter contracts and test doubles

Forbidden:
- direct provider SDK usage from business modules
- external side effects before policy/authorization/durable intent
- AI execution infrastructure
- duplicating Zeck authority

## Protected Surfaces

/interactions, /integrations, /notifications, provider adapters, durable side-effect boundary

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- all business external effects pass through owned provider-neutral ports
- durable intent precedes side effect
- provider delivery status is not automatically business completion
- idempotency and observed-result semantics survive retries/crashes
- tenant scope is enforced before external effect admission

## Acceptance Criteria

- AC-1 An external interaction can be durably intended before dispatch.
- AC-2 Provider adapters are selected behind one provider-neutral contract per capability class.
- AC-3 Duplicate dispatch attempts converge on one logical interaction.
- AC-4 A provider success does not itself complete Service Work.
- AC-5 Notification delivery failures remain explicit failures and are recoverable.
- AC-6 Direct provider SDK imports from business modules are structurally rejected.

## Verification Requirements

### Behavioral
- send/observe lifecycle
- failure/retry
- provider adapter conformance

### Structural
- no provider SDKs in domain modules
- one interaction authority
- no direct side effect from workflow/vertical modules

### Discrimination / Mutation
- provider call before durable intent fails the structural/dynamic proof
- duplicate interaction mutation must be detected
- cross-tenant interaction is rejected before adapter invocation

### Concurrency / Crash Safety
- concurrent dispatch converges
- crash between durable intent and adapter call is recoverable without duplicate business effect

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-09-01.

- Branch: `feat/WORK-015-external-interactions`
- Base revision: `2100e572b23606cfd2ec7681d6d804ca30c2f914`
- Activation issue: `#29`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect

The activation decision was made from frozen v1.0 architecture and completed WORK-002 and WORK-004 state. No architecture change is authorized by this Work Order.

## Evidence

Status: implementation delivered; awaiting Architect verification.

### What was implemented

- `/integrations` public contract: the frozen provider-neutral capability taxonomy (11 classes: email, sms, voice, accounting_erp, crm, construction_management, property_management, procurement, payment, document_storage, government_portal — Zeck deliberately absent, it is the /zeck module's boundary), per-class typed parameter contracts with fail-closed `validateEffectParams` (unknown keys, shapes, bounds), the adapter registry (one adapter per class selected behind the class contract; duplicate/unknown/unregistered/late registration all fail closed; sealed at composition), the `createEffectSink` dispatch sink (the only bridge the /interactions authority holds), and the contract-conformant in-memory provider test doubles (identity-idempotent dispatch by durable interaction identity, honest pre-effect failures, contract re-validation, deterministic hooks). No durable state, no real provider SDK, no sibling-module imports.
- `/interactions` public contract — THE durable business side-effect boundary, in the Work Order's invariant order: `createInteraction` (authorization → optional /policies gate that denies closed BEFORE any intent row → contract-validated params → durable intent state `intended`, keyed convergence, retryOf lineage validated against observed failures), `dispatchInteraction` (atomic claim CAS `intended → dispatching` → provider-neutral sink invocation → acceptance recorded `dispatched` or EXPLICIT observed dispatch failure; re-dispatch converges without a second invocation; in-flight/observed fail closed typed), `recoverInteraction` (the crash-window recovery surface: re-claim + re-dispatch; safe by the adapter contract's identity idempotency — no duplicate business effect), `recordObservedResult` (explicit, terminal, convergent observation; divergent re-observation rejected), plus the audit reads (`getInteraction`, `listInteractions` with state/capability/outcome/lineage/correlation filters, `listRecoverableDispatches`). Every read is tamper-evident (record hash recomputation); tenant predicates are mandatory.
- SQL store over the persistence boundary with the executor-explicit query discipline (every in-transaction statement on the pinned client — the PR #28 defect class, pinned by an always-on in-env tripwire, a source-discipline scan, and a live single-connection-pool proof). Migration `0005_external_interactions.sql`: `interaction_effects` (closed capability/state/outcome/failure-stage enumerations, lifecycle shape CHECKs — no acceptance without a claim, no success observation without an acceptance, no failure stage without a failed outcome, and one deliberate acceptance-free terminal: an observed dispatch-stage failure — the explicit, recoverable failure record of the retry protocol; tenant FKs; keyed partial unique index; recoverable-dispatch partial index; correlation GIN index; retry-lineage self-FK; policy provenance columns; input/record hashes) and `notification_requests` (closed channel enumeration; recipient/content/purpose/correlation; current-interaction pointer FK; NO delivery-status column — status is derived through /interactions, never re-recorded).
- `/notifications` public contract: `requestNotification` (durable request identity, keyed convergence, channel-shaped validation; requesting produces NO side effect), `dispatchNotification` (durable interaction intent through /interactions with the derived crash-convergent key `notification:{id}`, optional policyKey gate, idempotent pointer pin, then dispatch — repeated/concurrent calls converge on ONE interaction and ONE adapter invocation), `retryNotification` (explicit failure recovery: caller-keyed NEW interaction identity with retryOf lineage; only observed-FAILED deliveries are retriable; the failed observation stays durable), and the derived status surface (`getNotification`/`listNotifications`: requested → pending → in_flight → delivered/failed, projected from the linked interaction's durable state — no second observation authority; tamper evidence surfaces through the read).
- Governance wiring: `checkExternalInteractionBoundaries` (one interaction authority, one adapter/capability authority, one notification authority; provider-SDK imports rejected from every module — AC-6; the adapter surface contained behind /interactions; the interaction surface contained to /notifications in this frontier; import-direction rules for the three modules; no authorization/identity/route-guard/policy/workflow/Zeck/AI engine exports inside them; public-interface-only cross-module imports), the `interaction_`/`notification_` migration-prefix allowlist entries, check-CLI wiring, and composition-root wiring (registry composes EMPTY and SEALED — the boundary ships closed; "premature external effects" are impossible by construction; real provider adapters belong to the Work Order that owns provider configuration).
- Proofs: in-env behavioral lifecycle (30 tests), concurrency + discrimination incl. the CAS-skipping store mutant (9 tests), boundary structural/discrimination incl. provider-SDK imports and all violation codes (21 tests), notifications authority incl. AC-5 failure/recovery and tamper surfacing (18 tests), transaction-scope tripwire + source discipline + moving-clock record-hash timing regression (5 tests), and 13 live-PostgreSQL integration proofs (migrations/enumerations/lifecycle-shape invariants, lifecycle, parallel keyed convergence, parallel dispatch serialization, crash-window recovery, parallel observation convergence/arbitration, real policy gate, tamper detection, cross-tenant isolation, notifications end-to-end with retry, single-connection-pool transaction scope, AC-4 over the real stack) — CI-gated.

### Defects found and fixed during live verification

The first CI run of the implementation head (run 33529334494, commit 025e6d1) failed 5 of the 13 live-PostgreSQL proofs. Root-cause analysis (calibrated against the run's database-level constraint evidence) found three product-side defect classes and three test-side defects; all fixed in commit ba64af9:

1. **Schema/product contradiction (2 live failures)**: the migration's acceptance biconditional (`(state IN ('dispatched','observed')) = (provider acceptance columns set)`) forbade the module's legitimate explicit dispatch-failure record — an observation with `outcome='failed'`, `failure_stage='dispatch'` and NO acceptance (the provider never accepted: the sink invocation itself failed), which is exactly the explicit, recoverable failure the Work Order mandates. The CHECK now encodes the corrected lifecycle: acceptance exists exactly when the row is `dispatched` or observed with an acceptance-presupposing outcome (succeeded, or provider-stage failure). Relatedly: (a) the failure-stage CHECK `failure_stage IS NULL OR outcome = 'failed'` passed NULL outcomes via the SQL NULL-OR trap (`FALSE OR NULL` evaluates NULL and CHECK treats NULL as pass); now NULL-safe. (b) The intended-all-null CHECK missed `provider_reference`/`failure_stage`/`provider_observation` — an `intended` row could carry a failure stage; now every mutable state column is covered, plus a `provider_reference`-requires-`provider` pairing check.
2. **Frozen-clock-masked record-hash timing defect (found during re-verification, fixed before it could fail a live proof)**: `writeState`/`recordObservation` computed the record hash over the STALE `updatedAt` while the UPDATE stored the write's now — with a moving clock, the very next read of the row would fail closed as a false `interaction-record-tampered` (the second write of every dispatch). Invisible in every test because all suites use frozen clocks. Fixed to match the in-memory double's existing discipline (every state write advances `updatedAt` before hashing); pinned by a NEW always-on in-env moving-clock regression proof through the real SQL store code, verified to discriminate the defect (fix reverted → proof fails; restored → passes).
3. **Read-boundary orphan blind spot (1 live failure, plus hardening)**: `mapInteraction` silently dropped orphan column groups (e.g. a tampered `provider_reference` on an intended row — dispatch absent, so the column never entered the record hash), making such tampering invisible to the read-side integrity check. Orphan/partial groups now fail closed as `interaction-record-tampered` (mirroring the schema shape CHECKs at the read boundary), and the live tamper proof now flips `capability` — a schema-legal, hash-divergent mutation, the exact live equivalent of the in-env tamper seam.
4. **Test-side (3 live failures)**: (a) the keyed-retry convergence proof re-submitted the idempotency key WITHOUT the original correlation — a divergent input under the pinned intent-identity design (the input hash covers capability/params/correlation/retryOf/policyKey), which correctly fails closed with `INTERACTION_INPUT_CONFLICT`; the re-submission now carries the same logical intent. (b) The parallel-dispatch proof demanded exactly one fulfillment plus one typed rejection — but the loser's post-conflict re-check may postdate the winner's COMPLETE dispatch commit, in which case converging on the durable record is the legal, correct outcome (the WORK-004 post-conflict re-check discipline); the proof now accepts both legal loser outcomes while pinning the invariants that matter (ONE adapter invocation, one settled state, exactly one invoker, convergent views of the same durable record). (c) The tamper proof target was an orphan-invisible column (see 3).

### Verification results (correction head ba64af9)

- `npm run build` — PASS.
- `npm run check` (build + config + architecture structural checks incl. the external-interaction boundary checks + governance state) — PASS.
- `scripts/governance-check.py` — PASS.
- `npm test` — 501 tests / 448 pass / 0 fail / 53 skipped (40 pre-existing + 13 live-PostgreSQL proofs, CI-gated).
- Server smoke: composes 16 modules; `interactionsAuthority: composed`, `notificationsAuthority: composed`, `registeredAdapterCapabilities: 0` (the boundary ships closed).
- CI run on ba64af9: repository-governance PASS; foundation (all tests incl. the 13 live-PostgreSQL proofs) — see the PR for the final run evidence.

### Known limitations

- No real provider adapters ship in this Work Order (the registry composes empty and sealed; dispatch fails closed with ADAPTER_UNAVAILABLE until the Work Order owning provider configuration registers adapters). The contract conformance future adapters must reproduce is pinned by the test doubles.
- Live-PostgreSQL proofs execute in CI only (no local PostgreSQL in the implementation environment).
- No HTTP surface for the three modules (WORK-012 owns the control-plane API).
- WORK-006 will own the durable event inbox/outbox; webhook-driven `recordObservedResult` ingestion lands there.
