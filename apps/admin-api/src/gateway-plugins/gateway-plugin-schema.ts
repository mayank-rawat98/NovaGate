// Shared upgrade SQL; the default also appears in the canonical fresh public schema.
export const GATEWAY_PLUGIN_SCHEMA = `
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS "disabledPlugins" JSONB NOT NULL DEFAULT '[]'::jsonb;
`;
