# WORK-005

Status: complete
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Implement the thin ServiceOS-to-Zeck integration boundary for AI execution requests and results.

## Dependencies

Requires: WORK-004
Enables: WORK-010, WORK-012

## Scope

Allowed:
- /zeck integration module
- ServiceOS AIExecutionIntent contract
- Zeck execution reference persistence
- Zeck webhook/callback translation
- retry/idempotency handling

Forbidden:
- model/provider selection
- LLM provider SDKs
- AI agent runtime
- AI tools/context/planning/verification/learning
- shadow Zeck execution database

## Protected Surfaces

/zeck, Zeck integration contracts, execution-reference persistence, callback ingress

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- /zeck contains no AI implementation; no shadow Zeck lifecycle; no provider/model selection.

## Acceptance Criteria

- AC-1 ServiceOS can submit an AI Execution Intent through one provider-neutral Zeck port.
- AC-2 Zeck execution identity is correlated to Service Work/Attempt by durable idempotency identity.
- AC-3 Zeck lifecycle is not reimplemented in ServiceOS.
- AC-4 AI provider credentials are absent from ServiceOS domain modules.
- AC-5 Zeck results can be consumed without treating transport success as business success.
- AC-6 Duplicate requests converge on one Zeck execution reference when the Zeck contract permits idempotency.

## Verification Requirements

### Behavioral
- request, callback/result, retry

### Structural
- no LLM/model/provider/agent/tool/context/planning modules
- no direct Zeck provider-specific SDK in business modules

### Discrimination / Mutation
- a planted model-router import must fail architecture checks
- a Zeck success without business verification must not complete Service Work

### Concurrency / Crash Safety
- concurrent request attempts use one deterministic idempotency key and converge
- callback replay is idempotent

## Definition Of Done

See TEMPLATE.md.

## Evidence

Status: verified and approved by Architect; merged in PR #39.

### What was implemented

- `/zeck` public contract — the thin AI execution integration boundary (the protected surface of this Work Order): `createZeckModule` composing the single authorization chain, `/work`'s public read (correlation validation — read-only; /zeck never mutates work state) and the ONE provider-neutral Zeck port. No real gateway ships in this Work Order: the production composition injects none, so the boundary stays CLOSED and submissions fail closed `ZECK_GATEWAY_UNAVAILABLE` (truthful unavailability — no fabricated success, no credentials in ServiceOS, no premature external AI requests until the Work Order owning Zeck connection configuration registers a real gateway; AC-4). Contract-conformant test doubles (`createInMemoryZeckGateway`: identity-idempotent dispatch, honest unavailability, observable misbehavior) pin the port's semantics for every proof.
- The AIExecutionIntent contract (AC-1; contract §2): `validateExecutionIntentInput` — business identity (tenant, Service Work, Work Attempt), objective, bounded artifact/context references, capability REQUIREMENTS (validated through `/verticals`' frozen shared declaration contract — never re-implemented; forbidden model/provider/agent/prompt selection keys fail closed `AI_SELECTION_FORBIDDEN`), authoritative business constraints, the requested output contract and the REQUIRED durable idempotency key. The request sent through the port carries the deterministic intent identity as its idempotency key and NO model/provider selection surface anywhere.
- Durable correlation + reference persistence (AC-2/AC-6): `submitExecutionIntent` — the intent is registered/serialized under (tenant, idempotency key) with the post-lock idempotency re-check discipline (same key + identical content converges; divergence fails closed `IDEMPOTENCY_INPUT_CONFLICT`; ONE intent per work attempt — a different key on a linked attempt fails closed `ATTEMPT_ALREADY_LINKED`; dead attempts fail closed `ATTEMPT_NOT_SUBMITTABLE`). Dispatch happens OUTSIDE the store transactions (external IO never holds durable locks); the foreign execution reference is pinned in ONE advisory-locked critical section (identical re-attach converges; divergent or foreign-owned identity fails closed `REFERENCE_CONFLICT`, backstopped by the partial unique (tenant, execution reference) index and the 23505→typed-conflict mapping). Retries consult the durable correlation record FIRST (no second external request over a durable reference); the crash window (gateway accepted, attach never committed) re-dispatches through the SAME deterministic identity and converges (the AC-6 semantics under Zeck's idempotency contract).
- Callback translation (AC-5; contract §4/§6): `ingestCallback` — the frozen translation enumeration (`execution.completed`/`execution.failed`), bounded result-observation validation, and ONE serialized critical section per (tenant, event id) that decides the disposition INSIDE the section: accepted events insert the immutable delivery row and advance the intent's last-seen ingestion cursor in the SAME transaction (one clock read); unknown event types, malformed payloads, uncorrelated executions and conflicting correlation identities are REJECTED with typed errors AND durable rejected-delivery evidence. Identical replays converge (idempotent replay — no cursor re-advance); divergent replays fail closed `EVENT_CONFLICT` (the durable row is the evidence). Rejections replay idempotently (the same typed error, still one row).
- TRANSPORT ≠ BUSINESS SUCCESS (AC-5): a Zeck acceptance is a transport fact; a translated callback is an OBSERVATION. The module never mutates Service Work state, never records attempt outcomes, never imports `/workflow` — proven dynamically (after a full submit + accepted `execution.completed` callback the Service Work record stays `draft` and the attempt outcome stays null, in-env and over live SQL) and structurally (work-status writes remain exclusive to `/workflow`).
- No shadow Zeck lifecycle (AC-3; architecture-lock #19): the durable surface is reference-shaped only — intents carry the foreign reference + ingestion cursor, events carry the delivery disposition; NO execution status/state/lifecycle column exists anywhere in the schema or module (machine-checked by `checkZeckBoundaries`).
- SQL store over the persistence boundary with the executor-pinned transaction discipline, advisory locks (intent/attach/event critical sections), `ON CONFLICT DO NOTHING` convergence re-reads, post-lock idempotency re-checks, `FOR UPDATE` fresh-row record-hash recomputation on every intent write (cross-writer serialization between attach and cursor touch), and read-side hash verification. Migration `0008_zeck_integration_boundary.sql`: `zeck_execution_intents` (keyed logical identity; one-intent-per-attempt; one-intent-per-foreign-execution partial unique index; reference/submission pairing CHECK; cursor pairing CHECK) and `zeck_callback_events` (one row per event identity; disposition/rejection pairing CHECK; accepted rows are correlated and translated). Work/attempt identities validated through `/work`'s public read at the module layer (the /billing precedent for cross-module identity references — no cross-module FKs); NO credential column anywhere.
- Governance wiring: new `checkZeckBoundaries` (one boundary authority: submission/translation entry points reserved to /zeck; import direction: /zeck imports only auth/organizations/work/verticals — never /workflow//policies//billing; frontier-relative importers: none yet — WORK-010/WORK-012 extend; credential-shaped tokens rejected in /zeck sources and the `zeck_` schema; execution-lifecycle columns rejected on `zeck_` tables), the WORK-003 blanket migration tripwire refined (executable SQL may reference "zeck" only in the `zeck`-named, all-`zeck_`-tables migration — the precise shape of this Work Order's authorized reference surface), the `zeck_` migration table prefix, the `VERTICALS_IMPORTERS` frontier extension (`zeck`), check-CLI wiring, composition-root wiring (`zeckBoundary: composed (closed: no gateway)`; no HTTP surface — WORK-012).
- Proofs: behavioral/discrimination suite (22 tests incl. in-env tamper detection), concurrency suite (9 incl. the crash-window and two guard-dropped mutation discriminations), boundary structural/discrimination suite (15 incl. planted model-router/LLM-SDK imports and the full mutation catalog), and 9 live-PostgreSQL integration proofs (CI-gated): migration order/idempotency, schema backstops (all four unique identities + both pairing CHECKs), the full boundary flow with retry convergence, the AC-5 live proof, rejection evidence with idempotent replay, tamper detection over real rows, TRUE parallel convergence over independent pooled clients (same-key, divergent-key fresh-slot, same-attempt different keys, misbehaving gateway, concurrent identical/divergent deliveries), the moving-clock integrity regression, cross-tenant predicates.

### Defects found and fixed during live verification

The first CI run of the implementation head (run 33590451731, commit 43c985b) failed 4 of 9 live-PostgreSQL proofs. Root-cause analysis (commit d095cbf):

1. **PRODUCT defect — read-path error mapping**: the module's READ paths surfaced the raw `ZeckStoreRuleError` from the store's hash verification instead of the public typed codes (`INTENT_RECORD_TAMPERED`/`EVENT_RECORD_TAMPERED`) — a latent error-surface inconsistency (the in-env suites never exercised read-path tampering before this delivery added an in-env tamper proof to pin it). Every store call now maps through the module's error surface.
2. **TEST defect — pairing-CHECK plant**: the schema-backstop UPDATE set a reference on a row that already carried reference + submission metadata, so the pairing CHECK correctly passed; the plant now strips the submission metadata while pinning a reference.
3. **TEST defect — race-script slot reuse**: the TRUE-parallel proof re-used the shared work attempt for the divergent and different-key stages after the first race had durably linked it — both racers correctly hit `ATTEMPT_ALREADY_LINKED`. Each stage now races a fresh work+attempt (the WORK-009 fresh-slot lesson applied to the correlation slot).
4. **TEST defect — cross-tenant helper misuse**: the cross-tenant proof wrapped a legitimate same-tenant submission in the fail-closed helper; it now plants the actual cross reference (tenant A's work under tenant B → `WORK_NOT_FOUND`) and asserts the legitimate path succeeds.

### Verification results

- `npm run build` — PASS.
- `npm run check` (build + config + architecture structural checks incl. the new Zeck boundary checks + governance state + `scripts/governance-check.py`) — PASS.
- `npm test` locally — 609 tests / 0 fail / 75 skipped (the 75 live-PostgreSQL proofs execute in CI only; no local PostgreSQL in the implementation environment).
- Composition-root smoke — truthful startup with the boundary closed (`zeckBoundary: composed (closed: no gateway)`, 16 modules, exit 0 on SIGTERM).
- CI run 33590896289 at implementation revision `d095cbf` — repository-governance PASS, foundation PASS: **684/684 tests, 0 fail, 0 skipped**, including all 75 live-PostgreSQL proofs and all 9 WORK-005 live proofs.

### Known limitations

- Live-PostgreSQL proofs execute in CI only (no local PostgreSQL in the implementation environment).
- No real Zeck gateway ships: the boundary composes CLOSED (fail-closed `ZECK_GATEWAY_UNAVAILABLE`) until the Work Order owning Zeck connection configuration registers a real gateway — provider credentials never enter ServiceOS domain modules (AC-4).
- No HTTP/control-plane surface (WORK-012); the webhook ingress endpoint for `ingestCallback` is composed by the future control plane; the execution-flow orchestration (who submits intents when, and how observations feed business verification) is WORK-010/WORK-007 territory.
- The callback translation enumeration is deliberately minimal (`execution.completed`/`execution.failed`): non-terminal Zeck events have no business consumer at this frontier and are rejected with durable evidence rather than guessed at.
- Billing cost references remain operator-ingested through /billing's own surface; observations carry only opaque reported-cost pointers (no automatic cross-module linkage — the frontier discipline keeps /billing and /zeck mutually independent).
- Zeck-side failures surface typed transport errors with no automatic retry scheduling: retries are caller-driven through the same durable key (the retry protocol's convergence guarantees make this safe); a scheduled retry/dispatch loop belongs to the execution-flow owner (WORK-010).