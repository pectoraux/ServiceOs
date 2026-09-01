-- ServiceOS migration 0005 — External Interaction & Integration Authority
-- (WORK-015).
--
-- Scope: the durable state owned by the /interactions module (the
-- provider-neutral interaction ledger) and the /notifications module
-- (notification delivery requests). The /integrations module owns NO
-- durable state: it is the provider-neutral capability contracts and the
-- adapter registry (code, injected at the composition root).
--
-- Authority boundaries encoded in the schema:
--   * interaction_effects is THE business side-effect boundary's ledger:
--     one durable row per external effect, carrying the provider-neutral
--     capability class and its contract-validated params, the intent
--     identity (tenant-scoped idempotency key + deterministic input
--     hash), the dispatch claim (the crash-window marker), the recorded
--     provider acceptance, and the OBSERVED result with an explicit
--     outcome. The lifecycle is closed ('intended' -> 'dispatching' ->
--     'dispatched' -> 'observed') and shape-checked so a row can never
--     claim an acceptance without a claim, an observation without an
--     acceptance, or a failure stage without a failed outcome.
--   * NO Service Work state is written anywhere in this migration's
--     tables: work_service_works.status belongs to the /workflow
--     authority alone (WORK-004 checks reject any other writer). A
--     provider success recorded here is an OBSERVATION; business outcome
--     authority decides separately (Work Order AC-4).
--   * `correlation` is INERT reference data (e.g. { "workId": "..." }):
--     recorded for audit and lineage, never a foreign key and never
--     consulted by the interaction authority (no state coupling between
--     the effect boundary and business subjects).
--   * retry_of_interaction_id records the retry lineage: a retry is a
--     DISTINCT durable identity created after an observed FAILURE (the
--     store validates the target's state in transaction); the original
--     observation is never rewritten.
--   * notification_requests carries the delivery REQUESTS (business
--     meaning: who/what/why/channel) plus the POINTER to the current
--     interaction. Delivery status is DERIVED from the interaction's
--     durable state through /interactions' public contract — this table
--     deliberately has NO delivery-status column (no second observation
--     authority, architecture.md §2.11).
--   * NO Zeck/AI execution state anywhere: AI execution intents belong to
--     the /zeck module (WORK-005); this migration's capability
--     enumeration contains only the non-AI external systems.
--
-- Tenancy discipline (established by migration 0001): every durable row
-- carries a NOT NULL tenant_id referencing org_service_tenants(id) and is
-- queried only through a mandatory tenant predicate.

-- ---------------------------------------------------------------------------
-- /interactions: the provider-neutral interaction ledger
-- ---------------------------------------------------------------------------
CREATE TABLE interaction_effects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The frozen provider-neutral capability class (integration-model.md
  -- initial categories minus Zeck, which is the /zeck module's boundary).
  capability      TEXT NOT NULL CHECK (capability IN (
    'email',
    'sms',
    'voice',
    'accounting_erp',
    'crm',
    'construction_management',
    'property_management',
    'procurement',
    'payment',
    'document_storage',
    'government_portal'
  )),
  -- The capability class's contract-validated params (validated by
  -- /integrations' validateEffectParams before the intent is persisted).
  params          JSONB NOT NULL,
  -- Inert reference data ({ workId, attemptId, ... }): recorded, never
  -- enforced; the interaction authority consults no business state.
  correlation     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Retry lineage: the observed-FAILED interaction this one retries (the
  -- store validates the target in transaction; observations are never
  -- rewritten).
  retry_of_interaction_id UUID REFERENCES interaction_effects (id),
  -- Policy-gate provenance pinned at intent time (both columns together
  -- or both null).
  policy_key      TEXT,
  policy_decision_id UUID,
  -- Actor provenance (domain-model "identity rule").
  requested_by    UUID NOT NULL REFERENCES auth_users (id),
  -- Durable intent identity: a keyed re-submission converges on this row;
  -- a divergent re-submission fails closed.
  idempotency_key TEXT,
  -- Deterministic input revision: sha256 over the canonical intent core.
  input_hash      TEXT NOT NULL,
  -- Integrity hash over the canonical record core: recomputed by every
  -- legitimate state write, verified on every read (tamper-evident).
  record_hash     TEXT NOT NULL,
  -- The closed interaction lifecycle.
  state           TEXT NOT NULL CHECK (state IN ('intended','dispatching','dispatched','observed')),
  -- The dispatch claim (the crash-window marker): present from claiming
  -- on; never removed (recovery REFRESHES it).
  claim_claimed_by UUID REFERENCES auth_users (id),
  claim_claimed_at TIMESTAMPTZ,
  -- The recorded provider acceptance (present from dispatching-completion
  -- on; provider_reference may be null for providers that issue none).
  provider        TEXT,
  provider_reference TEXT,
  dispatched_at   TIMESTAMPTZ,
  dispatched_by   UUID REFERENCES auth_users (id),
  -- The observed result (terminal): explicit outcome, failure stage and
  -- the provider's own observation payload.
  outcome         TEXT CHECK (outcome IN ('succeeded','failed')),
  failure_stage   TEXT CHECK (failure_stage IN ('dispatch','provider')),
  observed_by     UUID REFERENCES auth_users (id),
  observed_at     TIMESTAMPTZ,
  provider_observation JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lifecycle shape invariants (schema-level backstops of the store's
  -- state machine; the module/store are the authority):
  CHECK ((state = 'intended') = (claim_claimed_by IS NULL AND claim_claimed_at IS NULL
                                  AND provider IS NULL AND dispatched_at IS NULL AND dispatched_by IS NULL
                                  AND outcome IS NULL AND observed_by IS NULL AND observed_at IS NULL)),
  CHECK ((state IN ('dispatching','dispatched','observed')) = (claim_claimed_by IS NOT NULL AND claim_claimed_at IS NOT NULL)),
  CHECK ((state IN ('dispatched','observed')) = (provider IS NOT NULL AND dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL)),
  CHECK ((state = 'observed') = (outcome IS NOT NULL AND observed_by IS NOT NULL AND observed_at IS NOT NULL
                                  AND provider_observation IS NOT NULL)),
  CHECK (failure_stage IS NULL OR outcome = 'failed'),
  CHECK ((policy_key IS NULL) = (policy_decision_id IS NULL))
);
COMMENT ON TABLE interaction_effects IS 'Provider-neutral external interaction ledger: the durable business side-effect boundary (durable intent -> dispatch claim -> provider acceptance -> observed result); a provider success is an observation, never an automatic business completion (/interactions authority, WORK-015)';

-- One durable interaction per (tenant, idempotency key): concurrent keyed
-- submissions of the same logical intent converge on one record.
CREATE UNIQUE INDEX interaction_effects_tenant_idempotency_key
  ON interaction_effects (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX interaction_effects_tenant_idx ON interaction_effects (tenant_id, created_at);
-- The crash-recovery scan surface: claimed-but-unsettled dispatches.
CREATE INDEX interaction_effects_recoverable_idx ON interaction_effects (tenant_id, claim_claimed_at)
  WHERE state = 'dispatching';
CREATE INDEX interaction_effects_capability_idx ON interaction_effects (tenant_id, capability);
-- Correlation lookups (e.g. all effects correlated to one work).
CREATE INDEX interaction_effects_correlation_idx ON interaction_effects USING gin (correlation jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- /notifications: notification delivery requests
-- ---------------------------------------------------------------------------
CREATE TABLE notification_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The delivery channel (a projection of the /integrations capability
  -- taxonomy; proven by test, never a cross-module structural dependency).
  channel         TEXT NOT NULL CHECK (channel IN ('email','sms','voice')),
  -- The addressee: { "address": string, "displayName"?: string }.
  recipient       JSONB NOT NULL,
  -- The content: { "subject"?: string (email only), "body": string }.
  content         JSONB NOT NULL,
  -- Inert business meaning (e.g. "compliance-followup").
  purpose         TEXT,
  -- Inert reference data (e.g. { "workId": "..." }).
  correlation     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Actor provenance.
  requested_by    UUID NOT NULL REFERENCES auth_users (id),
  -- Durable request identity (keyed convergence).
  idempotency_key TEXT,
  input_hash      TEXT NOT NULL,
  record_hash     TEXT NOT NULL,
  -- The /interactions record currently carrying this notification's
  -- effect. Delivery status is DERIVED from that record's durable state
  -- (no delivery-status column here: no second observation authority).
  current_interaction_id UUID REFERENCES interaction_effects (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE notification_requests IS 'Notification delivery requests: durable request identity and the pointer to the current delivery interaction; delivery status is derived through /interactions public contract, failures are explicit and recoverable through retry interactions (/notifications authority, WORK-015)';

-- One durable notification request per (tenant, idempotency key).
CREATE UNIQUE INDEX notification_requests_tenant_idempotency_key
  ON notification_requests (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX notification_requests_tenant_idx ON notification_requests (tenant_id, created_at);
CREATE INDEX notification_requests_interaction_idx ON notification_requests (tenant_id, current_interaction_id);
