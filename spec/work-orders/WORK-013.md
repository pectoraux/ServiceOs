# WORK-013

Status: planned
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Run a governed end-to-end construction customer dogfooding/conformance journey and encode the resulting evidence into the persistent architecture/development frontier.

## Dependencies

Requires: WORK-010, WORK-012
Enables: future service expansion decisions

## Scope

Allowed:
- real customer-like construction journey
- evidence capture
- runtime/product observations
- governed follow-up Work Orders

Forbidden:
- silently fixing architecture during dogfooding
- ungoverned scope expansion

## Protected Surfaces

production topology, frontend/backend integration, dogfooding evidence, development-state follow-up artifacts

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- dogfooding observes the deployed ServiceOS authorities rather than bypassing them
- findings are evidence, not architectural authority
- future changes are introduced only through Work Orders/ACRs
- Zeck remains the sole AI execution authority during the journey

## Acceptance Criteria

- AC-1 The complete onboarding-to-compliance journey can be exercised on the real product topology.
- AC-2 Business outcomes are independently verified.
- AC-3 Findings are classified and persisted without rewriting historical evidence.
- AC-4 Future work is created through the existing Work Order authority.

## Verification Requirements

### Behavioral
- end-to-end construction workflow

### Structural
- dogfooding findings do not mutate architecture without ACR

### Discrimination / Mutation
- a claims-only completion is not accepted

### Concurrency / Crash Safety
- exercise duplicate event/retry scenarios in the real product path

## Definition Of Done

See TEMPLATE.md.
