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

The activation decision was made from the frozen v1.0 architecture and completed WORK-003 state. No architecture change is authorized by this Work Order.

## Implementation Status

Activated and ready for implementation. Z.ai must implement only the scope above and return a PR with the four required proof classes.
