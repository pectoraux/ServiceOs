# ServiceOS Implementation Handoff Contract

This document is the shortest operational handoff for a Z.ai implementation worker.

## 1. Determine authority

Classify every requested capability before coding:

```text
Customer/business state or decision?
    -> ServiceOS authority

AI reasoning/execution capability?
    -> Zeck authority

Canonical record owned by an external system?
    -> External-system authority via ServiceOS adapter
```

When ambiguous, stop and return the decision to the Architect. Do not create a new authority to resolve ambiguity.

## 2. Determine the Work Order

The worker must identify exactly one activated Work Order:

- `spec/work-orders/WORK-NNN.md`
- status `in_flight`
- exact dependency list
- exact branch
- exact governed base revision
- allowed/forbidden/protected surfaces
- required assurance/proof classes

No activated Work Order means no implementation is authorized.

## 3. Determine existing authorities

Before creating a service, repository, engine, table, state machine or adapter, search for an existing authoritative public interface. Consume it instead of creating a second authority.

## 4. Durable state rule

For any mutation that can be retried or replayed, identify:

```text
logical identity
+ idempotency identity
+ durable intent
+ authorization/policy decision
+ observed external result
+ evidence
```

Do not infer success from a transport response.

## 5. Zeck rule

When a step needs AI:

```text
ServiceOS business context/policy
        |
        v
AIExecutionIntent
        |
        v
      Zeck
        |
        v
execution reference/result/evidence
        |
        v
ServiceOS business verification
        |
        v
Service Work transition
```

ServiceOS never selects a model/provider, runs an AI agent/tool, compiles AI context, or owns the AI execution lifecycle.

## 6. Evidence rule

For each acceptance criterion, record:

- what was observed;
- exact revision;
- test/check/proof that establishes it;
- any limitations.

Agent claims and PR descriptions are evidence sources, not authority.

## 7. Stop conditions

Return control to the Architect if implementation would require:

- a frozen architecture change;
- a new horizontal authority;
- a new AI authority in ServiceOS;
- weakening a lock invariant;
- an unplanned protected surface;
- an incomplete dependency;
- a security/tenant boundary exception;
- an external-side-effect protocol not covered by the Work Order.

## 8. Completion

The worker opens/updates exactly one PR for the Work Order. The Architect alone determines approval, merge and post-merge finalization.
