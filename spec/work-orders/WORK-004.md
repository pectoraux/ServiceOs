# WORK-004

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Implement the deterministic ServiceOS business workflow authority for Service Work.

## Dependencies

Requires: WORK-003, WORK-014
Enables: WORK-005, WORK-006, WORK-007, WORK-008, WORK-015

## Scope

Allowed:
- /workflow module
- Service Work transition rules
- transition preconditions
- SLA/continuation orchestration hooks

Forbidden:
- Zeck execution lifecycle
- AI planning/routing
- vertical-specific semantics
- direct external provider calls

## Protected Surfaces

/workflow, Service Work transition boundary, transition persistence/audit integration

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Exactly one deterministic Service Work transition authority; Zeck results are inputs only.

## Acceptance Criteria

- AC-1 Every Service Work transition is validated by one deterministic workflow authority.
- AC-2 Illegal transitions are rejected.
- AC-3 Zeck execution status cannot directly mutate Service Work state.
- AC-4 transition identity is idempotent.
- AC-5 workflow mutations are auditable.

## Verification Requirements

### Behavioral
- all legal transitions
- illegal transitions
- retry/correction paths

### Structural
- exactly one business workflow authority
- no AI imports

### Discrimination / Mutation
- bypassing workflow transition service must fail structural checks

### Concurrency / Crash Safety
- concurrent transitions from the same state converge or one fails deterministically

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-09-01.

- Branch: `feat/WORK-004-business-workflow`
- Base revision: `0df4ad6c71e1e9ebbdc694423d05b79098d62cf2`
- Activation issue: `#27`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect

The activation decision was made from the frozen v1.0 architecture and the completed WORK-003 and WORK-014 state. No architecture change is authorized by this Work Order.

## Implementation Status

Implementation delivered by Z.ai on 2026-09-01; PR opened for Architect review/merge/finalization (implementation branch `feat/WORK-004-business-workflow`, activation baseline `0df4ad6c`, implementation branch head at activation `cb14b73`).

## Evidence

Status: delivered, awaiting Architect verification.

### What was implemented

- `/workflow` public contract: `submitTransition` (the single deterministic transition surface), transition audit reads (`getTransition`/`listTransitions`), the continuation hook (`listContinuations`), and the SLA orchestration hooks (`setSlaDeadline`/`listSlaDeadlines`/`listSlaBreaches`).
- The frozen canonical Service Work state machine (architecture.md §7) as code in `transitions.ts`: closed 12-state enumeration, happy path, in_progress waiting/blocked loops, verifying rework, completion only through verifying, absorbing terminal states, and alternative terminal entries (cancelled/failed/expired) from every non-terminal state. Deterministic rule-id derivation; no data/config/vertical input can alter the table.
- Transition preconditions: the dependency gate (draft → ready requires every dependency work terminal-completed) evaluated authoritatively in-transaction under the work-row lock AND the same per-tenant dependency advisory lock /work's `addDependency` serializes on; the policy gate consumed through /policies' public `evaluatePolicy` contract (deny fails closed; allow pins decision provenance; namespaced policy idempotency keys).
- Transition persistence/audit integration: the append-only `workflow_transitions` ledger — one durable, attributable, tamper-evident record per applied transition (canonical rule id, evaluated preconditions, actor, reason, input hash, record integrity hash, strict per-work sequence) committed atomically with the work-status write inside one client-pinned transaction. After-the-fact row mutation is detected on read (hash recomputation). Migration 0004 extends migration 0002's closed one-value status enumeration through the /workflow authority (the sanctioned path 0002 documented).
- Transition identity idempotency: keyed submissions converge on the durable transition (input-matched; retries re-observe the original even after the work progressed further); divergent same-key input fails closed; the state machine's terminal absorption and self-loop rejection deterministically deduplicate unkeyed re-submissions.
- SLA/continuation orchestration hooks: read-side deterministic surfaces only (admissible continuations of the current state; per-(work, state) deadline upserts; deterministic breach evaluation whose EXPIRED enforcement still flows through `submitTransition`). No scheduler, timer, or external call exists in the module.
- Workflow boundary governance checks wired into the check CLI and CI: one transition authority (reserved transition exports forbidden outside /workflow), work-status UPDATEs forbidden outside the /workflow store, no Zeck/AI/vertical/policy/authorization engine inside /workflow, cross-module public-interface-only imports from /workflow, and the `workflow_` migration table prefix (the deliberate WORK-004 allowlist extension).
- Composition-root wiring (`createWorkflowModule`) consuming the single authorization chain (/organizations) and the /policies public contract; no `/workflow` HTTP surface (WORK-012 owns the control plane).
- Faithful in-memory workflow store for the in-env proofs; SQL store is the authoritative persistence.

### Verification results (implementation environment)

- `npm run build` (tsc) — PASS.
- `node --test dist/test/*.test.js` — **359 pass / 0 fail / 38 skipped** locally (the 38 skipped are the 11 gated live-PostgreSQL workflow proofs plus the 27 pre-existing gated live-DB proofs from WORK-002/003/014; this environment has no local PostgreSQL — CI runs them).
- `node dist/src/cli/check.js` — PASS: frozen architecture tree, identity/tenancy, work, policies and workflow boundary checks, branch/frontier conformance.
- `scripts/governance-check.py` — PASS.
- New test files: `workflow-transitions.test.ts` (12), `workflow-authority.test.ts` (25), `workflow-idempotency.test.ts` (6), `workflow-concurrency.test.ts` (9), `workflow-tenant-isolation.test.ts` (6), `workflow-boundary-checks.test.ts` (16), `workflow.integration.test.ts` (11, live-PostgreSQL, CI-only).

### Proof classes

- static/structural — PASS (boundary checks on the real tree; migration/schema pins; the real module implements its public contract; the SQL store is the only status writer with FOR UPDATE + the shared dependency advisory lock).
- dynamic/behavioral — PASS (legal/illegal transitions, full lifecycle, dependency and policy gates, AC-3 attempt-outcome proof, audit reads, SLA hooks, continuation hook).
- discrimination/mutation — PASS (mutated trees rejected with exact violation codes; mutant store that skips status re-validation produces the detectable double-ledger anomaly; out-of-band row tamper detected on read).
- concurrency — PASS in-env (deterministic interleavings: one-wins/one-conflicts, keyed convergence races, dependency-gate race; the live-PostgreSQL equivalents run in CI with TRUE parallel actors).

### Defects found and fixed during implementation/verification

1. The first live-PostgreSQL CI run exposed a keyed-convergence race window the in-env interleavings could not produce: a keyed retry whose keyed lookup ran BEFORE the winner's commit but whose work snapshot (module) / work-row lock acquisition (store) ran AFTER it observed the winner's outcome and failed closed (`TRANSITION_CONFLICT` / an illegal self-loop) instead of converging. Fixed on both planes — the SQL store re-checks keyed convergence after acquiring the FOR UPDATE row lock (the waited-on statement sees the newly committed row under READ COMMITTED), and the module re-checks once on the illegal-transition path — with two dedicated in-env regression tests (convergence + divergent-input fail-closed).
2. The SLA deadline upsert's rare same-key-different-target race path surfaced a raw driver conflict instead of the typed rule; it is now mapped to `sla-deadline-conflict` (fail closed, retry converges through the pre-check).

### Governance reconciliation (flagged for Architect review)

The activation's roadmap write was skipped by the Architect (contents-API staleness): `spec/governance/future-roadmap.json` still listed WORK-004 in the future generation while dependency-state/frontier-state already recorded the activation, failing `scripts/governance-check.py` at the UNTOUCHED activation baseline. This delivery includes a dedicated reconciliation commit applying exactly the documented activation frontier (WORK-004 removed from the roadmap sequence/waves; rationale updated). No other governance state was touched.

### Known limitations

- Live PostgreSQL proofs execute in CI only (no local PostgreSQL service in the implementation environment), consistent with WORK-002/003/014.
- `/workflow` has no HTTP/control-plane surface; WORK-012 owns that API.
- Attempt-outcome and evidence-based preconditions are deliberately NOT evaluated here: they belong to later authorities (/zeck WORK-005, /evidence WORK-007); the workflow authority's transition decision remains the single deterministic gate.
- SLA deadline VALUES are supplied through the public contract; service-definition SLA defaults arrive with /services (WORK-009).
