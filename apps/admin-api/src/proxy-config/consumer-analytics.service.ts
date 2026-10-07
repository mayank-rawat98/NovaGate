import {
  retentionCoverage,
  retentionProfile,
} from '../log-retention/log-retention.policy';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  ConsumerAnalyticsPeriod,
  ConsumerUsageStats,
} from '@api-gateway/shared-types';
import { DataSource } from 'typeorm';
import { tenantSchema } from '../tenants/tenant-schema';

import {
  CONSUMER_ANALYTICS_ROW_LIMIT,
  logPrivacyPolicy,
} from '@api-gateway/shared-types';
export { CONSUMER_ANALYTICS_ROW_LIMIT } from '@api-gateway/shared-types';
const PERIODS = {
  '1h': { seconds: 3600, bucket: 60 },
  '24h': { seconds: 86400, bucket: 900 },
  '7d': { seconds: 604800, bucket: 3600 },
};
export function consumerIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    throw new BadRequestException('Select a valid consumer');
  return value.toLowerCase();
}

/** Exact bounded log-derived aggregates. Over-limit windows fail explicitly. */
@Injectable()
export class ConsumerAnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger(ConsumerAnalyticsService.name);
  private readonly work = new Set<Promise<ConsumerUsageStats>>();
  private readonly tenants = new Map<string, number>();
  private stopping = false;
  constructor(private readonly db: DataSource) {}

  async get(
    tenantId: string,
    consumerId: unknown,
    period: unknown = '24h',
  ): Promise<ConsumerUsageStats> {
    const schema = tenantSchema(tenantId);
    const canonical = schema.slice(7).replace(/_/g, '-');
    const consumer = consumerIdentity(consumerId);
    if (typeof period !== 'string' || !Object.hasOwn(PERIODS, period))
      throw new BadRequestException('Choose 1h, 24h or 7d');
    if (
      this.stopping ||
      this.work.size >= 8 ||
      (this.tenants.get(canonical) ?? 0) >= 2
    )
      throw new ServiceUnavailableException(
        'Consumer usage is busy. Please retry shortly.',
      );
    this.tenants.set(canonical, (this.tenants.get(canonical) ?? 0) + 1);
    const request = this.read(
      schema,
      consumer,
      period as ConsumerAnalyticsPeriod,
    );
    this.work.add(request);
    try {
      return await request;
    } finally {
      this.work.delete(request);
      const remaining = (this.tenants.get(canonical) ?? 1) - 1;
      if (remaining) this.tenants.set(canonical, remaining);
      else this.tenants.delete(canonical);
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled([...this.work]);
  }
  private async read(
    schema: string,
    consumerId: string,
    period: ConsumerAnalyticsPeriod,
  ): Promise<ConsumerUsageStats> {
    const { seconds, bucket } = PERIODS[period];
    const to = new Date(Date.now()).toISOString();
    const from = new Date(Date.parse(to) - seconds * 1000).toISOString();
    // Filters are parameters; only the validated tenant schema is interpolated.
    // One repeatable snapshot keeps metadata, totals, paths and series consistent.
    const counts = `COUNT(*)::integer AS requests,
      COUNT(*) FILTER (WHERE "statusCode">=500)::integer AS "serverErrors",
      COALESCE(COUNT(*) FILTER (WHERE "statusCode">=500)::double precision / NULLIF(COUNT(*),0),0) AS "errorRate",
      COUNT("responseTimeMs")::integer AS "latencySamples",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY "responseTimeMs") AS "p50Ms",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "responseTimeMs") AS "p95Ms",
      percentile_cont(0.99) WITHIN GROUP (ORDER BY "responseTimeMs") AS "p99Ms"`;
    try {
      const result: ConsumerUsageStats = await this.db.transaction(
        'REPEATABLE READ',
        async (manager) => {
          await manager.query(
            `SELECT set_config('statement_timeout','3000',true),set_config('lock_timeout','1000',true),set_config('work_mem','4MB',true)`,
          );
          const [consumer] = await manager.query(
            `SELECT id,LEFT(name,256) AS name,to_char("revokedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "revokedAt" FROM ${schema}.consumers WHERE id=$1`,
            [consumerId],
          );
          if (!consumer)
            throw new NotFoundException('Consumer not found in this workspace');
          const profile = await retentionProfile(
            manager,
            schema.slice(7).replace(/_/g, '-'),
          );
          const [privacy] = await manager.query(
            'SELECT "logPrivacy","logPrivacyRevision" FROM public.tenants WHERE id=$1',
            [schema.slice(7).replace(/_/g, '-')],
          );
          if (!privacy) throw new NotFoundException('Workspace not found');
          const hidden =
            logPrivacyPolicy(privacy.logPrivacy).redactedFields ?? [];
          const [row] = await manager.query(
            `WITH selected AS MATERIALIZED (
          SELECT timestamp,LEFT(COALESCE(method,'UNKNOWN'),16) AS method,
            CASE WHEN $8::boolean THEN '[redacted]' ELSE LEFT(split_part(COALESCE(path,'/'), '?', 1),512) END AS path,"statusCode",
            CASE WHEN "responseTimeMs">=0 THEN "responseTimeMs" END AS "responseTimeMs"
          FROM ${schema}.request_logs WHERE NOT $9::boolean AND "consumerId"=$1 AND timestamp>=$2::timestamptz AND timestamp<$3::timestamptz AND "receivedAt">=$7::timestamptz
          ORDER BY timestamp DESC,id DESC LIMIT $4
        ), cardinality AS (SELECT COUNT(*)::integer AS matched FROM selected),
        supported AS MATERIALIZED (SELECT * FROM selected WHERE (SELECT matched FROM cardinality)<$4),
        totals AS (SELECT ${counts},COUNT(*)::double precision/$5 AS rps FROM supported),
        buckets AS (SELECT date_bin(make_interval(secs=>$6),timestamp,$2::timestamptz) AS timestamp,
          ${counts},COUNT(*)::double precision/$6 AS rps FROM supported GROUP BY 1),
        paths AS (SELECT method,path,${counts},COUNT(*)::double precision/$5 AS rps FROM supported
          GROUP BY method,path ORDER BY requests DESC,method,path LIMIT 10),
        series AS (SELECT to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp,
          COALESCE(b.requests,0) AS requests,COALESCE(b."serverErrors",0) AS "serverErrors",
          COALESCE(b."errorRate",0) AS "errorRate",COALESCE(b.rps,0) AS rps,
          COALESCE(b."latencySamples",0) AS "latencySamples",b."p50Ms",b."p95Ms",b."p99Ms"
          FROM generate_series($2::timestamptz,$3::timestamptz-make_interval(secs=>$6),make_interval(secs=>$6)) t
          LEFT JOIN buckets b ON b.timestamp=t)
        SELECT matched,to_jsonb(totals) AS totals,
          (SELECT COALESCE(jsonb_agg(series ORDER BY timestamp),'[]'::jsonb) FROM series) AS series,
          (SELECT COALESCE(jsonb_agg(paths ORDER BY requests DESC,method,path),'[]'::jsonb) FROM paths) AS paths
        FROM cardinality CROSS JOIN totals`,
            [
              consumerId,
              from,
              to,
              CONSUMER_ANALYTICS_ROW_LIMIT + 1,
              seconds,
              bucket,
              profile.cutoff,
              hidden.includes('path'),
              hidden.includes('consumerId'),
            ],
          );
          if (row.matched > CONSUMER_ANALYTICS_ROW_LIMIT)
            throw new ServiceUnavailableException(
              'This window exceeds the consumer usage limit. Choose a shorter period.',
            );
          return {
            ...row.totals,
            retention: retentionCoverage(profile),
            privacy: {
              revision: privacy.logPrivacyRevision,
              redactedFields: hidden,
            },
            consumer: {
              id: consumer.id,
              name: consumer.name,
              revokedAt: consumer.revokedAt ?? null,
            },
            period,
            from,
            to,
            generatedAt: new Date(Date.now()).toISOString(),
            source: 'persisted_request_logs',
            bucketSeconds: bucket,
            rowLimit: CONSUMER_ANALYTICS_ROW_LIMIT,
            series: row.series,
            topPaths: row.paths,
          };
        },
      );
      // A policy change during a long snapshot must not publish stale retained-data counts.
      const valid = await this.db.transaction(async (manager) => {
        await manager.query(
          "SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'",
        );
        const [row] = await manager.query(
          'SELECT "logRetentionRevision"=$2::uuid AND "logPrivacyRevision"=$3::uuid AS valid FROM public.tenants WHERE id=$1',
          [
            schema.slice(7).replace(/_/g, '-'),
            result.retention?.revision,
            result.privacy?.revision,
          ],
        );
        return row?.valid;
      });
      if (!valid)
        throw new ServiceUnavailableException(
          'Log privacy or retention changed. Retry consumer usage.',
        );
      return result;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      this.logger.warn(
        'Consumer usage query failed; please retry the bounded request',
      );
      throw new ServiceUnavailableException(
        'Consumer usage is temporarily unavailable. Please retry.',
      );
    }
  }
}
