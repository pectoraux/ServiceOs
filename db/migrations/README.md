# ServiceOS Persistence Migrations

SQL migrations live here as `NNNN_name.sql` (zero-padded version ordinal,
kebab-or-underscore name), applied in ascending order.

- Applied by the explicit operator action `npm run migrate` — the server never
  auto-initializes durable state.
- The runner serializes concurrent invocations with a PostgreSQL advisory lock
  and records applied versions in `serviceos_schema_history`; re-runs are no-ops.
- WORK-001 ships no business schema by design: the first durable tables belong
  to the Work Orders that own that state (WORK-002 identity/tenancy,
  WORK-003 Service Work), per the frozen architecture's authority boundaries.

See `docs/DEVELOPMENT.md` and `src/platform/persistence/migrations.ts`.
