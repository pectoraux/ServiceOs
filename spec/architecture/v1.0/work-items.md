# ServiceOS Work Items v1.0

Work Orders are implementation-program artifacts. Identity is immutable; planned Work Orders become executable only after Architect activation.

| Work Order | Title | Requires | Status |
|---|---|---|---|
| WORK-001 | ServiceOS Foundation | none | planned |
| WORK-002 | Identity & Tenancy | WORK-001 | planned |
| WORK-003 | Service Work Domain & Durable Attempts | WORK-001 | planned |
| WORK-014 | Business Policy Authority | WORK-002, WORK-003 | planned |
| WORK-004 | Deterministic Business Workflow Authority | WORK-003, WORK-014 | planned |
| WORK-015 | External Interaction & Integration Authority | WORK-002, WORK-004 | planned |
| WORK-005 | Zeck Integration Boundary | WORK-004 | planned |
| WORK-007 | Business Evidence & Outcome Verification | WORK-004 | planned |
| WORK-008 | Human Business Approval Authority | WORK-004, WORK-014 | planned |
| WORK-009 | Service & Vertical Definition Runtime | WORK-003 | planned |
| WORK-006 | External Event Inbox & Outbox | WORK-004, WORK-015 | planned |
| WORK-010 | Construction Subcontractor Compliance Service | WORK-005, WORK-006, WORK-007, WORK-009, WORK-014, WORK-015 | planned |
| WORK-011 | Billing & Service Economics | WORK-001 | planned |
| WORK-012 | Service Control-Plane API & UX | WORK-005, WORK-007, WORK-009, WORK-014, WORK-015 | planned |
| WORK-013 | Construction Dogfooding & Outcome Validation | WORK-010, WORK-012 | planned |

The roadmap/dependency-state files are the machine-readable dependency authority; this table is the human-readable catalog.
