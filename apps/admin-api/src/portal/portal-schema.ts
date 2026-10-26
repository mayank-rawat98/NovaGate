// Startup upgrade SQL shared with fresh provisioning.
export const PORTAL_PUBLIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.portal_settings (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  title VARCHAR(80) NOT NULL,
  custom_domain VARCHAR(253) UNIQUE CHECK (custom_domain = lower(custom_domain)),
  signup VARCHAR NOT NULL DEFAULT 'open' CHECK (signup IN ('open','closed')),
  default_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_keys_per_developer INTEGER NOT NULL DEFAULT 5 CHECK (max_keys_per_developer BETWEEN 1 AND 25),
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_at TIMESTAMPTZ
);
ALTER TABLE public.portal_settings ADD COLUMN IF NOT EXISTS api_base_url VARCHAR(2048);
`;

/** Per-tenant developer accounts and route/consumer columns. Tables must exist. */
export function portalSchemaSql(schema: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${schema}.portal_developers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(320) NOT NULL,
  name VARCHAR(128) NOT NULL,
  password_hash VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  session_version INTEGER NOT NULL DEFAULT 1,
  verify_token_hash CHAR(64),
  verify_expires TIMESTAMPTZ,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_developers_email ON ${schema}.portal_developers (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS portal_developers_verify ON ${schema}.portal_developers (verify_token_hash) WHERE verify_token_hash IS NOT NULL;
ALTER TABLE IF EXISTS ${schema}.consumers ADD COLUMN IF NOT EXISTS "portalDeveloperId" UUID REFERENCES ${schema}.portal_developers(id),
  ADD COLUMN IF NOT EXISTS "portalKeyName" VARCHAR(64);
CREATE INDEX IF NOT EXISTS consumers_portal_developer ON ${schema}.consumers ("portalDeveloperId") WHERE "portalDeveloperId" IS NOT NULL;
ALTER TABLE IF EXISTS ${schema}.routes ADD COLUMN IF NOT EXISTS portal JSONB;
`;
}
