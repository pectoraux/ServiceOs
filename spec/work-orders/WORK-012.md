# WORK-012

Status: planned
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE

## Objective

Build the first human-facing ServiceOS control-plane API and UX for monitoring Service Work, exceptions, approvals, outcomes and service performance.

## Dependencies

Requires: WORK-005, WORK-007, WORK-009, WORK-014, WORK-015
Enables: WORK-013

## Scope

Allowed:
- project/service/work overview
- work queue
- exception/approval views
- evidence/outcome views
- service health/metrics views

Forbidden:
- frontend-owned business state authority
- AI execution UI that duplicates Zeck's execution console
- fabricated empty/success states

## Protected Surfaces

API transport, frontend control-plane surfaces, evidence/work/approval views

## Required Proof Classes

`static,dynamic,discrimination`

## Architecture Invariants

- frontend is a consumer, never an authority
- ServiceOS APIs remain the source of business truth
- Zeck execution remains referenced rather than duplicated
- failed reads remain distinct from genuine empty results

## Acceptance Criteria

- AC-1 UI reads authoritative ServiceOS APIs.
- AC-2 Failed reads remain explicit errors, not empty states.
- AC-3 Current work state is rendered from the workflow authority.
- AC-4 Zeck execution details are referenced, not reimplemented as a second execution console.

## Verification Requirements

### Behavioral
- workbench flows

### Structural
- frontend has no DB/provider SDK access
- frontend has zero business-state authority

### Discrimination / Mutation
- failed authority read must not render “nothing to do”

### Concurrency / Crash Safety
- refresh after mutation reflects authoritative backend state

## Definition Of Done

See TEMPLATE.md.
