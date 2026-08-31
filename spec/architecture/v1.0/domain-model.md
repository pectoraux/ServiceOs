# ServiceOS Domain Model

## Organization and tenant

```text
Organization
  ├── Members
  ├── ServiceTenants
  └── Subscriptions
```

A `ServiceTenant` is the isolated customer-domain boundary used by business records.

## Service and vertical

```text
VerticalPackage
  └── ServiceDefinition
        ├── EntityDefinitions
        ├── WorkDefinitions
        ├── WorkflowDefinition
        ├── BusinessPolicies
        ├── SLA defaults
        ├── Approval rules
        ├── OutputContract
        └── Pricing/Metering
```

## Runtime work

```text
ServiceWork
  ├── WorkDependencies
  ├── WorkAttempts
  │     ├── DeterministicActions
  │     ├── ExternalInteractions
  │     ├── ApprovalRequests
  │     ├── AIExecutionIntents -> ZeckExecutionReference
  │     ├── BusinessEvidence
  │     └── OutcomeVerification
  └── BusinessOutcome
```

## Identity rule

Every durable business object has:

- globally unique identity within its type
- tenant identity
- created/updated timestamps
- actor provenance
- idempotency identity for externally-triggered creation where applicable

## State rule

Service Work state is owned by the workflow authority. Attempt and Zeck execution records cannot directly mutate Service Work state outside the workflow transition boundary.
