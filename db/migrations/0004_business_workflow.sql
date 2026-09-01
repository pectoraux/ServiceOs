-- ServiceOS migration 0004 — Business Workflow Authority (WORK-004).
--
-- Scope: the durable state owned by the /workflow module (Work Order frozen
-- scope: "/workflow module, deterministic Service Work transition rules,
-- transition preconditions, transition persistence/audit integration,
-- SLA/continuation orchestration hooks").
--
-- Authority boundaries encoded in the schema:
--   * Migration 0002 deliberately shipped ServiceWork.status as a CLOSED
--     one-value enumeration ('draft') "until WORK-004 extends it through its
--     own authority": THIS migration is that sanctioned extension. The
--     enumeration below is the canonical ServiceOS business workflow state
--     machine from architecture.md §7 (DRAFT -> READY -> ACCEPTED ->
--     IN_PROGRESS <-> WAITING_INFORMATION/WAITING_APPROVAL/BLOCKED ->
--     VERIFYING -> COMPLETED, plus the alternative terminal states
--     CANCELLED/FAILED/EXPIRED). The /work module still never writes any
--     status but 'draft'; only the /workflow authority performs transitions
--     (enforced structurally by the workflow boundary checks: no module
--     other than /workflow may UPDATE work_service_works.status).
--   * workflow_transitions is the APPEND-ONLY transition ledger: one durable
--     row per applied transition, carrying the canonical rule id, the
--     evaluated preconditions (dependency gate outcome, consulted policy
--     decision), actor provenance, a durable idempotency identity, the
--     deterministic input hash and an integrity hash over the record core.
--     Transition rows are never updated or deleted — workflow mutations are
--     auditable by construction, and after-the-fact mutation is detectable
--     on read (record_hash recomputation).
--   * workflow_sla_deadlines is the SLA orchestration hook data: the
--     deadline a work must not remain in one state past. Deadline VALUES
--     are supplied through the module's public contract (service-definition
--     SLA defaults are future /services surface); the module only evaluates
--     breaches deterministically. The EXPIRED enforcement transition still
--     goes through the single transition authority — this table never
--     mutates work state and no scheduler exists here.
--   * NO Zeck execution state anywhere: Zeck results are inputs to business
--     decisions only (architecture-lock #19; a foreign execution status
--     never becomes ServiceOS workflow state — AC-3).
--
-- Tenancy discipline (established by migration 0001): every durable row
-- carries a NOT NULL tenant_id referencing org_service_tenants(id) and is
-- queried only through a mandatory tenant predicate.

-- ---------------------------------------------------------------------------
-- /workflow: extend the ServiceWork status enumeration (transition boundary)
-- ---------------------------------------------------------------------------
-- Drop whatever CHECK constraint migration 0002 left on work_service_works
-- (PostgreSQL names the inline constraint work_service_works_status_check;
-- the lookup is by definition so a renamed constraint still gets replaced)
-- and re-add the full canonical business workflow enumeration.
DO $$
DECLARE existing text;
BEGIN
  SELECT conname INTO existing
  FROM pg_constraint
  WHERE conrelid = 'work_service_works'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ~ 'status';
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE work_service_works DROP CONSTRAINT %I', existing);
  END IF;
END $$;

ALTER TABLE work_service_works
  ADD CONSTRAINT work_service_works_status_check
  CHECK (status IN (
    'draft',
    'ready',
    'accepted',
    'in_progress',
    'waiting_information',
    'waiting_approval',
    'blocked',
    'verifying',
    'completed',
    'cancelled',
    'failed',
    'expired'
  ));

-- ---------------------------------------------------------------------------
-- /workflow: the append-only transition ledger (persistence + audit)
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_transitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The ServiceWork whose business state transitioned. The status column of
  -- this work is the /workflow transition boundary (updated only inside the
  -- same transaction that inserts this row).
  work_id         UUID NOT NULL REFERENCES work_service_works (id),
  -- Monotonic per-work ledger sequence, allocated under the work-row lock
  -- (like /work's attempt numbering): the append-only ledger has a strict
  -- per-work order even when timestamps collide.
  seq             INTEGER NOT NULL CHECK (seq > 0),
  -- The canonical machine states (architecture.md §7; lowercase, matching
  -- the works status enumeration). A transition is never a self-loop.
  from_state      TEXT NOT NULL CHECK (from_state IN ('draft','ready','accepted','in_progress','waiting_information','waiting_approval','blocked','verifying','completed','cancelled','failed','expired')),
  to_state        TEXT NOT NULL CHECK (to_state IN ('draft','ready','accepted','in_progress','waiting_information','waiting_approval','blocked','verifying','completed','cancelled','failed','expired')),
  CHECK (from_state <> to_state),
  -- The canonical rule that authorized this transition (deterministically
  -- derived by the authority: 'canonical:<from>-><to>' or
  -- 'terminal:<to>' for cancel/fail/expire entries).
  rule_id         TEXT NOT NULL,
  -- Evaluated preconditions pinned at decision time:
  -- { dependencies: { evaluated, satisfied }, policy: { decisionId, outcome } | null }
  preconditions   JSONB NOT NULL,
  -- Opaque business reason supplied by the submitting actor (never
  -- interpreted by the authority).
  reason          TEXT,
  -- Actor provenance (domain-model "identity rule").
  transitioned_by UUID NOT NULL REFERENCES auth_users (id),
  -- Durable idempotency identity: a keyed re-submission of the same logical
  -- transition converges on this row; a divergent re-submission fails closed.
  idempotency_key TEXT,
  -- Deterministic input revision: sha256 over the canonical submission core.
  input_hash      TEXT NOT NULL,
  -- Integrity hash over the canonical record core: after-the-fact mutation
  -- of any core field is detectable on read.
  record_hash     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Strict per-work ledger sequence (schema backstop; allocated under the
  -- work-row lock so it is race-free).
  UNIQUE (work_id, seq)
);
COMMENT ON TABLE workflow_transitions IS 'Append-only Service Work transition ledger: durable, attributable, idempotent workflow mutations with mutation-detectable provenance and strict per-work sequence (/workflow authority; the single deterministic transition engine)';

-- One durable transition per (tenant, idempotency key): concurrent keyed
-- submissions of the same logical transition converge on one record.
CREATE UNIQUE INDEX workflow_transitions_tenant_idempotency_key
  ON workflow_transitions (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX workflow_transitions_tenant_idx ON workflow_transitions (tenant_id);
CREATE INDEX workflow_transitions_work_idx ON workflow_transitions (tenant_id, work_id, seq);

-- ---------------------------------------------------------------------------
-- /workflow: SLA orchestration hook data (deadlines; never a state machine)
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_sla_deadlines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES org_service_tenants (id),
  work_id         UUID NOT NULL REFERENCES work_service_works (id),
  -- The state this deadline applies to: the work must not remain in this
  -- state past deadline_at. Terminal states accept no deadlines (fail
  -- closed in the module; there is no continuation from a terminal state).
  state           TEXT NOT NULL CHECK (state IN ('draft','ready','accepted','in_progress','waiting_information','waiting_approval','blocked','verifying')),
  deadline_at     TIMESTAMPTZ NOT NULL,
  -- Actor provenance for the hook data (set/updated through the module).
  set_by          UUID NOT NULL REFERENCES auth_users (id),
  -- Durable idempotency identity for deadline creation.
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One deadline per (work, state): re-setting a deadline for the same state
  -- is the deliberate upsert through which orchestration extends an SLA.
  UNIQUE (work_id, state)
);
COMMENT ON TABLE workflow_sla_deadlines IS 'SLA orchestration hook data: per-state deadlines consumed by the deterministic breach evaluation; enforcement still flows through the single transition authority (/workflow authority)';

-- One durable deadline creation per (tenant, idempotency key).
CREATE UNIQUE INDEX workflow_sla_deadlines_tenant_idempotency_key
  ON workflow_sla_deadlines (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX workflow_sla_deadlines_tenant_idx ON workflow_sla_deadlines (tenant_id);
CREATE INDEX workflow_sla_deadlines_work_idx ON workflow_sla_deadlines (tenant_id, work_id);
