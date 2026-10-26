import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import type {
  TraceSpan,
  TraceSummary,
  TraceListResponse,
  TraceDetailResponse,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import {
  DEFAULT_TRACE_QUERIES,
  type TraceQuerySettings,
} from './traces.configuration';

const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ROUTE_SQL = `COALESCE(attributes->>'http.route', CASE WHEN attributes ? 'rpc.service' AND attributes ? 'rpc.method' THEN '/' || (attributes->>'rpc.service') || '/' || (attributes->>'rpc.method') END, 'unmatched')`;
function text(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 256)
    throw new BadRequestException('Invalid trace filter');
  return value;
}
function time(value: string): Date {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new BadRequestException('Use a valid UTC timestamp');
  return new Date(value);
}
function cursor(value: string): { timestamp: string; traceId: string } {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      typeof decoded.timestamp !== 'string' ||
      typeof decoded.traceId !== 'string' ||
      !TRACE_ID.test(decoded.traceId)
    )
      throw new Error();
    return {
      timestamp: time(decoded.timestamp).toISOString(),
      traceId: decoded.traceId,
    };
  } catch {
    throw new BadRequestException('Invalid trace cursor');
  }
}

@Injectable()
export class TracesService {
  private readonly settings: TraceQuerySettings;
  private active = 0;
  constructor(
    private readonly dataSource: DataSource,
    @Optional() config: ConfigService = new ConfigService(),
  ) {
    this.settings = {
      ...DEFAULT_TRACE_QUERIES,
      ...config.get<TraceQuerySettings>('traceQueries'),
    };
  }
  private async query<T>(
    tenantId: string,
    fn: (manager: EntityManager, schema: string) => Promise<T>,
  ): Promise<T> {
    if (!UUID.test(tenantId))
      throw new BadRequestException('Invalid workspace');
    if (this.active >= this.settings.maxConcurrent)
      throw new ServiceUnavailableException(
        'Trace queries are busy. Please retry.',
      );
    this.active++;
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SELECT set_config('statement_timeout', $1, true)`,
          [String(this.settings.statementTimeoutMs)],
        );
        return fn(manager, tenantSchema(tenantId));
      });
    } finally {
      this.active--;
    }
  }
  async list(
    tenantId: string,
    input: Record<string, unknown>,
  ): Promise<TraceListResponse> {
    if (
      Object.keys(input).some(
        (key) =>
          ![
            'from',
            'to',
            'traceId',
            'requestId',
            'route',
            'errorsOnly',
            'cursor',
          ].includes(key),
      )
    )
      throw new BadRequestException('Unknown trace filter');
    const now = new Date();
    const from = text(input.from);
    const to = text(input.to);
    const start = from ? time(from) : new Date(now.getTime() - 86400000);
    const end = to ? time(to) : now;
    if (
      start >= end ||
      end.getTime() - start.getTime() > this.settings.maxRangeDays * 86400000
    )
      throw new BadRequestException('Choose a valid bounded time range');
    const traceId = text(input.traceId);
    const requestId = text(input.requestId);
    const route = text(input.route);
    const errorsOnly = text(input.errorsOnly);
    const next = text(input.cursor);
    if (
      (traceId && !TRACE_ID.test(traceId)) ||
      (requestId && !UUID.test(requestId)) ||
      (route && /[?#]/.test(route)) ||
      (errorsOnly && !['true', 'false'].includes(errorsOnly))
    )
      throw new BadRequestException('Invalid trace filter');
    const after = next ? cursor(next) : undefined;
    return this.query(tenantId, async (manager, schema) => {
      const cutoff = new Date(
        now.getTime() - this.settings.retentionDays * 86400000,
      );
      const params: unknown[] = [
        new Date(Math.max(start.getTime(), cutoff.getTime())).toISOString(),
        end.toISOString(),
      ];
      const conditions = ['timestamp >= $1', 'timestamp <= $2'];
      if (traceId) {
        params.push(traceId);
        conditions.push(`"traceId" = $${params.length}`);
      }
      if (requestId) {
        params.push(requestId);
        conditions.push(
          `attributes->>'gateway.request.id' = $${params.length}`,
        );
      }
      if (route) {
        params.push(route);
        conditions.push(`${ROUTE_SQL} = $${params.length}`);
      }
      const grouped = `SELECT "traceId", MIN(timestamp) AS timestamp,
        GREATEST(0, EXTRACT(EPOCH FROM (MAX(timestamp + "durationMs" * INTERVAL '1 millisecond') - MIN(timestamp))) * 1000)::double precision AS "durationMs",
        COUNT(*)::integer AS "spanCount", CASE WHEN BOOL_OR(status = 'error') THEN 'error' WHEN BOOL_OR(status = 'ok') THEN 'ok' ELSE 'unset' END AS status,
        (array_agg(${ROUTE_SQL} ORDER BY (kind = 'server') DESC, timestamp))[1] AS route,
        (array_agg(attributes->>'gateway.request.id' ORDER BY (kind = 'server') DESC, timestamp))[1] AS "requestId"
        FROM ${schema}.trace_spans WHERE ${conditions.join(' AND ')} GROUP BY "traceId"`;
      const groupedConditions = [];
      if (errorsOnly === 'true') groupedConditions.push(`status = 'error'`);
      if (after) {
        params.push(after.timestamp, after.traceId);
        groupedConditions.push(
          `(timestamp, "traceId") < ($${params.length - 1}::timestamptz, $${params.length}::varchar)`,
        );
      }
      params.push(this.settings.pageSize + 1);
      const rows = await manager.query<
        Array<
          Omit<TraceSummary, 'timestamp' | 'requestId'> & {
            timestamp: Date;
            requestId: string | null;
          }
        >
      >(
        `SELECT * FROM (${grouped}) grouped ${groupedConditions.length ? `WHERE ${groupedConditions.join(' AND ')}` : ''} ORDER BY timestamp DESC, "traceId" DESC LIMIT $${params.length}`,
        params,
      );
      const more = rows.length > this.settings.pageSize;
      const traces: TraceSummary[] = rows
        .slice(0, this.settings.pageSize)
        .map((row) => ({
          ...row,
          timestamp: new Date(row.timestamp).toISOString(),
          requestId: row.requestId ?? undefined,
        }));
      const last = traces.at(-1);
      return {
        traces,
        nextCursor:
          more && last
            ? Buffer.from(
                JSON.stringify({
                  timestamp: last.timestamp,
                  traceId: last.traceId,
                }),
              ).toString('base64url')
            : null,
      };
    });
  }
  async detail(
    tenantId: string,
    traceId: string,
  ): Promise<TraceDetailResponse> {
    if (!TRACE_ID.test(traceId))
      throw new BadRequestException('Invalid trace ID');
    return this.query(tenantId, async (manager, schema) => {
      const rows = await manager.query<
        Array<
          Omit<TraceSpan, 'timestamp' | 'parentSpanId'> & {
            timestamp: Date;
            parentSpanId: string | null;
          }
        >
      >(
        `SELECT "traceId", "spanId", "parentSpanId", name, kind, timestamp, "durationMs", status, attributes FROM ${schema}.trace_spans WHERE "traceId" = $1 AND timestamp >= NOW() - make_interval(secs => $3::integer * 86400) ORDER BY timestamp, "spanId" LIMIT $2`,
        [
          traceId,
          this.settings.maxDetailSpans + 1,
          this.settings.retentionDays,
        ],
      );
      if (!rows.length)
        throw new NotFoundException('Trace not found or no longer retained');
      return {
        traceId,
        spans: rows.slice(0, this.settings.maxDetailSpans).map((span) => ({
          ...span,
          timestamp: new Date(span.timestamp).toISOString(),
          parentSpanId: span.parentSpanId ?? undefined,
        })),
        truncated: rows.length > this.settings.maxDetailSpans,
      };
    });
  }
}
