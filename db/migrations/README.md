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
  service tenants, memberships — with the tenant-integrity constraints);
  WORK-003 and later Work Orders own their own durable tables per the frozen
  architecture's authority boundaries.
- New customer-domain tables must follow the tenancy discipline established by
  migration 0001: a NOT NULL `tenant_id` referencing `org_service_tenants(id)`,
  enforced by foreign key and read only through a mandatory tenant predicate
  (see the /organizations store contract in `src/modules/organizations/`).

See `docs/DEVELOPMENT.md` and `src/platform/persistence/migrations.ts`.
