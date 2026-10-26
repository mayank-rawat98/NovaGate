// Startup upgrade SQL. Only a SHA-256 digest of each high-entropy secret is stored.
export const AUTOMATION_TOKEN_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.automation_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name VARCHAR(64) NOT NULL,
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 32),
  token_hash CHAR(64) NOT NULL UNIQUE,
  display_prefix VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS automation_tokens_tenant ON public.automation_tokens (tenant_id, created_at DESC, id DESC);
`;
