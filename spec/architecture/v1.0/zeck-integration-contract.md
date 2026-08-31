# ServiceOS ↔ Zeck Integration Contract v1.0

This document makes the external boundary implementable without importing Zeck internals.

## 1. Ownership

- Zeck owns AI execution identity, planning, dispatch, providers, models, agents, tools, context, AI verification, AI runtime state and AI usage/cost.
- ServiceOS owns the business objective, business policy constraints, Service Work/Attempt state, business evidence and the business outcome decision.

## 2. ServiceOS request

ServiceOS submits an `AIExecutionIntent` containing, at minimum:

- `tenantId`
- `serviceWorkId`
- `workAttemptId`
- `intentId` (globally unique ServiceOS identity)
- `idempotencyKey`
- `objective`
- `inputArtifactRefs` / business-context references
- `requiredCapabilities` (capability requirements only; never model/provider selection)
- authoritative business constraints Zeck must honor
- result contract / output schema expected by ServiceOS
- correlation metadata sufficient to bind the result back to the attempt

ServiceOS does **not** send model/provider choices as architectural requirements. Zeck decides the AI execution plan within its own authority.

## 3. Zeck response

The integration boundary accepts a Zeck execution reference containing the Zeck-owned execution identity and correlation information required to observe the execution.

ServiceOS may persist:

- `zeckExecutionId`
- ServiceOS `intentId`
- ServiceOS `idempotencyKey`
- `serviceWorkId`
- `workAttemptId`
- Zeck connection/reference metadata
- ingestion metadata such as `lastSeenEventId` / `lastSeenAt`

ServiceOS must **not** persist a second authoritative Zeck execution state machine.

## 4. Result handling

A Zeck result is an observation/input to ServiceOS.

The ServiceOS business pipeline is:

```text
Zeck result / artifact / evidence
          ↓
business interpretation
          ↓
business evidence requirements
          ↓
ServiceOS business verification
          ↓
workflow transition
```

The following are distinct facts:

1. Zeck transport succeeded.
2. Zeck execution completed.
3. Zeck's own verification succeeded.
4. ServiceOS business outcome was independently established.
5. Service Work was transitioned to `COMPLETED`.

A higher-numbered fact cannot be inferred solely from a lower-numbered fact.

## 5. Idempotency

ServiceOS must use a stable `idempotencyKey` for one logical AI intent.

Retries must first consult the durable ServiceOS correlation record. If an existing Zeck execution is already associated with the same logical intent, the connector must converge on that identity rather than create a duplicate request, subject to Zeck's supported idempotency contract.

A callback/event is accepted at most once as a state-changing domain input. Duplicate callback delivery must not duplicate business effects.

## 6. Webhooks/events

Zeck callbacks enter the generic durable inbound-event boundary. The `/zeck` module translates external payloads into ServiceOS-owned observations; it does not decide business state.

Unknown event types, malformed payloads, missing tenant/work correlation, replayed event identities and conflicting correlation identities fail closed with typed errors and durable evidence.

## 7. Unavailable Zeck

If Zeck is unavailable, ServiceOS must preserve the Service Work state truthfully. It may place the Work Attempt into a business-defined waiting/retry path through the workflow authority; it must not fabricate success or silently create a local substitute AI engine.

## 8. Features intentionally outside Zeck

The following are not delegated because they are ServiceOS business authority:

- deciding whether a contractual/compliance/business condition has been satisfied
- determining legal Service Work transitions
- deciding whether a customer/business approval exists
- enforcing tenant authorization
- applying deterministic domain thresholds/rules
- deciding whether an external business side effect is permitted
- deciding when missing/contradictory evidence makes a business outcome incomplete
- metering/billing the customer for the business service

AI may assist these processes through Zeck, but the final business authority remains in ServiceOS.
