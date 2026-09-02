# WORK-005 Activation Record

## Work Order

WORK-005 — Zeck Integration Boundary

## Status

IN_FLIGHT

## Activation

Activated by the Architect on 2026-09-02.

- Activation issue: #36
- Implementation branch: `feat/WORK-005-zeck-integration`
- Activation baseline: `bd11baa497574e576db57c0bc8d6035bb91eec6d`
- Assurance profile: `CRITICAL`
- Implementation authority: Z.ai
- Review / merge / finalization authority: Architect

## Preconditions

- WORK-004 is complete.
- WORK-011 is complete and canonical state has been reconciled.
- No other Work Order is in flight.

## Authorized Surface

- `/zeck`
- ServiceOS AIExecutionIntent contract
- Zeck execution-reference persistence
- Zeck webhook/callback translation
- retry/idempotency handling

## Mandatory Invariants

1. `/zeck` contains no AI implementation; no shadow Zeck lifecycle; no provider/model selection.
2. ServiceOS exposes one provider-neutral Zeck port for AI execution intents.
3. Zeck execution identity is correlated durably to Service Work/Attempt.
4. Zeck transport/lifecycle status is never redefined as business outcome success.
5. AI provider credentials and provider-specific SDKs remain outside ServiceOS domain modules.
6. Duplicate requests converge on one Zeck execution reference where the Zeck contract permits idempotency.

## Forbidden Scope

No model/provider selection, LLM provider SDKs, AI agent runtime, AI tools/context/planning/verification/learning, or shadow Zeck execution database. No frozen v1.0 architecture change.

## Proof Requirement

The delivery must provide `static`, `dynamic`, `discrimination`, and `concurrency` proofs for execution-intent boundaries, callback/retry behavior, idempotency, and the separation between Zeck transport success and business success.

## Governance Rule

No architecture change is authorized by this activation. Any change to the frozen v1.0 architecture requires a separate Architect decision and ADR before implementation.
