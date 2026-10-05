import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_SOCKET_ADMISSION,
  type SocketAdmissionSettings,
} from '../config/tracing.configuration';
import { TraceIngestionService } from '../ingestion/trace-ingestion.service';
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';
import * as crypto from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import {
  Tenant,
  ApiKey,
  PendingConfigUpdate,
} from '../database/entities/public.entities';
import { LogIngestionService } from '../ingestion/log-ingestion.service';
import {
  AuthMessage,
  AuthOkMessage,
  BaseWsMessage,
  GatewayCloseCode,
  TenantConfig,
  LogsMessage,
  HealthMessage,
  ErrorsMessage,
  MetricsMessage,
} from '@api-gateway/shared-types';

import Redis from 'ioredis';

@Injectable()
export class TenantConnectionManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantConnectionManager.name);
  private wss!: WebSocketServer;
  private connections = new Map<string, WebSocket>();
  private redisPub!: Redis;
  private redisSub!: Redis;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly admission: SocketAdmissionSettings;

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(PendingConfigUpdate)
    private readonly pendingUpdateRepo: Repository<PendingConfigUpdate>,
    private readonly ingestionService: LogIngestionService,
    private readonly dataSource: DataSource,
    @Optional() private readonly traceIngestion?: TraceIngestionService,
    @Optional() config: ConfigService = new ConfigService(),
  ) {
    this.admission = {
      ...DEFAULT_SOCKET_ADMISSION,
      ...config.get<SocketAdmissionSettings>('socketAdmission'),
    };
  }

  onModuleInit() {
    const port = parseInt(process.env.WS_PORT || '8080', 10);
    this.wss = new WebSocketServer({
      port,
      maxPayload: this.admission.maxMessageBytes,
    });
    this.logger.log(`WebSocket server started on port ${port}`);

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisPub = new Redis(redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 2000,
    });
    this.redisSub = new Redis(redisUrl);

    this.redisSub.subscribe('config.update');
    this.redisSub.on('message', (channel, message) => {
      if (channel === 'config.update') {
        try {
          const { tenantId, config, version } = JSON.parse(message);
          void this.pushConfigUpdate(tenantId, config, version).catch(
            (err: Error) =>
              this.logger.error(`Config delivery failed: ${err.message}`),
          );
        } catch {
          this.logger.warn('Ignoring malformed config publication');
        }
      }
    });

    this.wss.on('connection', (ws) => {
      ws.on('error', () => {
        /* Malformed/oversized messages terminate inside ws. */
      });
      if (this.wss.clients.size > this.admission.maxConnections) {
        ws.close(
          GatewayCloseCode.RESOURCE_LIMIT,
          'Connection capacity exhausted',
        );
        return;
      }
      this.handleConnection(ws);
    });

    // Heartbeat: ping all connections every 30s
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 30000);
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const ws of this.connections.values()) ws.close();
    this.wss.close();
    await Promise.allSettled([this.redisPub.quit(), this.redisSub.quit()]);
  }

  private handleConnection(ws: WebSocket) {
    let authenticated = false;
    let tenantId: string | null = null;

    // Expect auth within 5s
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        this.logger.warn('Auth timeout - closing connection');
        ws.close(GatewayCloseCode.AUTH_TIMEOUT);
      }
    }, 5000);

    let messageQueue = Promise.resolve();
    let queuedMessages = 0;
    let queuedBytes = 0;
    ws.on('message', (data) => {
      const bytes = Array.isArray(data)
        ? data.reduce((total, part) => total + part.length, 0)
        : data.byteLength;
      if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
      if (
        queuedMessages >= this.admission.maxQueuedMessages ||
        queuedBytes + bytes > this.admission.maxQueuedBytes
      ) {
        ws.close(
          GatewayCloseCode.RESOURCE_LIMIT,
          'Message admission exhausted',
        );
        return;
      }
      queuedMessages++;
      queuedBytes += bytes;
      messageQueue = messageQueue.then(async () => {
        try {
          if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
          const message = JSON.parse(data.toString()) as BaseWsMessage;
          if (
            !message ||
            typeof message !== 'object' ||
            typeof message.type !== 'string'
          )
            return;

          if (!authenticated && message.type === 'auth') {
            const authPayload = (message as AuthMessage).payload;
            tenantId = await this.validateApiKey(authPayload.apiKey);

            if (!tenantId) {
              this.logger.warn('Invalid or revoked gateway API key');
              ws.close(GatewayCloseCode.INVALID_API_KEY);
              return;
            }

            authenticated = true;
            clearTimeout(authTimeout);
            this.connections.set(tenantId, ws);
            await this.redisPub.set(`gw:online:${tenantId}`, '1', 'EX', 90);

            // Get config and pending updates
            const { config, version } = await this.getTenantConfig(tenantId);

            const authOk: AuthOkMessage = {
              type: 'auth_ok',
              payload: {
                tenantId,
                config,
                configVersion: version,
              },
            };
            ws.send(JSON.stringify(authOk));

            await this.tenantRepo.update(tenantId, { lastSeen: new Date() });
            this.logger.log(`Tenant ${tenantId} connected`);

            // Flush pending updates if any
            await this.flushPendingUpdates(tenantId, ws);
            return;
          }

          if (!authenticated) {
            this.logger.warn('Received message before auth - ignoring');
            return;
          }

          // Handle other message types (logs, health, etc.)
          if (tenantId) await this.handleInboundMessage(tenantId, message);
        } catch {
          this.logger.warn('Gateway message processing failed');
        } finally {
          queuedMessages--;
          queuedBytes -= bytes;
        }
      });
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (!this.stopped && tenantId && this.connections.get(tenantId) === ws) {
        this.connections.delete(tenantId);
        void this.tenantRepo
          .update(tenantId, { lastSeen: new Date() })
          .catch((err: Error) => this.logger.error(err.message));
        void this.redisPub
          .del(`gw:online:${tenantId}`)
          .catch((err: Error) => this.logger.error(err.message));
        this.logger.log(`Tenant ${tenantId} disconnected`);
      }
    });

    ws.on('pong', () => {
      if (!this.stopped && tenantId)
        void this.redisPub
          .set(`gw:online:${tenantId}`, '1', 'EX', 90)
          .catch((err: Error) => this.logger.error(err.message));
    });
  }

  private async validateApiKey(apiKey: string): Promise<string | null> {
    if (typeof apiKey !== 'string' || apiKey.length > 512) return null;
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const key = await this.apiKeyRepo.findOne({
      where: { keyHash: hash, revokedAt: IsNull() },
    });
    return key ? key.tenantId : null;
  }

  private async getTenantConfig(
    tenantId: string,
  ): Promise<{ config: TenantConfig; version: number }> {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(tenantId))
      throw new Error('Invalid tenant ID');
    const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const [tenant] = await manager.query(
        `SELECT "gatewayConfigVersion", "caCertPem" FROM public.tenants WHERE id = $1`,
        [tenantId],
      );
      if (!tenant) throw new Error('Tenant not found');
      const routes = await manager.query(
        `SELECT * FROM ${schema}.routes WHERE "deletedAt" IS NULL AND enabled = true`,
      );
      const services = await manager.query(
        `SELECT * FROM ${schema}.services WHERE "deletedAt" IS NULL`,
      );
      const consumers = await manager.query(
        `SELECT * FROM ${schema}.consumers WHERE "revokedAt" IS NULL`,
      );
      return {
        config: {
          routes,
          services,
          consumers,
          caCertPem: tenant.caCertPem ?? undefined,
          rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
        },
        version: tenant.gatewayConfigVersion,
      };
    });
  }

  private async flushPendingUpdates(tenantId: string, ws: WebSocket) {
    const pending = await this.pendingUpdateRepo.find({
      where: { tenantId },
      order: { createdAt: 'ASC' },
    });

    for (const update of pending) {
      const envelope = update.config as unknown as {
        config: TenantConfig;
        version: number;
      };
      if (!envelope.config || !Number.isSafeInteger(envelope.version)) continue;
      ws.send(
        JSON.stringify({
          type: 'config.update',
          payload: envelope.config,
          version: envelope.version,
        }),
      );
      // Retain until the gateway confirms installation with config.ack.
    }
  }

  private async handleInboundMessage(tenantId: string, message: BaseWsMessage) {
    switch (message.type) {
      case 'config.ack': {
        const version = (message as BaseWsMessage & { version: number })
          .version;
        if (Number.isSafeInteger(version) && version >= 0) {
          await this.dataSource.query(
            `DELETE FROM public.pending_config_updates WHERE "tenantId" = $1 AND (config->>'version')::bigint <= $2`,
            [tenantId, version],
          );
        }
        break;
      }
      case 'traces':
        if (this.traceIngestion)
          await this.traceIngestion.ingest(tenantId, message.payload);
        break;
      case 'logs':
        await this.ingestionService.ingestLogs(
          tenantId,
          (message as LogsMessage).payload,
        );
        break;
      case 'health':
        await this.ingestionService.ingestHealth(
          tenantId,
          (message as HealthMessage).payload,
        );
        break;
      case 'errors': {
        const errorMsg = message as ErrorsMessage;
        await this.ingestionService.ingestErrors(tenantId, errorMsg.payload);
        // Errors require ACKs
        const ws = this.connections.get(tenantId);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ack', id: errorMsg.id }));
        }
        break;
      }
      case 'metrics': {
        const snapshot = await this.ingestionService.ingestMetrics(
          tenantId,
          (message as MetricsMessage).payload,
        );
        await this.redisPub.publish(
          `metrics:${tenantId.toLowerCase()}`,
          JSON.stringify(snapshot),
        );
        break;
      }
      case 'pong':
        this.logger.debug(`Received pong from ${tenantId}`);
        break;
      default:
        this.logger.warn(`Unknown message type: ${message.type}`);
    }
  }

  private heartbeat() {
    this.connections.forEach((ws, tenantId) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        this.connections.delete(tenantId);
      }
    });
  }

  async pushConfigUpdate(
    tenantId: string,
    config: TenantConfig,
    version: number,
  ) {
    if (!Number.isSafeInteger(version) || version < 0)
      throw new Error('Invalid configuration version');
    const ws = this.connections.get(tenantId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'config.update',
          payload: config,
          version,
        }),
      );
    }
  }

  isOnline(tenantId: string): boolean {
    const ws = this.connections.get(tenantId);
    return ws?.readyState === WebSocket.OPEN;
  }
}
