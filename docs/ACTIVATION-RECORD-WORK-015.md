# WORK-015 Activation Record

## Work Order

WORK-015 — External Interaction & Integration Authority

## Status

IN_FLIGHT

## Activation

Activated by the Architect on 2026-09-01.

- Activation issue: #29
- Implementation branch: `feat/WORK-015-external-interactions`
- Activation baseline: `2100e572b23606cfd2ec7681d6d804ca30c2f914`
- Assurance profile: `HIGH_ASSURANCE`
- Implementation authority: Z.ai
- Review / merge / finalization authority: Architect

## Preconditions

- WORK-002 is complete.
- WORK-004 is complete.
- No other Work Order is in flight.

## Authorized Surface

- `/interactions`
- `/integrations`
- `/notifications`
- provider-neutral external-effect ports
- durable interaction identity and observed-result recording
- provider adapter contracts and test doubles

## Mandatory Invariants

1. Durable external intent precedes side effect admission.
2. Provider implementations remain behind provider-neutral capability contracts.
3. Duplicate dispatch attempts converge on one logical interaction.
4. Provider delivery success does not itself complete Service Work.
5. Notification failures remain explicit and recoverable.
6. Tenant authorization is established before adapter invocation.
7. Provider SDK imports are forbidden from business/domain modules.
8. AI execution infrastructure remains outside ServiceOS; Zeck remains the AI execution authority.

## Proof Requirement

The delivery must provide `static`, `dynamic`, `discrimination`, and `concurrency` proofs, including live PostgreSQL/crash-safety evidence where required by the Work Order.

## Forbidden Scope

No direct provider SDK usage from business modules, no external side effect before durable intent and authorization, no AI execution infrastructure, no duplicate Zeck authority, and no unrelated vertical business logic.

## Governance Rule

No architecture change is authorized by this activation. Any change to the frozen v1.0 architecture requires a separate Architect decision and ADR before implementation.