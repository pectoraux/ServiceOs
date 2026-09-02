# WORK-007

Status: complete
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Implement ServiceOS business evidence and outcome-verification primitives.

## Dependencies

Requires: WORK-004
Enables: WORK-010, WORK-012

## Scope

Allowed:
- /evidence
- business outcome contracts
- deterministic evidence mapping
- domain verification interfaces

Forbidden:
- replacing Zeck's AI execution evidence authority
- AI model evaluator
- vertical-specific outcome rules

## Protected Surfaces

/evidence, business verification contracts, evidence persistence

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Business evidence and outcome verification are distinct from Zeck execution evidence and status.

## Acceptance Criteria

- AC-1 Evidence can be attributed to a specific Service Work/Attempt.
- AC-2 Business outcome verification is distinct from transport/AI execution success.
- AC-3 Evidence provenance is preserved.
- AC-4 Missing evidence cannot become an unearned successful outcome.

## Verification Requirements

### Behavioral
- evidence attach/read
- outcome verification

### Structural
- no parallel Zeck evidence store for AI execution

### Discrimination / Mutation
- fabricated completion without evidence fails
- wrong-work evidence cannot satisfy another Work item

### Concurrency / Crash Safety
- duplicate evidence attachment converges

## Definition Of Done

See TEMPLATE.md.

## Evidence

Status: implemented and Architect-approved; final implementation revision `d788cf1a662be5cba5c46f44b4cf82410acaf09b` on PR #52, merged as `82d03b5277da29b7d846bb25a51c9efa6012d988`.

### What was implemented

- `/evidence` public contract — the ServiceOS business evidence and outcome-verification authority (architecture-lock #4; the protected surface of this Work Order): `createEvidenceModule` composing the single authorization chain (authorize BEFORE any domain data access; denials never touch the store) and `/work`'s public read for attribution validation (read-only; /evidence never mutates work state). No HTTP surface (WORK-012 owns the control-plane API).
- Evidence attachment (AC-1; activation invariant 2): `attachEvidence` — the ONE entry point attributing an immutable evidence FACT to a REAL Service Work and, optionally, one of its Work Attempts (existence + membership validated through `/work`'s public read; NO status gate — late results from any attempt state are recorded as evidence, never as work mutations; attempt-level attribution is provenance, the outcome scope is the work). Inputs validate fail-closed (identifier-shaped requirement names, frozen provenance kinds, bounded sources/refs, required payload/observed-at/key).
- Provenance preserved and tamper-evident (AC-3; activation invariant 3): every record carries its provenance (kind ∈ {operator_attestation, system_observation, external_record, customer_approval, calculation}, source, opaque durable references preserved verbatim — architecture-lock #20) plus BOTH a content hash (the actor- and key-independent FACT: convergence follows the fact regardless of who re-reports) and a record hash (the full immutable row core, recomputed on every read; divergence fails closed `EVIDENCE_RECORD_TAMPERED`/`VERIFICATION_RECORD_TAMPERED`).
- Duplicate attachment converges (activation invariant 6): the durable logical identity is (tenant, idempotency key) — keyed convergence; the durable content identity is (tenant, work, content hash) — the same fact under ANY key (any principal) converges on ONE durable row; divergent content under the same key fails closed `EVIDENCE_INPUT_CONFLICT`. Store-serialized per key AND per the work's evidence state with the post-lock idempotency re-check (the WORK-009 lesson), `ON CONFLICT DO NOTHING` convergence re-reads, and the deadlock-free fixed lock order (keyed lock first, work-state lock second).
- The deterministic evidence mapping + outcome verification (AC-2/AC-4; activation invariants 4/5): `verifyOutcome` — ONE business outcome verification decision: the module-owned PURE evaluator (`evaluateOutcomeContract`) is INJECTED into the store's serialized critical section (the WORK-011 discipline: authority in index.ts, atomicity in the store) and computes the verdict over exactly the SERIALIZED, COMMITTED evidence state (attaches and verifications of one work are mutually serialized through the work's evidence-state advisory lock — a decision never observes a torn evidence state). A requirement is satisfied iff at least one attached evidence record of THIS work item carries that requirement name; the verdict is 'satisfied' only when every contract requirement is satisfied (evidence of another Work item structurally never counts — invariant 5); missing evidence yields 'not_satisfied' with the missing requirements listed (invariant 4 — never an unearned success). The contract input is the `/services`-compatible verification subset (outcomeId, verification ∈ {deterministic, human_approval, external_record}, evidenceRequirements); AI-execution-shaped declarations fail closed `AI_VERIFICATION_FORBIDDEN` exactly like /services' validator (no AI model evaluator — the forbidden surface).
- Immutable decision ledger: verification rows are append-only and pin their input (scope + contract + the evaluated evidence snapshot, hashed); the verdict is a pure function of that input. Same key + identical input converges (idempotent re-run); same key + changed evidence state or contract fails closed `VERIFICATION_INPUT_CONFLICT` (a re-verification after evidence changes is a NEW logical decision and uses a new key); consumers read the current verdict through `getLatestOutcomeVerification` (missing distinguishable from empty — lock #30) and the full history through `listOutcomeVerifications` (REQ-014).
- No Zeck collapse (AC-2; activation invariant 1; structural requirement "no parallel Zeck evidence store for AI execution"): /evidence imports ONLY auth/organizations/work (machine-checked); it has no path that consults the AI boundary at all — a foreign execution claim can be cited only as an OPAQUE provenance reference string inside JSONB, never as typed state; the schema has no lifecycle column and no typed foreign-AI-execution/model column; and a transport/AI execution success never becomes a satisfied business outcome (proven dynamically: the work record stays unchanged through the full attach+verify flow).
- SQL store over the persistence boundary with the executor-pinned transaction discipline, advisory locks (evidence-key + evidence-state; verification-key + evidence-state), `ON CONFLICT DO NOTHING` convergence re-reads, post-lock idempotency re-checks, read-side defensive shape re-validation + hash recomputation. Migration `0009_business_evidence.sql`: `evidence_records` (keyed identity; one-row-per-fact content identity; provenance-shape CHECK) and `evidence_outcome_verifications` (keyed decision identity; closed verdict + business-verification-mode enumerations; requirements/results array CHECKs). Work/attempt identities validated through `/work`'s public read at the module layer (the /billing and /zeck precedent — no cross-module FKs); NO credential surface.
- Governance wiring: new `checkEvidenceBoundaries` (stable codes: `evidence-authority-duplicate` — attach/verify entry points reserved to /evidence; `ai-evidence-evaluator-surface` — model/provider/agent/LLM-shaped evaluation exports rejected in /evidence; `evidence-import-direction` — /evidence imports only auth/organizations/work, the /zeck prohibition encodes activation invariant 1; `evidence-internal-import`; `evidence-importer-frontier` — no module consumes the authority yet, WORK-010/WORK-012 extend; `evidence-parallel-ai-execution-schema` — lifecycle and typed foreign-AI-execution/model columns rejected on `evidence_` tables), the `evidence_` migration table prefix, check-CLI wiring, composition-root wiring (`evidenceAuthority: composed`).
- Activation-state repair (mechanical, not a governance decision): the WORK-007 activation commits moved WORK-007 to in_flight in dependency-state but omitted removing it from the future-only roadmap sequence/waves, so the fail-closed `governance-check.py` rejected the activation tip itself (verified with the implementation stashed at `c7d7c24`). This delivery completes the recorded activation decision exactly like the `64471ba` precedent (activated WORK-011 removed from the roadmap): WORK-007 removed from the future-only sequence and waves; the checker passes.
- Proofs: behavioral/discrimination suite (23 tests: attribution validation, provenance round-trip, missing-evidence denial, wrong-work rejection, fabricated-completion failure, re-verification discipline, content convergence, tamper detection on every read surface, authorization-before-data with store-read counters, AI-shaped declarations fail closed), concurrency suite (10 tests: same-key/same-fact convergence, divergent conflicts, crash window, attach/verify serialization, two guard-dropped mutation discriminations), boundary structural/discrimination suite (16 tests incl. planted model-router/LLM-SDK imports and the full mutation catalog), and 9 live-PostgreSQL integration proofs (CI-gated): migration order/idempotency (9 migrations), schema backstops (both unique identities + all enumeration/shape CHECKs), the full evidence flow with re-verification and no-work-mutation, wrong-work discrimination, duplicate convergence + divergent conflict, tamper detection over real rows, TRUE parallel convergence over independent pooled clients (same-key, divergent, same-fact, concurrent verification, attach/verify race), the moving-clock integrity regression, cross-tenant predicates.

### Defects found and fixed during live verification

The first CI run of the implementation head (run 33596641918, commit a0a714a) failed 2 of 9 WORK-007 live-PostgreSQL proofs plus surfaced one pre-existing harness flake. Root-cause analysis (commit 7bc40f1):

1. **TEST defect — nondeterministic ledger order**: the flow proof's fixed clock gave both decisions the same `decided_at`, so the latest-decision read tie-broke on random surrogate UUIDs (`ORDER BY decided_at, id`). The live app's default clock now ADVANCES one second per read (every durable write pins a distinct instant; attachment/decision order is deterministic). The moving-clock proof still injects its own real clock.
2. **TEST defect — race-script content-slot reuse**: the TRUE-parallel divergent race re-used the base fact content already attached by the first section, so side A legitimately CONTENT-converged on the earlier row (correct store behavior) and side B inserted its divergent payload freely — both sides succeeded. Each race stage now uses a fresh fact domain (the WORK-005 fresh-slot lesson applied to the content slot).
3. **HARNESS repair — pre-existing pool-teardown flake class**: `DROP DATABASE WITH (FORCE)` in any sibling teardown terminates idle pooled clients; pg then emits an unhandled pool 'error' event that lands as an uncaught exception attributed to whichever test is running (the failure class the service-work test file already documents in its drain comment; the previous green runs never hit it). All test pools are now created through `createTestPool` (live-database helper) with a no-op 'error' listener — teardown noise stays non-fatal while real query failures still reject their promises.

A second run (33597467909) then failed one ZECK-era live proof (the parallel divergent race: 2 rejections instead of 1). Root cause (commit 432399a): the parallel proof's two gateway doubles generate execution references through independent counters that land in the SAME tenant tables — when the race's sections are won by different sides, the fresh double's counter restarts at 1 and its attach collides with the OTHER gateway's already-pinned reference (the winner rejects REFERENCE_CONFLICT alongside the loser's IDEMPOTENCY_INPUT_CONFLICT; which racer wins a section decides whether the namespaces collide — timing-dependent, not deterministic). The doubles' purpose-built `executionPrefix` now namespaces gatewayB and the misbehaving gateway, making every gateway's references globally unique under any race outcome.

### Verification results

- `npm run build` — PASS.
- `npm run check` (build + config + architecture structural checks incl. the new evidence boundary checks + governance state + `scripts/governance-check.py`) — PASS before merge.
- `npm test` locally — 742 tests / 658 pass / 0 fail / 84 skipped (the 84 live-PostgreSQL proofs execute in CI only; no local PostgreSQL in the implementation environment).
- Composition-root smoke — truthful startup (`evidenceAuthority: composed`, 16 modules, exit 0 on SIGTERM).
- CI run 33598399215 at final substantive evidence head `2ec047a242aeee747ea9e35fd4952765a04cde88` — repository-governance PASS, foundation PASS: **742/742 tests, 0 fail, 0 skipped**, including all 84 live-PostgreSQL proofs and all 9 WORK-007 live proofs.
- CI run 33618519700 at final correction head `d788cf1a662be5cba5c46f44b4cf82410acaf09b` — repository-governance PASS, foundation PASS: **742/742 tests, 0 fail, 0 skipped**, including all 84 live-PostgreSQL proofs and all 9 WORK-007 live proofs. This exact-head rerun satisfied the Architect evidence-record correction gate.
- Historical, superseded as verification evidence: CI run 33598190423 at head `432399a` — both jobs PASS with the identical 742/742 result; this was the implementation head immediately before the evidence-recording commit `2ec047a`. The earlier failed runs (33596641918 at `a0a714a`, 33597467909 at `7bc40f1`) remain recorded above as historical defects.

### Evidence-record correction

The Architect review of `2ec047a` (PR #52) found this Evidence section still pointing its verification evidence at the pre-evidence head `432399a` / run `33598190423`, while the actual final PR evidence head/run was `2ec047a` / `33598399215`. The Status and Verification results pointers were corrected accordingly in commit `d788cf1a662be5cba5c46f44b4cf82410acaf09b`; the failed-run history is preserved unchanged as historical defects. The correction is evidence-record consistency only — no architecture, implementation, schema, or test change — and exact-head CI rerun `33618519700` passed.

### Architect verification and finalization

The Architect independently verified the corrected durable evidence record, the exact correction head `d788cf1a662be5cba5c46f44b4cf82410acaf09b`, and exact-head CI run `33618519700`. PR #52 was approved for merge under the Architect protocol and merged as `82d03b5277da29b7d846bb25a51c9efa6012d988`. This Work Order is complete; the canonical frontier now advances to `WORK-008` and no Work Order remains in flight.

### Known limitations

- Live-PostgreSQL proofs execute in CI only (no local PostgreSQL in the implementation environment).
- Evidence has no revocation/invalidation surface in this Work Order (append-only ledger; the verdict function is monotone — once every requirement is satisfied, additional evidence cannot un-satisfy an outcome). Adjustment/revocation surfaces belong to future Work Orders.
- The deterministic mapping counts evidence by requirement name only (no attribute predicates): vertical-specific matching rules are forbidden by this Work Order's scope and belong to the flow/vertical Work Orders (WORK-010) composing richer contracts atop this primitive; outcome output values are the attempt results' concern (the contract's outputSchema validation is /services' authority).
- Verification-mode values are business metadata recorded with the decision (they do not switch evaluation paths — every mode maps through the same deterministic evidence rule; the mode enumerates how the business chose to source evidence, mirroring /services' declared contract).
- No HTTP/control-plane surface (WORK-012); the execution-flow orchestration (who attaches evidence when, and how verification decisions drive Service Work transitions) is WORK-010 territory — /evidence records decisions, never transitions.
