# WORK-004

Status: complete
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

The activation decision was made from the frozen v1.0 architecture and the completed WORK-003 and WORK-014 state. No architecture change was authorized by this Work Order.

## Implementation Status

Implementation delivered by Z.ai and merged via PR #28. Architect review identified and required correction of a CRITICAL transaction-boundary defect; the correction was delivered on the same PR and re-proven before merge.

## Evidence

Status: approved and complete.

### What was implemented

- `/workflow` public contract: `submitTransition` (the single deterministic transition surface), transition audit reads (`getTransition`/`listTransitions`), the continuation hook (`listContinuations`), and the SLA orchestration hooks (`setSlaDeadline`/`listSlaDeadlines`/`listSlaBreaches`).
- The frozen canonical Service Work state machine (architecture.md §7) as code in `transitions.ts`: closed 12-state enumeration, happy path, in_progress waiting/blocked loops, verifying rework, completion only through verifying, absorbing terminal states, and alternative terminal states. Deterministic rule-id derivation; no data/config/vertical input can alter the table.
- Transition preconditions: the dependency gate (draft → ready requires every dependency work terminal-completed) evaluated authoritatively in-transaction under the work-row lock and the same per-tenant dependency advisory lock; the policy gate consumed through /policies' public `evaluatePolicy` contract.
- Transition persistence/audit integration: the append-only `workflow_transitions` ledger with canonical rule id, evaluated preconditions, actor, reason, input hash, integrity hash, and strict per-work sequence, committed atomically with the work-status write.
- Transaction-scope correction: the SQL store query helper became executor-explicit and every critical-section statement of `applyTransition`, plus the SLA upsert, executes on the single pinned transaction client. The correction was proven with an always-on in-env tripwire, a live single-connection-pool proof, and a live forced-commit rollback proof.
- Transition identity idempotency: keyed submissions converge on the durable transition; divergent same-key input fails closed; unkeyed self-loops are illegal.
- SLA/continuation orchestration hooks are deterministic read/upsert surfaces only; EXPIRED enforcement still flows through `submitTransition`.
- Workflow boundary governance checks enforce one transition authority, status-writes only in `/workflow`, no Zeck/AI/vertical/duplicate-policy/authorization engines in `/workflow`, public-interface-only cross-module imports, and the `workflow_` migration prefix.
- Composition-root wiring consumes the single authorization chain and the `/policies` public contract; `/workflow` exposes no HTTP surface (WORK-012 owns control-plane API).

### Verification results

- `npm run build` — PASS.
- `node dist/src/cli/check.js` — PASS.
- `scripts/governance-check.py` — PASS.
- Local test suite after correction: **405 total, 365 pass, 0 fail, 40 CI-gated**.
- GitHub Actions run `33521604369` on correction head `a4e4577`: **405/405 tests, 0 fail, 0 skipped, all 40 live PostgreSQL proofs executed**, including both transaction-scope proofs.
- Final evidence-head verification run `33522313052` — SUCCESS.
- PR #28 merged as `5be64d034253bfebd317da417d395fabcae388e6`.

### Proof classes

- static/structural — PASS.
- dynamic/behavioral — PASS.
- discrimination/mutation — PASS, including empirical failure of the transaction-scope tripwire against the pre-fix closure-captured-executor implementation.
- concurrency — PASS in-env and in live PostgreSQL CI.

### Defects found and fixed during implementation/verification

1. A live PostgreSQL run exposed a keyed-convergence race window; the SQL store and module were hardened to re-check the durable keyed transition after the competing commit became visible.
2. A same-key SLA deadline conflict path was mapped to a typed fail-closed rule.
3. A live-test design was corrected so one-wins/one-fails uses the same target, avoiding a false conflict expectation for a legitimately sequential different-target transition.
4. Architect review found a CRITICAL transaction-boundary defect: the SQL store's helper used the pooled executor from inside a transaction. This violated the claimed atomicity/serialization of `FOR UPDATE`, dependency gate, sequence allocation, ledger insert, and status mutation; the same escape class existed in the SLA upsert. The helper was made executor-explicit, every in-transaction call site was switched to `tx`, and transaction-scope discrimination/live proofs were added and passed.

### Governance reconciliation

During WORK-004 delivery, the future-only roadmap was reconciled so `future-roadmap.json` exactly matched the future generation represented by dependency-state. This is now the canonical post-completion state.

### Known limitations

- Live PostgreSQL proofs execute in CI only; all required live proofs passed.
- `/workflow` has no HTTP/control-plane surface; WORK-012 owns that API.
- Attempt-outcome and evidence-based preconditions belong to later authorities (/zeck WORK-005 and /evidence WORK-007).
- SLA deadline values are supplied through the public contract; service-definition SLA defaults arrive with /services (WORK-009).
