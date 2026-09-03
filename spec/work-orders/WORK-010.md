# WORK-010

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: CRITICAL
Activation Issue: #61
Implementation Branch: `feat/WORK-010-construction-compliance`
Activation Baseline: `0ef7148900572be30fc88af590e16633911aec61`

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

## Activation Record

Activated by Architect on 2026-09-02.

- Activation issue: `#61`
- Activation baseline: `0ef7148900572be30fc88af590e16633911aec61`
- Assurance profile: `CRITICAL`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect

The activation decision is from frozen v1.0 architecture with WORK-005, WORK-006, WORK-007, WORK-009, WORK-014 and WORK-015 complete. No architecture change is authorized by this Work Order.

## Evidence

Status: implemented and verified; PR #62 open for Architect review.

### Placement decision (architecture-conformant)

The frozen architecture §6 module table is machine-checked (`unknown-module` — the module tree must contain EXACTLY the 16 declared modules), and only module files may import other modules (`module-import-outside-composition-root`). The Construction vertical implementation therefore lives in **`/entities`** — the one module WORK-001 shipped as a placeholder whose business implementation was explicitly deferred to a later Work Order ("A later Work Order owns the module's business implementation"), and whose scope WORK-010 owns ("subcontractor/vendor entities"). The module hosts: (1) the entity-instance authority (its deferred business implementation), (2) the Construction v1 vertical package content (pure declaration data, registered through /verticals' public surface), (3) the deterministic construction compliance rules (pure functions), and (4) the Construction Subcontractor Compliance flow — stateless orchestration over the horizontal authorities' public interfaces. New structural governance (`checkEntitiesBoundaries`) pins every boundary this placement creates.

### What was implemented

- **The entity-instance authority** (`/entities` core): `createEntityInstance`/`getEntityInstance`/`listEntityInstances` — tenant-bound, immutable (append-only; corrections are new instances), tamper-evident records of the declared entity types (Project, Subcontractor, Contract, InsuranceCertificate, License, ComplianceRequirement), validated against REGISTERED vertical package declarations consumed through /verticals' public read (a missing package is a typed `VERTICAL_PACKAGE_NOT_FOUND`; undeclared types/fields, missing required fields and type mismatches fail closed). Keyed convergence with divergent fail-closed; date fields normalize to canonical ISO; the SQL store runs advisory-locked critical sections with post-lock idempotency re-checks and ON CONFLICT convergence.
- **Migration `0012_construction_entities.sql`** (`entity_` prefix added to the migration allowlist): `entity_instances` with the keyed partial unique index, the immutability CHECK (`updated_at = created_at`), the `gen_random_uuid()` identity, and NO lifecycle/policy/provider/credential/foreign-AI-execution columns (the vertical flow owns no durable state — machine-checked).
- **The Construction v1 vertical package content** (`constructionVerticalPackage()`): the vertical-model.md "Construction v1" declaration set — 6 entities, 7 work types (with SLA floors), 8 workflow steps, policy defaults (`construction.followup`, `construction.exception`), the approval matrix, 8 evidence requirements, the email integration binding, the `document.reasoning` Zeck capability requirement (declaration only — no selection field can even be expressed), and pricing rules. Registered through /verticals' public surface (the content factory is data, never a registration entry point).
- **The deterministic compliance rules** (pure functions of (facts, requirement, instant)): insurance limits/expiry/lead-window/additional-insured validation; license validity; W-9 tax-id identity match; the project-specialized outcome-contract requirement derivation. Determinism proven by test.
- **The Construction compliance flow** (`createConstructionCompliance`, stateless): `onboardSubcontractor` (subcontractor + compliance ServiceWork + reused keyed attempt + draft→ready→accepted→in_progress + per-kind ComplianceRequirement instances + ONE durable email document request + the replay-guarded profile evidence + waiting_information), `receiveVendorDocument` (document entity + evidence; duplicate callbacks converge; live works resume; terminal works record evidence and are NEVER mutated), `evaluateCompliance` (the deterministic rules over the LATEST recorded facts by business observation time + the validation evidence as durable findings + the /evidence verification decision + the composed gate: verdict AND every rule outcome — AC-6, a fabricated AI claim alone cannot compose compliance; verifying→completed or verifying→in_progress rework), `chaseMissingDocuments` (governed follow-up Service Work + ONE keyed interaction per (work, round); concurrent workers converge on one contact — AC-4/AC-5), `escalateException`/`applyExceptionDecision` (waiting_approval + the /approvals request bound to the construction.exception policy; approve resumes, reject fails terminally; applying before the human decision fails closed), `requestDocumentReasoning` (a /zeck intent carrying the package-DECLARED capability requirement, correlated to a real reused attempt; duplicate requests converge on one execution reference), `recordReasonedDocumentFacts` (extracted facts enter as EVIDENCE citing the foreign execution as opaque provenance — a claim, never an outcome), `assembleCompliancePackage` (gated on the latest satisfied verification AND the latest compliant rule outcomes; a deterministic hash over the assembled authority ledger state, self-reference excluded so re-assembly converges; the package record as attributable evidence — AC-7), `getComplianceStatus` (derived from the newest verification decision — no second state).
- **Governance wiring**: `checkEntitiesBoundaries` with 7 stable violation codes (`entities-authority-duplicate`, `vertical-engine-in-entities`, `ai-selection-in-entities`, `entities-import-direction`, `entities-internal-import`, `entities-importer-frontier`, `entities-vertical-state-schema`); the `entity_` migration-prefix entry; the frontier extensions (/entities consumes /zeck, /evidence, /approvals, /interactions, /verticals — each list's test updated to the extended frontier); check-CLI wiring + summary line; governance index exports; composition-root wiring (`entityAuthority` + `constructionComplianceFlow` composed).
- **Proofs**: `entities-runtime` (12: declaration-validated entity CRUD with every fail-closed class, keyed convergence/divergence/date-normalization/tenant-isolation/tamper detection, package registration convergence, the full happy path incl. package assembly + replay convergence, the missing-document path + governed chase, expired insurance, noncompliant limits + the NOT_COMPLIANT package gate, vendor correction with the stale-key discrimination, the Zeck reasoning path incl. duplicate-request convergence, the fabricated-AI-claim discrimination, escalation approve/reject, pure-rule determinism), `entities-boundary-checks` (14: the real tree passes; frontier extensions pinned; the public contract + migration invariants; synthetic trees rejected with exact codes — duplicate entity authority, replacement engines, AI selection, forbidden imports, internal imports, importer frontier, schema columns; the prefix discipline; planted AI infra rejected; the check CLI end to end), `entities-concurrency` (5: parallel duplicate document callbacks converge on ONE entity + ONE evidence row; concurrent chasers single-contact with typed recoverable losers; duplicate Zeck requests converge on one reference; the stale-attempt overwrite discrimination with work-state non-regression; parallel same-key entity creation races), `entities.integration` (7, CI-gated: migrations 0001..0012 + schema invariants over real rows, the real-SQL entity flow, the full compliance journey, the governed chase, parallel duplicate callbacks, concurrent chasers, the single-connection pinned-client transaction scope). The faithful `InMemoryEntitiesStore` (race injection) and `buildConstructionApp` (all 12 composed modules + the moving clock handle) are shared through the test helpers.

### Defects found and fixed during verification

1. **Replay-unsafe attempt creation (in-env defect)**: the flow created its work attempts by key on every call, but the /work retry protocol SUPERSEDES a dispatched attempt on a keyed retry — the replay then bound its keyed side effects (profile evidence, Zeck intent) to a DIFFERENT attempt identity and failed closed. Fixed: keyed attempts are REUSED on replay (`keyedAttempt` — find by key first); the real-retry protocol stays untouched.
2. **Latest-document selection under a frozen clock (in-env defect)**: the flow selected "the latest document evidence" by list order; with a frozen attachment clock the order is random. Fixed: selection by the record's business observation time (`observedAt`), list-position tiebreak — vendor corrections carry a newer observation instant by construction.
3. **Package self-reference broke re-assembly convergence (in-env defect)**: the assembled document listed its own evidence rows as inputs, so a second assembly hashed different content. Fixed: the package is the OUTPUT — its own requirement is excluded from the assembly.
4. **Stale pre-dispatch records returned (in-env defect)**: onboarding/chase returned the pre-dispatch interaction and pre-transition work records. Fixed: the post-write durable records are returned.
5. **Two clock reads per entity write (latent)**: the record hash and the row pinned different instants under a moving clock (read-side verification would fail). Fixed: one clock read per write.
6. **Schema defect (live-PostgreSQL proof, run 33705527916)**: `entity_instances.id` had no `gen_random_uuid()` default — every real insert violated the not-null constraint (the in-memory double generates ids itself, so the defect was invisible in-env). Fixed in ee3bc21 (the house discipline: the surrogate id is assigned by the store and excluded from the record hash).
7. **Replay convergence under a moving clock (live proof, run 33705847834)**: flow evidence attaches included the clock-read observation instant in their content, so a pure retry with the same key failed closed (correct /evidence discipline; wrong flow discipline). Fixed: every flow-evidence step is replay-guarded by its flow key carried in the evidence payload — the durable record is the authority a retry converges on.
8. **The W-9 validation rode the document's requirement name (live proof, run 33705847834)**: `construction.w9` carried both the document fact and the validation outcome, so the latest-document selection could pick a validation row as the document input. Fixed: the package declares `construction.w9_validation` as its own evidence requirement (the document INPUT and the deterministic rule OUTCOME are distinct facts, exactly like insurance/license).
9. **Disclosed test-side correction (no product change, the WORK-006 precedent)**: the events integration test's parallel-inbox assertion only accepted the winner's `consumed` state, contradicting the substrate's documented loser contract ("the loser converges on the durable result or surfaces the typed in-progress state") — a latent assertion defect exposed by CI timing. The assertion now pins the real invariant: exactly ONE consumer invocation; the loser never invokes.

### Verification results

- `npm run build` — PASS.
- `npm run check` (EXPECT_BRANCH=feat/WORK-010-construction-compliance) — PASS (16 modules conform to the frozen tree; all boundary checkers including the new entities checks; governance state internally consistent).
- Full suite locally — 898 tests / 784 pass / 0 fail / 114 skipped (107 pre-existing + 7 new live-PostgreSQL proofs, CI-gated).
- CI run 33706383151 at head `2a4177c`: repository-governance PASS, foundation PASS — **898/898 tests, 0 fail, 0 skipped**, including all 114 live-PostgreSQL proofs (107 pre-existing + 7 new WORK-010 proofs).

### Known limitations

- No real Zeck gateway, email adapter or event delivery port is composed in production (the boundaries ship closed with truthful typed unavailability; contract conformance is pinned by the in-memory doubles).
- No HTTP/control-plane surface (WORK-012 owns the API; the flow surface is programmatic).
- Vendor document arrival is a flow-level keyed surface (`receiveVendorDocument`), not a new inbound event type: the horizontal event vocabulary is frozen (WORK-006 scope), and vertical-specific event meanings are forbidden; provider-native arrival channels translate through the future control plane.
- The compliance outcome contract is the project-specialized requirement set derived from the Project entity's declared profile; richer per-project requirement matrices (e.g. per-trade requirements) extend through a future Work Order.
- Live-PostgreSQL proofs execute in CI only (no local PostgreSQL in the implementation environment).
- The chase round identity is caller-supplied (one durable contact per (work, round) is enforced; a scheduled round-advance loop belongs to the Work Order owning scheduling).
