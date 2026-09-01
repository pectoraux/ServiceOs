# WORK-004 Activation Record

Date: 2026-09-01
Architecture: v1.0
Assurance: CRITICAL

## Work Order

WORK-004 — Business Workflow Authority

## Authority

Implementation authority: Z.ai
Review/merge/finalization authority: Architect

## Activation

Activation issue: #27
Implementation branch: `feat/WORK-004-business-workflow`
Implementation baseline: `0df4ad6c71e1e9ebbdc694423d05b79098d62cf2`

## Dependencies

Completed prerequisites: WORK-003, WORK-014

## Allowed Scope

- `/workflow` module
- deterministic Service Work transition rules
- transition preconditions
- SLA/continuation orchestration hooks

## Forbidden Scope

- Zeck execution lifecycle
- AI planning/routing
- vertical-specific semantics
- direct external provider calls

## Required Proofs

`static,dynamic,discrimination,concurrency`

## Acceptance Criteria

- Every Service Work transition is validated by one deterministic workflow authority.
- Illegal transitions are rejected.
- Zeck execution status cannot directly mutate Service Work state.
- Transition identity is idempotent.
- Workflow mutations are auditable.

No architecture change is authorized by this activation.