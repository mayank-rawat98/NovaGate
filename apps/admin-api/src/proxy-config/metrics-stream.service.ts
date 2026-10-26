import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import {
  validateMetricPayload,
  type MetricsSnapshot,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import {
  DEFAULT_METRIC_STREAM,
  type MetricStreamSettings,
} from './metrics-stream.configuration';
type Client = {
  response: Response;
  deadline: number;
  initializing: boolean;
  pending?: MetricsSnapshot;
  close: () => void;
};
@Injectable()
export class MetricsStreamService implements OnModuleInit, OnModuleDestroy {
  private redis?: Redis;
  private timer?: ReturnType<typeof setInterval>;
  private readonly clients = new Map<string, Set<Client>>();
  private total = 0;
  private pendingReads = 0;
  private stopping = false;
  private subscribed = false;
  private readonly settings: MetricStreamSettings;
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {
    this.settings = {
      ...DEFAULT_METRIC_STREAM,
      ...config.get<MetricStreamSettings>('metricStream'),
    };
  }
  async onModuleInit(): Promise<void> {
    this.redis = new Redis(
      this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
      {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: 2000,
        connectTimeout: 2000,
      },
    );
    this.redis.on('pmessage', (_pattern, channel, bytes) =>
      this.receive(channel, bytes),
    );
    this.redis.on('error', () => {
      this.subscribed = false;
      this.closeAll();
    });
    this.redis.on('close', () => {
      this.subscribed = false;
      this.closeAll();
    });
    this.redis.on('ready', () => {
      void this.redis
        ?.psubscribe('metrics:*')
        .then(() => {
          this.subscribed = !this.stopping;
        })
        .catch(() => {
          this.subscribed = false;
          this.closeAll();
        });
    });
    // ioredis restores its subscription when the transport reconnects.
    try {
      await this.redis.connect();
      await this.redis.psubscribe('metrics:*');
      this.subscribed = true;
    } catch {
      /* REST history remains available during Redis outages. */
    }
    this.timer = setInterval(() => {
      for (const group of this.clients.values())
        for (const client of group) {
          if (Date.now() >= client.deadline) client.close();
          else if (!client.initializing) this.write(client, ': heartbeat\n\n');
        }
    }, this.settings.heartbeatMs);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closeAll();
    this.redis?.disconnect();
  }
  private closeAll(): void {
    for (const group of this.clients.values())
      for (const client of group) client.close();
  }
  private write(client: Client, bytes: string): void {
    const response = client.response;
    if (
      Date.now() >= client.deadline ||
      response.destroyed ||
      response.writableEnded ||
      response.writableLength + Buffer.byteLength(bytes) >
        this.settings.maxBufferedBytes
    ) {
      client.close();
      return;
    }
    try {
      if (!response.write(bytes)) client.close();
    } catch {
      client.close();
    }
  }
  private emit(client: Client, snapshot: MetricsSnapshot): void {
    this.write(client, `event: metrics\ndata: ${JSON.stringify(snapshot)}\n\n`);
  }
  private receive(channel: string, bytes: string): void {
    const group = this.clients.get(channel.slice('metrics:'.length));
    if (
      !channel.startsWith('metrics:') ||
      !group ||
      Buffer.byteLength(bytes) > 1024
    )
      return;
    let snapshot: MetricsSnapshot;
    try {
      const value = JSON.parse(bytes) as MetricsSnapshot;
      if (
        !value ||
        typeof value !== 'object' ||
        Object.keys(value).some(
          (key) =>
            ![
              'rps',
              'p50Ms',
              'p95Ms',
              'p99Ms',
              'errorRate',
              'timestamp',
            ].includes(key),
        ) ||
        typeof value.timestamp !== 'string' ||
        !Number.isFinite(Date.parse(value.timestamp)) ||
        Date.parse(value.timestamp) > Date.now() + 300000 ||
        Date.parse(value.timestamp) < Date.now() - 300000
      )
        return;
      validateMetricPayload({
        rps: value.rps,
        p50: value.p50Ms,
        p95: value.p95Ms,
        p99: value.p99Ms,
        errorRate: value.errorRate,
      });
      snapshot = value;
    } catch {
      return;
    }
    for (const client of group) {
      if (Date.now() >= client.deadline) {
        client.close();
        continue;
      }
      if (client.initializing) client.pending = snapshot;
      else this.emit(client, snapshot);
    }
  }
  async history(
    tenantId: string,
    period = '24h',
    latest = false,
  ): Promise<MetricsSnapshot[]> {
    const schema = tenantSchema(tenantId);
    if (this.pendingReads >= this.settings.maxPendingReads)
      throw new ServiceUnavailableException('Metrics are busy. Please retry.');
    this.pendingReads++;
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SELECT set_config('statement_timeout', $1, true)`,
          [String(this.settings.statementTimeoutMs)],
        );
        const seconds = Math.min(
          (
            { '1h': 3600, '24h': 86400, '7d': 604800 } as Record<string, number>
          )[period] ?? 86400,
          this.settings.retentionDays * 86400,
        );
        const rows = await manager.query<
          Array<Omit<MetricsSnapshot, 'timestamp'> & { timestamp: Date }>
        >(
          `SELECT * FROM (SELECT rps, "p50Ms", "p95Ms", "p99Ms", "errorRate", timestamp FROM ${schema}.metrics_snapshots WHERE timestamp >= NOW() - make_interval(secs => $1) ORDER BY timestamp DESC LIMIT $2) recent ORDER BY timestamp`,
          [seconds, latest ? 1 : this.settings.historyLimit],
        );
        return rows.map((row) => ({
          ...row,
          timestamp: new Date(row.timestamp).toISOString(),
        }));
      });
    } finally {
      this.pendingReads--;
    }
  }
  async open(
    tenantId: string,
    response: Response,
    expiresAt?: number,
  ): Promise<void> {
    tenantSchema(tenantId);
    tenantId = tenantId.toLowerCase();
    const group = this.clients.get(tenantId) ?? new Set<Client>();
    if (
      this.stopping ||
      this.redis?.status !== 'ready' ||
      !this.subscribed ||
      this.total >= this.settings.maxConnections ||
      group.size >= this.settings.maxPerTenant
    )
      throw new ServiceUnavailableException(
        'Live metrics are unavailable. Please retry.',
      );
    let closed = false;
    let preserveErrorResponse = false;
    const client: Client = {
      response,
      deadline: Math.min(
        Date.now() + this.settings.maxLifetimeMs,
        expiresAt ?? Infinity,
      ),
      initializing: true,
      close: () => {
        if (closed) return;
        closed = true;
        response.off('close', client.close);
        response.off('error', client.close);
        group.delete(client);
        this.total--;
        if (!group.size) this.clients.delete(tenantId);
        if (
          (response.headersSent || !preserveErrorResponse) &&
          !response.writableEnded &&
          !response.destroyed
        )
          response.end();
      },
    };
    this.total++;
    group.add(client);
    this.clients.set(tenantId, group);
    response.once('close', client.close);
    response.once('error', client.close);
    try {
      const recent = await this.history(tenantId, '1h', true);
      if (closed) return;
      response.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      this.write(client, ': connected\n\n');
      const stored = recent.at(-1);
      const newest =
        client.pending &&
        (!stored ||
          Date.parse(client.pending.timestamp) >= Date.parse(stored.timestamp))
          ? client.pending
          : stored;
      client.initializing = false;
      client.pending = undefined;
      if (newest) this.emit(client, newest);
    } catch (error) {
      preserveErrorResponse = true;
      client.close();
      throw error;
    }
  }
}
