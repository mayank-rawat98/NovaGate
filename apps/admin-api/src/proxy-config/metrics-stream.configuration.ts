export const DEFAULT_METRIC_STREAM = {
  maxConnections: 256,
  maxPerTenant: 8,
  maxPendingReads: 8,
  maxBufferedBytes: 65536,
  heartbeatMs: 15000,
  maxLifetimeMs: 300000,
  statementTimeoutMs: 3000,
  historyLimit: 600,
  retentionDays: 7,
};
export type MetricStreamSettings = typeof DEFAULT_METRIC_STREAM;
export function metricStreamConfiguration(env: Record<string, unknown>) {
  function limit(key: string, fallback: number, min: number, max: number) {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  }
  return {
    maxConnections: limit('METRICS_STREAM_MAX_CONNECTIONS', 256, 1, 4096),
    maxPerTenant: limit('METRICS_STREAM_MAX_PER_TENANT', 8, 1, 64),
    maxPendingReads: limit('METRICS_STREAM_MAX_PENDING_READS', 8, 1, 64),
    maxBufferedBytes: limit(
      'METRICS_STREAM_MAX_BUFFERED_BYTES',
      65536,
      1024,
      1048576,
    ),
    heartbeatMs: limit('METRICS_STREAM_HEARTBEAT_MS', 15000, 1000, 30000),
    maxLifetimeMs: limit(
      'METRICS_STREAM_MAX_LIFETIME_MS',
      300000,
      10000,
      900000,
    ),
    statementTimeoutMs: limit(
      'METRICS_QUERY_STATEMENT_TIMEOUT_MS',
      3000,
      100,
      30000,
    ),
    historyLimit: limit('METRICS_HISTORY_LIMIT', 600, 1, 3600),
    retentionDays: limit('METRICS_RETENTION_DAYS', 7, 1, 30),
  };
}
