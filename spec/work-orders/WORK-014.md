# WORK-014

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Implement the single ServiceOS business-policy authority used to resolve and enforce customer/service policies before governed business transitions and external effects.

## Context

The architecture requires one deterministic business-policy authority. Policies may be parameterized by vertical/service/customer configuration, but configuration cannot weaken horizontal security or authority invariants.

## Dependencies

Requires: WORK-002, WORK-003
Enables: WORK-004, WORK-008, WORK-010, WORK-012

## Scope

Allowed:
- `/policies` module
- versioned business-policy contracts
- policy resolution
- deterministic policy evaluation
- policy decision/provenance records
- policy hooks consumed by workflow and side-effect authorities

Forbidden:
- model/provider/agent/AI policy engines
- authorization replacement
- workflow state machine
- vertical-specific policy engine outside the public policy contract

## Protected Surfaces

/policies, policy resolution/evaluation, policy decision provenance

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- one ServiceOS business-policy authority
- authorization remains separate from business policy
- policy can tighten but never weaken frozen security/authority invariants
- AI policy/execution remains Zeck-owned
- policy decisions are attributable and revision-bound

## Acceptance Criteria

- AC-1 One provider-independent business-policy interface exists.
- AC-2 The same policy inputs produce the same policy decision.
- AC-3 Customer/vertical configuration cannot grant forbidden capability or bypass higher authority.
- AC-4 Workflow and external-side-effect paths consume policy through the public contract rather than reimplementing policy logic.
- AC-5 Policy decision provenance identifies the policy version and relevant input revision.

## Verification Requirements

### Behavioral
- allow/deny policy cases
- policy version resolution
- customer override precedence

### Structural
- exactly one policy authority
- no AI/provider imports
- no authorization/workflow state machine in `/policies`

### Discrimination / Mutation
- mutating a policy result after evaluation must be detected
- weakening a frozen invariant must be rejected
- duplicate policy engines are rejected structurally

### Concurrency / Crash Safety
- concurrent creation/resolution of the same policy identity converges

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-09-01.

- Branch: `feat/WORK-014-business-policy`
- Base revision: `272351771aed3886347fe325dd4a7abc317cf669`
- Activation issue: `#25`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect

The activation decision was made from the frozen v1.0 architecture and the completed WORK-002 and WORK-003 state. No architecture change is authorized by this Work Order.

## Implementation Status

Implementation delivered for Architect verification on 2026-09-01. Z.ai implemented only the scope above and returned the implementation PR with the four required proof classes.

## Evidence

Status: delivered for Architect verification on 2026-09-01.

Implementation branch: `feat/WORK-014-business-policy` (base revision `272351771aed3886347fe325dd4a7abc317cf669`, activation issue #25, branch reconciled with main's finalized activation state `c4682bd` by fast-forward).

### What was implemented

- `/policies` module public contract — `createPolicyVersion`, `getPolicyVersion`, `listPolicyVersions`, `activatePolicyVersion`, `resolvePolicy`, `evaluatePolicy`, `getDecision`, `verifyDecision` — consuming the single authorization chain from `/organizations`' public interface (authorization-before-data-access; read action for reads, write action for mutations and decision recording).
- **Versioned policy contracts** — tenant-bound durable rows (`policy_contracts`) with an opaque business `policy_key`, a precedence `scope` (`base` = service/vertical default, `customer` = override), monotonic per-identity version numbering under a lock, and immutable rule content. Publication state is contract versioning, not the workflow state machine: `draft` → `active` forward-only (retirement precedes activation, per-statement partial-unique ordering), `retired` is terminal, one active version per (tenant, key, scope).
- **Policy resolution** — `resolvePolicy` returns the active base and customer contracts plus the frozen revision; `evaluatePolicy` resolves the same layers and pins exactly what it consulted.
- **Deterministic evaluation** — a pure, provider-independent evaluator (`evaluation.ts`): no clock, no randomness, no I/O, no model/provider/agent surface. First matching rule decides a layer; the contract's default effect governs unmatched inputs; ordered comparisons on non-number attributes fail closed with a typed error.
- **Override precedence without weakening** — deny-dominates composition: frozen floor → customer deny → base deny → fail-closed (no base policy ⇒ deny; an override alone never grants) → customer allow → base allow. A customer override may tighten (deny where base allows) but can never weaken the base deny or the frozen floor.
- **Frozen floor** — code-defined (never data, never configurable) deny rules for frozen-denied capabilities (`authorization-bypass`, `policy-gate-bypass`, `ai-authority`, `ai-credentials`, `cross-tenant-data`, `audit-rewrite`, `governance-rewrite`), pinned to `frozen-v1.0` and recorded in every decision's provenance.
- **Policy decision provenance** — durable decision records (`policy_decisions`) pin the policy id/version each layer consulted, the deciding layer + rule id, the frozen revision, the input snapshot, its canonical-input SHA-256 (`input_hash` = the input revision), the deciding principal, and an integrity hash over the record core. `verifyDecision` additionally replays the pinned versions against the pinned input (determinism proof + tamper evidence).
- **Idempotency / convergence primitives** — version-creation convergence by tenant-scoped idempotency key (partial unique index); decision-record convergence for re-delivered gated decisions (same key + same input hash ⇒ one record; a divergent input for the same key fails closed with `DECISION_INPUT_CONFLICT`); activation of the already-active version converges.
- **Mutation detection** — every decision read recomputes the persisted input and record hashes; an after-the-fact change to a recorded result (outcome, provenance, input, attribution) is detected on read (`DECISION_RECORD_TAMPERED`).
- **Structural boundary checks (new governance wiring)** — `checkPoliciesBoundaries` machine-enforces: no policy-engine entry points outside `/policies` (`policy-engine-duplicate`), no authorization/credential/guard exports in `/policies` (authorization replacement forbidden), no transition-engine exports in `/policies` (workflow state machine forbidden), no AI/provider policy-engine exports in `/policies`, no `/policies → /workflow|/zeck` imports (dependency direction: they consume `/policies`), plus the `policy_` migration table-prefix extension owned by this Work Order.
- **Store port + SQL store + faithful in-memory double** (exposed on the module's public interface so test doubles implement the same contract).
- **Durable schema** — `db/migrations/0003_business_policy.sql` (`policy_contracts`, `policy_decisions`) with closed enumerations, the one-active partial unique index, tenant-scoped idempotency partial unique indexes, and tenant FKs.
- **Composition-root wiring** in `src/main.ts` (policies module composed over the single authorization chain; `policyAuthority: composed` in the startup log; HTTP surface belongs to WORK-012).

### Verification results

- `npm run build` (tsc) — PASS.
- `node dist/src/cli/check.js` — PASS: frozen 16-module architecture, identity/tenancy boundary checks, work boundary checks, NEW policies boundary checks, frontier/branch conformance.
- `npm test` locally — 286 pass, 0 fail; 27 live-PostgreSQL proofs gated locally (no PostgreSQL service in the implementation environment).
- Server smoke — `policyAuthority: composed` in the startup log; `/healthz` 200; `/readyz` truthfully 503 with the database down; guarded customer routes reject unauthenticated callers 401 before any data access.
- GitHub Actions — run on the PR (tests + repository-governance jobs); live-PostgreSQL proofs execute in CI through the postgres:17 service.

### Acceptance-criterion evidence

- AC-1 (one provider-independent business-policy interface) — the `/policies` public contract is the sole policy surface; structural check `policy-engine-duplicate` rejects any other module exporting policy-engine entry points; the evaluator is pure code with no model/provider/agent import or export (also enforced by `ai-policy-engine-in-policies` and the global AI package denylist).
- AC-2 (same inputs ⇒ same decision) — determinism tests (repeated evaluation, attribute-order-independent canonical input hash, pure evaluator stability) plus live-SQL determinism proof and `verifyDecision` replay.
- AC-3 (configuration cannot grant forbidden capability or bypass higher authority) — frozen-floor dominance tests (all layers allow + frozen capability ⇒ deny, decided by `frozen`); override-cannot-weaken tests (customer allow + base deny ⇒ deny, decided by `base`); fail-closed-without-base tests (an override alone never grants); the pure composition table pins every precedence case.
- AC-4 (workflow/side-effect paths consume the public contract) — `resolvePolicy`/`evaluatePolicy` are the public hooks; the structural checks enforce the `/workflow → /policies` dependency direction and reject duplicate policy engines in any module (AC-4's enforcement is structural because the consumers are future Work Orders).
- AC-5 (provenance identifies policy version and input revision) — decision records pin per-layer policy id/version, frozen revision, input snapshot + input hash, deciding rule and principal; provenance and replay tests over both stores.

### Proof classes

- static/structural — policies-boundary governance checks (real tree passes; mutated synthetic trees rejected with stable codes: `policy-engine-duplicate`, `authorization-in-policies`, `identity-engine-in-policies`, `route-guard-in-policies`, `workflow-engine-in-policies`, `ai-policy-engine-in-policies`, `policy-import-direction`, `unknown-migration-table-prefix`); closed enumerations and partial unique indexes pinned in the real migration; check-CLI end-to-end wiring.
- dynamic/behavioral — contract versioning lifecycle, activation retirement ordering, resolution, allow/deny/default cases, validation fail-closed, idempotent creation/decisions, decision conflict on divergent input.
- discrimination/mutation — decision-record tampering detected on read (outcome, input, provenance mutations each detected); replay divergence on tampered rule content; tenant-predicate mutation sensitivity (the row exists in the raw store but the predicated read returns null; a predicate-dropping store leaks observably); frozen-floor and override-weakening rejections; suspended-tenant denial distinct from missing.
- concurrency — in-memory interleaving races with injected hooks (same-key version creation converges; same-version activation converges with exactly one active; different-version activations leave exactly one active; same-key decision evaluation converges on one record; divergent-input races fail closed with exactly one winner; a decision resolving during an activation race pins the versions it consulted) — plus live-PostgreSQL equivalents with separate pooled clients.

### Changed surfaces (allowed scope only)

- `src/modules/policies/**` (evaluation engine, store port, SQL store, module public contract)
- `db/migrations/0003_business_policy.sql`
- `db/migrations/README.md`
- additive policies-boundary governance checks and check CLI wiring
- additive composition-root wiring in `src/main.ts`
- test helpers (in-memory `/policies` store) and the five proof-class suites
- one era-relative fix to a WORK-003-era test that hardcoded the then-active branch (now reads canonical state, the WORK-002 precedent for era-relative tests)
