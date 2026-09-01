# WORK-003

Status: in_flight
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

The activation decision was made from the frozen v1.0 architecture and the completed WORK-002 state. No architecture change is authorized by this Work Order.

## Implementation Status

Implementation has not yet been delivered. This Work Order is the sole active implementation frontier. Z.ai may implement only the scope above and must return a PR with the four required proof classes.
