import { tenantSchema } from '../tenants/tenant-schema';

/** Public due queues avoid scanning every tenant when scheduling bounded workers. */
export const ALERT_SCHEDULE_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.alert_rule_schedule (
  "tenantId" UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  "ruleId" UUID NOT NULL,
  "dueAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMPTZ,
  PRIMARY KEY ("tenantId", "ruleId"),
  CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL))
);
CREATE INDEX IF NOT EXISTS alert_rule_schedule_due ON public.alert_rule_schedule ("dueAt");
CREATE TABLE IF NOT EXISTS public.alert_delivery_schedule (
  "tenantId" UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  "deliveryId" UUID NOT NULL,
  "dueAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMPTZ,
  PRIMARY KEY ("tenantId", "deliveryId"),
  CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL))
);
CREATE INDEX IF NOT EXISTS alert_delivery_schedule_due ON public.alert_delivery_schedule ("dueAt");
`;

export function alertSchemaSql(tenantId: string): string {
  const schema = tenantSchema(tenantId);
  return `
CREATE TABLE IF NOT EXISTS ${schema}.alert_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  type VARCHAR NOT NULL CHECK (type IN ('webhook', 'slack', 'email')),
  destination VARCHAR(512) NOT NULL,
  credentials JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ${schema}.alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  metric VARCHAR NOT NULL CHECK (metric IN ('error_rate', 'p95_latency_ms', 'rps', 'downstream_timeout_rate')),
  operator VARCHAR NOT NULL CHECK (operator IN ('>', '<', '>=', '<=')),
  threshold DOUBLE PRECISION NOT NULL CHECK (threshold >= 0 AND threshold <= 1000000000),
  "windowMinutes" INTEGER NOT NULL CHECK ("windowMinutes" BETWEEN 1 AND 60),
  "minRequests" INTEGER NOT NULL CHECK ("minRequests" BETWEEN 0 AND 1000000),
  enabled BOOLEAN NOT NULL DEFAULT true,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  evaluation JSONB,
  "notifiedState" VARCHAR NOT NULL DEFAULT 'ok' CHECK ("notifiedState" IN ('ok', 'firing')),
  "cooldownUntil" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((metric IN ('error_rate', 'downstream_timeout_rate') AND threshold <= 1)
    OR (metric = 'p95_latency_ms' AND threshold <= 3600000) OR metric = 'rps')
);
CREATE TABLE IF NOT EXISTS ${schema}.alert_rule_channels (
  "ruleId" UUID NOT NULL REFERENCES ${schema}.alert_rules(id) ON DELETE CASCADE,
  "channelId" UUID NOT NULL REFERENCES ${schema}.alert_channels(id) ON DELETE CASCADE,
  PRIMARY KEY ("ruleId", "channelId")
);
CREATE TABLE IF NOT EXISTS ${schema}.alert_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ruleId" UUID REFERENCES ${schema}.alert_rules(id) ON DELETE SET NULL,
  "ruleName" VARCHAR(100) NOT NULL,
  metric VARCHAR NOT NULL CHECK (metric IN ('error_rate', 'p95_latency_ms', 'rps', 'downstream_timeout_rate')),
  operator VARCHAR NOT NULL CHECK (operator IN ('>', '<', '>=', '<=')),
  threshold DOUBLE PRECISION NOT NULL,
  "windowMinutes" INTEGER NOT NULL CHECK ("windowMinutes" BETWEEN 1 AND 60),
  state VARCHAR NOT NULL CHECK (state IN ('firing', 'resolved')),
  value DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS alert_events_time ON ${schema}.alert_events ("createdAt" DESC, id DESC);
CREATE TABLE IF NOT EXISTS ${schema}.alert_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventId" UUID NOT NULL REFERENCES ${schema}.alert_events(id) ON DELETE CASCADE,
  "channelId" UUID REFERENCES ${schema}.alert_channels(id) ON DELETE SET NULL,
  "channelName" VARCHAR(100) NOT NULL,
  type VARCHAR NOT NULL CHECK (type IN ('webhook', 'slack', 'email')),
  "channelRevision" INTEGER NOT NULL CHECK ("channelRevision" > 0),
  status VARCHAR NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'delivered', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  "lastError" VARCHAR(256),
  "nextAttemptAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS alert_deliveries_event ON ${schema}.alert_deliveries ("eventId", id);
`;
}
