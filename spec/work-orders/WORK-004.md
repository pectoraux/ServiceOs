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
