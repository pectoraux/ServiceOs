# WORK-008

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE

## Objective

Implement explicit ServiceOS business/human approval requests and decisions.

## Dependencies

Requires: WORK-004, WORK-014
Enables: WORK-010

## Scope

Allowed:
- approval request/decision records
- approval policy hooks
- authenticated human approval surface

Forbidden:
- replacing Zeck's optional AI human-escalation execution primitive
- implicit approval from agent claims

## Protected Surfaces

/approvals, approval persistence/routes, authorization integration

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Business approval is an explicit human authority; AI/agent output is never approval.

## Acceptance Criteria

- AC-1 Approval requests are bound to specific Service Work/Attempt and policy.
- AC-2 Only authorized humans can approve.
- AC-3 Approval is durable and auditable.
- AC-4 An AI result does not equal approval.

## Verification Requirements

### Behavioral
- request/approve/reject/review lifecycle

### Structural
- approval authority exists only in ServiceOS for business decisions

### Discrimination / Mutation
- unauthorized approval fails

### Concurrency / Crash Safety
- simultaneous approval/rejection has deterministic terminal arbitration

## Definition Of Done

See TEMPLATE.md.
