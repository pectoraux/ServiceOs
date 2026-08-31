# ServiceOS Work Order Dependency Graph

```text
WORK-001 Foundation
   ├──> WORK-002 Identity & Tenancy
   ├──> WORK-003 Service Work Domain
   │       ├──> WORK-004 Business Workflow Authority
   │       │       ├──> WORK-005 Zeck Integration Boundary
   │       │       ├──> WORK-006 External Event & Outbox Substrate
   │       │       ├──> WORK-007 Evidence & Outcome Verification
   │       │       └──> WORK-008 Human Business Approvals
   │       └──> WORK-009 Service / Vertical Definition Runtime
   │               └──> WORK-010 Construction Subcontractor Compliance
   └──> WORK-011 Billing & Service Economics

WORK-005 + WORK-007 + WORK-009
   └──> WORK-012 Service Control-Plane UX/API

WORK-010 + WORK-012
   └──> WORK-013 Construction Dogfooding & Outcome Validation
```

No future Work Order may depend on a later Work Order. The machine-readable dependency state is authoritative.
