-- ServiceOS migration 0006 — Service / Vertical Runtime (WORK-009).
--
-- Scope: the durable state owned by the /verticals and /services modules
-- (Work Order frozen scope: "service definitions, vertical registration,
-- work definitions, workflow-definition bindings, business policy
-- configuration schema, outcome contracts, pricing/metering metadata,
-- Zeck capability requirement declarations").
--
-- Tenancy discipline (established by migration 0001): every durable row
-- carries a NOT NULL tenant_id referencing org_service_tenants(id) and is
-- queried only through a mandatory tenant predicate.
--
-- Authority boundaries encoded in the schema:
--   * Vertical packages are VERSIONED and IMMUTABLE IN CONTENT: the
--     durable identity is (tenant, package id, version); the UNIQUE
--     constraint backstops the store's advisory-locked sequencing, and
--     the partial idempotency index backstops convergence. There is NO
--     publication lifecycle here — service definitions pin exact
--     versions; the service-package lifecycle (draft -> active) belongs
--     to /services.
--   * Vertical package content is DATA, never executable logic: every
--     section is a validated JSONB declaration. Declarative business
--     rules arrive as parameter defaults only — rule/effect composition
--     is /policies' authority; a package row cannot carry rule content.
--   * Zeck capability REQUIREMENTS are declarations: the
--     required_ai_capabilities JSONB holds provider-neutral capability
--     names with optional quality/latency bounds. Model/provider/agent/
--     prompt selection has no column, no field and no surface anywhere
--     in this schema (AC-4; the module's frozen forbidden-key validator
--     fails closed on smuggled selection fields).
--   * Service definitions are versioned, immutable-in-content, bound to
--     a REGISTERED vertical package version through the composite
--     foreign key (binding, never invention), and lifecycle-forward
--     (draft -> active; the previously active version retires first;
--     one active per (tenant, service id) via the partial unique index).
--     This is CONTRACT VERSIONING — the Service Work state machine stays
--     the frozen /workflow authority (architecture-lock #31); a binding
--     referencing a non-canonical state or illegal transition is
--     rejected by the module's validation against the /workflow public
--     contract before any row exists.
--   * Customer configurations are versioned, immutable-in-content and
--     pinned to the service version they were validated against
--     (composite foreign key). The module validates every adjustment
--     against the service's declared contract BEFORE persistence: policy
--     parameter values within the schema, SLA deadlines only tighter,
--     approval thresholds only stricter — weakened content never
--     persists (AC-3; architecture-lock #33). Workflow bindings, outcome
--     contracts, capability requirements and pricing are structurally
--     non-configurable: no column exists to carry them.
--   * No provider/adapter state exists anywhere in this schema: external
--     integration bindings are declarative capability-class names; the
--     provider-neutral adapters are the /integrations + /interactions
--     authorities (WORK-015).

-- ---------------------------------------------------------------------------
-- /verticals: versioned vertical-package registrations (the domain catalog)
-- ---------------------------------------------------------------------------
CREATE TABLE verticals_packages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  -- Stable logical package id (e.g. 'construction').
  package_id              TEXT NOT NULL,
  -- Monotonic contiguous version per (tenant, package_id); allocated
  -- through the store's advisory-locked sequencing.
  version                 INTEGER NOT NULL CHECK (version > 0),
  name                    TEXT NOT NULL,
  description             TEXT,
  -- Domain glossary: { term: definition } (validated, bounded).
  terminology             JSONB NOT NULL,
  -- Entity definitions: [{ name, description?, fields: [{ name, type, required }] }] (declarative).
  entities                JSONB NOT NULL,
  -- Work-type definitions: [{ name, description?, defaultSlaHours? }] (declarative).
  work_types              JSONB NOT NULL,
  -- Workflow-step declarations: [{ step, description?, workType?, entity? }] (declarative).
  workflow_steps          JSONB NOT NULL,
  -- Policy parameter defaults: [{ policyKey, parameters: [{ name, defaultValue }] }] — VALUES ONLY, never rules.
  policy_defaults         JSONB NOT NULL,
  -- Approval matrix: [{ id, workType?, role, threshold }] (declarative floors).
  approval_matrix         JSONB NOT NULL,
  -- Evidence requirement declarations: [{ name, description? }].
  evidence_requirements   JSONB NOT NULL,
  -- Integration binding declarations: [{ capabilityClass, description? }] — NAMES ONLY.
  integration_bindings    JSONB NOT NULL,
  -- AI capability REQUIREMENT declarations: [{ capability, minQuality?, maxLatencyMs?, description? }]
  -- (provider-neutral names + bounds; selection is impossible by shape).
  required_ai_capabilities JSONB NOT NULL,
  -- Declarative pricing rules: [{ id, description?, model, amount?, currency? }].
  pricing_rules           JSONB NOT NULL,
  -- sha256 over the canonical package content (convergence matching).
  content_hash            TEXT NOT NULL,
  -- Integrity hash over the canonical record core (tamper detection on read).
  record_hash             TEXT NOT NULL,
  created_by              UUID NOT NULL REFERENCES auth_users (id),
  -- Durable idempotency identity for externally-triggered registration.
  idempotency_key         TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, package_id, version)
);
COMMENT ON TABLE verticals_packages IS 'Vertical package versions: the tenant-bound, immutable-in-content domain catalog (/verticals authority; declarative data only, never executable vertical logic)';

-- Two actors registering the same logical package (tenant + idempotency
-- key) converge on one durable identity (concurrency proof).
CREATE UNIQUE INDEX verticals_packages_tenant_idempotency_key
  ON verticals_packages (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX verticals_packages_tenant_idx ON verticals_packages (tenant_id, package_id, version);

-- ---------------------------------------------------------------------------
-- /services: versioned service definitions (the binding layer)
-- ---------------------------------------------------------------------------
CREATE TABLE services_definitions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  -- Stable logical service id (e.g. 'subcontractor-compliance').
  service_id              TEXT NOT NULL,
  version                 INTEGER NOT NULL CHECK (version > 0),
  -- Contract VERSIONING (the service-package lifecycle), never the
  -- Service Work state machine: draft -> active (forward only, one
  -- active per identity); retired is terminal.
  status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  name                    TEXT NOT NULL,
  description             TEXT,
  -- The PINNED vertical package version this service binds. The composite
  -- foreign key makes binding-to-registered-packages a database-level
  -- invariant: a service definition can never reference a package
  -- version that does not exist in the same tenant.
  vertical_package_id     TEXT NOT NULL,
  vertical_package_version INTEGER NOT NULL CHECK (vertical_package_version > 0),
  FOREIGN KEY (tenant_id, vertical_package_id, vertical_package_version)
    REFERENCES verticals_packages (tenant_id, package_id, version),
  -- Entity bindings: [{ entity, required }] (references package entities).
  entities                JSONB NOT NULL,
  -- Work definitions: [{ workType, description? }] (references package work types).
  work_definitions        JSONB NOT NULL,
  -- Workflow-definition bindings: [{ step, from, to, description? }] —
  -- every (from, to) edge is validated against the FROZEN canonical
  -- Service Work state machine through /workflow's public contract
  -- before any row exists (architecture-lock #31).
  workflow_binding        JSONB NOT NULL,
  -- Business-policy configuration SCHEMA: [{ policyKey, parameters: [{ name, type, required, min?, max?, values?, defaultValue? }] }]
  -- — schema only, never rules/effects (the /policies authority owns those).
  policy_configuration    JSONB NOT NULL,
  -- Approval rule bindings: [{ id, threshold }] (>= the package's floor).
  approval_rules          JSONB NOT NULL,
  -- SLA defaults: [{ workType, deadlineHours }] (<= the package's floor).
  sla_defaults            JSONB NOT NULL,
  -- The business outcome contract (output schema + evidence + verification mode).
  outcome_contract        JSONB NOT NULL,
  -- Declarative external capability-class names (subset of the package's bindings).
  required_external_capabilities JSONB NOT NULL,
  -- AI capability REQUIREMENT declarations (subset of the package's; names + bounds only).
  required_ai_capabilities JSONB NOT NULL,
  -- Declarative pricing/metering metadata ({ model, amount?, currency?, metering: [...] }).
  pricing                 JSONB NOT NULL,
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  created_by              UUID NOT NULL REFERENCES auth_users (id),
  idempotency_key         TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, service_id, version)
);
COMMENT ON TABLE services_definitions IS 'Service definition versions: the tenant-bound, immutable-in-content binding of vertical semantics to the horizontal runtime (/services authority; workflow bindings validated against the frozen /workflow machine)';

-- One active version per (tenant, service id): activation retires the
-- prior active version first (per-statement enforcement, like the
-- /policies one-active index).
CREATE UNIQUE INDEX services_definitions_one_active
  ON services_definitions (tenant_id, service_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX services_definitions_tenant_idempotency_key
  ON services_definitions (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX services_definitions_tenant_idx ON services_definitions (tenant_id, service_id, version);

-- ---------------------------------------------------------------------------
-- /services: customer configurations (specialize, never weaken)
-- ---------------------------------------------------------------------------
CREATE TABLE services_configurations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  service_id              TEXT NOT NULL,
  -- The service-definition version this configuration was validated
  -- against and pins (composite foreign key: always a REGISTERED
  -- version of the same tenant).
  service_version         INTEGER NOT NULL CHECK (service_version > 0),
  FOREIGN KEY (tenant_id, service_id, service_version)
    REFERENCES services_definitions (tenant_id, service_id, version),
  -- Store-allocated monotonic configuration version per (tenant, service_id).
  configuration_version   INTEGER NOT NULL CHECK (configuration_version > 0),
  -- Same forward-only contract versioning as service definitions.
  status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  -- Policy parameter values WITHIN the service's declared schema:
  -- [{ policyKey, values: { name: value } }] — values only, never rules.
  policy_parameters       JSONB NOT NULL,
  -- SLA tightening: [{ workType, deadlineHours }] (<= the service's default
  -- at registration time; a looser value is rejected BEFORE persistence).
  sla_adjustments         JSONB NOT NULL,
  -- Approval strengthening: [{ id, threshold }] (>= the service's
  -- requirement at registration time; a weaker value is rejected BEFORE
  -- persistence).
  approval_adjustments    JSONB NOT NULL,
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  created_by              UUID NOT NULL REFERENCES auth_users (id),
  idempotency_key         TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, service_id, configuration_version)
);
COMMENT ON TABLE services_configurations IS 'Customer service configurations: versioned, immutable-in-content specializations of an ACTIVE service definition, validated weakening-free before persistence (/services authority, AC-3)';

-- One active configuration per (tenant, service id).
CREATE UNIQUE INDEX services_configurations_one_active
  ON services_configurations (tenant_id, service_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX services_configurations_tenant_idempotency_key
  ON services_configurations (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX services_configurations_tenant_idx ON services_configurations (tenant_id, service_id, configuration_version);
