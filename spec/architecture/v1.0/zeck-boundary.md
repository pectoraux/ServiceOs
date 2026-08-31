# ServiceOS ↔ Zeck Boundary

## Purpose

Define the exact ownership boundary between the ServiceOS business-work platform and the Zeck AI Execution OS.

## ServiceOS owns

- customer/tenant identity and authorization
- business entities and customer records
- Service Work identity and lifecycle
- business workflow state transitions
- business policies and approval thresholds
- business-side external effects
- business evidence and business outcome verification
- service definitions and vertical package semantics
- service SLAs and customer-facing service economics
- audit of ServiceOS-owned decisions and effects

## Zeck owns

- AI execution identity
- AI execution planning
- model/provider selection
- AI agent execution
- AI tool execution
- AI context compilation
- AI sandbox/runtime selection
- AI execution verification
- AI execution learning and provider/tool telemetry
- AI provider credentials/connections
- AI execution cost/usage authority

## Boundary protocol

```text
ServiceOS
  create AIExecutionIntent
          |
          v
      Zeck API
          |
          v
     Zeck Execution
          |
          +---- models / agents / tools / context / verification
          |
          v
     result + artifacts + evidence + provenance
          |
          v
ServiceOS business verification
          |
          v
Service Work transition
```

## ServiceOS must not

- call an LLM provider directly
- select a model
- route between AI providers
- construct an internal AI agent runtime
- execute AI tools itself
- create an internal AI execution plan
- copy Zeck execution state into a ServiceOS state machine
- treat Zeck quality/verification as automatic business acceptance

## ServiceOS may retain

A minimal business-side linkage:

```text
AIExecutionIntent
├── id
├── serviceWorkId
├── attemptId
├── zeckApplicationRef
├── zeckExecutionRef
├── requestedOutputContract
├── businessConstraintsHash
├── idempotencyKey
└── createdAt
```

The `zeckExecutionRef` is a foreign-system identity, not a ServiceOS execution identity.

## AI features that do NOT move to Zeck

The following are deliberately **not AI features** and therefore remain in ServiceOS when needed:

- deterministic business-rule evaluation
- customer authorization
- approval thresholds
- contractual/business policy enforcement
- business workflow transitions
- SLA timers/deadlines
- reconciliation against authoritative business records
- business-side payment authorization
- final business outcome acceptance
- tenant isolation
- business audit

A future feature should be evaluated with the rule:

> If removing the AI/model/provider would leave a necessary customer-domain authority, it belongs in ServiceOS. If it is about how AI computes, routes, reasons, uses tools or executes, it belongs in Zeck.
