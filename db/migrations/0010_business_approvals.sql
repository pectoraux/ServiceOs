-- ServiceOS migration 0010 — Business/Human Approval (WORK-008).
--
-- Scope: the durable state owned by the /approvals module (Work Order
-- frozen scope: "/approvals, approval request/decision records,
-- approval persistence/routes, authorization integration, approval
-- policy hooks"; architecture-lock #3: /approvals is the SOLE ServiceOS
-- authority for business/human approval state).
--
-- Tenancy discipline (established by migration 0001): every durable row
-- carries a NOT NULL tenant_id referencing org_service_tenants(id) and is
-- queried only through a mandatory tenant predicate.
--
-- Authority boundaries encoded in the schema:
--   * THE EXPLICIT REQUEST LEDGER (AC-1; activation invariants 1/2):
--     `approval_requests` binds every request to a specific Service
--     Work (and, optionally, one of its Work Attempts — identities
--     validated through /work's public read at the module layer, the
--     /billing, /zeck and /evidence precedent for cross-module identity
--     references, so no cross-module foreign keys) AND to the
--     applicable business policy (policy_key + the pinned /policies
--     admission decision id — read-only provenance, never a second
--     policy authority). The status enumeration is CLOSED:
--     pending -> approved | rejected, exactly one terminal state per
--     request, written only by the /approvals decision path.
--   * THE TERMINAL ARBITRATION (activation invariant 6: simultaneous
--     approval/rejection converges deterministically to ONE terminal
--     decision): UNIQUE (tenant, request_id) on `approval_decisions`
--     is the schema-level backstop — at most ONE decision row per
--     request can ever exist, no matter what any code path attempts.
--     The request row's status flip is performed only by the
--     serialized decision critical section (guarded update).
--   * THE EXPLICIT HUMAN AUTHORITY (AC-2/AC-4; activation invariants
--     3/5): `decided_by` references auth_users — the module layer
--     requires an authenticated HUMAN principal (kind = 'human') and
--     rejects machine principals and agent claims before any durable
--     effect (typed DECIDER_NOT_HUMAN). No AI/agent/model/provider/
--     Zeck-execution column exists anywhere in this schema: a foreign
--     execution outcome is at most opaque JSON inside `subject` (data
--     under approval), NEVER a decision surface.
--   * DURABLE AND AUDITABLE (AC-3): decision rows are immutable
--     (append-only; no update path) with their decider, reason and
--     instant; request rows carry their current authority state and
--     are tamper-evident through the record-hash recomputation on
--     every read.
--   * Keyed logical identity: UNIQUE (tenant, idempotency_key) on both
--     tables — idempotent submissions converge; divergent content
--     under the same key fails closed at the module layer.
--   * No credential surface: no key, secret, token or provider column
--     exists anywhere in this schema.

-- ---------------------------------------------------------------------------
-- /approvals: approval requests (the authority-state ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE approval_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The Service Work / optional Work Attempt the request is bound to
  -- (validated through /work's public read; read-only — /approvals
  -- never mutates work state; the workflow authority owns transitions).
  service_work_id         UUID NOT NULL,
  work_attempt_id         UUID,
  -- The applicable business policy binding (AC-1): the frozen key plus
  -- the pinned /policies admission decision (opaque provenance — this
  -- schema never re-implements policy evaluation).
  policy_key              TEXT NOT NULL,
  policy_decision_id      UUID NOT NULL,
  -- The business content under approval (any JSON value, preserved
  -- verbatim; DATA being approved, never an approval).
  subject                 JSONB NOT NULL,
  -- The closed authority-state enumeration. Written ONLY by the
  -- /approvals decision path (the serialized terminal arbitration).
  status                  TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  idempotency_key         TEXT NOT NULL,
  -- Integrity hashes: content = the request FACT (requester/key
  -- independent); record = the full CURRENT row core (recomputed on
  -- every read; rewritten only by the decision path).
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  requested_by            UUID NOT NULL REFERENCES auth_users (id),
  requested_at            TIMESTAMPTZ NOT NULL,
  -- The terminal decision once decided (the arbitration's durable
  -- pointer); null while pending.
  decision_id             UUID
);

-- Keyed request convergence (the durable logical identity).
CREATE UNIQUE INDEX approval_requests_tenant_idempotency_key
  ON approval_requests (tenant_id, idempotency_key);
CREATE INDEX approval_requests_tenant_work_idx
  ON approval_requests (tenant_id, service_work_id);
CREATE INDEX approval_requests_tenant_status_idx
  ON approval_requests (tenant_id, status);
CREATE INDEX approval_requests_tenant_requester_idx
  ON approval_requests (tenant_id, requested_by);

-- ---------------------------------------------------------------------------
-- /approvals: approval decisions (the immutable terminal ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE approval_decisions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES org_service_tenants (id),
  -- The decided request. UNIQUE (tenant, request_id) is THE terminal
  -- arbitration backstop: exactly ONE decision row per request, ever —
  -- simultaneous approve/reject converges deterministically to one
  -- terminal decision (activation invariant 6).
  request_id              UUID NOT NULL,
  -- Denormalized from the request inside the serialized critical
  -- section (tenant-predicated review without a join).
  service_work_id         UUID NOT NULL,
  -- The explicit terminal human verdict (closed enumeration).
  decision                TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  -- The human reason, preserved verbatim; null when absent.
  reason                  TEXT,
  idempotency_key         TEXT NOT NULL,
  -- Hash over scope + request + verdict + reason (the decision INPUT);
  -- record = the full immutable decision row core.
  content_hash            TEXT NOT NULL,
  record_hash             TEXT NOT NULL,
  -- The authenticated HUMAN decider (the module rejects non-human
  -- principals before any durable effect; an AI/agent output can never
  -- reach this column as a decision authority).
  decided_by              UUID NOT NULL REFERENCES auth_users (id),
  decided_at              TIMESTAMPTZ NOT NULL
);

-- Keyed decision convergence (the durable logical identity).
CREATE UNIQUE INDEX approval_decisions_tenant_idempotency_key
  ON approval_decisions (tenant_id, idempotency_key);
-- THE terminal arbitration: one decision row per request, ever.
CREATE UNIQUE INDEX approval_decisions_request_terminal
  ON approval_decisions (tenant_id, request_id);
CREATE INDEX approval_decisions_tenant_work_idx
  ON approval_decisions (tenant_id, service_work_id);
CREATE INDEX approval_decisions_tenant_decider_idx
  ON approval_decisions (tenant_id, decided_by);
CREATE INDEX approval_decisions_tenant_verdict_idx
  ON approval_decisions (tenant_id, decision);
