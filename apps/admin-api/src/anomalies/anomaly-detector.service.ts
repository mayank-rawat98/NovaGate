import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import {
  ANOMALY_BASELINE_DAYS,
  ANOMALY_CURRENT_MINUTES,
  ANOMALY_WINDOW_MINUTES,
  MAX_ANOMALY_CHANNELS,
  describeAnomaly,
  type AlertAnomalyDetail,
  type AlertChannelType,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import {
  CALM_TICKS_TO_RESOLVE,
  MIN_WINDOW_REQUESTS,
  scoreRoute,
  windowStart,
  type CurrentWindow,
  type Finding,
  type RouteBaseline,
} from './anomaly-scoring';

export const DEFAULT_ANOMALY_INTERVAL_MS = 60000;
const LEASE_SECONDS = 120;
const MAX_ROUTES = 200;
/** Windows materialized per evaluation while catching up. */
const MAX_CATCH_UP_WINDOWS = 16;
/** A new workspace's first baseline starts this far back. */
const INITIAL_LOOKBACK_HOURS = 24;
/** Logs commit within seconds of receipt; wait this long before closing a window. */
const WINDOW_GRACE_MS = 60000;
const MAX_NEW_ANOMALIES_PER_TICK = 10;
const WINDOW_MS = ANOMALY_WINDOW_MINUTES * 60000;
const ROUTE_COLUMNS = `method, path, count(*)::bigint AS requests,
  count(*) FILTER (WHERE "statusCode" >= 500)::bigint AS "serverErrors",
  percentile_cont(0.95) WITHIN GROUP (ORDER BY "responseTimeMs") AS "p95Ms"`;
const ROUTE_FILTER = `method IS NOT NULL AND path IS NOT NULL
  AND char_length(method) <= 16 AND char_length(path) <= 512`;

/** TypeORM returns [rows, affectedCount] for UPDATE ... RETURNING. */
function returnedRows<T>(result: unknown): T[] {
  return Array.isArray(result) && Array.isArray(result[0])
    ? (result[0] as T[])
    : ((result as T[]) ?? []);
}

export interface AnomalyLease {
  tenantId: string;
  leaseToken: string;
}

interface ResolvedRow {
  method: string;
  path: string;
  metric: Finding['metric'];
  direction: Finding['direction'];
  baseline_mean: number;
  baseline_stddev: number;
  baseline_windows: number;
  z_score: number;
}

interface Settings {
  enabled: boolean;
  zThreshold: number;
  minRequests: number;
  nextWindow: Date | null;
}

export function anomalyIntervalMs(value: unknown): number {
  if (value === undefined || value === '') return DEFAULT_ANOMALY_INTERVAL_MS;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 3600000)
    throw new Error(
      'ANOMALY_EVALUATION_INTERVAL_MS must be an integer from 1000 to 3600000',
    );
  return ms;
}

/**
 * Per-workspace anomaly detection. Each evaluation (one lease per workspace)
 * materializes completed 15-minute route windows from received request logs,
 * scores the rolling 5-minute window against them and records anomalies.
 * Anomalies open and resolve Phase 4 alert events and deliveries.
 */
@Injectable()
export class AnomalyDetectorService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AnomalyDetectorService.name);
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.intervalMs = anomalyIntervalMs(
      config.get('ANOMALY_EVALUATION_INTERVAL_MS'),
    );
  }

  onApplicationBootstrap(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => {
      if (this.running || this.stopping) return;
      void this.tick().catch(() =>
        this.logger.warn('Anomaly evaluation tick failed.'),
      );
    }, 1000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.running) return this.running;
    const work = this.runBatch();
    this.running = work;
    try {
      await work;
    } finally {
      if (this.running === work) this.running = undefined;
    }
  }

  private async runBatch(): Promise<void> {
    const leases = await this.claimDue();
    for (const lease of leases) {
      if (this.stopping) break;
      try {
        await this.evaluate(lease);
      } catch {
        this.logger.warn(
          'An anomaly evaluation failed; its lease will expire for retry.',
        );
      }
    }
  }

  async claimDue(): Promise<AnomalyLease[]> {
    if (this.stopping) return [];
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('statement_timeout', '3000', true), set_config('lock_timeout', '1000', true)`,
      );
      return manager.query<AnomalyLease[]>(
        `WITH due AS (
          SELECT "tenantId" FROM public.anomaly_schedule
          WHERE "dueAt" <= clock_timestamp() AND ("leaseUntil" IS NULL OR "leaseUntil" <= clock_timestamp())
          ORDER BY "dueAt", "tenantId" LIMIT 8 FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE public.anomaly_schedule q SET "leaseToken" = gen_random_uuid(),
            "leaseUntil" = clock_timestamp() + make_interval(secs => $1)
          FROM due WHERE q."tenantId" = due."tenantId"
          RETURNING q."tenantId", q."leaseToken"
        ) SELECT * FROM claimed`,
        [LEASE_SECONDS],
      );
    });
  }

  /** One workspace evaluation. Returns false when the lease was lost. */
  async evaluate(lease: AnomalyLease): Promise<boolean> {
    const schema = tenantSchema(lease.tenantId);
    const tenant = lease.tenantId.toLowerCase();
    const settings = await this.bounded(3000, (manager) =>
      this.settings(manager, schema),
    );
    if (settings?.enabled) await this.materialize(schema, settings);
    return this.bounded(10000, async (manager) => {
      const [held] = await manager.query(
        `SELECT 1 FROM public.anomaly_schedule WHERE "tenantId" = $1 AND "leaseToken" = $2
          AND "leaseUntil" > clock_timestamp() FOR UPDATE`,
        [tenant, lease.leaseToken],
      );
      if (!held) return false;
      const [{ now }] = await manager.query<Array<{ now: Date }>>(
        `SELECT clock_timestamp() AS now`,
      );
      // Re-read under the lease: settings may have changed meanwhile.
      const current = await this.settings(manager, schema);
      if (current?.enabled)
        await this.score(manager, schema, tenant, current, now);
      else if (current)
        // Detection off: close what is open, without notifications.
        await manager.query(
          `UPDATE ${schema}.anomalies SET state = 'resolved', resolved_at = $1 WHERE state = 'active'`,
          [now],
        );
      if (current) await this.prune(manager, schema, now);
      await manager.query(
        `UPDATE public.anomaly_schedule SET "dueAt" = $3::timestamptz + make_interval(secs => $4),
          "leaseToken" = NULL, "leaseUntil" = NULL WHERE "tenantId" = $1 AND "leaseToken" = $2`,
        [tenant, lease.leaseToken, now, this.intervalMs / 1000],
      );
      return true;
    });
  }

  private async bounded<T>(
    timeoutMs: number,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '1000', true)`,
        [String(timeoutMs)],
      );
      return work(manager);
    });
  }

  private async settings(
    manager: EntityManager,
    schema: string,
  ): Promise<Settings | null> {
    // Missing until admin migration provisions the workspace's tables.
    const [exists] = await manager.query(
      `SELECT to_regclass($1) IS NOT NULL AS ready`,
      [`${schema}.anomaly_settings`],
    );
    if (!exists?.ready) return null;
    const [row] = await manager.query(
      `SELECT enabled, z_threshold AS "zThreshold", min_requests AS "minRequests", next_window AS "nextWindow"
        FROM ${schema}.anomaly_settings`,
    );
    return row ?? null;
  }

  /**
   * Materializes completed windows in order. A window that cannot be computed
   * within its deadline is skipped, so a busy workspace never stalls.
   */
  private async materialize(schema: string, settings: Settings) {
    const [{ now }] = await this.dataSource.query<Array<{ now: Date }>>(
      `SELECT clock_timestamp() AS now`,
    );
    let next =
      settings.nextWindow ??
      windowStart(new Date(now.getTime() - INITIAL_LOOKBACK_HOURS * 3600000));
    const oldest = windowStart(
      new Date(now.getTime() - ANOMALY_BASELINE_DAYS * 86400000),
    );
    if (next < oldest) next = oldest;
    for (let done = 0; done < MAX_CATCH_UP_WINDOWS && !this.stopping; done++) {
      if (next.getTime() + WINDOW_MS + WINDOW_GRACE_MS > now.getTime()) break;
      const start = next;
      const end = new Date(start.getTime() + WINDOW_MS);
      try {
        await this.bounded(10000, (manager) =>
          manager.query(
            `INSERT INTO ${schema}.route_traffic_windows (window_start, method, path, requests, server_errors, p95_ms)
            SELECT $1::timestamptz, method, path, requests, "serverErrors", "p95Ms" FROM (
              SELECT ${ROUTE_COLUMNS} FROM ${schema}.request_logs
              WHERE "receivedAt" >= $1 AND "receivedAt" < $2 AND ${ROUTE_FILTER}
              GROUP BY method, path ORDER BY count(*) DESC LIMIT ${MAX_ROUTES}
            ) routes ON CONFLICT DO NOTHING`,
            [start, end],
          ),
        );
      } catch {
        this.logger.warn('An anomaly baseline window was skipped.');
      }
      // Compare-and-set: an overlapping evaluation (expired lease) may have
      // advanced the cursor; then it owns the rest of the catch-up.
      const advanced = returnedRows(
        await this.dataSource.query(
          `UPDATE ${schema}.anomaly_settings SET next_window = $1
            WHERE next_window IS NOT DISTINCT FROM $2 RETURNING 1`,
          [end, settings.nextWindow],
        ),
      );
      if (!advanced.length) break;
      settings.nextWindow = end;
      next = end;
    }
  }

  private async score(
    manager: EntityManager,
    schema: string,
    tenant: string,
    settings: Settings,
    now: Date,
  ) {
    const currentRows = await manager.query<
      Array<{
        method: string;
        path: string;
        requests: string;
        serverErrors: string;
        p95Ms: number | null;
      }>
    >(
      `SELECT ${ROUTE_COLUMNS} FROM ${schema}.request_logs
        WHERE "receivedAt" >= $1::timestamptz - make_interval(mins => $2) AND ${ROUTE_FILTER}
        GROUP BY method, path ORDER BY count(*) DESC LIMIT ${MAX_ROUTES}`,
      [now, ANOMALY_CURRENT_MINUTES],
    );
    const current = new Map<string, CurrentWindow>(
      currentRows.map((row) => [
        `${row.method} ${row.path}`,
        {
          method: row.method,
          path: row.path,
          requests: Number(row.requests),
          serverErrors: Number(row.serverErrors),
          p95Ms: row.p95Ms === null ? null : Number(row.p95Ms),
        },
      ]),
    );
    const baselines = settings.nextWindow
      ? await this.baselines(manager, schema, settings.nextWindow)
      : [];
    // Traffic drops only count for routes that still exist and are enabled.
    const configured = new Set(
      (
        await manager.query<Array<{ pathPattern: string }>>(
          `SELECT DISTINCT "pathPattern" FROM ${schema}.routes WHERE "deletedAt" IS NULL AND enabled = true LIMIT 1000`,
        )
      ).map((row) => row.pathPattern),
    );
    const findings: Finding[] = [];
    for (const baseline of baselines) {
      const route = current.get(`${baseline.method} ${baseline.path}`);
      for (const finding of scoreRoute(route, baseline, settings))
        if (finding.direction === 'up' || configured.has(finding.path))
          findings.push(finding);
    }
    const active = await manager.query<
      Array<{
        id: string;
        method: string;
        path: string;
        metric: Finding['metric'];
        calm_ticks: number;
      }>
    >(
      `SELECT id, method, path, metric, calm_ticks FROM ${schema}.anomalies WHERE state = 'active' FOR UPDATE`,
    );
    const key = (item: { method: string; path: string; metric: string }) =>
      `${item.method} ${item.path} ${item.metric}`;
    const open = new Map(active.map((row) => [key(row), row]));
    let created = 0;
    for (const finding of findings.sort(
      (a, b) => Math.abs(b.zScore) - Math.abs(a.zScore),
    )) {
      const existing = open.get(key(finding));
      if (existing) {
        open.delete(key(finding));
        await manager.query(
          `UPDATE ${schema}.anomalies SET current = $2, z_score = $3, requests = $4, last_seen_at = $5, calm_ticks = 0 WHERE id = $1`,
          [existing.id, finding.current, finding.zScore, finding.requests, now],
        );
        continue;
      }
      if (created >= MAX_NEW_ANOMALIES_PER_TICK) continue;
      created++;
      const [{ id }] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO ${schema}.anomalies (method, path, metric, direction, baseline_mean, baseline_stddev,
          baseline_windows, current, z_score, requests, started_at, last_seen_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id`,
        [
          finding.method,
          finding.path,
          finding.metric,
          finding.direction,
          finding.baseline.mean,
          finding.baseline.stddev,
          finding.baseline.windows,
          finding.current,
          finding.zScore,
          finding.requests,
          now,
        ],
      );
      await this.raise(manager, schema, tenant, id, finding, 'firing', now);
    }
    // Active anomalies not seen this evaluation calm down, then resolve.
    for (const row of open.values()) {
      if (row.calm_ticks + 1 < CALM_TICKS_TO_RESOLVE) {
        await manager.query(
          `UPDATE ${schema}.anomalies SET calm_ticks = calm_ticks + 1 WHERE id = $1`,
          [row.id],
        );
        continue;
      }
      const [resolved] = returnedRows<ResolvedRow>(
        await manager.query(
          `UPDATE ${schema}.anomalies SET state = 'resolved', resolved_at = $2, calm_ticks = calm_ticks + 1
          WHERE id = $1 RETURNING method, path, metric, direction, baseline_mean, baseline_stddev,
          baseline_windows, current, z_score, requests`,
          [row.id, now],
        ),
      );
      const route = current.get(`${resolved.method} ${resolved.path}`);
      await this.raise(
        manager,
        schema,
        tenant,
        row.id,
        {
          method: resolved.method,
          path: resolved.path,
          metric: resolved.metric,
          direction: resolved.direction,
          baseline: {
            mean: resolved.baseline_mean,
            stddev: resolved.baseline_stddev,
            windows: resolved.baseline_windows,
          },
          current: this.currentValue(resolved.metric, route),
          zScore: resolved.z_score,
          requests: route?.requests ?? 0,
        },
        'resolved',
        now,
      );
    }
  }

  private currentValue(metric: Finding['metric'], route?: CurrentWindow) {
    if (!route) return 0;
    if (metric === 'error_rate') return route.serverErrors / route.requests;
    if (metric === 'p95_latency_ms') return route.p95Ms ?? 0;
    return route.requests / (ANOMALY_CURRENT_MINUTES * 60);
  }

  private async baselines(
    manager: EntityManager,
    schema: string,
    nextWindow: Date,
  ): Promise<RouteBaseline[]> {
    const rows = await manager.query<
      Array<{
        method: string;
        path: string;
        first: Date;
        n: number;
        rpsSum: number;
        rpsSq: number;
        qn: number;
        eSum: number | null;
        eSq: number | null;
        pn: number;
        pSum: number | null;
        pSq: number | null;
      }>
    >(
      `SELECT method, path, min(window_start) AS first, count(*)::int AS n,
        sum(requests / $3::float8) AS "rpsSum", sum((requests / $3::float8) ^ 2) AS "rpsSq",
        count(*) FILTER (WHERE requests >= ${MIN_WINDOW_REQUESTS})::int AS qn,
        sum(server_errors::float8 / requests) FILTER (WHERE requests >= ${MIN_WINDOW_REQUESTS}) AS "eSum",
        sum((server_errors::float8 / requests) ^ 2) FILTER (WHERE requests >= ${MIN_WINDOW_REQUESTS}) AS "eSq",
        count(p95_ms) FILTER (WHERE requests >= ${MIN_WINDOW_REQUESTS})::int AS pn,
        sum(p95_ms) FILTER (WHERE requests >= ${MIN_WINDOW_REQUESTS}) AS "pSum",
        sum(p95_ms ^ 2) FILTER (WHERE requests >= ${MIN_WINDOW_REQUESTS}) AS "pSq"
      FROM ${schema}.route_traffic_windows
      WHERE window_start >= $1::timestamptz - make_interval(days => $2) AND window_start < $1
      GROUP BY method, path ORDER BY sum(requests) DESC LIMIT ${MAX_ROUTES}`,
      [nextWindow, ANOMALY_BASELINE_DAYS, ANOMALY_WINDOW_MINUTES * 60],
    );
    return rows.map((row) => ({
      method: row.method,
      path: row.path,
      span: Math.max(
        row.n,
        Math.floor(
          (nextWindow.getTime() - new Date(row.first).getTime()) / WINDOW_MS,
        ),
      ),
      rps: { n: row.n, sum: Number(row.rpsSum), sumSq: Number(row.rpsSq) },
      errorRate: {
        n: row.qn,
        sum: Number(row.eSum ?? 0),
        sumSq: Number(row.eSq ?? 0),
      },
      p95: {
        n: row.pn,
        sum: Number(row.pSum ?? 0),
        sumSq: Number(row.pSq ?? 0),
      },
    }));
  }

  /** Records an alert event for the anomaly and queues configured channels. */
  private async raise(
    manager: EntityManager,
    schema: string,
    tenant: string,
    anomalyId: string,
    finding: Finding,
    state: 'firing' | 'resolved',
    now: Date,
  ) {
    const summary = describeAnomaly(finding).slice(0, 700);
    const detail: AlertAnomalyDetail = {
      id: anomalyId,
      method: finding.method,
      path: finding.path,
      direction: finding.direction,
      baseline: finding.baseline.mean,
      zScore: finding.zScore,
      summary,
    };
    const name =
      `Anomaly: ${finding.metric} ${finding.method} ${finding.path}`.slice(
        0,
        100,
      );
    const [{ id: eventId }] = await manager.query<Array<{ id: string }>>(
      `INSERT INTO ${schema}.alert_events
        ("ruleId", "ruleName", metric, operator, threshold, "windowMinutes", state, value, "createdAt", "anomalyId", anomaly)
        VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING id`,
      [
        name,
        finding.metric,
        finding.direction === 'up' ? '>' : '<',
        Math.max(0, finding.baseline.mean),
        ANOMALY_CURRENT_MINUTES,
        state,
        Math.max(0, finding.current),
        now,
        anomalyId,
        JSON.stringify(detail),
      ],
    );
    const channels = await manager.query<
      Array<{
        id: string;
        name: string;
        type: AlertChannelType;
        revision: number;
      }>
    >(
      `SELECT c.id, c.name, c.type, c.revision FROM ${schema}.alert_channels c
        JOIN ${schema}.anomaly_channels a ON a."channelId" = c.id
        WHERE c.enabled = true ORDER BY c.id LIMIT ${MAX_ANOMALY_CHANNELS}`,
    );
    for (const channel of channels) {
      const [{ id: deliveryId }] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO ${schema}.alert_deliveries
          ("eventId", "channelId", "channelName", type, "channelRevision", "nextAttemptAt")
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          eventId,
          channel.id,
          channel.name,
          channel.type,
          channel.revision,
          now,
        ],
      );
      await manager.query(
        `INSERT INTO public.alert_delivery_schedule ("tenantId", "deliveryId", "dueAt") VALUES ($1, $2, $3)`,
        [tenant, deliveryId, now],
      );
    }
  }

  private async prune(manager: EntityManager, schema: string, now: Date) {
    await manager.query(
      `DELETE FROM ${schema}.route_traffic_windows WHERE window_start < $1::timestamptz - make_interval(days => $2)`,
      [now, ANOMALY_BASELINE_DAYS],
    );
    await manager.query(
      `DELETE FROM ${schema}.anomalies WHERE state = 'resolved' AND id IN (
        SELECT id FROM ${schema}.anomalies WHERE state = 'resolved'
          AND (resolved_at < $1::timestamptz - INTERVAL '720 hours' OR id IN (
            SELECT id FROM ${schema}.anomalies ORDER BY started_at DESC, id DESC OFFSET 1000)))`,
      [now],
    );
  }
}
