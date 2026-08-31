# ServiceOS Vertical Model

## Goal

One horizontal ServiceOS runtime should support many industries without embedding industry-specific logic in horizontal authorities.

## Vertical package contract

A vertical package contains:

```text
VerticalPackage
├── metadata
├── terminology
├── entity definitions
├── work definitions
├── workflow definitions
├── deterministic business rules
├── policy defaults
├── approval matrix
├── evidence requirements
├── outcome contracts
├── integration bindings
├── Zeck capability requirements
└── pricing/metering rules
```

## Horizontal/vertical boundary

### Horizontal

- tenanting
- Service Work identity
- state machine
- work attempts
- durable events
- idempotency
- approvals
- generic evidence containers
- Zeck adapter
- external integration ports
- billing/metering primitives
- audit

### Vertical

- industry entities
- industry vocabulary
- service workflows
- business rules
- industry evidence requirements
- domain outcome definitions
- domain integration mappings
- domain pricing packages

### Customer configuration

Customer configuration can specialize a vertical package's parameters, but cannot weaken horizontal authority invariants or create a new state machine.

## Construction v1

```text
Vertical: Construction
Service: Subcontractor Compliance

Entities:
  Project
  Subcontractor
  Contract
  InsuranceCertificate
  License
  ComplianceRequirement

Work:
  OnboardSubcontractor
  CollectComplianceDocument
  ValidateInsurance
  ValidateLicense
  ChaseMissingDocument
  EscalateException
  AssembleCompliancePackage
```
