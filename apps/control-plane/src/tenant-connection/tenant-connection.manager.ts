import { logPrivacyPolicy } from '@api-gateway/shared-types';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_REGION_SETTINGS,
  DEFAULT_SOCKET_ADMISSION,
  type RegionSettings,
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
import { MAX_GATEWAY_INSTANCE_NAME_LENGTH } from '@api-gateway/shared-types';
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
  PluginsStatusMessage,
  disabledPluginList,
  parsePluginStatuses,
  parseCircuitStatuses,
  CircuitStateMessage,
  parseUsageReport,
  UsageReportMessage,
  parseWasmStatuses,
  FEDERATED_GRAPH_CONFIG_COLUMNS,
  federatedGraphConfigs,
  type WasmFetchMessage,
  type WasmStatusMessage,
} from '@api-gateway/shared-types';

import Redis from 'ioredis';

/** One authenticated gateway socket. A workspace can run several gateways. */
interface GatewaySession {
  tenantId: string;
  instanceId: string;
  /** Highest version sent or acknowledged on this socket. */
  sentVersion: number;
  sentAt: number;
  ackedVersion: number;
}
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
/** Resend an unacknowledged version after this long. */
const CONFIG_RESEND_MS = 30000;
/** Presence is best effort: missing admin migrations or a slow DB never block. */
const PRESENCE_MISSING = new Set(['42P01', '42703']);

@Injectable()
export class TenantConnectionManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantConnectionManager.name);
  private wss!: WebSocketServer;
  private connections = new Map<string, Set<WebSocket>>();
  private readonly sessions = new Map<WebSocket, GatewaySession>();
  private readonly regionSettings: RegionSettings;
  private syncTimer?: NodeJS.Timeout;
  private syncing?: Promise<void>;
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
    this.regionSettings = {
      ...DEFAULT_REGION_SETTINGS,
      ...config.get<RegionSettings>('region'),
    };
  }

  get region(): string | null {
    return this.regionSettings.region;
  }

  private sockets(tenantId: string): WebSocket[] {
    return [...(this.connections.get(tenantId) ?? [])].filter(
      (ws) => ws.readyState === WebSocket.OPEN,
    );
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
    // Regions with their own Redis never see another region's publications;
    // the database is the shared source of configuration versions.
    this.syncTimer = setInterval(() => {
      if (this.stopped || this.syncing) return;
      this.syncing = this.syncConfigVersions()
        .catch(() => this.logger.warn('Configuration sync will retry'))
        .finally(() => {
          this.syncing = undefined;
        });
    }, this.regionSettings.configSyncIntervalMs);
    this.syncTimer.unref();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    clearInterval(this.syncTimer);
    await this.syncing;
    for (const ws of this.sessions.keys()) ws.close();
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
            const instanceId =
              typeof authPayload.instanceId === 'string' &&
              UUID.test(authPayload.instanceId)
                ? authPayload.instanceId.toLowerCase()
                : crypto.randomUUID();
            const instanceName =
              typeof authPayload.instanceName === 'string'
                ? authPayload.instanceName
                    .replace(/[^\x20-\x7e]/g, '?')
                    .slice(0, MAX_GATEWAY_INSTANCE_NAME_LENGTH)
                : '';
            const sockets = this.connections.get(tenantId) ?? new Set();
            sockets.add(ws);
            this.connections.set(tenantId, sockets);
            await this.redisPub.set(`gw:online:${tenantId}`, '1', 'EX', 90);

            // Get config and pending updates
            const { config, version } = await this.getTenantConfig(tenantId);
            this.sessions.set(ws, {
              tenantId,
              instanceId,
              sentVersion: version,
              sentAt: Date.now(),
              ackedVersion: -1,
            });

            const authOk: AuthOkMessage = {
              type: 'auth_ok',
              payload: {
                tenantId,
                config,
                configVersion: version,
                ...(this.region ? { controlPlaneRegion: this.region } : {}),
              },
            };
            ws.send(JSON.stringify(authOk));
            await this.recordPresence(
              `INSERT INTO public.gateway_instances ("tenantId","instanceId",name,region,"connectedAt","lastSeenAt","disconnectedAt","configVersion")
               VALUES ($1,$2,$3,$4,NOW(),NOW(),NULL,$5)
               ON CONFLICT ("tenantId","instanceId") DO UPDATE SET name=EXCLUDED.name,region=EXCLUDED.region,
                 "connectedAt"=NOW(),"lastSeenAt"=NOW(),"disconnectedAt"=NULL,
                 "configVersion"=COALESCE(EXCLUDED."configVersion",public.gateway_instances."configVersion")`,
              [
                tenantId,
                instanceId,
                instanceName || 'gateway',
                this.region,
                Number.isSafeInteger(authPayload.configVersion) &&
                (authPayload.configVersion as number) >= 0
                  ? authPayload.configVersion
                  : null,
              ],
            );

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
          if (tenantId) await this.handleInboundMessage(tenantId, message, ws);
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
      const session = this.sessions.get(ws);
      this.sessions.delete(ws);
      const sockets = tenantId ? this.connections.get(tenantId) : undefined;
      if (!this.stopped && tenantId && sockets?.delete(ws)) {
        if (session)
          void this.recordPresence(
            `UPDATE public.gateway_instances SET "disconnectedAt"=NOW(),"lastSeenAt"=NOW() WHERE "tenantId"=$1 AND "instanceId"=$2 AND region IS NOT DISTINCT FROM $3`,
            [tenantId, session.instanceId, this.region],
          );
        if (sockets.size) return;
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
      if (this.stopped || !tenantId) return;
      void this.redisPub
        .set(`gw:online:${tenantId}`, '1', 'EX', 90)
        .catch((err: Error) => this.logger.error(err.message));
      const session = this.sessions.get(ws);
      if (session)
        void this.recordPresence(
          `UPDATE public.gateway_instances SET "lastSeenAt"=NOW() WHERE "tenantId"=$1 AND "instanceId"=$2 AND "disconnectedAt" IS NULL`,
          [tenantId, session.instanceId],
        );
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
        // to_jsonb tolerates a schema admin-api has not upgraded yet.
        `SELECT "gatewayConfigVersion", "caCertPem", "logPrivacy", to_jsonb(t)->'disabledPlugins' AS "disabledPlugins", to_jsonb(t)->>'quotaSuspendedUntil' AS "quotaSuspendedUntil", to_jsonb(t)->>'preferredRegion' AS "preferredRegion" FROM public.tenants t WHERE id = $1`,
        [tenantId],
      );
      if (!tenant) throw new Error('Tenant not found');
      const suspendedUntil = Date.parse(tenant.quotaSuspendedUntil ?? '');
      const routes = await manager.query(
        `SELECT r.* FROM ${schema}.routes r WHERE "deletedAt" IS NULL AND enabled = true
          ORDER BY (to_jsonb(r)->>'configOrder')::integer NULLS LAST,(to_jsonb(r)->>'createdAt')::timestamp NULLS LAST,id`,
      );
      const services = await manager.query(
        `SELECT * FROM ${schema}.services WHERE "deletedAt" IS NULL`,
      );
      const consumers = await manager.query(
        `SELECT * FROM ${schema}.consumers WHERE "revokedAt" IS NULL`,
      );
      // Admin migrations create the table; an older schema has no plugins.
      const [{ wasm }] = await manager.query(
        `SELECT to_regclass($1) IS NOT NULL AS wasm`,
        [`${schema}.wasm_plugins`],
      );
      const wasmPlugins = wasm
        ? await manager.query(
            `SELECT name, sha256, hooks, "allowedHosts" FROM ${schema}.wasm_plugins WHERE "deletedAt" IS NULL ORDER BY name`,
          )
        : [];
      const [{ federation }] = await manager.query(
        `SELECT to_regclass($1) IS NOT NULL AS federation`,
        [`${schema}.federated_graphs`],
      );
      const federatedGraphs = federation
        ? federatedGraphConfigs(
            await manager.query(
              `SELECT ${FEDERATED_GRAPH_CONFIG_COLUMNS} FROM ${schema}.federated_graphs WHERE "deletedAt" IS NULL ORDER BY name`,
            ),
          )
        : [];
      // Portal publication and developer ownership are administration-only,
      // matching the admin API's published snapshots.
      return {
        config: {
          routes: routes.map(
            ({ portal: _portal, ...route }: Record<string, unknown>) => route,
          ),
          services,
          consumers: consumers.map(
            ({
              portalDeveloperId: _developer,
              portalKeyName: _key,
              ...consumer
            }: Record<string, unknown>) => consumer,
          ),
          caCertPem: tenant.caCertPem ?? undefined,
          logPrivacy: logPrivacyPolicy(tenant.logPrivacy),
          rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
          disabledPlugins: disabledPluginList(tenant.disabledPlugins),
          suspended:
            suspendedUntil > Date.now()
              ? {
                  reason: 'QUOTA_EXCEEDED',
                  until: new Date(suspendedUntil).toISOString(),
                }
              : null,
          preferredRegion: tenant.preferredRegion ?? null,
          wasmPlugins,
          federatedGraphs,
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
      this.send(ws, envelope.config, envelope.version);
      // Retain until the gateway confirms installation with config.ack.
    }
  }

  private async handleInboundMessage(
    tenantId: string,
    message: BaseWsMessage,
    ws?: WebSocket,
  ) {
    switch (message.type) {
      case 'config.ack': {
        const version = (message as BaseWsMessage & { version: number })
          .version;
        if (Number.isSafeInteger(version) && version >= 0) {
          await this.dataSource.query(
            `DELETE FROM public.pending_config_updates WHERE "tenantId" = $1 AND (config->>'version')::bigint <= $2`,
            [tenantId, version],
          );
          const session = ws ? this.sessions.get(ws) : undefined;
          if (session) {
            session.ackedVersion = Math.max(session.ackedVersion, version);
            session.sentVersion = Math.max(session.sentVersion, version);
            await this.recordPresence(
              `UPDATE public.gateway_instances SET "configVersion"=GREATEST(COALESCE("configVersion",0),$3),"lastSeenAt"=NOW() WHERE "tenantId"=$1 AND "instanceId"=$2`,
              [tenantId, session.instanceId, version],
            );
          }
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
        // Errors require ACKs, on the socket that sent them.
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
      case 'plugins.status': {
        const plugins = parsePluginStatuses(
          (message as PluginsStatusMessage).payload?.plugins,
        );
        if (!plugins) {
          this.logger.warn(`Rejected invalid plugin report from ${tenantId}`);
          break;
        }
        // Gateways refresh every 60s; a stale report expires on its own.
        await this.redisPub.set(
          `gw:plugins:${tenantId.toLowerCase()}`,
          JSON.stringify({ reportedAt: new Date().toISOString(), plugins }),
          'EX',
          180,
        );
        break;
      }
      case 'circuit.state': {
        const services = parseCircuitStatuses(
          (message as CircuitStateMessage).payload?.services,
        );
        if (!services) {
          this.logger.warn(`Rejected invalid circuit report from ${tenantId}`);
          break;
        }
        const tenant = tenantId.toLowerCase();
        const snapshot = JSON.stringify({
          reportedAt: new Date().toISOString(),
          services,
        });
        // The gateway refreshes every 30s; a silent gateway's state expires.
        await this.redisPub.set(`gw:circuits:${tenant}`, snapshot, 'EX', 90);
        await this.redisPub.publish(`circuits:${tenant}`, snapshot);
        break;
      }
      case 'usage.report': {
        const report = parseUsageReport(
          (message as UsageReportMessage).payload,
        );
        if (!report) {
          this.logger.warn(`Rejected invalid usage report from ${tenantId}`);
          break;
        }
        await this.recordUsage(tenantId, report);
        break;
      }
      case 'wasm.fetch': {
        const sha256 = (message as unknown as WasmFetchMessage).payload?.sha256;
        if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) break;
        const schema = `tenant_${tenantId.toLowerCase().replace(/-/g, '_')}`;
        // Only this workspace's own installed modules are served.
        const [row] = await this.dataSource
          .query(
            `SELECT encode(module, 'base64') AS module FROM ${schema}.wasm_plugins WHERE sha256=$1 AND "deletedAt" IS NULL LIMIT 1`,
            [sha256],
          )
          .catch(() => []);
        if (ws?.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: 'wasm.module',
              payload: {
                sha256,
                module: row?.module?.replace(/\s+/g, '') ?? null,
              },
            }),
          );
        break;
      }
      case 'wasm.status': {
        const plugins = parseWasmStatuses(
          (message as unknown as WasmStatusMessage).payload?.plugins,
        );
        if (!plugins) {
          this.logger.warn(`Rejected invalid WASM report from ${tenantId}`);
          break;
        }
        await this.redisPub.set(
          `gw:wasm:${tenantId.toLowerCase()}`,
          JSON.stringify({ reportedAt: new Date().toISOString(), plugins }),
          'EX',
          180,
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

  /**
   * Reports carry cumulative totals, so keeping the largest value per source
   * makes repeated, reordered or missed reports harmless.
   */
  private async recordUsage(
    tenantId: string,
    report: NonNullable<ReturnType<typeof parseUsageReport>>,
  ) {
    try {
      for (const month of report.months) {
        await this.dataSource.query(
          `INSERT INTO public.usage_meters ("tenantId", month, source, requests)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT ("tenantId", month, source) DO UPDATE
             SET requests = GREATEST(public.usage_meters.requests, EXCLUDED.requests),
                 "updatedAt" = NOW()`,
          [tenantId, month.month, report.source, month.requests],
        );
        if (!month.consumers.length) continue;
        await this.dataSource.query(
          `INSERT INTO public.consumer_usage_meters ("tenantId", month, source, "consumerId", requests)
           SELECT $1, $2, $3, c.id, c.requests
             FROM unnest($4::uuid[], $5::bigint[]) AS c(id, requests)
           ON CONFLICT ("tenantId", month, source, "consumerId") DO UPDATE
             SET requests = GREATEST(public.consumer_usage_meters.requests, EXCLUDED.requests)`,
          [
            tenantId,
            month.month,
            report.source,
            month.consumers.map((c) => c.consumerId),
            month.consumers.map((c) => c.requests),
          ],
        );
      }
    } catch (error) {
      // The admin API owns this schema; before its upgrade, drop the report.
      if ((error as { code?: string }).code === '42P01') {
        this.logger.warn('Usage meters are not installed yet; report dropped');
        return;
      }
      throw error;
    }
  }

  private heartbeat() {
    for (const [tenantId, sockets] of this.connections) {
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
        else {
          sockets.delete(ws);
          this.sessions.delete(ws);
        }
      }
      if (!sockets.size) this.connections.delete(tenantId);
    }
  }

  private async recordPresence(sql: string, parameters: unknown[]) {
    try {
      await this.dataSource.query(sql, parameters);
    } catch (error) {
      if (!PRESENCE_MISSING.has((error as { code?: string }).code ?? ''))
        this.logger.warn('Gateway presence update failed');
    }
  }

  private send(ws: WebSocket, config: TenantConfig, version: number) {
    const session = this.sessions.get(ws);
    if (ws.readyState !== WebSocket.OPEN || !session) return;
    ws.send(
      JSON.stringify({ type: 'config.update', payload: config, version }),
    );
    session.sentVersion = Math.max(session.sentVersion, version);
    session.sentAt = Date.now();
  }

  /**
   * Brings every connected gateway up to the workspace's version in the
   * database. Publications through Redis are the fast path; this repairs
   * missed ones, including those published in another region's Redis.
   */
  async syncConfigVersions() {
    const lagging = new Map<string, WebSocket[]>();
    const tenants = [...this.connections.keys()];
    for (let offset = 0; offset < tenants.length; offset += 500) {
      const rows: Array<{ id: string; version: number }> =
        await this.dataSource.query(
          `SELECT id, "gatewayConfigVersion" AS version FROM public.tenants WHERE id = ANY($1::uuid[])`,
          [tenants.slice(offset, offset + 500)],
        );
      const now = Date.now();
      for (const row of rows) {
        const behind = this.sockets(row.id).filter((ws) => {
          const session = this.sessions.get(ws);
          return (
            session &&
            session.ackedVersion < row.version &&
            (session.sentVersion < row.version ||
              now - session.sentAt > CONFIG_RESEND_MS)
          );
        });
        if (behind.length) lagging.set(row.id, behind);
      }
    }
    for (const [tenantId, sockets] of lagging) {
      if (this.stopped) return;
      const { config, version } = await this.getTenantConfig(tenantId);
      for (const ws of sockets) this.send(ws, config, version);
    }
  }

  async pushConfigUpdate(
    tenantId: string,
    config: TenantConfig,
    version: number,
  ) {
    if (!Number.isSafeInteger(version) || version < 0)
      throw new Error('Invalid configuration version');
    for (const ws of this.sockets(tenantId)) this.send(ws, config, version);
  }

  isOnline(tenantId: string): boolean {
    return this.sockets(tenantId).length > 0;
  }
}
