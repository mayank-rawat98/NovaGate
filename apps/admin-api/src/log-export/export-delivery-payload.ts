import {
  redactRequestLog,
  stricterLogPrivacy,
  validateLogPrivacy,
  REDACTED_LOG_VALUE,
  type LogExportDeliveryBatch,
  type LogExportRecord,
} from '@api-gateway/shared-types';
import { OutboundHttpError } from '../shared/outbound-http';

export const EXPORT_MAX_RECORDS = 256;
export const EXPORT_MAX_BODY_BYTES = 1024 * 1024;
export const EXPORT_MAX_RECORD_BYTES = 16384;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
function invalid(): never {
  throw new OutboundHttpError('invalid_payload');
}
function text(value: unknown, limit: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    Buffer.byteLength(value) > limit ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    invalid();
  return value;
}
function identifier(value: unknown): string {
  const result = text(value, 36);
  if (!uuid.test(result)) invalid();
  return result.toLowerCase();
}
function duration(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 86400000
  )
    invalid();
  return value;
}
/** Snapshot documented fields, then apply the stricter tenant/destination policy. */
export function exportDeliveryRecords(
  batch: LogExportDeliveryBatch,
  signal: AbortSignal,
  deadline: number,
): LogExportRecord[] {
  if (
    !batch ||
    batch.version !== 1 ||
    !Array.isArray(batch.records) ||
    !batch.records.length ||
    batch.records.length > EXPORT_MAX_RECORDS
  )
    invalid();
  identifier(batch.tenantId);
  identifier(batch.destinationId);
  identifier(batch.deliveryId);
  let privacy;
  try {
    privacy = validateLogPrivacy(batch.privacy);
    if (batch.payloadPrivacy !== undefined)
      privacy = stricterLogPrivacy(
        privacy,
        validateLogPrivacy(batch.payloadPrivacy),
      );
  } catch {
    return invalid();
  }
  let total = 0;
  return batch.records.map((source) => {
    if (signal.aborted) throw new OutboundHttpError('cancelled');
    if (performance.now() >= deadline)
      throw new OutboundHttpError('timeout', true);
    if (!source || typeof source !== 'object') invalid();
    // Project first: unknown columns and getters never reach the redactor/serializer.
    const row = {
      id: source.id,
      method: source.method,
      path: source.path,
      statusCode: source.statusCode,
      responseTimeMs: source.responseTimeMs,
      requestId: source.requestId,
      timestamp: source.timestamp,
      clientIp: source.clientIp,
      userAgent: source.userAgent,
      downstreamService: source.downstreamService,
      downstreamLatencyMs: source.downstreamLatencyMs,
      consumerId: source.consumerId,
      traceId: source.traceId,
      spanId: source.spanId,
      errorCode: source.errorCode,
    };
    const projected = redactRequestLog(row, privacy);
    const result: LogExportRecord = {
      id: identifier(projected.id),
      method: text(projected.method, 32),
      path: text(projected.path, 4096),
      statusCode: projected.statusCode,
      responseTimeMs: duration(projected.responseTimeMs),
      requestId:
        projected.requestId === REDACTED_LOG_VALUE
          ? REDACTED_LOG_VALUE
          : identifier(projected.requestId),
      timestamp: text(projected.timestamp, 40),
      clientIp: text(projected.clientIp, 64),
    };
    if (
      !/^[A-Z]+$/.test(result.method) ||
      !Number.isInteger(result.statusCode) ||
      result.statusCode < 100 ||
      result.statusCode > 599 ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(
        result.timestamp,
      ) ||
      !Number.isFinite(Date.parse(result.timestamp))
    )
      invalid();
    if (projected.consumerId !== undefined)
      result.consumerId = identifier(projected.consumerId);
    if (projected.userAgent !== undefined)
      result.userAgent = text(projected.userAgent, 2048);
    if (projected.downstreamService !== undefined)
      result.downstreamService = text(projected.downstreamService, 256);
    if (projected.downstreamLatencyMs !== undefined)
      result.downstreamLatencyMs = duration(projected.downstreamLatencyMs);
    if (projected.errorCode !== undefined)
      result.errorCode = text(projected.errorCode, 128);
    for (const [key, size] of [
      ['traceId', 32],
      ['spanId', 16],
    ] as const) {
      const value = projected[key];
      if (value !== undefined) {
        if (
          typeof value !== 'string' ||
          value.length !== size ||
          !/^[a-f\d]+$/.test(value) ||
          /^0+$/.test(value)
        )
          invalid();
        result[key] = value;
      }
    }
    const bytes = Buffer.byteLength(JSON.stringify(result)) + 1;
    total += bytes;
    if (bytes > EXPORT_MAX_RECORD_BYTES || total > EXPORT_MAX_BODY_BYTES)
      invalid();
    return result;
  });
}
