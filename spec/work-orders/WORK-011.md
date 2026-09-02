# WORK-011

Status: complete
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE

## Objective

Implement service-level billing, metering and unit-economics primitives without duplicating Zeck's AI usage ledger.

## Dependencies

Requires: WORK-001
Enables: WORK-013

## Scope

Allowed:
- service subscriptions
- service usage records
- work-based metering
- outcome-linked service billing
- margin reporting inputs

Forbidden:
- provider-level AI usage authority
- replacing Zeck's AI economic ledger

## Protected Surfaces

/billing, service metering, subscription/work/outcome billing ledger

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- ServiceOS owns customer service economics; Zeck remains authoritative for AI usage/cost.

## Acceptance Criteria

- AC-1 Service work can be metered.
- AC-2 Customer pricing can be subscription, work-based or hybrid.
- AC-3 Zeck cost references can be consumed for service margin analysis without becoming ServiceOS AI cost authority.

## Verification Requirements

### Behavioral
- usage and billing records

### Structural
- no provider-specific AI cost authority

### Discrimination / Mutation
- duplicate billable work cannot double-charge

### Concurrency / Crash Safety
- concurrent settlement converges on one ledger outcome

## Definition Of Done

See TEMPLATE.md.

## Evidence

Status: verified and approved by Architect; merged.

### What was implemented

- `/billing` public contract — the customer service-economics authority: `registerSubscription` (AC-2: customer pricing plans `subscription`/`work_based`/`hybrid`, validated fail-closed against the ACTIVE service-definition version's declared pricing metadata through /services' public contract — work-rate metrics must match declared metering rules; model/component consistency enforced; the pinned version is recorded on the subscription), `activateSubscription`/`cancelSubscription` (forward-only one-live lifecycle; cancel is terminal and absorbing; keyed registration convergence with the post-lock idempotency re-check discipline), `resolveActiveSubscription`, audit reads.
- Work-based metering (AC-1): `meterWorkUsage` (the work identity validated through /work's public read — same tenant, typed `WORK_NOT_FOUND`; the metric validated against the PINNED version's metering rules with the unit taken from the declared rule), `meterOutcomeUsage` (outcome-linked billing: the outcome must be the service definition's declared outcome contract), `recordManualUsage` (keyed usage events). DUPLICATE BILLABLE WORK CAN NEVER DOUBLE-CHARGE: the durable billable identity is the work item (unique (tenant, work_id)) and the outcome (unique (tenant, outcome_id)); the usage content hash pins the BILLABLE EVENT (tenant, subscription, metric, unit, quantity, reference, occurredAt — actor-independent), so duplicate metering of the same event converges on one row and divergence fails closed (`USAGE_INPUT_CONFLICT`), regardless of which authorized principal re-reports it.
- Settlement: `settleBillingPeriod` — ONE serialized critical section per (tenant, subscription): the store advisory-locks, selects the period's unsettled usage, prices it through the module's PURE pricing policy (the plan's recurring component + per-metric exact-decimal unit rates; metered usage on an unrated metric contributes ZERO charge — metering is measurement, charging follows the plan), and atomically inserts THE ledger entry (content/record hashes computed over the PRICED outcome) and marks the usage settled (with truthful record hashes — `settled_ledger_id` participates in the usage record hash). Concurrent settlement converges on the single durable outcome (unique (tenant, subscription, period) + advisory lock + insert-conflict convergence re-read); re-settling converges; late usage after settlement stays metered but is never re-billed into the settled period. `getLedgerEntry`/`listLedgerEntries` tamper-evident reads.
- Margin reporting inputs (AC-3): `recordCostReference` — NON-AUTHORITATIVE opaque references to external cost statements published by the AI cost authority (Zeck): an opaque pointer, the reported total, the period and the closed source enumeration `ai_authority` (the authority DOMAIN, never a provider). The input carries a FROZEN forbidden-key set — any provider/model/token/usage/prompt/rate-card key fails closed (`AI_COST_BREAKDOWN_FORBIDDEN`) — so this surface structurally cannot become a provider-level AI usage/cost ledger. `computeMarginReport` derives revenue (settled ledger) minus external cost references per currency on read (nothing margin-shaped persists; negative margins are exact signed decimals). /billing never imports /zeck; no AI usage ledger, provider rate or token accounting exists anywhere in the module or its schema.
- Exact-decimal money discipline: canonical decimal strings end to end (validation, stores, SQL NUMERIC columns, ledger arithmetic through scaled-BigInt helpers) — never binary floating point; the schema CHECKs `total_charge = subscription_charge + usage_charge`.
- SQL store over the persistence boundary with the executor-pinned transaction discipline, advisory locks, `ON CONFLICT DO NOTHING` convergence re-reads, post-lock idempotency re-checks and read-side hash verification. Migration `0007_billing_economics.sql`: `billing_subscriptions` (composite FK into the service catalog pinning the definition version; one-live partial unique index), `billing_usage_records` (one-per-work / one-per-outcome dedup indexes; keyed convergence; source/reference pairing CHECKs), `billing_period_ledger` (one-outcome unique index; arithmetic CHECK), `billing_cost_references` (keyed; closed `ai_authority` source enumeration; NO provider/model/token column exists).
- Governance wiring: `checkBillingBoundaries` (single billing authority; provider-level AI usage/cost entry points rejected ServiceOS-wide; /zeck import in /billing rejected — AC-3; billing imports only the identity chain + /services + /work; frontier-relative importers; internal-import discipline; AI-cost table/column rejection in migrations), the `billing_` migration prefix, the `SERVICES_IMPORTERS` frontier extension, check-CLI wiring, composition-root wiring (`billingAuthority: composed`; no HTTP surface — WORK-012).
- Proofs: behavioral/discrimination suite (21 tests), concurrency suite (8), boundary structural/discrimination suite (12), and 7 live-PostgreSQL integration proofs (CI-gated): migrations order/idempotency, schema backstops (one-live, dedup, one-outcome, closed source enumeration, catalog FK, arithmetic), the full billing flow with exact charges (recurring + rated usage + cost references + margin), duplicate-charge prevention over real rows, tamper detection on read, TRUE parallel convergence over independent pooled clients (registration, divergent keyed registration, same-work metering, concurrent settlement with the usage priced exactly once), cross-tenant predicates.

### Defects found and fixed during live verification

The first CI run of the implementation head (run 33584328571, commit 1242076) failed 4 of 7 live-PostgreSQL proofs. Root-cause analysis found all four to be TEST-side (the product behavior was correct; the in-env equivalents passed under frozen clocks): fixed in commits 94a49fa and 3b1db67:

1. **Constraint-evaluation ordering in the schema-backstops proof**: the catalog-FK assertion inserted a (tenant, service, 99) subscription for a service that already had a LIVE subscription — PostgreSQL fired the one-live partial unique index before evaluating the FK. The proof now uses a service with no subscription so the FK is the violated constraint.
2. **Real-clock content divergence in the duplicate-work proof**: with the real (moving) clock, the two metering calls defaulted `occurredAt` to two different instants — correctly DIFFERENT billable events (hence the typed conflict). The proof now pins the billable event's `occurredAt` explicitly; duplicate metering of the SAME event converges. (Same reason in the TRUE-parallel metering race.)
3. **Untamperable tamper targets in the ledger proof**: `total_charge` and `usage_charge` are both protected by the schema arithmetic CHECK (`total = subscription + usage`) — the schema itself is a tamper backstop for every charge column. The read-side detection proof now mutates the ledger `currency` (schema-legal, hash-divergent) — the exact live equivalent of the in-env tamper seam.
4. **One-live sequencing in the TRUE-parallel proof**: the divergent-registration race left its winner as a live DRAFT subscription, which the next registration correctly rejected through the one-live invariant — the proof now cancels the winner first.
5. **Era-dependent frontier CLI test (pre-existing, surfaced by this activation)**: main's queued activation-checkpoint workflows (runs 33581110271 @ 83497b8, 33581099271 @ 1a4c31b) failed on the WORK-009-era service/vertical CLI test, which hard-coded `EXPECT_BRANCH=feat/WORK-009-service-runtime` — a latent defect that only manifested when the frontier moved to WORK-011. The test now derives the expected branch from the repository's own checkpoint-state (era-independent), which repairs main's checkpoint on merge.

### Verification results

- `npm run build` — PASS.
- `npm run check` (build + config + architecture structural checks incl. the billing boundary checks + governance state + `scripts/governance-check.py`) — PASS.
- `npm test` locally — 562 tests / 0 fail / 66 skipped (the 66 live-PostgreSQL proofs execute in CI only; no local PostgreSQL in the implementation environment).
- CI run 33585142160 at final implementation revision `8035a1ba80ac3329c648fd650528d8e62f47b9f0` — repository-governance PASS, foundation PASS: **628/628 tests, 0 fail, 0 skipped**, including all 66 live-PostgreSQL proofs and all 7 WORK-011 live proofs.
- Architect independently verified the final PR head `8035a1b`; PR #35 merged as `bd11baa497574e576db57c0bc8d6035bb91eec6d`.

### Known limitations

- No HTTP surface for /billing (WORK-012 owns the control-plane API).
- Settlement happens against the LIVE subscription; a cancelled subscription's final period must be settled before cancellation (post-cancellation settlement and billing adjustments/credit notes belong to the future billing-adjustment surface — WORK-013).
- Late usage recorded after a settled period stays metered but unbilled until a future adjustment surface (the settled ledger outcome is immutable by design — never a double charge).
- Proration of recurring charges (partial-month activation) is out of scope: a settled period charges the plan's full recurring component.
- Live-PostgreSQL proofs execute in CI only (no local PostgreSQL in the implementation environment).
- No real external cost-statement ingestion exists yet: cost references are recorded through the module surface; the Zeck-side publisher integration arrives with WORK-005/006 territory.

## Finalization

Implementation revision: `8035a1ba80ac3329c648fd650528d8e62f47b9f0`
Merge commit: `bd11baa497574e576db57c0bc8d6035bb91eec6d`
Architect verdict: approved
Finalized: 2026-09-02
