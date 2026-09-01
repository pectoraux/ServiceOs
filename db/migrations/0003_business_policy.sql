-- ServiceOS migration 0003 — Business Policy Authority (WORK-014).
--
-- Scope: the durable state owned by the /policies module (Work Order frozen
-- scope: "/policies module, versioned business-policy contracts, policy
-- resolution, deterministic policy evaluation, policy decision/provenance
-- records").
--
-- Tenancy discipline (established by migration 0001): every durable row
-- carries a NOT NULL tenant_id referencing org_service_tenants(id) and is
-- queried only through a mandatory tenant predicate.
--
-- Authority boundaries encoded in the schema:
--   * Policy contracts are VERSIONED and immutable in content: the rule set
--     is written once at creation; publication state moves forward only
--     (draft -> active; the previously active version is retired first).
--     At most ONE active version per (tenant, policy key, scope) — the
--     partial unique index below. Version numbers are per identity.
--   * Precedence is structural: scope is either 'base' (the tenant's
--     service/vertical default policy) or 'customer' (the customer
--     override). The module composes deny-dominates (an override may
--     tighten, never weaken); the frozen floor is code, not rows — it can
--     never be weakened by configuration (architecture-lock #33).
--   * Decision records are durable, attributable and revision-bound
--     (AC-5): they pin the policy id/version each layer consulted, the
--     frozen revision, the input snapshot, its deterministic hash
--     (sha256 of canonical input) and an integrity hash over the record
--     core (after-the-fact mutation is detectable on read).
--   * The frozen floor and evaluation engine are CODE (src/modules/
--     policies/evaluation.ts); no model/provider/AI surface exists
--     anywhere in this schema (forbidden zone: AI/provider policy
--     engines).

-- ---------------------------------------------------------------------------
-- /policies: policy contract versions (the durable business-policy catalog)
-- ---------------------------------------------------------------------------
CREATE TABLE policy_contracts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES org_service_tenants (id),
  -- Opaque business policy key (e.g. 'serviceos.example.refund-threshold').
  -- Service/vertical semantics stay external (/services, /verticals);
  -- /policies never interprets the key.
  policy_key      TEXT NOT NULL,
  -- Precedence layer: 'base' = service/vertical default policy for the
  -- tenant; 'customer' = customer override (may tighten, never weaken).
  scope           TEXT NOT NULL CHECK (scope IN ('base', 'customer')),
  -- Monotonic per (tenant, policy_key, scope); allocated under a lock.
  version         INTEGER NOT NULL CHECK (version > 0),
  -- Contract VERSIONING (not the Service Work workflow state machine):
  -- draft -> active (forward only; the prior active version is retired
  -- first); retired is terminal. At most one active per identity.
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  -- The ordered deterministic rule set (JSON, validated by the module).
  rules           JSONB NOT NULL,
  -- Layer outcome when no rule matches: allow | deny.
  default_effect  TEXT NOT NULL CHECK (default_effect IN ('allow', 'deny')),
  -- Actor provenance (domain-model "identity rule").
  created_by      UUID NOT NULL REFERENCES auth_users (id),
  -- Durable idempotency identity for externally-triggered creation.
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, policy_key, scope, version)
);
COMMENT ON TABLE policy_contracts IS 'Policy contract versions: the durable, tenant-bound business-policy catalog (/policies authority; deterministic evaluation is code, not data)';

-- Two actors creating the same logical policy version (same tenant +
-- idempotency key) converge on one durable identity (concurrency proof).
CREATE UNIQUE INDEX policy_contracts_tenant_idempotency_key
  ON policy_contracts (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- ONE active version per (tenant, policy key, scope): resolution reads it;
-- activation retires the prior active version first (per-statement
-- enforcement, like WORK-003's one-live-attempt index).
CREATE UNIQUE INDEX policy_contracts_one_active
  ON policy_contracts (tenant_id, policy_key, scope)
  WHERE status = 'active';
CREATE INDEX policy_contracts_tenant_key_idx ON policy_contracts (tenant_id, policy_key);

-- ---------------------------------------------------------------------------
-- /policies: policy decision records (durable, attributable, revision-bound)
-- ---------------------------------------------------------------------------
CREATE TABLE policy_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES org_service_tenants (id),
  policy_key      TEXT NOT NULL,
  -- The composed decision: allow | deny.
  outcome         TEXT NOT NULL CHECK (outcome IN ('allow', 'deny')),
  -- Which precedence layer decided: frozen | customer | base | default.
  deciding_layer  TEXT NOT NULL CHECK (deciding_layer IN ('frozen', 'customer', 'base', 'default')),
  -- The deciding rule's stable id (provenance; null for defaults).
  deciding_rule_id TEXT,
  -- The frozen-floor revision the decision was bound to (code-pinned).
  frozen_revision TEXT NOT NULL,
  -- Per-layer provenance: the policy id/version each layer consulted and
  -- its outcome (AC-5). [{layer, policyId, version, outcome, ruleId}]
  layers          JSONB NOT NULL,
  -- The exact evaluation input snapshot (action + flat attributes).
  input           JSONB NOT NULL,
  -- Deterministic input revision: sha256 over the canonical input.
  input_hash      TEXT NOT NULL,
  -- Integrity hash over the canonical record core: after-the-fact
  -- mutation of any core field is detectable on read.
  record_hash     TEXT NOT NULL,
  decided_by      UUID NOT NULL REFERENCES auth_users (id),
  -- Durable idempotency identity: re-delivery of the same gated decision
  -- converges; a divergent input for the same key fails closed.
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE policy_decisions IS 'Policy decision records: durable, attributable, revision-bound business-policy decisions with mutation-detectable provenance (/policies authority)';

-- One durable decision per (tenant, idempotency key): concurrent
-- evaluations of the same gated decision converge on one record.
CREATE UNIQUE INDEX policy_decisions_tenant_idempotency_key
  ON policy_decisions (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX policy_decisions_tenant_key_idx ON policy_decisions (tenant_id, policy_key);
CREATE INDEX policy_decisions_tenant_created_idx ON policy_decisions (tenant_id, created_at);
