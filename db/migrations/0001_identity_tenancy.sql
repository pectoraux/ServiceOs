-- ServiceOS migration 0001 — identity & tenancy (WORK-002).
--
-- Scope: the durable state owned by the /auth and /organizations modules:
-- principals (humans + machine service accounts), credentials (sessions, API
-- keys), organizations, service tenants and memberships.
--
-- Tenant integrity constraints (Work Order "database constraints needed for
-- tenant integrity"):
--   * every service tenant references exactly one organization (FK);
--   * every membership references exactly one organization and principal (FKs)
--     and is unique per (organization, principal);
--   * tenant and organization slugs are globally unique stable handles;
--   * credential digests are unique;
--   * roles/statuses/kinds are closed enumerations.
--
-- No AI provider/model credential column exists anywhere (lock #17): machine
-- credentials are ServiceOS-internal service-account keys whose capabilities
-- derive solely from the membership chain.
--
-- Later customer-domain tables (entities, work, …) MUST follow the tenancy
-- discipline established here: a NOT NULL tenant_id referencing
-- org_service_tenants(id), enforced by FK and queried only through a
-- mandatory tenant predicate (see the tenant-scoped store contract).

-- ---------------------------------------------------------------------------
-- /auth: principals (humans and machine service accounts)
-- ---------------------------------------------------------------------------
CREATE TABLE auth_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('human', 'machine')),
  display_name  TEXT NOT NULL,
  -- scrypt$N$r$p$salt$hash for humans; NULL for machine service accounts.
  password_hash TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth_users IS 'ServiceOS principals: human users and machine service accounts (/auth authority)';

CREATE TABLE auth_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id UUID NOT NULL REFERENCES auth_users (id),
  token_hash   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_principal_idx ON auth_sessions (principal_id);
COMMENT ON TABLE auth_sessions IS 'Opaque bearer session credentials stored as digests (/auth authority)';

CREATE TABLE auth_api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id UUID NOT NULL REFERENCES auth_users (id),
  key_hash     TEXT NOT NULL UNIQUE,
  key_hint     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_api_keys_principal_idx ON auth_api_keys (principal_id);
COMMENT ON TABLE auth_api_keys IS 'Machine service-account API keys stored as digests (/auth authority)';

-- ---------------------------------------------------------------------------
-- /organizations: organizations, service tenants, memberships
-- ---------------------------------------------------------------------------
CREATE TABLE org_organizations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE org_organizations IS 'Customer organizations (/organizations authority)';

-- ServiceTenant: the isolated customer-domain boundary used by business records.
CREATE TABLE org_service_tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES org_organizations (id),
  slug            TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a tenant handle is unique within its organization as well as globally
  UNIQUE (organization_id, slug)
);
CREATE INDEX org_service_tenants_org_idx ON org_service_tenants (organization_id);
COMMENT ON TABLE org_service_tenants IS 'Service tenants: the isolated customer-domain boundary (/organizations authority)';

CREATE TABLE org_memberships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES org_organizations (id),
  principal_id    UUID NOT NULL REFERENCES auth_users (id),
  role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by      UUID REFERENCES auth_users (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one membership per (organization, principal): concurrent grants converge
  UNIQUE (organization_id, principal_id)
);
CREATE INDEX org_memberships_org_idx ON org_memberships (organization_id);
CREATE INDEX org_memberships_principal_idx ON org_memberships (principal_id);
COMMENT ON TABLE org_memberships IS 'Organization memberships and roles: the single grant source for the authorization chain (/organizations authority)';
