import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  MAX_TRACE_BATCH_SPANS,
  MAX_TRACE_BATCH_BYTES,
  MAX_TRACE_SPAN_BYTES,
  MAX_TRACE_ATTRIBUTES,
  MAX_TRACE_ATTRIBUTE_BYTES,
  TRACE_ATTRIBUTE_KEYS,
  type TraceSpan,
} from '@api-gateway/shared-types';
import {
  DEFAULT_TRACE_INGESTION,
  type TraceIngestionSettings,
} from '../config/tracing.configuration';

const ATTRIBUTES = new Set<string>(TRACE_ATTRIBUTE_KEYS);
const TRACE_ID = /^(?!0{32}$)[a-f0-9]{32}$/;
const SPAN_ID = /^(?!0{16}$)[a-f0-9]{16}$/;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function validateTraceBatch(
  payload: unknown,
  retentionDays: number,
): TraceSpan[] {
  if (
    !Array.isArray(payload) ||
    !payload.length ||
    payload.length > MAX_TRACE_BATCH_SPANS ||
    Buffer.byteLength(JSON.stringify(payload)) > MAX_TRACE_BATCH_BYTES
  )
    throw new Error('Invalid trace batch');
  const now = Date.now();
  const output: TraceSpan[] = [];
  for (const span of payload) {
    if (
      !record(span) ||
      Object.keys(span).some(
        (key) =>
          ![
            'traceId',
            'spanId',
            'parentSpanId',
            'name',
            'kind',
            'timestamp',
            'durationMs',
            'status',
            'attributes',
          ].includes(key),
      ) ||
      Buffer.byteLength(JSON.stringify(span)) > MAX_TRACE_SPAN_BYTES
    )
      throw new Error('Invalid trace span');
    const time =
      typeof span.timestamp === 'string' && span.timestamp.length <= 32
        ? Date.parse(span.timestamp)
        : NaN;
    if (
      typeof span.traceId !== 'string' ||
      !TRACE_ID.test(span.traceId) ||
      typeof span.spanId !== 'string' ||
      !SPAN_ID.test(span.spanId) ||
      (span.parentSpanId !== undefined &&
        (typeof span.parentSpanId !== 'string' ||
          !SPAN_ID.test(span.parentSpanId) ||
          span.parentSpanId === span.spanId)) ||
      typeof span.name !== 'string' ||
      !span.name.length ||
      Buffer.byteLength(span.name) > 128 ||
      typeof span.kind !== 'string' ||
      !['server', 'client', 'internal'].includes(span.kind) ||
      typeof span.status !== 'string' ||
      !['ok', 'error', 'unset'].includes(span.status) ||
      !Number.isFinite(time) ||
      time < now - retentionDays * 86400000 ||
      time > now + 300000 ||
      typeof span.durationMs !== 'number' ||
      !Number.isFinite(span.durationMs) ||
      span.durationMs < 0 ||
      span.durationMs > 30 * 86400000 ||
      !record(span.attributes) ||
      Object.keys(span.attributes).length > MAX_TRACE_ATTRIBUTES
    )
      throw new Error('Invalid trace span');
    const attributes: TraceSpan['attributes'] = {};
    for (const [key, value] of Object.entries(span.attributes)) {
      if (
        !ATTRIBUTES.has(key) ||
        !['string', 'boolean', 'number'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)) ||
        (typeof value === 'string' &&
          Buffer.byteLength(value) > MAX_TRACE_ATTRIBUTE_BYTES)
      )
        throw new Error('Invalid trace attribute');
      if (
        typeof value === 'string' &&
        Array.from(value).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error('Invalid trace attribute');
      if (
        key === 'http.route' &&
        (typeof value !== 'string' || /[?#]/.test(value))
      )
        throw new Error('Invalid trace route');
      if (
        key === 'gateway.request.id' &&
        (typeof value !== 'string' ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
      )
        throw new Error('Invalid trace request identity');
      attributes[key] = value as string | number | boolean;
    }
    output.push({
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId
        ? { parentSpanId: span.parentSpanId as string }
        : {}),
      name: span.name,
      kind: span.kind as TraceSpan['kind'],
      timestamp: new Date(time).toISOString(),
      durationMs: span.durationMs,
      status: span.status as TraceSpan['status'],
      attributes,
    });
  }
  return output;
}

@Injectable()
export class TraceIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TraceIngestionService.name);
  private timer?: ReturnType<typeof setInterval>;
  private cleanup?: Promise<void>;
  private schemaCursor = '';
  private stopping = false;
  private cleanupRunning = false;
  private readonly settings: TraceIngestionSettings;
  private active = 0;
  constructor(
    private readonly dataSource: DataSource,
    @Optional() config: ConfigService = new ConfigService(),
  ) {
    this.settings = {
      ...DEFAULT_TRACE_INGESTION,
      ...config.get<TraceIngestionSettings>('traceIngestion'),
    };
  }
  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.cleanup || this.stopping) return;
      this.cleanup = this.cleanupExpired()
        .catch(() => {
          this.logger.warn(
            'Trace retention cleanup failed; retrying on the next tick',
          );
        })
        .finally(() => {
          this.cleanup = undefined;
        });
    }, 60000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.cleanup;
  }
  async cleanupExpired(): Promise<void> {
    if (
      this.stopping ||
      this.cleanupRunning ||
      this.active >= this.settings.maxConcurrent
    )
      return;
    this.cleanupRunning = true;
    this.active++;
    try {
      const schemas = await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SELECT set_config('statement_timeout', $1, true)`,
          [String(this.settings.statementTimeoutMs)],
        );
        return manager.query<Array<{ table_schema: string }>>(
          `SELECT table_schema FROM information_schema.tables WHERE table_name = 'trace_spans' AND table_schema > $1 AND table_schema ~ '^tenant_[0-9a-f]{8}(_[0-9a-f]{4}){3}_[0-9a-f]{12}$' ORDER BY table_schema LIMIT 64`,
          [this.schemaCursor],
        );
      });
      for (const { table_schema: schema } of schemas) {
        if (this.stopping) break;
        if (
          !/^tenant_[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}$/.test(schema)
        )
          throw new Error('Invalid trace retention schema');
        const tenantId = schema.slice(7).replace(/_/g, '-');
        try {
          await this.dataSource.transaction(async (manager) => {
            await manager.query(
              `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`,
              [
                String(this.settings.statementTimeoutMs),
                String(this.settings.lockTimeoutMs),
              ],
            );
            await manager.query(
              `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
              [`trace-ingestion:${tenantId}`],
            );
            await manager.query(
              `DELETE FROM ${schema}.trace_spans WHERE timestamp < NOW() - make_interval(secs => $1::integer * 86400)`,
              [this.settings.retentionDays],
            );
          });
        } catch {
          this.logger.warn(
            'A tenant trace retention cleanup failed; continuing the sweep',
          );
        }
        this.schemaCursor = schema;
      }
      if (schemas.length < 64) this.schemaCursor = '';
    } finally {
      this.active--;
      this.cleanupRunning = false;
    }
  }
  get activeIngestions(): number {
    return this.active;
  }
  async ingest(tenantId: string, payload: unknown): Promise<void> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(tenantId))
      throw new Error('Invalid tenant identifier');
    tenantId = tenantId.toLowerCase();
    const spans = validateTraceBatch(payload, this.settings.retentionDays);
    if (this.active >= this.settings.maxConcurrent)
      throw new Error('Trace ingestion capacity exhausted');
    this.active++;
    const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`,
          [
            String(this.settings.statementTimeoutMs),
            String(this.settings.lockTimeoutMs),
          ],
        );
        await manager.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [`trace-ingestion:${tenantId}`],
        );
        await manager.query(
          `DELETE FROM ${schema}.trace_spans WHERE timestamp < NOW() - make_interval(secs => $1::integer * 86400)`,
          [this.settings.retentionDays],
        );
        const values = spans.map((span) => [
          span.traceId,
          span.spanId,
          span.parentSpanId ?? null,
          span.name,
          span.kind,
          span.timestamp,
          span.durationMs,
          span.status,
          JSON.stringify(span.attributes),
        ]);
        await manager.query(
          `INSERT INTO ${schema}.trace_spans ("traceId", "spanId", "parentSpanId", name, kind, timestamp, "durationMs", status, attributes) VALUES ${values.map((_, i) => `(${Array.from({ length: 9 }, (_, j) => `$${i * 9 + j + 1}`).join(', ')})`).join(', ')} ON CONFLICT ("traceId", "spanId") DO NOTHING`,
          values.flat(),
        );
        await manager.query(
          `DELETE FROM ${schema}.trace_spans WHERE ("traceId", "spanId") IN (SELECT "traceId", "spanId" FROM ${schema}.trace_spans ORDER BY timestamp DESC, "traceId", "spanId" OFFSET $1)`,
          [this.settings.maxRowsPerTenant],
        );
      });
    } finally {
      this.active--;
    }
  }
}
