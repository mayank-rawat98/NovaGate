import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';
import * as crypto from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  private wss: WebSocketServer;
  private connections = new Map<string, WebSocket>();
  private redisPub: Redis;
  private redisSub: Redis;

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(PendingConfigUpdate)
    private readonly pendingUpdateRepo: Repository<PendingConfigUpdate>,
    private readonly ingestionService: LogIngestionService,
  ) {}

  onModuleInit() {
    const port = parseInt(process.env.WS_PORT || '8080', 10);
    this.wss = new WebSocketServer({ port });
    this.logger.log(`WebSocket server started on port ${port}`);

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisPub = new Redis(redisUrl);
    this.redisSub = new Redis(redisUrl);

    this.redisSub.subscribe('config.update');
    this.redisSub.on('message', (channel, message) => {
      if (channel === 'config.update') {
        const { tenantId, config } = JSON.parse(message);
        this.pushConfigUpdate(tenantId, config);
      }
    });

    this.wss.on('connection', (ws) => this.handleConnection(ws));

    // Heartbeat: ping all connections every 30s
    setInterval(() => this.heartbeat(), 30000);
  }

  onModuleDestroy() {
    this.wss.close();
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

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as BaseWsMessage;

        if (!authenticated && message.type === 'auth') {
          const authPayload = (message as AuthMessage).payload;
          tenantId = await this.validateApiKey(authPayload.apiKey);

          if (!tenantId) {
            this.logger.warn(`Invalid API key attempt: ${authPayload.apiKey}`);
            ws.close(GatewayCloseCode.INVALID_API_KEY);
            return;
          }

          authenticated = true;
          clearTimeout(authTimeout);
          this.connections.set(tenantId, ws);
          await this.redisPub.set(`gw:online:${tenantId}`, '1', 'EX', 90);

          // Get config and pending updates
          const config = await this.getTenantConfig(tenantId);
          const tenant = await this.tenantRepo.findOneBy({ id: tenantId });

          const authOk: AuthOkMessage = {
            type: 'auth_ok',
            payload: {
              tenantId,
              config,
              configVersion: tenant?.gatewayConfigVersion || 0,
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
        this.handleInboundMessage(tenantId!, message);
      } catch (err) {
        this.logger.error(`Error processing message: ${err.message}`);
      }
    });

    ws.on('close', () => {
      if (tenantId) {
        this.connections.delete(tenantId);
        this.tenantRepo.update(tenantId, { lastSeen: new Date() });
        this.redisPub.del(`gw:online:${tenantId}`);
        this.logger.log(`Tenant ${tenantId} disconnected`);
      }
    });

    ws.on('pong', () => {
      if (tenantId) this.redisPub.set(`gw:online:${tenantId}`, '1', 'EX', 90);
    });
  }

  private async validateApiKey(apiKey: string): Promise<string | null> {
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const key = await this.apiKeyRepo.findOne({
      where: { keyHash: hash, revokedAt: undefined },
    });
    return key ? key.tenantId : null;
  }

  private async getTenantConfig(tenantId: string): Promise<TenantConfig> {
    // This will be implemented fully once we have the tenant schema logic
    // For now, return a default skeleton or read from public schema placeholder
    return {
      routes: [],
      services: [],
      consumers: [],
      rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
    };
  }

  private async flushPendingUpdates(tenantId: string, ws: WebSocket) {
    const pending = await this.pendingUpdateRepo.find({
      where: { tenantId },
      order: { createdAt: 'ASC' },
    });

    for (const update of pending) {
      ws.send(
        JSON.stringify({
          type: 'config.update',
          payload: update.config,
          version: Date.now(), // placeholder
        }),
      );
      await this.pendingUpdateRepo.delete(update.id);
    }
  }

  private async handleInboundMessage(tenantId: string, message: BaseWsMessage) {
    switch (message.type) {
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
      case 'metrics':
        await this.ingestionService.ingestMetrics(
          tenantId,
          (message as MetricsMessage).payload,
        );
        break;
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

  async pushConfigUpdate(tenantId: string, config: TenantConfig) {
    const ws = this.connections.get(tenantId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'config.update',
          payload: config,
          version: Date.now(),
        }),
      );
    } else {
      await this.pendingUpdateRepo.save({
        tenantId,
        config,
        createdAt: new Date(),
      });
    }
  }

  isOnline(tenantId: string): boolean {
    const ws = this.connections.get(tenantId);
    return ws?.readyState === WebSocket.OPEN;
  }
}
