import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import Redis from 'ioredis';
import {
  parseCircuitStatuses,
  type CircuitBreakerSnapshot,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import {
  DEFAULT_METRIC_STREAM,
  type MetricStreamSettings,
} from '../proxy-config/metrics-stream.configuration';

/** A full 200-service snapshot is about 40 KiB. */
const MAX_SNAPSHOT_BYTES = 131072;
const MAX_BUFFERED_BYTES = 262144;
const NONE: CircuitBreakerSnapshot = { reportedAt: null, services: [] };

type Client = {
  response: Response;
  deadline: number;
  initializing: boolean;
  pending?: CircuitBreakerSnapshot;
  close: () => void;
};

/** Validates a stored or published snapshot; anything malformed reads as none. */
export function parseCircuitSnapshot(
  bytes: string | null,
): CircuitBreakerSnapshot | null {
  if (!bytes || Buffer.byteLength(bytes) > MAX_SNAPSHOT_BYTES) return null;
  try {
    const value = JSON.parse(bytes) as Record<string, unknown>;
    const services = parseCircuitStatuses(value?.services);
    if (
      !services ||
      typeof value.reportedAt !== 'string' ||
      Number.isNaN(Date.parse(value.reportedAt))
    )
      return null;
    return { reportedAt: value.reportedAt, services };
  } catch {
    return null;
  }
}

/**
 * Per-service circuit state reported by the workspace's gateway through the
 * control plane: the latest snapshot (`gw:circuits:<tenant>`, 90 s TTL) and a
 * live relay of `circuits:<tenant>` publications over server-sent events.
 */
@Injectable()
export class CircuitBreakersService implements OnModuleInit, OnModuleDestroy {
  private reader?: Redis;
  private subscriber?: Redis;
  private timer?: ReturnType<typeof setInterval>;
  private readonly clients = new Map<string, Set<Client>>();
  private total = 0;
  private stopping = false;
  private subscribed = false;
  private readonly settings: MetricStreamSettings;

  constructor(private readonly config: ConfigService) {
    // Live circuit streams share the metric stream's admission bounds.
    this.settings = {
      ...DEFAULT_METRIC_STREAM,
      ...config.get<MetricStreamSettings>('metricStream'),
    };
  }

  async onModuleInit(): Promise<void> {
    const url =
      this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    const options = {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 2000,
      connectTimeout: 2000,
    };
    this.reader = new Redis(url, options);
    this.subscriber = new Redis(url, options);
    this.reader.on('error', () => undefined);
    this.subscriber.on('pmessage', (_pattern, channel, bytes) =>
      this.receive(channel, bytes),
    );
    const lost = () => {
      this.subscribed = false;
      this.closeAll();
    };
    this.subscriber.on('error', lost);
    this.subscriber.on('close', lost);
    this.subscriber.on('ready', () => {
      void this.subscriber
        ?.psubscribe('circuits:*')
        .then(() => {
          this.subscribed = !this.stopping;
        })
        .catch(lost);
    });
    try {
      await this.reader.connect();
    } catch {
      /* Snapshots read as unavailable until Redis returns. */
    }
    try {
      await this.subscriber.connect();
      await this.subscriber.psubscribe('circuits:*');
      this.subscribed = true;
    } catch {
      /* Streams are refused until the subscription is ready. */
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
    this.closeAll();
    this.reader?.disconnect();
    this.subscriber?.disconnect();
  }

  async snapshot(tenantId: string): Promise<CircuitBreakerSnapshot> {
    tenantSchema(tenantId);
    try {
      const bytes =
        (await this.reader?.get(`gw:circuits:${tenantId.toLowerCase()}`)) ??
        null;
      return parseCircuitSnapshot(bytes) ?? NONE;
    } catch {
      return NONE;
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
      this.subscriber?.status !== 'ready' ||
      !this.subscribed ||
      this.total >= this.settings.maxConnections ||
      group.size >= this.settings.maxPerTenant
    )
      throw new ServiceUnavailableException(
        'Live circuit status is unavailable. Please retry.',
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
      const stored = await this.snapshot(tenantId);
      if (closed) return;
      response.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      this.write(client, ': connected\n\n');
      const pending = client.pending;
      client.initializing = false;
      client.pending = undefined;
      // A publication during the read is at least as new as the stored copy.
      this.emit(client, pending ?? stored);
    } catch (error) {
      preserveErrorResponse = true;
      client.close();
      throw error;
    }
  }

  private receive(channel: string, bytes: string): void {
    if (!channel.startsWith('circuits:')) return;
    const group = this.clients.get(channel.slice('circuits:'.length));
    if (!group) return;
    const snapshot = parseCircuitSnapshot(bytes);
    if (!snapshot) return;
    for (const client of group) {
      if (Date.now() >= client.deadline) client.close();
      else if (client.initializing) client.pending = snapshot;
      else this.emit(client, snapshot);
    }
  }

  private emit(client: Client, snapshot: CircuitBreakerSnapshot): void {
    this.write(
      client,
      `event: circuits\ndata: ${JSON.stringify(snapshot)}\n\n`,
    );
  }

  private write(client: Client, bytes: string): void {
    const response = client.response;
    if (
      Date.now() >= client.deadline ||
      response.destroyed ||
      response.writableEnded ||
      response.writableLength + Buffer.byteLength(bytes) > MAX_BUFFERED_BYTES
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

  private closeAll(): void {
    for (const group of this.clients.values())
      for (const client of group) client.close();
  }
}
