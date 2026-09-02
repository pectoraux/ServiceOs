-- ServiceOS migration 0007 — Billing & Service Economics (WORK-011).
--
-- Scope: the durable state owned by the /billing module (Work Order
-- frozen scope: "billing subscriptions, service usage, work-based
-- metering, outcome-linked billing, margin reporting inputs").
--
-- Tenancy discipline (established by migration 0001): every durable row
-- carries a NOT NULL tenant_id referencing org_service_tenants(id) and is
-- queried only through a mandatory tenant predicate.
--
-- Authority boundaries encoded in the schema:
--   * ServiceOS OWNS CUSTOMER ECONOMICS; the AI usage/cost authority
--     (Zeck) stays authoritative for AI-side costs. The ONLY AI-side
--     surface here is billing_cost_references: NON-AUTHORITATIVE
--     references to external cost statements — an opaque pointer, the
--     reported total, and the source domain 'ai_authority'. There is NO
--     usage breakdown, NO provider, NO model, NO token accounting
--     anywhere in this schema: these rows are margin-analysis inputs,
--     never a replacement for the external AI economic ledger (Work
--     Order forbidden surface; the module's frozen forbidden-key
--     validator fails closed on smuggled breakdown fields).
--   * Subscriptions BIND the service catalog, never redefine it: each
--     row pins the ACTIVE service-definition version through the
--     composite foreign key into services_definitions (tenant, service,
--     version) — the service authority owns definitions and pricing
--     metadata; /billing owns the customer ledger.
--   * Usage rows reference REAL work identities (work_id) or the
--     service's declared outcome (outcome_id), deduplicated durably:
--     UNIQUE (tenant, work_id) / UNIQUE (tenant, outcome_id) — duplicate
--     billable work can never double-charge (Work Order discrimination
--     requirement). The billable identity is the work item, not the
--     metering call.
--   * Settlement is ONE authoritative outcome per (tenant,
--     subscription, period): the unique index backstops the store's
--     advisory-locked critical section; total_charge is the exact sum
--     of its components (schema-level arithmetic invariant).
--   * All money/quantity columns are NUMERIC (exact decimals — never
--     binary floating point); the module carries canonical decimal
--     strings end to end and content/record hashes over them.

-- ---------------------------------------------------------------------------
-- /billing: customer service subscriptions (the billing relationship)
-- ---------------------------------------------------------------------------
CREATE TABLE billing_subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The billed service; the pinned version is FK-bound to the catalog.
  service_id              TEXT NOT NULL,
  -- The ACTIVE service-definition version at registration (the billing
  -- contract; metering validates against THIS version).
  service_version         INTEGER NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('draft', 'active', 'cancelled')),
  -- The customer pricing plan: { model: subscription|work_based|hybrid,
  -- currency, recurringAmount|null, workRates: [{ metric, unitPrice }] }.
  -- Rate metrics/units are validated against the pinned version's
  -- declared metering rules by the module (values only; no rules).
  plan                    JSONB NOT NULL,
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  created_by              UUID NOT NULL REFERENCES auth_users (id),
  idempotency_key         TEXT,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  cancelled_at            TIMESTAMPTZ,
  -- The pinned version must exist in the service catalog (binding, not
  -- invention — /services stays the definition authority).
  FOREIGN KEY (tenant_id, service_id, service_version)
    REFERENCES services_definitions (tenant_id, service_id, version),
  CHECK (cancelled_at IS NULL OR status = 'cancelled')
);

-- One live (non-cancelled) subscription per (tenant, service): the
-- store's advisory-locked registration critical section plus this
-- partial unique backstop.
CREATE UNIQUE INDEX billing_subscriptions_one_live
  ON billing_subscriptions (tenant_id, service_id) WHERE status <> 'cancelled';
-- Keyed registration convergence (partial: keyless registrations allowed).
CREATE UNIQUE INDEX billing_subscriptions_tenant_idempotency_key
  ON billing_subscriptions (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX billing_subscriptions_tenant_service_idx
  ON billing_subscriptions (tenant_id, service_id, status);

-- ---------------------------------------------------------------------------
-- /billing: service usage records (work-based metering, outcome-linked
-- billing, keyed manual usage)
-- ---------------------------------------------------------------------------
CREATE TABLE billing_usage_records (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  subscription_id         UUID NOT NULL REFERENCES billing_subscriptions (id),
  service_id              TEXT NOT NULL,
  -- The pinned service-definition version the usage was validated against.
  service_version         INTEGER NOT NULL,
  source                  TEXT NOT NULL CHECK (source IN ('work', 'outcome', 'manual')),
  -- Metering metric + unit as declared by the pinned version.
  metric                  TEXT NOT NULL,
  unit                    TEXT NOT NULL,
  quantity                NUMERIC NOT NULL CHECK (quantity > 0),
  -- The billable work identity (source 'work'): deduplicated durably.
  work_id                 UUID,
  -- The verified outcome identity (source 'outcome').
  outcome_id              TEXT,
  occurred_at             TIMESTAMPTZ NOT NULL,
  -- 'YYYY-MM' derived from occurred_at (UTC).
  billing_period          TEXT NOT NULL CHECK (billing_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- The ledger entry this usage settled into (NULL until settled; the
  -- settlement critical section writes it together with the ledger row).
  settled_ledger_id       UUID,
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  created_by              UUID NOT NULL REFERENCES auth_users (id),
  idempotency_key         TEXT,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (tenant_id, service_id, service_version)
    REFERENCES services_definitions (tenant_id, service_id, version),
  -- Source/reference pairing (the billable identity is exact; manual
  -- usage is always keyed).
  CHECK (
    (source = 'work' AND work_id IS NOT NULL AND outcome_id IS NULL)
    OR (source = 'outcome' AND outcome_id IS NOT NULL AND work_id IS NULL)
    OR (source = 'manual' AND work_id IS NULL AND outcome_id IS NULL AND idempotency_key IS NOT NULL)
  )
);

-- Duplicate billable work can never double-charge: ONE usage row per
-- work identity (identical content converges; divergence fails closed
-- in the module/store).
CREATE UNIQUE INDEX billing_usage_records_one_per_work
  ON billing_usage_records (tenant_id, work_id) WHERE work_id IS NOT NULL;
-- Outcome-linked billing deduplicates on the outcome identity.
CREATE UNIQUE INDEX billing_usage_records_one_per_outcome
  ON billing_usage_records (tenant_id, outcome_id) WHERE outcome_id IS NOT NULL;
-- Keyed usage convergence (required for manual usage).
CREATE UNIQUE INDEX billing_usage_records_tenant_idempotency_key
  ON billing_usage_records (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX billing_usage_records_settlement_idx
  ON billing_usage_records (tenant_id, subscription_id, billing_period, settled_ledger_id);
CREATE INDEX billing_usage_records_tenant_idx
  ON billing_usage_records (tenant_id, service_id, occurred_at);

-- ---------------------------------------------------------------------------
-- /billing: the service billing ledger (one authoritative outcome per
-- subscription and period)
-- ---------------------------------------------------------------------------
CREATE TABLE billing_period_ledger (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  subscription_id         UUID NOT NULL REFERENCES billing_subscriptions (id),
  service_id              TEXT NOT NULL,
  billing_period          TEXT NOT NULL CHECK (billing_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  currency                TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The plan's recurring component for the period (exact decimal).
  subscription_charge     NUMERIC NOT NULL CHECK (subscription_charge >= 0),
  -- The priced usage component (exact decimal).
  usage_charge            NUMERIC NOT NULL CHECK (usage_charge >= 0),
  -- The total is the exact sum of its components (schema invariant).
  total_charge            NUMERIC NOT NULL CHECK (total_charge >= 0 AND total_charge = subscription_charge + usage_charge),
  -- How many usage rows this outcome settled.
  usage_count             INTEGER NOT NULL CHECK (usage_count >= 0),
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  settled_by              UUID NOT NULL REFERENCES auth_users (id),
  created_by              UUID NOT NULL REFERENCES auth_users (id),
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL
);

-- ONE authoritative ledger outcome per (tenant, subscription, period):
-- concurrent settlement converges (the store's advisory-locked critical
-- section plus this backstop).
CREATE UNIQUE INDEX billing_period_ledger_one_outcome
  ON billing_period_ledger (tenant_id, subscription_id, billing_period);
CREATE INDEX billing_period_ledger_tenant_idx
  ON billing_period_ledger (tenant_id, billing_period, created_at);

-- ---------------------------------------------------------------------------
-- /billing: external cost references (margin reporting inputs —
-- NON-AUTHORITATIVE)
-- ---------------------------------------------------------------------------
CREATE TABLE billing_cost_references (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  billing_period          TEXT NOT NULL CHECK (billing_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- The closed source enumeration: 'ai_authority' names the external AI
  -- cost authority DOMAIN — never a provider or model. No
  -- provider/model/token column exists in this table.
  source                  TEXT NOT NULL CHECK (source IN ('ai_authority')),
  -- Opaque pointer to the external authoritative cost statement.
  external_reference      TEXT NOT NULL,
  -- The reported cost total for the period (a non-authoritative copy for
  -- margin analysis; the authority stays external).
  amount                  NUMERIC NOT NULL CHECK (amount >= 0),
  currency                TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  recorded_by             UUID NOT NULL REFERENCES auth_users (id),
  idempotency_key         TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL
);

-- Keyed convergence (the key is the logical identity of the reference).
CREATE UNIQUE INDEX billing_cost_references_tenant_idempotency_key
  ON billing_cost_references (tenant_id, idempotency_key);
CREATE INDEX billing_cost_references_tenant_idx
  ON billing_cost_references (tenant_id, billing_period, created_at);
