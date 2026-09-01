# WORK-015

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE

## Objective

Implement the ServiceOS external-interaction authority and provider-neutral integration boundaries for business side effects and notifications.

## Context

ServiceOS must coordinate external systems without allowing provider SDKs to leak into domain authorities. Durable intent, authorization, idempotency and observed results form the business side-effect boundary.

## Dependencies

Requires: WORK-002, WORK-004
Enables: WORK-006, WORK-010, WORK-012

## Scope

Allowed:
- `/interactions`
- `/integrations`
- `/notifications`
- provider-neutral email/SMS/voice/business-system/payment interfaces
- durable interaction identity and result recording
- adapter contracts and test doubles

Forbidden:
- direct provider SDK usage from business modules
- external side effects before policy/authorization/durable intent
- AI execution infrastructure
- duplicating Zeck authority

## Protected Surfaces

/interactions, /integrations, /notifications, provider adapters, durable side-effect boundary

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- all business external effects pass through owned provider-neutral ports
- durable intent precedes side effect
- provider delivery status is not automatically business completion
- idempotency and observed-result semantics survive retries/crashes
- tenant scope is enforced before external effect admission

## Acceptance Criteria

- AC-1 An external interaction can be durably intended before dispatch.
- AC-2 Provider adapters are selected behind one provider-neutral contract per capability class.
- AC-3 Duplicate dispatch attempts converge on one logical interaction.
- AC-4 A provider success does not itself complete Service Work.
- AC-5 Notification delivery failures remain explicit failures and are recoverable.
- AC-6 Direct provider SDK imports from business modules are structurally rejected.

## Verification Requirements

### Behavioral
- send/observe lifecycle
- failure/retry
- provider adapter conformance

### Structural
- no provider SDKs in domain modules
- one interaction authority
- no direct side effect from workflow/vertical modules

### Discrimination / Mutation
- provider call before durable intent fails the structural/dynamic proof
- duplicate interaction mutation must be detected
- cross-tenant interaction is rejected before adapter invocation

### Concurrency / Crash Safety
- concurrent dispatch converges
- crash between durable intent and adapter call is recoverable without duplicate business effect

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-09-01.

- Branch: `feat/WORK-015-external-interactions`
- Base revision: `2100e572b23606cfd2ec7681d6d804ca30c2f914`
- Activation issue: `#29`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect

The activation decision was made from frozen v1.0 architecture and completed WORK-002 and WORK-004 state. No architecture change is authorized by this Work Order.
