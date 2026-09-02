# WORK-009

Status: complete
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE

## Objective

Implement the versioned service-definition and vertical-package runtime that describes business services without embedding them in the horizontal core.

## Dependencies

Requires: WORK-003
Enables: WORK-010, WORK-012

## Scope

Allowed:
- service definitions
- vertical registration
- work definitions
- workflow-definition bindings
- business policy configuration schema
- outcome contracts
- pricing/metering metadata
- Zeck capability requirement declarations

Forbidden:
- AI engine implementation
- vertical workflow logic leaking into horizontal authority

## Protected Surfaces

/services, /verticals, versioned service definitions and package configuration

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Verticals specialize domain semantics but cannot weaken horizontal authorities or select AI providers/models.

## Acceptance Criteria

- AC-1 A service definition can define entities, work types, workflow and outcome requirements.
- AC-2 Vertical packages are versioned.
- AC-3 Customer configuration cannot weaken horizontal authority invariants.
- AC-4 A service can declare Zeck capability requirements without selecting a model/provider.

## Verification Requirements

### Behavioral
- package registration/versioning

### Structural
- vertical package does not import AI provider infrastructure

### Discrimination / Mutation
- attempt to weaken a frozen horizontal invariant is rejected

### Concurrency / Crash Safety
- duplicate package/version registration converges or rejects deterministically

## Definition Of Done

See TEMPLATE.md.

## Activation Record

Activated by Architect on 2026-09-01.

- Branch: `feat/WORK-009-service-runtime`
- Base revision: `65d527b1aba75a025e5c5b4bf23c71bdcb32a3cf`
- Activation issue: `#31`
- Implementation authority: Z.ai
- Review/merge/finalization authority: Architect
- Assurance profile: `HIGH_ASSURANCE`

The activation decision was made from frozen v1.0 architecture with WORK-003 complete and WORK-015 now finalized in the mainline. No architecture change is authorized by this Work Order.
## Evidence

Status: verified and merged by Architect on 2026-09-02.

### What was implemented

- `/verticals` public contract: the vertical-package registration authority. Versioned, immutable-in-content, tenant-bound catalog rows of declarative domain semantics (terminology glossary, entity definitions with typed fields, work-type definitions with default SLA floors, workflow-step declarations, policy parameter DEFAULTS — values only, never rules, approval-matrix floors, evidence requirements, integration bindings as provider-neutral capability-class names, pricing rules) plus the Zeck capability-requirement declaration contract (shared, frozen forbidden-key list: any model/provider/agent/prompt selection field fails closed `AI_SELECTION_FORBIDDEN`; optional quality/latency bounds validated fail-closed; AC-4). Packages are DATA, never code — no publication lifecycle (service definitions pin exact versions), so vertical workflow logic cannot leak into horizontal authorities by construction. Durable identity `(tenant, package, version)` with advisory-locked store-serialized sequencing: duplicate registration converges on identical canonical content (`canonicalJson` + SHA-256 content hash), fails closed typed `VERSION_CONTENT_CONFLICT` otherwise; gaps/skips fail closed `VERSION_NOT_SEQUENTIAL`; idempotency-key convergence with `IDEMPOTENCY_INPUT_CONFLICT` on divergent content; every read verifies content + record hashes (`VERTICAL_RECORD_TAMPERED`). The module imports no business authority other than the identity/tenancy chain (checked structurally).
- `/services` public contract — the binding layer: `registerServiceDefinition` validates the input fail-closed against the pinned vertical package (every referenced entity/work type/step/policy key/parameter/approval rule/evidence requirement/capability class/AI capability must be DECLARED by the package — binding, never invention), maps every workflow-binding edge onto the FROZEN canonical `/workflow` machine consumed through its public interface (`WORKFLOW_STATE_UNKNOWN` / `TRANSITION_ILLEGAL` — service data can never redefine the horizontal lifecycle, architecture-lock #31), declares the business-policy configuration as a SCHEMA (keys, typed parameters, bounds, enums, defaults; rule/effect content fails closed `POLICY_RULES_FORBIDDEN` — /policies stays the single engine), outcome contracts with business-verification modes only (`AI_VERIFICATION_FORBIDDEN` — deterministic / human approval / external authoritative record), pricing/metering metadata, and required AI capabilities as a SUBSET of the vertical's provider-neutral declarations (`CAPABILITY_NOT_DECLARED`). Draft -> active forward-only lifecycle with retire-first and one active per identity; `activateServiceDefinition` / `resolveActiveServiceDefinition`; versioned, immutable-in-content, key-convergent registration.
- Customer configuration (AC-3): `registerCustomerConfiguration` / `activateCustomerConfiguration` / `resolveActiveCustomerConfiguration` specialize an ACTIVE service — the input surface is exactly policy parameter values (validated against the service schema, `POLICY_PARAMETER_OUT_OF_BOUNDS`), SLA adjustments (only TIGHTER than the service default, `SLA_WEAKENED`) and approval adjustments (only STRICTER, `APPROVAL_WEAKENED`); workflow bindings, outcome contracts, capability requirements and pricing are STRUCTURALLY non-configurable (absent from the input shape — no data can weaken them, architecture-lock #33). Configurations pin the service version they were validated against across later updates; store-allocated monotonic configuration versions; forward-only one-active lifecycle; tamper-evident reads.
- SQL stores over the persistence boundary with the executor-pinned transaction discipline (every in-transaction statement on the `tx` client), advisory-locked sequencing, `ON CONFLICT DO NOTHING` insert-conflict convergence re-reads, and the POST-LOCK IDEMPOTENCY RE-CHECK. Migration `0006_service_vertical_runtime.sql`: composite foreign keys pinning the registered package version and the validated service version, one-active partial unique indexes, keyed partial unique idempotency indexes, closed status enumerations, content/record hash columns, tenant discipline throughout (`NOT NULL tenant_id` + mandatory tenant predicates).
- Governance wiring: `checkServiceVerticalBoundaries` (single service-definition and vertical-registration authorities; AI-runtime entry points rejected in both modules; `/zeck` imports rejected — AC-4 boundary; verticals import only the identity chain; services import only public contracts of allowed authorities; frontier-relative importer rules for `/work` and future consumers), `verticals_` / `services_` migration-prefix allowlist entries, check-CLI wiring (new `services/verticals` line), composition-root wiring (both authorities composed; no HTTP surface — WORK-012 owns the control-plane API).
- Proofs: behavioral runtime suites, concurrency suite, boundary structural/discrimination suite, migration README discipline, and 6 live-PostgreSQL integration proofs (CI-gated): migrations order/idempotency, schema backstops (one-active + closed enumerations + composite FKs), the full lifecycle flow, tamper detection on read, TRUE parallel convergence over independent pooled clients, cross-tenant predicates.

### Defects found and fixed during live verification

The first CI run of the implementation head (run 33568094876, commit e698949) failed 1 of 6 live-PostgreSQL proofs: "TRUE parallel actors converge over real SQL" — the same-key divergent service-definition race produced TWO rejections instead of one. Root-cause analysis found one product-side defect class and one test-side defect; both fixed in commit 4e78433:

1. **Product — idempotency lookup outside the serialized critical section**: `registerPackage` (/verticals) and `registerDefinition` (/services) checked the idempotency key BEFORE acquiring the advisory lock. Under a TRUE same-key divergent race the loser exited through the version-sequence branch with `version-content-conflict`, violating the store port contract's `idempotency-input-conflict`. Fixed with the POST-LOCK IDEMPOTENCY RE-CHECK; `registerConfiguration` received the same re-check for consistency.
2. **Test — the "race" was not a race**: the live proof's divergent step re-used an idempotency key already bound by the preceding convergent race. The proof was corrected to use a FRESH key on the next free version slot, yielding exactly one winner and one `IDEMPOTENCY_INPUT_CONFLICT` loser.
3. **Discrimination added**: two new in-env concurrency proofs pin the same-key divergent semantics for package and definition registrations alongside the existing different-key divergent proof.

### Verification results

- `npm run build` — PASS.
- `npm run check` — PASS.
- `npm test` locally — 521 tests / 0 fail / 59 skipped (the 59 live-PostgreSQL proofs execute in CI only).
- Final CI run `33569063765` at head `75dc1d6036c6be5e45ce6126a47fb199672be46d` — repository-governance PASS, foundation PASS: **580/580 tests, 0 fail, 0 skipped**, including all 59 live-PostgreSQL proofs and all 6 WORK-009 live proofs.
- Architect review: independent scope, authority-boundary, persistence, concurrency and evidence gate passed; PR #32 merged as `34d955320a998aae1544b6dc7423801fd1de1557`.

### Known limitations

- No HTTP surface for `/services` or `/verticals` (WORK-012 owns the control-plane API surface).
- Executable vertical workflow logic belongs to the vertical-implementation Work Orders (WORK-010 and successors); this Work Order ships the declarative catalog, binding and configuration runtime only.
- Live-PostgreSQL proofs execute in CI only.
- SLA deadlines surface through the service/vertical declarations to the workflow authority's SLA hooks (WORK-004) at execution time; no scheduling or breach evaluation lives here.
