-- ServiceOS migration 0009 — Business Evidence & Outcome Verification
-- (WORK-007).
--
-- Scope: the durable state owned by the /evidence module (Work Order
-- frozen scope: "/evidence, business verification contracts, evidence
-- persistence"; architecture-lock #4: /evidence is the sole ServiceOS
-- authority for ServiceOS business evidence and business outcome
-- verification records).
--
-- Tenancy discipline (established by migration 0001): every durable row
-- carries a NOT NULL tenant_id referencing org_service_tenants(id) and is
-- queried only through a mandatory tenant predicate.
--
-- Authority boundaries encoded in the schema:
--   * THE IMMUTABLE EVIDENCE LEDGER (AC-1/AC-3; activation invariants
--     2/3): `evidence_records` is append-only attributable business
--     evidence — the evidence fact (requirement class + provenance +
--     payload + observation instant) durably attributed to a Service
--     Work and, optionally, one of its Work Attempts (identities
--     validated through /work's public read at the module layer — the
--     /billing and /zeck precedent for cross-module identity
--     references — so no cross-module foreign keys). There is NO
--     lifecycle/status column anywhere and NO update path: rows are
--     immutable facts. Provenance is preserved verbatim (kind
--     enumeration + source + opaque durable references) and the
--     content/record integrity hashes make every row tamper-evident
--     (recomputed on every read). This is ServiceOS business evidence
--     — never a copy of a foreign AI execution record, and no foreign
--     execution identity is a typed column (opaque reference strings
--     only, inside the provenance payload).
--   * ONE ROW PER LOGICAL SUBMISSION AND PER FACT (activation
--     invariant 6: duplicate evidence attachment converges
--     deterministically): UNIQUE (tenant, idempotency_key) — keyed
--     convergence; UNIQUE (tenant, service_work_id, content_hash) —
--     CONTENT convergence: the same actor-independent evidence fact
--     re-attached under ANY key converges on the ONE durable row (the
--     content hash deliberately excludes the key and the recorder).
--   * THE IMMUTABLE DECISION LEDGER (AC-2/AC-4; activation invariants
--     4/5): `evidence_outcome_verifications` is the append-only
--     business outcome verification record — the deterministic mapping
--     of one validated outcome contract over the work's committed
--     evidence state (verdict + per-requirement results + the content
--     hash pinning scope, contract and the exact evaluated evidence
--     snapshot). The verdict enumeration is closed; 'not_satisfied'
--     with the missing requirements listed is the ONLY outcome when
--     evidence is missing — missing evidence can never become an
--     unearned successful outcome. There is NO work-status column:
--     this ledger records decisions, never Service Work lifecycle
--     (the workflow authority owns transitions).
--   * Business verification ONLY: the verification-mode enumeration is
--     the closed ServiceOS business-verification domain
--     (deterministic / human_approval / external_record) — an AI
--     execution verification concept has no surface here (it fails
--     closed at the module layer exactly like /services' validator;
--     AI execution evaluation stays with the external AI authority).
--   * No credential surface: no key, secret, token or provider column
--     exists anywhere in this schema.

-- ---------------------------------------------------------------------------
-- /evidence: business evidence records (the immutable fact ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE evidence_records (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The Service Work / optional Work Attempt attribution (validated
  -- through /work's public read; read-only — /evidence never mutates
  -- work state).
  service_work_id         UUID NOT NULL,
  work_attempt_id         UUID,
  -- The business evidence class this record satisfies (a vertical
  -- package's declared evidence requirement name).
  requirement             TEXT NOT NULL,
  -- The preserved provenance: frozen kind enumeration + source + opaque
  -- durable references (preserved verbatim, never dereferenced here).
  provenance              JSONB NOT NULL,
  -- The recorded business facts (any JSON value).
  payload                 JSONB NOT NULL,
  -- When the underlying business fact was observed (provenance time —
  -- distinct from the attach instant).
  observed_at             TIMESTAMPTZ NOT NULL,
  idempotency_key         TEXT NOT NULL,
  -- Integrity hashes: content = the actor/key-independent FACT; record
  -- = the full immutable row core (recomputed on every read).
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  attached_by             UUID NOT NULL REFERENCES auth_users (id),
  attached_at             TIMESTAMPTZ NOT NULL,
  -- Provenance pairing is exact (the CHECK is a read-side backstop of
  -- the module's frozen enumeration).
  CHECK (
    jsonb_typeof(provenance) = 'object'
    AND provenance ? 'kind'
    AND provenance ? 'source'
    AND provenance ? 'refs'
    AND jsonb_typeof(provenance->'refs') = 'array'
  )
);

-- Keyed registration convergence (the durable logical identity).
CREATE UNIQUE INDEX evidence_records_tenant_idempotency_key
  ON evidence_records (tenant_id, idempotency_key);
-- CONTENT convergence: ONE durable row per evidence fact per work item
-- (activation invariant 6 — duplicates converge under ANY key).
CREATE UNIQUE INDEX evidence_records_tenant_work_content
  ON evidence_records (tenant_id, service_work_id, content_hash);
CREATE INDEX evidence_records_tenant_work_idx
  ON evidence_records (tenant_id, service_work_id);
CREATE INDEX evidence_records_tenant_attempt_idx
  ON evidence_records (tenant_id, work_attempt_id) WHERE work_attempt_id IS NOT NULL;
CREATE INDEX evidence_records_tenant_requirement_idx
  ON evidence_records (tenant_id, requirement);

-- ---------------------------------------------------------------------------
-- /evidence: business outcome verifications (the immutable decision
-- ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE evidence_outcome_verifications (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The verified Service Work (the decision scope; evidence of other
  -- work items structurally never counts).
  service_work_id         UUID NOT NULL,
  -- The business outcome identity of the evaluated contract.
  outcome_id              TEXT NOT NULL,
  -- The closed ServiceOS business-verification mode (the contract's).
  verification_mode       TEXT NOT NULL CHECK (verification_mode IN ('deterministic', 'human_approval', 'external_record')),
  -- The requirement names the decision evaluated (the validated
  -- contract).
  requirements            JSONB NOT NULL,
  -- The decision. 'not_satisfied' with missing requirements listed is
  -- the ONLY missing-evidence outcome (never an unearned success).
  verdict                 TEXT NOT NULL CHECK (verdict IN ('satisfied', 'not_satisfied')),
  -- The deterministic mapping: per requirement, whether THIS work
  -- item's attached evidence satisfied it and which records did.
  requirement_results     JSONB NOT NULL,
  idempotency_key         TEXT NOT NULL,
  -- Hash over scope + contract + the evaluated evidence snapshot (the
  -- decision INPUT); record = the full immutable decision core.
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  decided_by              UUID NOT NULL REFERENCES auth_users (id),
  decided_at              TIMESTAMPTZ NOT NULL,
  -- The decision's input and mapping are structurally present.
  CHECK (jsonb_typeof(requirements) = 'array' AND jsonb_typeof(requirement_results) = 'array')
);

-- Keyed decision convergence (the durable logical identity; the
-- content hash comparison inside the serialized critical section
-- decides converge vs. conflict).
CREATE UNIQUE INDEX evidence_outcome_verifications_tenant_idempotency_key
  ON evidence_outcome_verifications (tenant_id, idempotency_key);
CREATE INDEX evidence_outcome_verifications_tenant_work_idx
  ON evidence_outcome_verifications (tenant_id, service_work_id);
CREATE INDEX evidence_outcome_verifications_tenant_outcome_idx
  ON evidence_outcome_verifications (tenant_id, outcome_id);
CREATE INDEX evidence_outcome_verifications_tenant_verdict_idx
  ON evidence_outcome_verifications (tenant_id, verdict);
