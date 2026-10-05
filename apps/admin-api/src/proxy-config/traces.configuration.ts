export const DEFAULT_TRACE_QUERIES = {
  retentionDays: 7,
  maxConcurrent: 8,
  statementTimeoutMs: 3000,
  maxRangeDays: 7,
  pageSize: 50,
  maxDetailSpans: 256,
};
export type TraceQuerySettings = typeof DEFAULT_TRACE_QUERIES;
export function validateTraceQueryConfiguration(env: Record<string, unknown>) {
  function limit(key: string, fallback: number, min: number, max: number) {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(
        `Invalid ${key}: expected an integer from ${min} to ${max}`,
      );
    return value;
  }
  return {
    ...env,
    traceQueries: {
      retentionDays: limit(
        'TRACE_RETENTION_DAYS',
        DEFAULT_TRACE_QUERIES.retentionDays,
        1,
        30,
      ),
      maxConcurrent: limit(
        'TRACE_QUERY_MAX_CONCURRENT',
        DEFAULT_TRACE_QUERIES.maxConcurrent,
        1,
        64,
      ),
      statementTimeoutMs: limit(
        'TRACE_QUERY_STATEMENT_TIMEOUT_MS',
        DEFAULT_TRACE_QUERIES.statementTimeoutMs,
        100,
        30000,
      ),
      maxRangeDays: limit(
        'TRACE_QUERY_MAX_RANGE_DAYS',
        DEFAULT_TRACE_QUERIES.maxRangeDays,
        1,
        30,
      ),
      pageSize: limit(
        'TRACE_QUERY_PAGE_SIZE',
        DEFAULT_TRACE_QUERIES.pageSize,
        1,
        100,
      ),
      maxDetailSpans: limit(
        'TRACE_QUERY_MAX_DETAIL_SPANS',
        DEFAULT_TRACE_QUERIES.maxDetailSpans,
        16,
        1024,
      ),
    },
  };
}
