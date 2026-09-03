-- ServiceOS migration 0012 — Construction Entities (WORK-010).
--
-- Scope: the durable state owned by the /entities module (Work Order
-- frozen scope: "subcontractor/vendor entities, compliance
-- requirements"; the construction compliance flow itself owns NO
-- durable state — every flow fact lives in an authority's ledger:
-- /work attempts, /workflow transitions, /evidence records and
-- verification decisions, /interactions intents, /zeck intents,
-- /approvals requests).
--
-- Tenancy discipline (established by migration 0001): every durable row
-- carries a NOT NULL tenant_id referencing org_service_tenants(id) and is
-- queried only through a mandatory tenant predicate.
--
-- Authority boundaries encoded in the schema:
--   * THE ENTITY-INSTANCE AUTHORITY (WORK-001 planned the module; the
--     Work Order owns its business implementation): `entity_instances`
--     is the single tenant-bound store of customer/business entity
--     records (Project, Subcontractor, Contract, InsuranceCertificate,
--     License, ComplianceRequirement). Field VALUES are declared-typed
--     JSONB validated at the module layer against the REGISTERED
--     vertical package declaration (consulted through /verticals'
--     public read — no cross-module foreign keys, the /billing, /zeck
--     and /evidence precedent).
--   * IMMUTABLE, APPEND-ONLY INSTANCES: no update path exists. A
--     corrected or re-submitted entity is a NEW instance row (the
--     audit trail never rewrites history; vendor corrections append).
--     "stale vendor attempt cannot overwrite a newer compliance
--     decision" is therefore schema-impossible for entity facts, and
--     the compliance decision itself is the /evidence verification
--     ledger's immutable row.
--   * NO VERTICAL FLOW STATE: no compliance-status, work-state,
--     transition, policy, approval, provider or AI/model/provider/
--     agent/credential column exists anywhere in this schema. The
--     vertical flow holds no durable state by design (its status is
--     DERIVED from the authorities' ledgers).
--   * Tamper evidence: content_hash (the actor-independent fact) and
--     record_hash (the full immutable row core) are recomputed on
--     every read; divergence fails closed (typed
--     ENTITY_RECORD_TAMPERED).
--   * Keyed logical identity: UNIQUE (tenant, idempotency_key) —
--     idempotent submissions converge; divergent content under the
--     same key fails closed at the module layer.
--   * No credential surface: no key, secret, token or provider column
--     exists anywhere in this schema.

CREATE TABLE IF NOT EXISTS entity_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES org_service_tenants(id),
  -- The vertical package whose declaration defined this entity type
  -- (read-only provenance through /verticals' public surface; the
  -- package row itself stays /verticals' authority).
  package_id text NOT NULL,
  package_version integer NOT NULL,
  entity_type text NOT NULL,
  fields jsonb NOT NULL,
  idempotency_key text,
  content_hash text NOT NULL,
  record_hash text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Shape invariants (schema-level backstops).
  CONSTRAINT entity_instances_package_version_positive CHECK (package_version >= 1),
  CONSTRAINT entity_instances_type_shape CHECK (entity_type ~ '^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$'),
  CONSTRAINT entity_instances_package_shape CHECK (package_id ~ '^[a-z][a-z0-9-]{1,63}$'),
  -- Entities are immutable: updated_at always equals created_at (no
  -- update path exists; the constraint backstops any accidental
  -- mutation attempt).
  CONSTRAINT entity_instances_immutable CHECK (updated_at = created_at)
);
COMMENT ON TABLE entity_instances IS 'Tenant-bound immutable entity instances (Project, Subcontractor, InsuranceCertificate, ...): validated against registered vertical package declarations, append-only (corrections are new instances), tamper-evident through read-side hash recomputation (/entities authority, WORK-010)';

-- One durable instance per (tenant, idempotency key): concurrent keyed
-- submissions of the same logical instance converge on one row.
CREATE UNIQUE INDEX IF NOT EXISTS entity_instances_tenant_idempotency_key
  ON entity_instances (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_instances_tenant_created_idx ON entity_instances (tenant_id, created_at);
-- Type-scoped scans (the flow's linkage and listing surface).
CREATE INDEX IF NOT EXISTS entity_instances_tenant_type_idx ON entity_instances (tenant_id, entity_type);
CREATE INDEX IF NOT EXISTS entity_instances_tenant_package_idx ON entity_instances (tenant_id, package_id, package_version);
