export const DEFAULT_TRACE_INGESTION = {
  maxConcurrent: 8,
  maxRowsPerTenant: 100000,
  retentionDays: 7,
  statementTimeoutMs: 5000,
  lockTimeoutMs: 1000,
};
export type TraceIngestionSettings = typeof DEFAULT_TRACE_INGESTION;
export const DEFAULT_SOCKET_ADMISSION = {
  maxMessageBytes: 131072,
  maxQueuedMessages: 16,
  maxQueuedBytes: 1048576,
  maxConnections: 256,
};
export type SocketAdmissionSettings = typeof DEFAULT_SOCKET_ADMISSION;

export function validateTracingConfiguration(env: Record<string, unknown>) {
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
    traceIngestion: {
      maxConcurrent: limit(
        'TRACE_INGESTION_MAX_CONCURRENT',
        DEFAULT_TRACE_INGESTION.maxConcurrent,
        1,
        64,
      ),
      maxRowsPerTenant: limit(
        'TRACE_MAX_ROWS_PER_TENANT',
        DEFAULT_TRACE_INGESTION.maxRowsPerTenant,
        128,
        1000000,
      ),
      retentionDays: limit(
        'TRACE_RETENTION_DAYS',
        DEFAULT_TRACE_INGESTION.retentionDays,
        1,
        30,
      ),
      statementTimeoutMs: limit(
        'TRACE_INGESTION_STATEMENT_TIMEOUT_MS',
        DEFAULT_TRACE_INGESTION.statementTimeoutMs,
        100,
        30000,
      ),
      lockTimeoutMs: limit(
        'TRACE_INGESTION_LOCK_TIMEOUT_MS',
        DEFAULT_TRACE_INGESTION.lockTimeoutMs,
        100,
        10000,
      ),
    },
    socketAdmission: {
      maxMessageBytes: limit(
        'CONTROL_PLANE_MAX_MESSAGE_BYTES',
        DEFAULT_SOCKET_ADMISSION.maxMessageBytes,
        65536,
        1048576,
      ),
      maxQueuedMessages: limit(
        'CONTROL_PLANE_MAX_QUEUED_MESSAGES',
        DEFAULT_SOCKET_ADMISSION.maxQueuedMessages,
        1,
        128,
      ),
      maxQueuedBytes: limit(
        'CONTROL_PLANE_MAX_QUEUED_BYTES',
        DEFAULT_SOCKET_ADMISSION.maxQueuedBytes,
        65536,
        16777216,
      ),
      maxConnections: limit(
        'CONTROL_PLANE_MAX_CONNECTIONS',
        DEFAULT_SOCKET_ADMISSION.maxConnections,
        1,
        4096,
      ),
    },
  };
}
