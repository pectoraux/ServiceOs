-- ServiceOS migration 0011 — Durable Event Inbox/Outbox (WORK-006).
--
-- Scope: the durable event substrate owned by the /interactions module
-- (the module §6 owns "external communications"): the deduplicated
-- external event inbox (inbound provider events and callback ingestion)
-- and the outbound event outbox (durable intent before delivery, worker
-- dispatch through the provider-neutral event delivery port).
--
-- Authority boundaries encoded in the schema:
--   * event_inbox is THE durable external event surface: one row per
--     stable identity (tenant, source, external event id — the
--     provider's own event identity preserved verbatim,
--     architecture-lock #20), carrying the delivery hash over the
--     canonical envelope (the replay identity: identical re-deliveries
--     converge, divergent re-deliveries fail closed — AC-1 duplicate
--     inbound events converge), the ingress-validation disposition
--     (rejected deliveries are DURABLE evidence with a closed rejection
--     code vocabulary — the same durable-ingestion guarantees the
--     /zeck callback ledger applies, AC-4), the processing claim (the
--     crash-window marker for worker dispatch), the consumer's durable
--     completion result (consumed: ONE domain effect per event through
--     the idempotent consumer) or the explicit typed retryable failure.
--   * event_outbox is THE durable outbound event intent: one row per
--     keyed logical intent, carrying the authority-DERIVED content
--     (interaction.observed payloads are derived from the interaction
--     authority's terminal observation at intent time — the caller
--     supplies the subject and the destination, never the content), the
--     policy-gate provenance, the dispatch claim (the crash-window
--     marker), and the recorded delivery acceptance or the explicit
--     dispatch failure. Durable intent exists BEFORE any delivery
--     attempt and survives a crash between intent and dispatch (AC-2:
--     outbound events are not silently lost after durable intent).
--   * NO Service Work state, NO business outcome state, and NO AI
--     execution state anywhere in these tables: a consumed inbox event
--     records the observation THROUGH /interactions' observation
--     authority (the one path); a dispatched outbox event is a delivery
--     acceptance, never a business completion; the business outcome
--     authorities decide separately. No Zeck lifecycle columns (the
--     /zeck callback ledger keeps its own authority; these tables only
--     mirror its INGESTION guarantees).
--   * The event vocabularies are FROZEN HORIZONTAL enumerations (closed
--     CHECKs; frozen code, never data): the inbound source taxonomy is
--     the /integrations capability classes (Zeck deliberately absent —
--     its callbacks flow through /zeck's boundary), the event types are
--     horizontal only (interaction.delivery_result inbound,
--     interaction.observed outbound) — NO vertical-specific event
--     meanings (WORK-006 forbidden surface, checked structurally).
--
-- Tenancy discipline (established by migration 0001): every durable row
-- carries a NOT NULL tenant_id referencing org_service_tenants(id) and is
-- queried only through a mandatory tenant predicate (AC-3).

-- ---------------------------------------------------------------------------
-- /interactions: the durable event inbox
-- ---------------------------------------------------------------------------
CREATE TABLE event_inbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The frozen provider-neutral event source (the /integrations
  -- capability classes; Zeck deliberately absent — /zeck's boundary).
  source          TEXT NOT NULL CHECK (source IN (
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
  -- The provider's own stable event identity, preserved verbatim
  -- (architecture-lock #20: external provider identities are preserved
  -- verbatim where required for audit/idempotency).
  external_event_id TEXT NOT NULL,
  -- The frozen horizontal inbound event vocabulary (closed; extended
  -- only through future Work Orders' frozen scopes — never vertical
  -- meanings).
  event_type      TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  -- The contract-validated payload (validated by the module's ingress
  -- validation BEFORE persistence; rejected deliveries carry the
  -- canonical raw payload as evidence).
  payload         JSONB NOT NULL,
  -- sha256 over the canonical delivery envelope: the REPLAY identity
  -- (identical re-delivery converges; divergence fails closed).
  delivery_hash   TEXT NOT NULL,
  -- The closed inbox lifecycle.
  state           TEXT NOT NULL CHECK (state IN ('received','processing','consumed','failed','rejected')),
  -- The durable rejection evidence (state 'rejected' only; the closed
  -- /zeck-callback-vocabulary discipline).
  rejection_code  TEXT CHECK (rejection_code IN ('unknown_event_type','invalid_payload','uncorrelated')),
  rejection_rejected_at TIMESTAMPTZ,
  -- The processing claim (the crash-window marker): present from
  -- claiming on; never removed (recovery REFRESHES it).
  claimed_by      UUID REFERENCES auth_users (id),
  claimed_at      TIMESTAMPTZ,
  -- The consumer's durable completion (state 'consumed', terminal): the
  -- result summary of the ONE domain effect (e.g. the observed
  -- interaction), attributed.
  consumer_result JSONB,
  consumed_by     UUID REFERENCES auth_users (id),
  consumed_at     TIMESTAMPTZ,
  -- The explicit typed consumer failure (state 'failed', retryable):
  -- code + message + timestamp, attributed by the claim.
  failure_code    TEXT,
  failure_message TEXT,
  failure_failed_at TIMESTAMPTZ,
  -- Actor provenance (who received the delivery).
  received_by     UUID NOT NULL REFERENCES auth_users (id),
  -- Integrity hash over the canonical record core: recomputed by every
  -- legitimate state write, verified on every read (tamper-evident).
  record_hash     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lifecycle shape invariants (schema-level backstops of the store's
  -- state machine). The legal shapes:
  --   received  : nothing set
  --   rejected  : the rejection is set
  --   processing: the claim is set
  --   consumed  : claim + the consumption record are set
  --   failed    : claim + the failure record are set
  CHECK ((state = 'received') = (claimed_by IS NULL AND claimed_at IS NULL
                                  AND consumer_result IS NULL AND consumed_by IS NULL AND consumed_at IS NULL
                                  AND failure_code IS NULL AND failure_message IS NULL AND failure_failed_at IS NULL
                                  AND rejection_code IS NULL AND rejection_rejected_at IS NULL)),
  CHECK ((state = 'rejected') = (rejection_code IS NOT NULL AND rejection_rejected_at IS NOT NULL)),
  CHECK ((state IN ('processing','consumed','failed')) = (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((state = 'rejected') = (claimed_by IS NULL AND claimed_at IS NULL
                                  AND consumer_result IS NULL AND consumed_by IS NULL AND consumed_at IS NULL
                                  AND failure_code IS NULL AND failure_message IS NULL AND failure_failed_at IS NULL)),
  CHECK ((state = 'consumed') = (consumer_result IS NOT NULL AND consumed_by IS NOT NULL AND consumed_at IS NOT NULL)),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL AND failure_message IS NOT NULL AND failure_failed_at IS NOT NULL))
);
COMMENT ON TABLE event_inbox IS 'Durable external event inbox: one deduplicated delivery record per stable identity (tenant, source, external event id) with the claimed, idempotent processing lifecycle; rejected deliveries are durable evidence; the consumer records exactly one domain effect through the /interactions observation authority (/interactions event substrate, WORK-006)';

-- ONE durable inbox record per stable identity: concurrent re-deliveries
-- converge on one record; divergent re-deliveries fail closed typed.
CREATE UNIQUE INDEX event_inbox_stable_identity
  ON event_inbox (tenant_id, source, external_event_id);
CREATE INDEX event_inbox_tenant_idx ON event_inbox (tenant_id, created_at);
-- The worker-dispatch claim surface: received (claimable) events.
CREATE INDEX event_inbox_claimable_idx ON event_inbox (tenant_id, created_at)
  WHERE state = 'received';
-- The crash-recovery scan surface: claimed-but-unsettled processing.
CREATE INDEX event_inbox_recoverable_idx ON event_inbox (tenant_id, claimed_at)
  WHERE state = 'processing';
CREATE INDEX event_inbox_source_idx ON event_inbox (tenant_id, source);

-- ---------------------------------------------------------------------------
-- /interactions: the durable event outbox
-- ---------------------------------------------------------------------------
CREATE TABLE event_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The frozen horizontal outbound event vocabulary (closed; extended
  -- only through future Work Orders' frozen scopes — never vertical
  -- meanings).
  event_type      TEXT NOT NULL CHECK (event_type IN ('interaction.observed')),
  -- The authority-DERIVED, pinned content (derived from the
  -- interaction authority's terminal observation at intent time; the
  -- caller supplies the subject and the destination, never the
  -- content).
  payload         JSONB NOT NULL,
  -- The provider-neutral destination reference (resolved by the
  -- delivery port adapter; real adapters belong to the Work Order
  -- owning provider/destination configuration).
  destination     TEXT NOT NULL,
  -- Inert reference data ({ workId, ... }): recorded, never enforced.
  correlation     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Policy-gate provenance pinned at intent time (both columns
  -- together or both null).
  policy_key      TEXT,
  policy_decision_id UUID,
  -- Actor provenance.
  requested_by    UUID NOT NULL REFERENCES auth_users (id),
  -- Durable intent identity: a keyed re-submission converges on this
  -- row; a divergent re-submission fails closed.
  idempotency_key TEXT,
  -- Deterministic input revision: sha256 over the canonical intent core.
  input_hash      TEXT NOT NULL,
  -- Integrity hash over the canonical record core (tamper-evident).
  record_hash     TEXT NOT NULL,
  -- The closed outbox lifecycle.
  state           TEXT NOT NULL CHECK (state IN ('intended','dispatching','dispatched','failed')),
  -- The dispatch claim (the crash-window marker): present from claiming
  -- on; never removed (recovery REFRESHES it).
  claimed_by      UUID REFERENCES auth_users (id),
  claimed_at      TIMESTAMPTZ,
  -- The recorded delivery acceptance (state 'dispatched'; the
  -- provider-neutral delivery port's acceptance — never a business
  -- outcome).
  provider        TEXT,
  provider_reference TEXT,
  dispatched_at   TIMESTAMPTZ,
  dispatched_by   UUID REFERENCES auth_users (id),
  -- The explicit dispatch failure (state 'failed'; the delivery port
  -- invocation failed — explicit, durable, terminal for this identity).
  failure_code    TEXT,
  failure_message TEXT,
  failure_failed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lifecycle shape invariants (schema-level backstops). The legal
  -- shapes:
  --   intended  : nothing set
  --   dispatching: the claim is set
  --   dispatched: claim + the delivery acceptance are set
  --   failed    : claim + the failure record are set
  CHECK ((state = 'intended') = (claimed_by IS NULL AND claimed_at IS NULL
                                  AND provider IS NULL AND provider_reference IS NULL
                                  AND dispatched_at IS NULL AND dispatched_by IS NULL
                                  AND failure_code IS NULL AND failure_message IS NULL AND failure_failed_at IS NULL)),
  CHECK ((state IN ('dispatching','dispatched','failed')) = (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((state = 'dispatched') = (provider IS NOT NULL AND dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL)),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL AND failure_message IS NOT NULL AND failure_failed_at IS NOT NULL)),
  -- A provider reference without its provider is meaningless.
  CHECK (provider_reference IS NULL OR provider IS NOT NULL),
  CHECK ((policy_key IS NULL) = (policy_decision_id IS NULL))
);
COMMENT ON TABLE event_outbox IS 'Durable outbound event outbox: the authority-derived event intent persisted BEFORE any delivery attempt (never silently lost), dispatched through the provider-neutral event delivery port with a claimed, crash-recoverable, idempotent delivery lifecycle (/interactions event substrate, WORK-006)';

-- One durable outbox event per (tenant, idempotency key): concurrent
-- keyed submissions of the same logical intent converge on one record.
CREATE UNIQUE INDEX event_outbox_tenant_idempotency_key
  ON event_outbox (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX event_outbox_tenant_idx ON event_outbox (tenant_id, created_at);
-- The crash-recovery scan surface: claimed-but-unsettled dispatches.
CREATE INDEX event_outbox_recoverable_idx ON event_outbox (tenant_id, claimed_at)
  WHERE state = 'dispatching';
-- Correlation lookups (e.g. all events correlated to one work).
CREATE INDEX event_outbox_correlation_idx ON event_outbox USING gin (correlation jsonb_path_ops);
