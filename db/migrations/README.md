# ServiceOS Persistence Migrations

SQL migrations live here as `NNNN_name.sql` (zero-padded version ordinal,
kebab-or-underscore name), applied in ascending order.

- Applied by the explicit operator action `npm run migrate` — the server never
  auto-initializes durable state.
- The runner serializes concurrent invocations with a PostgreSQL advisory lock
  and records applied versions in `serviceos_schema_history`; re-runs are
  no-ops.
- WORK-001 shipped no business schema by design. WORK-002 ships
  `0001_identity_tenancy.sql` (principals, credential digests, organizations,
  service tenants, memberships — with the tenant-integrity constraints).
  WORK-003 ships `0002_service_work.sql` (ServiceWork, WorkAttempt and
  WorkDependency tables with the durable idempotency indexes: tenant-scoped
  work idempotency keys, one live attempt per work, one live attempt per
  (work, idempotency key), and the closed `'draft'` work-status enumeration —
  /workflow, WORK-004, owns transitions and will extend that enumeration).
  WORK-014 ships `0003_business_policy.sql` (policy contract versions and
  policy decision records: closed scope/status/effect/outcome enumerations,
  one-active-version-per-identity and tenant-scoped idempotency partial
  unique indexes, and decision-record integrity hashes — the frozen policy
  floor and the deterministic evaluator are code, not data).
  WORK-004 ships `0004_business_workflow.sql` (the workflow transition
  ledger and SLA deadlines, plus the sanctioned extension of migration
  0002's closed status enumeration to the full canonical machine).
  WORK-015 ships `0005_external_interactions.sql` (the provider-neutral
  interaction ledger `interaction_effects` with its closed
  intent/claim/acceptance/observation lifecycle and shape invariants, and
  the notification delivery requests `notification_requests` with the
  current-interaction pointer — delivery status is derived through
  /interactions, never re-recorded; /integrations owns no durable state).
  WORK-009 ships `0006_service_vertical_runtime.sql` (the versioned,
  immutable-in-content vertical-package catalog `verticals_packages` with
  declarative domain semantics and Zeck capability REQUIREMENTS without any
  selection surface, and the service-definition/service-configuration
  tables `services_definitions` and `services_configurations` binding a
  pinned package version through composite foreign keys, with one-active
  partial unique indexes, keyed idempotency and content/record hashes —
  the customer-configuration columns exist only for policy parameter
  values and SLA/approval TIGHTENING, so weakened content has no surface to
  persist through).
  Later Work Orders own their own durable tables per the frozen
  architecture's authority boundaries.
- Migration files create tables only under module-owned prefixes
  (`auth_`, `org_`, `work_`, `policy_`, `workflow_`, `interaction_`,
  `notification_`, `verticals_`, `services_`, …); extending that allowlist
  belongs to the Work Order owning the new module's tables (machine-enforced
  by `checkWorkBoundaries`).
- New customer-domain tables must follow the tenancy discipline established by
  migration 0001: a NOT NULL `tenant_id` referencing `org_service_tenants(id)`,
  enforced by foreign key and read only through a mandatory tenant predicate
  (see the /organizations store contract in `src/modules/organizations/`).

See `docs/DEVELOPMENT.md` and `src/platform/persistence/migrations.ts`.
