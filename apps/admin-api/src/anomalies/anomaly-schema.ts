import { ANOMALY_LIMITS } from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';

/** One lease row per workspace; detection never scans every tenant. */
export const ANOMALY_SCHEDULE_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.anomaly_schedule (
  "tenantId" UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  "dueAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMPTZ,
  CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL))
);
CREATE INDEX IF NOT EXISTS anomaly_schedule_due ON public.anomaly_schedule ("dueAt");
INSERT INTO public.anomaly_schedule ("tenantId") SELECT id FROM public.tenants ON CONFLICT DO NOTHING;
`;

/** Runs after alertSchemaSql: it references alert channels and extends events. */
export function anomalySchemaSql(tenantId: string): string {
  const schema = tenantSchema(tenantId);
  const [zMin, zMax] = ANOMALY_LIMITS.zThreshold;
  const [rMin, rMax] = ANOMALY_LIMITS.minRequests;
  return `
CREATE TABLE IF NOT EXISTS ${schema}.route_traffic_windows (
  window_start TIMESTAMPTZ NOT NULL,
  method TEXT COLLATE "C" NOT NULL CHECK (char_length(method) <= 16),
  path TEXT COLLATE "C" NOT NULL CHECK (char_length(path) <= 512),
  requests BIGINT NOT NULL CHECK (requests > 0),
  server_errors BIGINT NOT NULL CHECK (server_errors BETWEEN 0 AND requests),
  p95_ms DOUBLE PRECISION CHECK (p95_ms IS NULL OR p95_ms >= 0),
  PRIMARY KEY (method, path, window_start)
);
CREATE INDEX IF NOT EXISTS route_traffic_windows_time ON ${schema}.route_traffic_windows (window_start);
CREATE TABLE IF NOT EXISTS ${schema}.anomaly_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT true,
  z_threshold DOUBLE PRECISION NOT NULL DEFAULT 3 CHECK (z_threshold BETWEEN ${zMin} AND ${zMax}),
  min_requests INTEGER NOT NULL DEFAULT 20 CHECK (min_requests BETWEEN ${rMin} AND ${rMax}),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  -- Start of the next 15-minute window to materialize.
  next_window TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO ${schema}.anomaly_settings (singleton) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ${schema}.anomaly_channels (
  "channelId" UUID PRIMARY KEY REFERENCES ${schema}.alert_channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ${schema}.anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  method TEXT COLLATE "C" NOT NULL CHECK (char_length(method) <= 16),
  path TEXT COLLATE "C" NOT NULL CHECK (char_length(path) <= 512),
  metric VARCHAR NOT NULL CHECK (metric IN ('error_rate', 'p95_latency_ms', 'rps')),
  direction VARCHAR NOT NULL CHECK (direction IN ('up', 'down')),
  baseline_mean DOUBLE PRECISION NOT NULL,
  baseline_stddev DOUBLE PRECISION NOT NULL,
  baseline_windows INTEGER NOT NULL CHECK (baseline_windows > 0),
  current DOUBLE PRECISION NOT NULL,
  z_score DOUBLE PRECISION NOT NULL,
  requests BIGINT NOT NULL CHECK (requests >= 0),
  state VARCHAR NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'resolved')),
  calm_ticks INTEGER NOT NULL DEFAULT 0 CHECK (calm_ticks >= 0),
  started_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS anomalies_active ON ${schema}.anomalies (method, path, metric) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS anomalies_time ON ${schema}.anomalies (started_at DESC, id DESC);
ALTER TABLE ${schema}.alert_events
  ADD COLUMN IF NOT EXISTS "anomalyId" UUID,
  ADD COLUMN IF NOT EXISTS anomaly JSONB;
-- New workspaces join the schedule here; startup migration backfills it when
-- provisioning precedes the public table.
DO $schedule$ BEGIN
  IF to_regclass('public.anomaly_schedule') IS NOT NULL THEN
    INSERT INTO public.anomaly_schedule ("tenantId") VALUES ('${tenantId.toLowerCase()}'::uuid) ON CONFLICT DO NOTHING;
  END IF;
END $schedule$;
`;
}
