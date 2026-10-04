// Used by startup upgrades as well as a fresh public schema.
export const LOG_EXPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.log_export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  status VARCHAR NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','expired')),
  filter JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  object_key TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  bytes BIGINT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  cleanup_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS log_export_jobs_tenant ON public.log_export_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS log_export_jobs_queue ON public.log_export_jobs (created_at) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS log_export_jobs_expiry ON public.log_export_jobs (expires_at, cleanup_at);
`;
