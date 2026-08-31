# WORK-005

Status: planned
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL

## Objective

Implement the thin ServiceOS-to-Zeck integration boundary for AI execution requests and results.

## Dependencies

Requires: WORK-004
Enables: WORK-010, WORK-012

## Scope

Allowed:
- /zeck integration module
- ServiceOS AIExecutionIntent contract
- Zeck execution reference persistence
- Zeck webhook/callback translation
- retry/idempotency handling

Forbidden:
- model/provider selection
- LLM provider SDKs
- AI agent runtime
- AI tools/context/planning/verification/learning
- shadow Zeck execution database

## Protected Surfaces

/zeck, Zeck integration contracts, execution-reference persistence, callback ingress

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- /zeck contains no AI implementation; no shadow Zeck lifecycle; no provider/model selection.

## Acceptance Criteria

- AC-1 ServiceOS can submit an AI Execution Intent through one provider-neutral Zeck port.
- AC-2 Zeck execution identity is correlated to Service Work/Attempt by durable idempotency identity.
- AC-3 Zeck lifecycle is not reimplemented in ServiceOS.
- AC-4 AI provider credentials are absent from ServiceOS domain modules.
- AC-5 Zeck results can be consumed without treating transport success as business success.
- AC-6 Duplicate requests converge on one Zeck execution reference when the Zeck contract permits idempotency.

## Verification Requirements

### Behavioral
- request, callback/result, retry

### Structural
- no LLM/model/provider/agent/tool/context/planning modules
- no direct Zeck provider-specific SDK in business modules

### Discrimination / Mutation
- a planted model-router import must fail architecture checks
- a Zeck success without business verification must not complete Service Work

### Concurrency / Crash Safety
- concurrent request attempts use one deterministic idempotency key and converge
- callback replay is idempotent

## Definition Of Done

See TEMPLATE.md.
