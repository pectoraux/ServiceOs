# WORK-014

Status: complete
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

The activation decision was made from the frozen v1.0 architecture and the completed WORK-002 and WORK-003 state. No architecture change was authorized by this Work Order.

## Implementation Status

Implementation delivered and verified by the Architect on 2026-09-01. PR #26 merged to `main` as `d7a25d381d4a2429857cf7bf44f6a9c95585e947`.

## Evidence

Status: approved and complete on 2026-09-01.

Implementation branch: `feat/WORK-014-business-policy`; delivered head `6c3ed13`; merge commit `d7a25d381d4a2429857cf7bf44f6a9c95585e947`.

### What was implemented

- `/policies` public contract: versioned policy contracts, resolution, deterministic evaluation, decision recording, and replay verification.
- Versioned tenant-bound policy contracts with base/customer scope, immutable rules, monotonic versioning, forward-only publication lifecycle, one-active enforcement, and tenant-scoped idempotency.
- Deterministic provider-independent evaluation with canonical-input hashing and fail-closed invalid comparisons.
- Deny-dominates policy composition with a code-defined frozen floor that cannot be weakened by configuration.
- Durable policy decision provenance including consulted policy/version, frozen revision, input snapshot/hash, deciding rule/principal, and record integrity hash.
- Decision mutation detection and replay verification.
- Structural policy-boundary governance checks and public hooks consumed by future workflow/side-effect authorities.
- Tenant-scoped SQL persistence and faithful in-memory test doubles.
- Composition-root wiring without introducing any `/policies` HTTP surface.

### Verification results

- `npm run build` — PASS.
- `node dist/src/cli/check.js` — PASS.
- GitHub Actions run `33503799435` — `foundation` PASS and `repository-governance` PASS; all 314 tests passed including all 27 live PostgreSQL proofs.
- Server smoke verified policy authority composition and fail-closed readiness/authentication behavior.

### Defects found and fixed during implementation/verification

1. Live PostgreSQL exposed an aborted-transaction convergence defect caused by catching a unique violation and re-reading inside the aborted transaction. Replaced with `ON CONFLICT ... DO NOTHING` convergence.
2. Policy override default-effect semantics were clarified and explicitly pinned in tests.
3. A test-side constraint-name matching error was corrected.

### Proof classes

- static/structural — PASS
- dynamic/behavioral — PASS
- discrimination/mutation — PASS
- concurrency — PASS, including live PostgreSQL concurrency proofs

### Final Architect verdict

APPROVED. The implementation satisfies the activated CRITICAL Work Order and remains within the frozen ServiceOS/Zeck authority boundary. No architecture change was introduced.
