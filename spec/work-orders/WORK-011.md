# WORK-011

Status: planned
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE

## Objective

Implement service-level billing, metering and unit-economics primitives without duplicating Zeck's AI usage ledger.

## Dependencies

Requires: WORK-001
Enables: WORK-013

## Scope

Allowed:
- service subscriptions
- service usage records
- work-based metering
- outcome-linked service billing
- margin reporting inputs

Forbidden:
- provider-level AI usage authority
- replacing Zeck's AI economic ledger

## Protected Surfaces

/billing, service metering, subscription/work/outcome billing ledger

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- ServiceOS owns customer service economics; Zeck remains authoritative for AI usage/cost.

## Acceptance Criteria

- AC-1 Service work can be metered.
- AC-2 Customer pricing can be subscription, work-based or hybrid.
- AC-3 Zeck cost references can be consumed for service margin analysis without becoming ServiceOS AI cost authority.

## Verification Requirements

### Behavioral
- usage and billing records

### Structural
- no provider-specific AI cost authority

### Discrimination / Mutation
- duplicate billable work cannot double-charge

### Concurrency / Crash Safety
- concurrent settlement converges on one ledger outcome

## Definition Of Done

See TEMPLATE.md.
