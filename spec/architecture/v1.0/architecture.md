# ServiceOS Architecture

**Version:** v1.0
**Status:** FROZEN FOR IMPLEMENTATION
**Purpose:** Define the architectural structure and authority boundaries of ServiceOS.

---

# 1. Purpose

ServiceOS is a provider-independent business-service execution platform.

A customer service package defines recurring business work. ServiceOS receives business events and information, creates and manages Service Work, evaluates deterministic business policies, coordinates external parties and humans, requests AI execution from Zeck where appropriate, validates business outcomes, and records the authoritative business state and evidence.

ServiceOS is **not** an AI execution platform. AI execution is delegated to Zeck (`pectoraux/Zeck`).

---

# 2. Architectural principles

## 2.1 Business Work is the primary ServiceOS abstraction

The stable customer-domain primitive is `ServiceWork`, representing a business job with an objective, state, inputs, policy, deadlines, outputs, evidence and outcome.

## 2.2 Separate business-work authority from AI-execution authority

ServiceOS owns Service Work state and business workflow transitions.

Zeck owns AI Execution state and AI execution planning/dispatch/verification.

The two state machines are related through explicit external execution references but are never collapsed into one state machine.

## 2.3 Zeck is the sole AI execution authority

All AI execution capabilities are externalized to Zeck, including:

- model/provider selection
- model calls
- AI agent execution
- AI tool execution
- AI execution planning/routing
- AI context compilation
- AI provider federation
- AI sandbox/runtime selection
- AI execution verification
- AI execution learning/telemetry

ServiceOS must not implement a competing AI authority.

## 2.4 Business-domain authority remains in ServiceOS

ServiceOS owns deterministic business rules, business policy, customer configuration, business workflow state, business approvals, service definitions, business outcomes, and domain-specific verification required to establish those outcomes.

A Zeck result is an input to ServiceOS; it is not by itself a business-state transition.

## 2.5 Evidence over claims

An AI/agent claim that work is complete is not sufficient. ServiceOS must map business outcomes to attributable evidence.

## 2.6 Policy before business side effects

ServiceOS business mutations and external business side effects must pass the applicable business policy and authorization gates before they occur.

AI policy is evaluated by Zeck. ServiceOS supplies the authoritative customer/business constraints that Zeck must honor.

## 2.7 Deterministic computation is first-class

ServiceOS may perform deterministic parsing, validation, calculations, state transitions and business-rule evaluation directly. It should not invoke AI where deterministic computation is sufficient.

## 2.8 Human authority is first-class

Customer/business approvals are ServiceOS authority. Zeck's optional human-escalation capability is subordinate to the business workflow; it does not own Service Work transitions.

## 2.9 External systems are adapters

Email, SMS, telephony, ERP, accounting, CRM, property-management, construction-management, government portals, payment providers and Zeck are accessed through provider-independent ServiceOS ports.

## 2.10 Durable state is authoritative

PostgreSQL is the ServiceOS system of record for ServiceOS business state.

Zeck is authoritative for AI execution state and AI execution evidence.

External systems remain authoritative for records they own unless ServiceOS is explicitly the source of truth for a derived business record.

## 2.11 No second authority

A module may consume an existing authority through its public interface but must not silently recreate its state machine, datastore, policy engine, evidence authority or execution engine.

## 2.12 Architecture is immutable once frozen

Architecture changes require an Architecture Change Request and a new immutable architecture version.

---

# 3. System context

```text
                         CUSTOMER / OPERATOR
                                  |
                                  v
                          ServiceOS Experience
                                  |
                                  v
                         ServiceOS Control Plane
                                  |
          +-----------------------+-----------------------+
          |                       |                       |
          v                       v                       v
   Business Work            Business Policy        Service Catalog
   + Workflow                + Approval             + Verticals
          |                       |                       |
          +-----------------------+-----------------------+
                                  |
                         AI Execution Intent
                                  |
                                  v
                     +---------------------------+
                     |           Zeck            |
                     | AI Execution Authority    |
                     +-------------+-------------+
                                   |
                    Models / Agents / Tools / AI
                    Planning / Context / Verify
                                   |
                                   v
                           Result + Evidence
                                   |
                                   v
                              ServiceOS
                                   |
                    Business Outcome Verification
                                   |
                                   v
                          Completed Service Work
```

---

# 4. High-level layers

1. **Experience** — web/mobile/API/operator surfaces.
2. **Control** — identity, organizations, tenants, customer configuration, permissions.
3. **Business Work** — Service Work, business workflow state, deadlines, dependencies, SLAs.
4. **Service Definition** — service packages, verticals, workflow definitions, business policies, templates and capability requirements.
5. **External Action** — provider-neutral email, messaging, telephony, business-system and payment ports.
6. **Zeck Adapter** — thin integration boundary for AI execution intents, execution references, results, evidence and webhooks.
7. **Business Evidence** — domain evidence and outcome verification owned by ServiceOS.
8. **Economic** — customer subscriptions, metering, outcome accounting and service billing.
9. **Security/Governance** — tenancy, authorization, audit, idempotency, approvals and architecture governance.

ServiceOS has no internal AI Intelligence/Model/Agent/Context/Sandbox layer.

---

# 5. Core domain objects

- Organization
- User
- ServiceTenant
- ServiceDefinition
- VerticalPackage
- Entity
- BusinessPolicy
- ServiceWork
- WorkStateTransition
- WorkAttempt
- WorkDependency
- SLA
- ApprovalRequest
- ExternalParty
- ExternalInteraction
- AIExecutionIntent
- ZeckExecutionReference
- BusinessEvidence
- BusinessOutcome
- OutcomeVerification
- ServiceSubscription
- UsageRecord
- ServiceLedgerEntry
- AuditEvent

`AIExecutionIntent` is a ServiceOS request for AI execution; `ZeckExecutionReference` links the business work to Zeck. The AI execution itself is not a ServiceOS-owned object.

---

# 6. Module boundaries

The initial modular-monolith modules are:

| Module | Responsibility |
|---|---|
| `/auth` | ServiceOS human and machine identity integration |
| `/organizations` | organizations, tenants, memberships and roles |
| `/services` | service definitions and service-package lifecycle |
| `/verticals` | vertical package registration and domain configuration |
| `/entities` | customer/business entities used by service workflows |
| `/work` | Service Work identity, lifecycle, dependencies, attempts and outcomes |
| `/workflow` | deterministic business workflow state machine and transitions |
| `/policies` | business-policy resolution and enforcement |
| `/approvals` | business/human approval requests and decisions |
| `/interactions` | external communications and provider-neutral interaction ledger |
| `/zeck` | thin Zeck integration boundary; no AI implementation |
| `/evidence` | ServiceOS business evidence and outcome-verification records |
| `/billing` | customer subscriptions, metering and service economics |
| `/audit` | append-only privileged ServiceOS event trail |
| `/integrations` | provider-neutral external business-system ports/adapters |
| `/notifications` | ServiceOS notifications and delivery adapters |

The modules are business-domain modules, not AI modules.

Cross-module calls use public interfaces. Internal implementation imports are forbidden.

---

# 7. Service Work lifecycle

The canonical ServiceOS business workflow state machine is:

```text
DRAFT
  -> READY
  -> ACCEPTED
  -> IN_PROGRESS
       |-> WAITING_INFORMATION -> IN_PROGRESS
       |-> WAITING_APPROVAL -> IN_PROGRESS
       |-> BLOCKED -> IN_PROGRESS
  -> VERIFYING
       |-> IN_PROGRESS (correction/rework)
  -> COMPLETED

Alternative terminal states:
CANCELLED
FAILED
EXPIRED
```

The workflow engine owns these business transitions.

Zeck execution states are never copied into this state machine.

---

# 8. Work Attempts

A `WorkAttempt` is a durable unit of effort within Service Work.

An attempt may contain:

- deterministic actions
- external interactions
- human approvals
- one or more Zeck execution references
- business evidence
- outcome verification

An attempt is not synonymous with a Zeck Execution.

Retries are idempotent by durable identity and external-side-effect protocol.

---

# 9. Business workflow engine

The workflow engine is deterministic.

It is responsible for:

- validating legal Service Work transitions
- evaluating transition preconditions
- enforcing business SLAs
- scheduling explicit workflow continuation
- admitting business-side effects
- creating approval requests
- dispatching work attempts
- requesting Zeck execution where a service step requires AI
- consuming Zeck results
- entering business verification
- completing or reworking Service Work

It does not plan AI execution internally.

---

# 10. Zeck integration boundary

The `/zeck` module provides a provider-independent application boundary to Zeck.

ServiceOS may send an AI Execution Intent containing:

- service work identity
- task objective
- authoritative business context references
- required output contract
- business constraints
- privacy/data-handling constraints
- allowed AI capabilities
- requested quality/latency bounds
- callback/idempotency identity

Zeck returns an execution reference and later provides execution outcome, artifacts/evidence references, provenance, cost, latency and warnings according to the Zeck contract.

ServiceOS persists only the business-side linkage and the minimum business evidence/reference needed for its own authority. The authoritative AI Execution record remains in Zeck.

---

# 11. Zeck prohibition matrix

ServiceOS MUST NOT implement or persist as an authoritative ServiceOS subsystem:

- model registry
- model routing
- provider adapter registry for AI providers
- prompt execution runtime
- AI agent runtime
- AI tool registry/runtime
- AI context compiler
- AI execution planner
- AI sandbox selection/runtime
- AI model-learning/routing engine
- AI execution quality evaluator where the authoritative result is an AI execution concern
- AI provider credentials

A ServiceOS feature that appears to require any of the above is a candidate for Zeck integration, not ServiceOS implementation.

---

# 12. Business-domain verification

ServiceOS may verify outcomes using deterministic rules, domain data, external authoritative records, customer approvals, calculations and other business-specific evidence.

Examples:

- “vendor coverage meets project requirement”
- “invoice was actually paid”
- “permit submission was accepted by the portal”
- “service work was approved by the customer”

If an AI model evaluates evidence as part of an AI execution, Zeck owns that AI execution. ServiceOS owns the final business-state decision when the customer domain requires it.

---

# 13. External side effects

External side effects include:

- sending messages
- creating records in customer systems
- updating accounting systems
- submitting government forms
- placing orders
- initiating payments

Every external side effect requires:

1. durable intent
2. authorization/policy decision
3. idempotency identity
4. provider-neutral adapter
5. observed result
6. business evidence where the result affects Service Work

Zeck is used for AI reasoning/execution inside a step, not as a substitute for ServiceOS business authorization.

---

# 14. Events and asynchronous processing

Inbound events follow:

```text
Provider/Event Source
      ↓
Ingress Validation
      ↓
Durable Inbox
      ↓
Idempotent Event Processing
      ↓
Service Work / Workflow Engine
```

Outbound callbacks follow a durable outbox pattern.

Zeck webhook events are treated as external events and deduplicated by stable identity.

---

# 15. Service definitions and verticals

A service definition declares:

- service identity/version
- vertical package
- entities required
- work types
- workflow definitions
- business policies
- SLA defaults
- approval rules
- required external capabilities
- required Zeck AI capabilities, where applicable
- output schema
- business outcome contract
- pricing/metering rules

Vertical packages provide domain meaning; the horizontal runtime executes the same core primitives.

---

# 16. First vertical: construction

The first commercial vertical is Construction.

Initial service:

**Subcontractor Compliance Service**

Core work types include:

- subcontractor onboarding
- document collection
- insurance certificate validation
- license validation
- follow-up/chasing
- exception escalation
- compliance package assembly

Planned adjacent services:

- RFI administration
- submittal administration
- pay-application administration
- change-order administration
- project closeout administration

Construction business semantics remain in the vertical package, not the horizontal core.

---

# 17. Billing and economics

ServiceOS tracks service-level economics, not AI provider economics directly.

Customer billing may be based on:

- subscription
- work volume
- completed work item
- usage band
- successful outcome
- hybrid pricing

Zeck remains authoritative for AI usage/cost details. ServiceOS may consume cost data for customer-facing service economics and margin accounting.

---

# 18. Observability and audit

Every Service Work mutation and external business side effect is auditable.

Audit records include actor, timestamp, tenant, action, target, correlation/idempotency identity and result.

ServiceOS must distinguish:

- requested
- attempted
- observed
- verified
- completed

A Zeck execution success is not automatically a ServiceOS business success.

---

# 19. Security and tenancy

Authorization is enforced server-side before domain data access or mutation.

Tenant boundaries apply to every customer-domain row and every business operation.

Zeck credentials/connections are not owned as ServiceOS secrets; ServiceOS references the configured Zeck connection through the integration boundary.

---

# 20. Runtime architecture

Initial runtime is a TypeScript modular monolith with background workers, PostgreSQL as authoritative ServiceOS persistence, and an external Zeck dependency.

The architecture permits later extraction into services without changing domain authorities.

---

# 21. Architecture evolution

The architecture is immutable once frozen. Architecture Change Requests create new architecture versions. Historical architecture versions and Work Orders remain immutable records.
