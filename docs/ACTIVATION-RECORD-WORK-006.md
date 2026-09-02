# WORK-006 Activation Record

## Work Order

WORK-006 — Durable Event Inbox/Outbox

## Status

IN_FLIGHT

## Activation

Activated by the Architect on 2026-09-02.

- Activation issue: #58
- Implementation branch: `feat/WORK-006-event-inbox-outbox`
- Activation baseline: `23f6d604d9d43f32b89ab5781a28b74975465046`
- Assurance profile: `HIGH_ASSURANCE`
- Implementation authority: Z.ai
- Review / merge / finalization authority: Architect
- Pull request: pending
- Implementation revision: pending
- Merge commit: pending
- Architect verdict: pending

## Preconditions

- WORK-004 is complete.
- WORK-015 is complete.
- WORK-008 is complete and canonical finalization CI is green on merge commit `23f6d604d9d43f32b89ab5781a28b74975465046`.
- No other Work Order is in flight at activation.

## Authorized Surface

- event inbox/outbox
- durable event ingestion and dispatch
- worker dispatch
- callback ingestion
- idempotent event consumers
- provider-independent event contracts

## Mandatory Invariants

1. Inbound/outbound event processing is durable and idempotent.
2. Business modules do not call providers directly.
3. Duplicate inbound events converge.
4. Durable outbound intent is not silently lost before dispatch.
5. Event processing remains tenant-isolated where applicable.
6. Zeck callbacks use the same durable ingestion guarantees.
7. WORK-006 does not implement an AI execution engine or redefine vertical-specific event semantics.

## Forbidden Scope

No vertical-specific event meanings, no AI execution engine, no replacement of Zeck, no provider/model/agent ownership, no architecture change, and no unrelated business-module changes.

## Proof Requirement

Required proof classes: `static`, `dynamic`, `discrimination`, `concurrency`.

## Verification Requirements

- Behavioral: inbox/outbox lifecycle.
- Structural: no direct external calls from domain modules.
- Discrimination / Mutation: duplicate event regression.
- Concurrency / Crash Safety: two consumers of the same event do not produce duplicate domain effects; crash between intent and dispatch converges.

## Governance Rule

Only this Work Order may be in flight. Any architecture change requires a separate Architect decision and ADR before implementation. Zeck remains the sole AI execution authority.
