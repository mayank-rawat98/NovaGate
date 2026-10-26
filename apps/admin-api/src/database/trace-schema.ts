/** Tenant trace storage is initialized only by authenticated admin provisioning/migration. */
export function traceSchemaSql(schema: string): string {
  if (!/^tenant_[a-f0-9]{8}(?:_[a-f0-9]{4}){3}_[a-f0-9]{12}$/i.test(schema))
    throw new Error('Invalid tenant schema');
  return `CREATE TABLE IF NOT EXISTS ${schema}.trace_spans (
    "traceId" VARCHAR(32) NOT NULL,
    "spanId" VARCHAR(16) NOT NULL,
    "parentSpanId" VARCHAR(16),
    name VARCHAR(128) NOT NULL,
    kind VARCHAR NOT NULL CHECK (kind IN ('server', 'client', 'internal')),
    timestamp TIMESTAMPTZ NOT NULL,
    "durationMs" DOUBLE PRECISION NOT NULL CHECK ("durationMs" >= 0),
    status VARCHAR NOT NULL CHECK (status IN ('unset', 'ok', 'error')),
    attributes JSONB NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
    PRIMARY KEY ("traceId", "spanId")
  );
  CREATE INDEX IF NOT EXISTS trace_spans_time_cursor ON ${schema}.trace_spans (timestamp DESC, "traceId", "spanId");
  CREATE INDEX IF NOT EXISTS trace_spans_request_id ON ${schema}.trace_spans ((attributes->>'gateway.request.id'), timestamp DESC);
  CREATE INDEX IF NOT EXISTS trace_spans_route ON ${schema}.trace_spans ((attributes->>'http.route'), timestamp DESC);`;
}
