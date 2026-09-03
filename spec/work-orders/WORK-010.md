# WORK-010

Status: complete
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL
Activation Issue: #61
Implementation Branch: `feat/WORK-010-construction-compliance`
Activation Baseline: `0ef7148900572be30fc88af590e16633911aec61`
Implementation Revision: `372e1a18be7a19b1f887a3d9b4022644cf31562f`
Pull Request: #62
Merge Commit: `dc5be9aa676eb4a92264b64f3428abfa5231ce44`
Architect Verdict: approved

## Objective

Implement the first commercial service: Construction Subcontractor Compliance.

## Dependencies

Requires: WORK-005, WORK-006, WORK-007, WORK-009, WORK-014, WORK-015
Enables: WORK-013

## Scope

Allowed:
- Construction vertical package
- subcontractor/vendor entities
- compliance requirements
- document collection workflow
- insurance certificate validation
- license validation
- automated follow-up
- exception escalation
- compliance package output
- Zeck-backed document reasoning only through WORK-005

Forbidden:
- AI provider/model code
- generic workflow engine replacement
- direct email/SMS/provider SDKs from domain modules
- changing Service Work lifecycle

## Protected Surfaces

construction vertical, compliance entities/work types, integrations via public ports, Zeck boundary consumption

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Construction logic consumes horizontal authorities and Zeck through public contracts; it owns no replacement engines.

## Acceptance Criteria

- AC-1 A subcontractor can be onboarded into a project.
- AC-2 Required compliance documents can be requested, received and tracked.
- AC-3 Insurance certificates are checked against project requirements using deterministic business rules and/or Zeck AI execution where document understanding is needed.
- AC-4 Missing/expired/noncompliant evidence creates governed follow-up work.
- AC-5 Automated follow-up uses durable interaction identity and is replay-safe.
- AC-6 Final compliance status is based on ServiceOS business verification, not merely an AI claim.
- AC-7 The service produces an auditable compliance package.

## Verification Requirements

### Behavioral
- happy path onboarding to compliant
- missing document
- expired insurance
- noncompliant limits
- vendor correction/retry

### Structural
- vertical package uses horizontal authorities
- AI functionality flows only through Zeck

### Discrimination / Mutation
- direct provider SDK import must fail
- fabricated AI success cannot mark compliant
- stale vendor attempt cannot overwrite a newer compliance decision

### Concurrency / Crash Safety
- duplicate document callbacks converge
- concurrent follow-up workers do not double-contact the vendor
- duplicate Zeck requests converge by idempotency key

## Definition Of Done

See TEMPLATE.md.

## Finalization Record

Activated by Architect on 2026-09-02.

- Activation issue: `#61`
- Activation baseline: `0ef7148900572be30fc88af590e16633911aec61`
- Assurance profile: `CRITICAL`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect
- Pull request: `#62`
- Implementation revision: `372e1a18be7a19b1f887a3d9b4022644cf31562f`
- Merge commit: `dc5be9aa676eb4a92264b64f3428abfa5231ce44`
- Merge time: 2026-09-03T04:25:22Z
- Final Architect verdict: APPROVED

The implementation was independently re-verified after the NOT APPROVED gate at `f5b761d`. The required corrections were present at the delivered head, including the nullable `idempotency_key` SQL mapping regression and deterministic package hashing that excludes volatile `assembledAt`. The corrected PR head passed the repository-governance and foundation workflow (run `33713286310`, run number 347), including behavioral, structural, discrimination and live-PostgreSQL test execution.

The authoritative production merge is `dc5be9aa676eb4a92264b64f3428abfa5231ce44`. No architecture change was made.

## Evidence

- Four required proof classes satisfied: static, dynamic, discrimination, concurrency.
- CI run `33713286310` on implementation revision `372e1a18be7a19b1f887a3d9b4022644cf31562f`: repository-governance PASS and foundation PASS; foundation executed build/configuration/architecture checks, governance frontier validation, behavioral/structural/discrimination tests, and live-PostgreSQL tests.
- PR #62 reports 898 tests, 0 failures, with live-PostgreSQL proofs CI-gated; the final corrected evidence was rerun green.
- The merge incorporates the two architect-required correctness corrections and their regression proofs.
- No direct provider SDKs, AI engine, provider/model/agent ownership, replacement workflow engine, or Service Work lifecycle change was introduced.

## Architectural Notes

The frozen architecture §6 module table is machine-checked (`unknown-module` — exactly 16 declared modules), and only module files may import other modules (`module-import-outside-composition-root`). The Construction implementation therefore lives in `/entities`, the WORK-001 placeholder module whose business implementation was explicitly deferred to a later Work Order and whose frozen scope covers subcontractor/vendor entities. The flow is stateless orchestration over horizontal authorities; durable facts remain in `/work`, `/workflow`, `/evidence`, `/interactions`, `/zeck`, and `/approvals` ledgers.

No new module or architecture layer was introduced. The repository governance checker was extended to pin the new `/entities` boundary and its allowed frontier.
