# WORK-011 Activation Record

## Work Order

WORK-011 — Billing & Service Economics

## Status

IN_FLIGHT

## Activation

Activated by the Architect on 2026-09-02.

- Activation issue: #33
- Implementation branch: `feat/WORK-011-billing-economics`
- Activation baseline: `70c07665809fc973b834126857ece9262fc74d1c`
- Assurance profile: `HIGH_ASSURANCE`
- Implementation authority: Z.ai
- Review / merge / finalization authority: Architect

## Preconditions

- WORK-001 is complete.
- WORK-009 is complete and canonical state has been reconciled.
- No other Work Order is in flight.

## Authorized Surface

- `/billing`
- service subscriptions
- service usage records
- work-based metering
- outcome-linked service billing
- margin reporting inputs

## Mandatory Invariants

1. ServiceOS owns customer service economics; Zeck remains authoritative for AI usage/cost.
2. Service billing and metering must not create a provider-level AI usage/cost authority.
3. Zeck cost references may be consumed for service margin analysis, but ServiceOS must not persist an authoritative replacement for Zeck's AI cost ledger.
4. Duplicate billable work must not double-charge.
5. Concurrent settlement must converge on one authoritative service billing outcome.

## Proof Requirement

The delivery must provide `static`, `dynamic`, `discrimination`, and `concurrency` proofs for billing/metering authority, idempotency, duplicate-charge prevention, and concurrent settlement.

## Forbidden Scope

No provider-level AI usage ledger, no replacement for Zeck's AI economic authority, no model/provider cost authority in ServiceOS, and no changes to frozen v1.0 architecture.

## Governance Rule

No architecture change is authorized by this activation. Any change to the frozen v1.0 architecture requires a separate Architect decision and ADR before implementation.
