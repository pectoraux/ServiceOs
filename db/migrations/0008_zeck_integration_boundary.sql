-- ServiceOS migration 0008 — Zeck Integration Boundary (WORK-005).
--
-- Scope: the durable state owned by the /zeck module (Work Order frozen
-- scope: "ServiceOS AIExecutionIntent contract, Zeck execution-reference
-- persistence, Zeck webhook/callback translation, retry/idempotency
-- handling").
--
-- Tenancy discipline (established by migration 0001): every durable row
-- carries a NOT NULL tenant_id referencing org_service_tenants(id) and is
-- queried only through a mandatory tenant predicate.
--
-- Authority boundaries encoded in the schema:
--   * NO SHADOW ZECK EXECUTION DATABASE (architecture-lock #19; Work
--     Order forbidden surface): `zeck_execution_intents` is the
--     BUSINESS-SIDE LINKAGE ONLY — the ServiceOS intent identity, its
--     Service Work/Attempt correlation, the validated request content
--     and, once Zeck accepted a dispatch, the FOREIGN execution
--     reference plus ingestion metadata (last-seen event cursor). There
--     is NO execution status/state/lifecycle column anywhere: the
--     authoritative AI execution record remains in Zeck. (Work and
--     attempt identities are validated through /work's public read at
--     the module layer — the /billing precedent for cross-module
--     identity references — so no cross-module foreign keys.)
--   * ONE INTENT PER LOGICAL IDENTITY AND PER ATTEMPT: UNIQUE (tenant,
--     idempotency_key) — keyed registration convergence; UNIQUE
--     (tenant, work_attempt_id) — the durable correlation identity
--     (AC-2: a new logical AI request for the same attempt is the
--     idempotent retry of the same key, never a second intent).
--   * ONE EXECUTION REFERENCE PER INTENT, ONE INTENT PER FOREIGN
--     EXECUTION: the reference columns arrive together with submission
--     metadata (the pairing CHECK) and the partial UNIQUE (tenant,
--     zeck_execution_id) backstops the attach critical section —
--     duplicate requests converge on ONE reference (AC-6) and a
--     foreign identity can never be correlated to two intents.
--   * `zeck_callback_events` is the TRANSLATED DELIVERY LEDGER: one
--     immutable observation row per (tenant, event_id) — the replay
--     identity. A row records what was DELIVERED and what the boundary
--     did with it (disposition accepted/rejected + typed rejection
--     reason = durable fail-closed evidence). `observed` carries the
--     translated result observation for accepted events only — a claim
--     Zeck reported, never a business outcome and never an AI
--     usage/cost breakdown (the reported cost is an opaque pointer;
--     the AI economic ledger stays in Zeck).
--   * No credential surface: no key, secret, token or provider column
--     exists anywhere in this schema (AC-4; machine-checked by the
--     WORK-005 boundary checks).

-- ---------------------------------------------------------------------------
-- /zeck: AI Execution Intents (the business-side linkage)
-- ---------------------------------------------------------------------------
CREATE TABLE zeck_execution_intents (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The Service Work / Work Attempt correlation (validated through
  -- /work's public read; one intent per attempt).
  service_work_id         UUID NOT NULL,
  work_attempt_id         UUID NOT NULL,
  -- The validated AIExecutionIntent content (contract §2).
  objective               TEXT NOT NULL,
  input_artifact_refs     JSONB NOT NULL,
  business_context        JSONB NOT NULL,
  -- Capability REQUIREMENTS only (names + bounds); model/provider
  -- selection has no surface here or in the module (frozen validator).
  required_capabilities   JSONB NOT NULL,
  business_constraints    JSONB NOT NULL,
  output_contract         JSONB NOT NULL,
  idempotency_key         TEXT NOT NULL,
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  created_by              UUID NOT NULL REFERENCES auth_users (id),
  -- The FOREIGN execution reference (Zeck's identity, not a ServiceOS
  -- execution identity) with its submission metadata. No lifecycle.
  zeck_execution_id       TEXT,
  zeck_application_ref    TEXT,
  submitted_by            UUID REFERENCES auth_users (id),
  submitted_at            TIMESTAMPTZ,
  -- Ingestion metadata (contract §3): the last accepted callback cursor.
  last_seen_event_id      TEXT,
  last_seen_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  -- The reference and its submission metadata arrive together.
  CHECK (
    (zeck_execution_id IS NULL AND submitted_by IS NULL AND submitted_at IS NULL)
    OR (zeck_execution_id IS NOT NULL AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL)
  ),
  -- The last-seen cursor fields arrive together.
  CHECK (
    (last_seen_event_id IS NULL AND last_seen_at IS NULL)
    OR (last_seen_event_id IS NOT NULL AND last_seen_at IS NOT NULL)
  )
);

-- Keyed registration convergence (the durable logical identity).
CREATE UNIQUE INDEX zeck_execution_intents_tenant_idempotency_key
  ON zeck_execution_intents (tenant_id, idempotency_key);
-- The durable correlation identity: ONE intent per work attempt.
CREATE UNIQUE INDEX zeck_execution_intents_tenant_attempt
  ON zeck_execution_intents (tenant_id, work_attempt_id);
-- ONE intent per foreign execution identity (the attach backstop).
CREATE UNIQUE INDEX zeck_execution_intents_tenant_execution_ref
  ON zeck_execution_intents (tenant_id, zeck_execution_id) WHERE zeck_execution_id IS NOT NULL;
CREATE INDEX zeck_execution_intents_tenant_work_idx
  ON zeck_execution_intents (tenant_id, service_work_id);

-- ---------------------------------------------------------------------------
-- /zeck: translated callback deliveries (the observation ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE zeck_callback_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  -- Zeck's event identity (the replay/dedup identity).
  event_id                TEXT NOT NULL,
  -- The event type as delivered (the frozen translation enumeration is
  -- enforced by the module; rejected rows keep the raw observed string).
  event_type              TEXT NOT NULL,
  -- The foreign execution identity the delivery correlates to.
  zeck_execution_id       TEXT,
  -- The linked intent (accepted events always; conflicting-correlation
  -- rejections keep it as evidence).
  intent_id               UUID REFERENCES zeck_execution_intents (id),
  -- What the boundary did with the delivery. This is the DELIVERY's
  -- disposition, never a Zeck execution lifecycle.
  disposition             TEXT NOT NULL CHECK (disposition IN ('accepted', 'rejected')),
  rejection_code          TEXT CHECK (rejection_code IN ('unknown_event_type', 'invalid_payload', 'uncorrelated', 'conflicting_correlation')),
  -- The translated result observation (accepted events only; a claim
  -- reported by Zeck — never a business outcome).
  observed                JSONB,
  -- Hash over the delivery envelope as received (the replay identity).
  delivery_hash           TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  received_by             UUID NOT NULL REFERENCES auth_users (id),
  received_at             TIMESTAMPTZ NOT NULL,
  -- Disposition/rejection pairing is exact.
  CHECK (
    (disposition = 'accepted' AND rejection_code IS NULL)
    OR (disposition = 'rejected' AND rejection_code IS NOT NULL)
  ),
  -- Accepted deliveries are correlated and translated; rejected ones
  -- carry no observation.
  CHECK (
    (disposition = 'accepted' AND intent_id IS NOT NULL AND observed IS NOT NULL)
    OR (disposition = 'rejected' AND observed IS NULL)
  )
);

-- ONE delivery record per event identity: the replay backstop.
CREATE UNIQUE INDEX zeck_callback_events_tenant_event_id
  ON zeck_callback_events (tenant_id, event_id);
CREATE INDEX zeck_callback_events_tenant_intent_idx
  ON zeck_callback_events (tenant_id, intent_id);
CREATE INDEX zeck_callback_events_tenant_disposition_idx
  ON zeck_callback_events (tenant_id, disposition);
