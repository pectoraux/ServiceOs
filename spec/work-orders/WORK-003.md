# WORK-003

Status: complete
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Implement Service Work identity, lifecycle records, work attempts, dependencies, durable identities and safe retry primitives.

## Dependencies

Requires: WORK-001
Enables: WORK-004, WORK-009, WORK-014

## Scope

Allowed:
- /work module
- ServiceWork persistence
- WorkAttempt persistence
- dependency records
- durable idempotency primitives

Forbidden:
- business state transition engine beyond the domain model; WORK-004 owns that
- AI execution runtime
- vertical-specific work types

## Protected Surfaces

/work, ServiceWork persistence, WorkAttempt persistence, dependency/idempotency records

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- ServiceWork and WorkAttempt identities are separate; no workflow state machine or Zeck lifecycle is owned here.

## Acceptance Criteria

- AC-1 Service Work has durable tenant-bound identity.
- AC-2 Work Attempts are distinct from Service Work and external/Zeck executions.
- AC-3 Work dependencies are durable and cycle-safe.
- AC-4 Retry/convergence identities prevent duplicate Work Attempts under the defined retry protocol.
- AC-5 Stale attempts cannot mutate current-work state after supersession.

## Verification Requirements

### Behavioral
- create/read work
- attempt creation
- dependencies

### Structural
- no workflow engine in /work
- no Zeck state machine in ServiceOS

### Discrimination / Mutation
- stale-attempt mutation regression
- duplicate identity regression

### Concurrency / Crash Safety
- two actors creating the same logical work must converge
- late prior attempt cannot win over current attempt

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-09-01.

- Branch: `feat/WORK-003-service-work`
- Base revision: `ce771414d698b6bd846da575c1ca32e29608d4b5`
- Activation issue: `#18`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect

The activation decision was made from the frozen v1.0 architecture and the completed WORK-002 state. No architecture change was authorized by this Work Order.

## Final Delivery Record

Status: **APPROVED / COMPLETE** on 2026-09-01.

Implementation PR: #24.
Implementation head: `18e022bdcff862701ac13764801fb37dae5e76d7`.
Merged as: `4ee83a28ca8777836fbc01c3d64f19447b7c64e8`.
CI: run `33473045255` — success; all required live PostgreSQL proofs executed.

### Verification results

- `npm run build` — PASS.
- `node dist/src/cli/check.js` — PASS: frozen architecture tree, identity/tenancy boundaries, work-boundary checks, branch/frontier conformance.
- `scripts/governance-check.py` — PASS.
- CI test suite — **259/259 PASS, 0 FAIL, 0 SKIPPED**; all 16 gated live-PostgreSQL proofs executed against postgres:17, including the 8 WORK-003 proofs.
- Required proof classes — static, dynamic, discrimination/mutation, concurrency — satisfied.
- Architect verification — PASS against the activated CRITICAL Work Order and frozen v1.0 authority matrix/Zeck boundary.

### Delivered scope

- Durable tenant-bound ServiceWork identity and idempotent creation convergence.
- Separate WorkAttempt identity with per-work sequencing, dispatch boundary, observed outcomes, and supersession chain.
- Durable same-tenant dependency edges with duplicate convergence, self-dependency rejection, and transaction-serialized cycle safety.
- Pre-dispatch retry convergence, post-dispatch superseding attempts, idempotent dispatch/result re-observation, and divergent-result conflict handling.
- Stale/superseded attempts cannot dispatch or mutate results; current-attempt pointer moves forward only.
- Structural enforcement that `/work` owns no workflow transition engine, no Zeck execution lifecycle, no AI runtime, and no vertical-specific work state.

### Notable implementation findings

- Client-pinned transactions from WORK-001 were correctly relied upon for concurrency-sensitive operations.
- First live CI execution exposed and corrected three test-side defects without changing the Work Order's production semantics: a non-evaluating CHECK probe, leaked test pools during database disposal, and an uncovered partial-index backstop fixture.

### Known limitations carried forward

- `/work` has no HTTP/control-plane surface; WORK-012 owns that API.
- Work status remains `'draft'` until WORK-004 extends the workflow-owned state machine.
- Live PostgreSQL proofs depend on CI because the implementation environment did not provide a running PostgreSQL service.
