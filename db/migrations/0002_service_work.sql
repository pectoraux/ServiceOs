-- ServiceOS migration 0002 — Service Work & durable attempts (WORK-003).
--
-- Scope: the durable state owned by the /work module (Work Order frozen
-- scope: "/work module, ServiceWork persistence, WorkAttempt persistence,
-- dependency records, durable idempotency primitives").
--
-- Tenancy discipline (established by migration 0001): every customer-domain
-- row carries a NOT NULL tenant_id referencing org_service_tenants(id) and
-- is queried only through a mandatory tenant predicate.
--
-- Authority boundaries encoded in the schema:
--   * ServiceWork identity is tenant-bound (AC-1) with a durable idempotency
--     identity for externally-triggered creation (domain-model "identity
--     rule"): a partial unique index on (tenant_id, idempotency_key).
--   * ServiceWork.status is a CLOSED one-value enumeration ('draft') for as
--     long as /work is the only writer: this Work Order owns identity and
--     persistence only, and /workflow (WORK-004) owns business state
--     transitions. /work physically cannot transition a work past 'draft';
--     WORK-004's migration extends this enumeration through its own
--     authority.
--   * WorkAttempt is a SEPARATE durable identity (AC-2): its own table, its
--     own UUID, and NO Zeck/execution columns anywhere. AI execution
--     references belong to the /zeck integration boundary (WORK-005); a
--     foreign execution reference never becomes ServiceOS state here.
--   * Retry protocol (architecture.md §8, work-execution-model.md): at most
--     ONE live (non-superseded) attempt per work, and at most one live
--     attempt per (work, idempotency key). A pre-dispatch retry converges on
--     the original identity; a post-dispatch retry supersedes the prior
--     attempt (supersedes/superseded chain) and moves the work's
--     current-attempt pointer FORWARD only.
--   * Dependencies (AC-3) are durable, same-tenant, non-self, unique per
--     edge; cycle safety is enforced transactionally by the store (the
--     dependency mutation for a tenant is serialized through an advisory
--     transaction lock, so two racing edges can never close a phantom
--     cycle).

-- ---------------------------------------------------------------------------
-- /work: ServiceWork (the durable business job identity)
-- ---------------------------------------------------------------------------
CREATE TABLE work_service_works (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES org_service_tenants (id),
  -- Opaque work-type reference; service/vertical semantics stay external
  -- (/services, /verticals — WORK-009). /work never interprets it.
  work_type         TEXT NOT NULL,
  title             TEXT NOT NULL,
  -- Business state RECORD: created as 'draft'. Transitions belong to the
  -- /workflow authority (WORK-004); /work never updates this column (also
  -- enforced structurally: see checkWorkBoundaries).
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft')),
  -- Actor provenance (domain-model "identity rule").
  created_by        UUID NOT NULL REFERENCES auth_users (id),
  -- Durable idempotency identity for externally-triggered creation.
  idempotency_key   TEXT,
  -- Forward-only pointer to the current attempt (updated only by attempt
  -- supersession; never set backward).
  current_attempt_id UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE work_service_works IS 'ServiceWork: the durable tenant-bound business job identity (/work authority; transitions owned by /workflow)';

-- Two actors creating the same logical work (same tenant + idempotency key)
-- converge on one durable identity (concurrency proof AC-4-adjacent).
CREATE UNIQUE INDEX work_service_works_tenant_idempotency_key
  ON work_service_works (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX work_service_works_tenant_idx ON work_service_works (tenant_id);

-- ---------------------------------------------------------------------------
-- /work: WorkAttempt (a durable unit of effort, NOT a Zeck execution)
-- ---------------------------------------------------------------------------
CREATE TABLE work_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES org_service_tenants (id),
  work_id         UUID NOT NULL REFERENCES work_service_works (id),
  -- Monotonic per-work sequence; concurrency-safe under the work-row lock.
  attempt_no      INTEGER NOT NULL CHECK (attempt_no > 0),
  -- Attempt bookkeeping record (identity/protocol states, NOT the business
  -- workflow state machine): pending -> dispatched -> completed|failed;
  -- superseded marks attempts replaced by a newer one. /work records facts;
  -- it does not evaluate business transitions.
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'dispatched', 'completed', 'failed', 'superseded')),
  -- Durable idempotency identity for attempt creation (the pre-dispatch
  -- convergence window key).
  idempotency_key TEXT,
  created_by      UUID NOT NULL REFERENCES auth_users (id),
  -- Supersession chain (forward-only): a new attempt records which prior
  -- attempt it replaces (supersedes_id); the prior attempt is marked
  -- superseded_at. The successor is derivable from the chain — no backward
  -- pointer exists to move.
  supersedes_id   UUID REFERENCES work_attempts (id),
  superseded_at   TIMESTAMPTZ,
  -- Dispatch boundary: closes the pre-dispatch convergence window. Set once.
  dispatched_at   TIMESTAMPTZ,
  -- Observed attempt outcome record (business meaning is evaluated by the
  -- workflow authority, never here).
  outcome         TEXT CHECK (outcome IN ('completed', 'failed')),
  -- Opaque result reference; business evidence linkage belongs to /evidence
  -- (WORK-007).
  result          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (work_id, attempt_no)
);
COMMENT ON TABLE work_attempts IS 'WorkAttempt: ServiceOS durable work-attempt identity, distinct from ServiceWork and from external AI executions (/work authority; execution references belong to the integration boundary)';

-- ONE live (non-superseded) attempt per work: the current attempt. New
-- attempts supersede the current one inside one transaction; the pointer
-- never moves backward (superseded-attempt protection, AC-5).
CREATE UNIQUE INDEX work_attempts_one_live_per_work
  ON work_attempts (work_id)
  WHERE superseded_at IS NULL;
-- ONE live attempt per (work, idempotency key): pre-dispatch retries
-- converge on the original identity; post-dispatch retries supersede it
-- (retry protocol AC-4).
CREATE UNIQUE INDEX work_attempts_live_idempotency_key
  ON work_attempts (work_id, idempotency_key)
  WHERE superseded_at IS NULL AND idempotency_key IS NOT NULL;
CREATE INDEX work_attempts_tenant_idx ON work_attempts (tenant_id);
CREATE INDEX work_attempts_work_idx ON work_attempts (work_id);

-- Current-attempt linkage (added after work_attempts exists to avoid a
-- circular table dependency).
ALTER TABLE work_service_works
  ADD CONSTRAINT work_service_works_current_attempt_fk
  FOREIGN KEY (current_attempt_id) REFERENCES work_attempts (id);

-- ---------------------------------------------------------------------------
-- /work: WorkDependency (durable, same-tenant, cycle-safe)
-- ---------------------------------------------------------------------------
CREATE TABLE work_dependencies (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES org_service_tenants (id),
  -- Dependent work (work_id depends on depends_on_work_id).
  work_id            UUID NOT NULL REFERENCES work_service_works (id),
  depends_on_work_id UUID NOT NULL REFERENCES work_service_works (id),
  created_by         UUID NOT NULL REFERENCES auth_users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One durable record per logical edge: concurrent/duplicate adds converge.
  UNIQUE (work_id, depends_on_work_id),
  -- Self-dependency is the trivial cycle; rejected at the schema boundary.
  CHECK (work_id <> depends_on_work_id)
);
COMMENT ON TABLE work_dependencies IS 'Durable same-tenant work dependencies with cycle safety enforced by the /work store (/work authority)';

CREATE INDEX work_dependencies_tenant_idx ON work_dependencies (tenant_id);
CREATE INDEX work_dependencies_work_idx ON work_dependencies (work_id);
CREATE INDEX work_dependencies_depends_on_idx ON work_dependencies (depends_on_work_id);
