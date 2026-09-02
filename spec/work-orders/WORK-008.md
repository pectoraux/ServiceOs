# WORK-008

Status: in_flight
Owner: Architect
Architecture Version: v1.0
Assurance Profile: HIGH_ASSURANCE
Activation Issue: #55
Implementation Branch: `feat/WORK-008-business-approval`
Activation Baseline: `04cf82d618fe006e8cc1f31bc03105c3a1e7c5a2`

## Objective

Implement explicit ServiceOS business/human approval requests and decisions.

## Dependencies

Requires: WORK-004, WORK-014
Enables: WORK-010

## Scope

Allowed:
- approval request/decision records
- approval policy hooks
- authenticated human approval surface

Forbidden:
- replacing Zeck's optional AI human-escalation execution primitive
- implicit approval from agent claims

## Protected Surfaces

/approvals, approval persistence/routes, authorization integration

## Required Proof Classes

`static,dynamic,discrimination,concurrency`

## Architecture Invariants

- Business approval is an explicit human authority; AI/agent output is never approval.

## Acceptance Criteria

- AC-1 Approval requests are bound to specific Service Work/Attempt and policy.
- AC-2 Only authorized humans can approve.
- AC-3 Approval is durable and auditable.
- AC-4 An AI result does not equal approval.

## Verification Requirements

### Behavioral
- request/approve/reject/review lifecycle

### Structural
- approval authority exists only in ServiceOS for business decisions

### Discrimination / Mutation
- unauthorized approval fails

### Concurrency / Crash Safety
- simultaneous approval/rejection has deterministic terminal arbitration

## Definition Of Done

See TEMPLATE.md.

## Evidence

Status: implemented; implementation revision `84fd0503cfa855643a7ca7c16fe01a6e0b6b2d60` on branch `feat/WORK-008-business-approval`; PR and CI verification pending.

### What was implemented

- `/approvals` public contract — the ServiceOS business/human approval authority (architecture-lock #3: the SOLE authority for business/human approval state; the protected surface of this Work Order): `createApprovalsModule` composing the single authorization chain (authorize BEFORE any domain data access; denials never touch the store — proven with store read counters), `/work`'s public read for request-binding validation (read-only; /approvals never mutates work state), and `/policies`' public evaluation hook as the applicable-policy binding (never a duplicate policy engine). No HTTP surface (WORK-012 owns the control-plane API — its approval views consume this public contract); no `/zeck` import anywhere (Zeck's optional AI human-escalation primitive is untouched — the forbidden surface).
- Approval requests (AC-1; activation invariant 2): `requestApproval` — the ONE entry point creating an explicit, tenant-bound approval request bound to a REAL Service Work (and, optionally, one of its Work Attempts — existence + membership validated through `/work`'s public read; NO status gate: an approval request may be bound to work in any state, and deciding never mutates work state) and to the applicable business policy: the frozen `policyKey` is REQUIRED, evaluated through `/policies`' public hook at creation with the namespaced idempotency key (`approval.request:<key>`, so gated retries converge too); a deny decision fails closed `POLICY_DENIED` with NO durable request; a genuine evaluation failure fails closed `POLICY_EVALUATION_FAILED` (wrapped); an allow decision is pinned onto the durable row (`policyDecisionId`, /policies' own ledger identity — read-only provenance). A keyed fast-path convergence runs BEFORE the policy gate (the /workflow discipline): a retry of an already-recorded request re-observes the durable row without re-adjudicating the policy, and the row keeps its original admission provenance. Inputs validate fail-closed (UUIDs, identifier-shaped policy keys, required subject, bounded keys/reasons).
- The explicit HUMAN decision authority (AC-2/AC-4; activation invariants 3/5): `decideApproval` — the single decision surface, HUMAN-ONLY: the deciding principal must be an authenticated human (`kind === 'human'`) with tenant write authorization; a machine principal (service account, agent, AI execution surface) fails closed typed `DECIDER_NOT_HUMAN` BEFORE authorization and BEFORE any durable effect (proven dynamically: an authorized machine principal creates requests, its decision attempt leaves zero decision rows and the request pending). There is no code path from an AI execution, a Zeck result, an agent claim or a transport success to a decision: foreign execution outcomes may be carried inside the request SUBJECT as opaque business content (data under approval — proven: such a request stays PENDING until an explicit human decision), never as a decision surface.
- Deterministic terminal arbitration (AC-invariant 6; "simultaneous approval/rejection converges deterministically to one terminal decision"): `decide` is ONE serialized critical section per (tenant, decision key) AND per (tenant, request) — deadlock-free fixed lock order (keyed lock first, request-state lock second). Inside the section: the post-lock keyed re-check (same key + identical decision input — verdict AND reason — converges `APPROVAL_DECISION_INPUT_CONFLICT` on divergence), then the request's DURABLE state arbitrates: `pending` records the immutable decision row and terminalizes exactly once (the guarded `UPDATE ... WHERE status = 'pending'`); an already-terminal request CONVERGES on the recorded terminal decision when the verdict matches (any key — the durable row is the authority; the first decider keeps attribution) and fails closed `APPROVAL_DECISION_CONFLICT` referencing the durable winner when it diverges. The schema-level backstop: UNIQUE (tenant, request_id) on `approval_decisions` — at most ONE decision row per request can EVER exist, proven by direct SQL violation over live PostgreSQL.
- Durable and auditable (AC-3; activation invariant 4): request and decision rows are attributable and tamper-evident — the request row carries its CURRENT authority state (status, decisionId) with the record hash recomputed on every read (the hash is rewritten only by the module's own single decision path; divergence fails closed `APPROVAL_REQUEST_RECORD_TAMPERED`); decision rows are IMMUTABLE (append-only, no update path) and carry their decider, reason, verdict and instant with the record hash verified on every read (`APPROVAL_DECISION_RECORD_TAMPERED`). The review surface: `getApprovalRequest`, `listApprovalRequests` (work/attempt/status/requester filters), `getApprovalDecision`, `listApprovalDecisions` (work/request/decider/verdict filters), and `getTerminalApprovalDecision` — a PENDING review is distinguishable from a decided one and from a missing request (architecture-lock #30).
- Keyed convergence: the durable logical identity is (tenant, idempotency key) on both ledgers. Same key + identical request content converges; divergent fails closed `APPROVAL_REQUEST_INPUT_CONFLICT`. Same key + identical decision input converges (the crash-window retry re-observes the durable row, never a duplicate); divergent fails closed. The request content hash pins the request FACT (scope + policyKey + subject — requester/key independent, and EXCLUDING the policy admission provenance so same-key retries converge even after the active policy version drifts); the decision content hash pins the decision INPUT (scope + request + verdict + reason).
- SQL store over the persistence boundary with the executor-pinned transaction discipline: advisory locks (`approval-request-key` for creation; `approval-decision-key` + `approval-request` for decisions), `ON CONFLICT DO NOTHING` convergence re-reads, post-lock idempotency re-checks (the WORK-009 lesson), mandatory tenant predicates on every query, read-side defensive shape re-validation + hash recomputation. Migration `0010_business_approvals.sql`: `approval_requests` (keyed identity; closed status enumeration pending/approved/rejected; the pinned policy binding; the terminal decision pointer) and `approval_decisions` (keyed identity; THE one-terminal-decision unique index; closed verdict enumeration approve/reject; the referenced human decider). Work/attempt identities validated through `/work`'s public read at the module layer (the /billing, /zeck and /evidence precedent — no cross-module FKs); NO credential surface.
- Governance wiring: new `checkApprovalsBoundaries` (stable codes: `approvals-authority-duplicate` — the request/decision entry points are reserved to /approvals; `ai-approval-surface` — AI/model/provider/agent/LLM-shaped approver exports and auto-approval surfaces rejected in /approvals (activation invariant 5); `approvals-import-direction` — /approvals imports only auth/organizations/work/policies, the /zeck prohibition encodes the forbidden "Zeck human-escalation replacement" surface; `approvals-internal-import`; `approvals-importer-frontier` — no module consumes the authority yet, WORK-010/WORK-012 extend; `approvals-ai-decider-schema` — typed AI-execution/model/provider/agent and credential columns rejected on `approval_` tables), the `approval_` migration table prefix (WORK-008 owns it), check-CLI wiring + summary line, governance-index export, composition-root wiring (`createApprovalsModule` composed with tenancy + work + policies).
- Proofs: runtime/discrimination suite (21 tests: the request/approve/reject/review lifecycle, work-level vs attempt-bound requests, the pinned admission decision verified through /policies' own ledger, policy deny/no-policy/type-drift fail-closed paths, keyed request + decision convergence and conflicts, the machine-principal discrimination pair (request OK / decide NEVER), the AI-subject discrimination (opaque data stays pending), the sequential divergent-decision conflict with attribution preservation, no-work-mutation, tamper detection on both read surfaces, authorization-before-data with store read counters, cross-tenant predicates, the validation surface), concurrency suite (8 tests: the simultaneous approve/reject arbitration — exactly one row, one terminal state, the typed loser referencing the durable winner; simultaneous same-key convergence; simultaneous same-key divergence; simultaneous same-outcome different-key convergence with attribution preserved; the crash window; concurrent request creation both ways; the guard-dropped mutation discrimination — a broken store that drops the terminal arbitration admits a second decision row, the faithful store never does), boundary structural/discrimination suite (16 tests: the real tree, the public contract surface, migration 0010's durable pins, and the full mutation catalog — duplicate authority exports, forbidden imports, internal imports, frontier importers, AI approver exports, AI-decider schema columns, credential columns, planted model-router/LLM-SDK imports, prefix discipline, the check CLI end-to-end era-branched), and 12 live-PostgreSQL integration proofs (CI-gated: migration order/idempotency, the schema backstops including the one-terminal-decision unique index and both closed enumerations via direct SQL violations, the full request/approve/review flow, the reject path + policy deny, the machine-principal discrimination, no-work-mutation, keyed convergence/conflicts over real rows, tamper detection over real rows, cross-tenant predicates, TRUE parallel approve/reject over independent pooled clients, TRUE parallel same-key decide, TRUE parallel same-key request creation).

### Verification results

- `npm run build` — PASS.
- `npm run check` (build + config + architecture structural checks incl. the new approvals boundary checks + governance state + `scripts/governance-check.py`, with `EXPECT_BRANCH=feat/WORK-008-business-approval`) — PASS: `approvals: single business/human approval authority, ... (no violations)`; `frontier: currentMain=04cf82d... currentLiveImplementation=WORK-008`; `work order: WORK-008 [in_flight] on branch feat/WORK-008-business-approval (assurance HIGH_ASSURANCE)`; both PASS lines.
- `npm test` locally — 799 tests / 703 pass / 0 fail / 96 skipped (the 96 live-PostgreSQL proofs execute in CI only — 84 pre-existing + the 12 new approvals proofs; no local PostgreSQL in the implementation environment). The 96 skips are identical in kind to the pre-repair suite: the repair/implementation introduced zero new skip classes.
- Implementation surface: `git show 84fd050 --stat` — exactly the 17 files of the authorized surface (module, migration, governance wiring, tests, helpers), +4882/−8; no production file outside the /approvals authority, the governance wiring and the composition root was touched.
- PR #56 opened from `feat/WORK-008-business-approval` (implementation revision 84fd050 + evidence 622ccec).

### Defects found and fixed during live verification

The first CI run of the implementation head (run 33659722044, commit 622ccec) passed repository-governance and failed 5 of the 12 WORK-008 live-PostgreSQL proofs (foundation: 799 tests / 794 pass / 5 fail). Root cause: a TEST-defect class, not an implementation defect — the rejection validator helper `expectCode` was an async function resolving `undefined`; node's `assert.rejects` requires a validation function to return a truthy value, so the validator failed with "The validation function is expected to return 'true'" even though every caught error WAS the expected typed ApprovalError (the caught-error line in each failure shows the correct code). The three TRUE-parallel live races (approve/reject arbitration, same-key decide, same-key request creation), the schema-backstop SQL violations, the machine-principal discrimination, and the migration proofs all passed on the first live run. The validator now returns `true` (fix commit recorded in the branch history; same class as the WORK-007 live-verification test defects).
