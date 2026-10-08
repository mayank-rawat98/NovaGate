/** Draft-only connection records. No row can enable unimplemented delivery. */
export const EXPORT_DESTINATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.log_export_destinations (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  revision UUID NOT NULL,
  name VARCHAR(80) NOT NULL,
  type VARCHAR NOT NULL CHECK (type IN ('s3','webhook','datadog')),
  destination VARCHAR(2048) NOT NULL,
  state VARCHAR NOT NULL DEFAULT 'draft' CHECK (state='draft'),
  credentials JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ,
  CHECK ((deleted_at IS NULL AND credentials IS NOT NULL) OR
         (deleted_at IS NOT NULL AND credentials IS NULL))
);
CREATE INDEX IF NOT EXISTS log_export_destinations_tenant ON public.log_export_destinations (tenant_id, created_at, id) WHERE deleted_at IS NULL;
`;
