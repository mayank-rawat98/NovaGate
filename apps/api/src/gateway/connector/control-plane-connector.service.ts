import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  orderControlPlaneEndpoints,
  parseControlPlaneEndpoints,
  type ControlPlaneEndpoint,
  AuthMessage,
  AuthOkMessage,
  BaseWsMessage,
  ConfigAckMessage,
  ConfigUpdateMessage,
  PluginsStatusMessage,
  CircuitStateMessage,
  UsageReportMessage,
} from '@api-gateway/shared-types';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { PluginLoaderService } from '../plugins/third-party/plugin-loader.service';
import { CircuitBreakerService } from '../circuit-breaker/circuit-breaker.service';
import { MeteringService } from '../metering/metering.service';
import {
  DEFAULT_CONTROL_PLANE,
  type ControlPlaneSettings,
} from '../../config/configuration';

/** Plugin reports are small snapshots; refresh so quarantine expiry is visible. */
const PLUGIN_REPORT_DEBOUNCE_MS = 1000;
const PLUGIN_REPORT_INTERVAL_MS = 60000;
const PLUGIN_REPORT_MAX_BUFFERED_BYTES = 65536;
/** Circuit transitions are reported quickly; a heartbeat keeps the snapshot fresh. */
const CIRCUIT_REPORT_DEBOUNCE_MS = 200;
const CIRCUIT_REPORT_INTERVAL_MS = 30000;
const CIRCUIT_REPORT_MAX_BUFFERED_BYTES = 262144;
/** Usage totals are cumulative, so a dropped report is repaired by the next. */
const USAGE_REPORT_INTERVAL_MS = 30000;
const USAGE_REPORT_MAX_BUFFERED_BYTES = 262144;
/**
 * Telemetry buffered while disconnected drains in small paced batches: the
 * control plane admits a bounded number of queued frames per socket and
 * closes sockets that exceed it, which would lose the backlog again.
 */
const FLUSH_BATCH = 4;
const FLUSH_INTERVAL_MS = 50;
const MAX_FAILBACK_MS = 3600000;
/** A preferred-region change moves the gateway shortly after it arrives. */
const PREFERENCE_SWITCH_DELAY_MS = 1000;

@Injectable()
export class ControlPlaneConnectorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ControlPlaneConnectorService.name);
  private ws: WebSocket | null = null;
  private reconnectDelays = [1000, 2000, 4000, 8000, 16000, 30000];
  private reconnectIndex = 0;
  private messageBuffer: BaseWsMessage[] = [];
  private readonly MAX_BUFFER_SIZE = 10000;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private authenticated = false;
  private pluginReportTimer?: NodeJS.Timeout;
  private pluginReportInterval?: NodeJS.Timeout;
  private stopPluginListener?: () => void;
  private circuitReportTimer?: NodeJS.Timeout;
  private circuitReportInterval?: NodeJS.Timeout;
  private stopCircuitListener?: () => void;
  private usageReportInterval?: NodeJS.Timeout;
  /** Random per process: identifies this gateway to every region. */
  readonly instanceId = randomUUID();
  private endpoints: ControlPlaneEndpoint[] = [];
  private order: ControlPlaneEndpoint[] = [];
  private endpointIndex = 0;
  /** Endpoints tried since the last successful authentication. */
  private failedAttempts = 0;
  private current: ControlPlaneEndpoint | null = null;
  private region: string | null = null;
  private preferredRegion: string | null = null;
  private failbackTimer?: NodeJS.Timeout;
  /** Set when this gateway closed the socket to move to a better endpoint. */
  private switching = false;
  private draining?: NodeJS.Timeout;
  /** Doubles after each failback that found the first endpoint still down. */
  private failbackDelay?: number;
  private failbackAttempted = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly gatewayConfig: GatewayConfigManagerService,
    @Optional() private readonly plugins?: PluginLoaderService,
    @Optional() private readonly circuits?: CircuitBreakerService,
    @Optional() private readonly metering?: MeteringService,
  ) {}

  private get settings(): ControlPlaneSettings {
    const configured =
      this.configService.get<ControlPlaneSettings>('controlPlane');
    if (configured) return configured;
    const url = this.configService.get<string>('CONTROL_PLANE_URL');
    return {
      endpoints: url ? parseControlPlaneEndpoints(url) : [],
      failbackMs: DEFAULT_CONTROL_PLANE.failbackMs,
      instanceName: 'gateway',
    };
  }

  async onModuleInit() {
    await this.gatewayConfig.warmStart();
    this.endpoints = this.settings.endpoints;
    this.preferredRegion =
      this.gatewayConfig.getConfig()?.preferredRegion ?? null;
    this.order = orderControlPlaneEndpoints(
      this.endpoints,
      this.preferredRegion,
    );
    if (this.plugins?.statuses().length) {
      this.stopPluginListener = this.plugins.onChange(() =>
        this.schedulePluginReport(),
      );
      this.pluginReportInterval = setInterval(
        () => this.reportPlugins(),
        PLUGIN_REPORT_INTERVAL_MS,
      );
      this.pluginReportInterval.unref();
    }
    if (this.circuits) {
      this.stopCircuitListener = this.circuits.onChange(() =>
        this.scheduleCircuitReport(),
      );
      this.circuitReportInterval = setInterval(
        () => this.reportCircuits(),
        CIRCUIT_REPORT_INTERVAL_MS,
      );
      this.circuitReportInterval.unref();
    }
    if (this.metering) {
      this.usageReportInterval = setInterval(
        () => void this.reportUsage(),
        USAGE_REPORT_INTERVAL_MS,
      );
      this.usageReportInterval.unref();
    }
    this.connect();
  }

  onModuleDestroy() {
    this.stopped = true;
    this.stopPluginListener?.();
    clearTimeout(this.pluginReportTimer);
    clearInterval(this.pluginReportInterval);
    this.stopCircuitListener?.();
    clearTimeout(this.circuitReportTimer);
    clearInterval(this.circuitReportInterval);
    clearInterval(this.usageReportInterval);
    clearTimeout(this.failbackTimer);
    clearTimeout(this.draining);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
    }
  }

  private connect() {
    if (this.stopped) return;
    this.authenticated = false;
    const endpoint = this.order[this.endpointIndex % (this.order.length || 1)];
    const apiKey = this.configService.get<string>('GATEWAY_API_KEY');

    if (!endpoint || !apiKey) {
      this.logger.error(
        'CONTROL_PLANE_URL(S) or GATEWAY_API_KEY missing - cannot connect',
      );
      return;
    }

    const label = endpoint.region ? ` (${endpoint.region})` : '';
    this.logger.log(`Connecting to control plane at ${endpoint.url}${label}`);
    const ws = new WebSocket(endpoint.url);
    this.ws = ws;
    this.current = endpoint;
    let authenticatedHere = false;

    ws.on('open', () => {
      this.logger.log('WebSocket connected - sending auth');
      const auth: AuthMessage = {
        type: 'auth',
        payload: {
          apiKey,
          instanceId: this.instanceId,
          instanceName: this.settings.instanceName,
          configVersion: this.gatewayConfig.configVersion,
        },
      };
      ws.send(JSON.stringify(auth));
    });

    ws.on('message', (data) => {
      void this.handleMessage(data).then((authenticated) => {
        if (authenticated) authenticatedHere = true;
      });
    });

    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.authenticated = false;
      this.region = null;
      clearTimeout(this.failbackTimer);
      clearTimeout(this.draining);
      this.draining = undefined;
      this.logger.warn(`Disconnected from control plane (code: ${code})`);
      if ([4001, 4003, 4004].includes(code)) {
        this.logger.error(
          'Permanent failure code received - stopping reconnection',
        );
        return;
      }
      this.scheduleReconnect(authenticatedHere);
    });

    ws.on('error', (err) => {
      this.logger.error(`WebSocket error: ${err.message}`);
    });

    ws.on('ping', () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.pong();
      }
    });
  }

  /** Region of the connected control plane, once authenticated. */
  connectedRegion(): string | null {
    return this.authenticated ? this.region : null;
  }

  /**
   * After authenticating anywhere but the first endpoint in priority order,
   * return to it later. If it is still down, rotation brings the gateway
   * back here; traffic is served from memory throughout.
   */
  private scheduleFailback(delay: number) {
    clearTimeout(this.failbackTimer);
    if (this.order[0] === this.current || this.order.length < 2) return;
    this.failbackTimer = setTimeout(() => {
      if (this.stopped || this.order[0] === this.current) return;
      this.logger.log('Moving back to the preferred control plane');
      this.switching = true;
      this.failbackAttempted = true;
      this.ws?.close(1000, 'failback');
    }, delay);
    this.failbackTimer.unref();
  }

  /**
   * Reorders endpoints when the workspace's preferred region changes and
   * schedules the move; returns whether it changed.
   */
  private applyPreference(config: { preferredRegion?: string | null }) {
    const preferred = config.preferredRegion ?? null;
    if (preferred === this.preferredRegion) return false;
    this.preferredRegion = preferred;
    this.failbackDelay = undefined;
    this.order = orderControlPlaneEndpoints(this.endpoints, preferred);
    this.endpointIndex = Math.max(
      0,
      this.order.findIndex((endpoint) => endpoint === this.current),
    );
    this.scheduleFailback(PREFERENCE_SWITCH_DELAY_MS);
    return true;
  }

  /** Resolves true when the message completed authentication. */
  private async handleMessage(data: RawData): Promise<boolean> {
    try {
      const message = JSON.parse(data.toString()) as BaseWsMessage;

      switch (message.type) {
        case 'auth_ok': {
          const payload = (message as AuthOkMessage).payload;
          await this.gatewayConfig.loadConfig(
            payload.tenantId,
            payload.config,
            payload.configVersion,
          );
          this.authenticated = true;
          this.region = payload.controlPlaneRegion ?? null;
          this.failedAttempts = 0;
          this.reconnectIndex = 0;
          this.logger.log(
            `Authenticated with control plane${this.region ? ` region ${this.region}` : ''}`,
          );
          if (!this.applyPreference(payload.config)) {
            if (this.order[0] === this.current) this.failbackDelay = undefined;
            else if (this.failbackAttempted)
              this.failbackDelay = Math.min(
                (this.failbackDelay ?? this.settings.failbackMs) * 2,
                MAX_FAILBACK_MS,
              );
            this.scheduleFailback(
              this.failbackDelay ?? this.settings.failbackMs,
            );
          }
          this.failbackAttempted = false;
          this.sendNow({
            type: 'config.ack',
            version: payload.configVersion,
          } as ConfigAckMessage);
          this.flushBuffer();
          this.reportPlugins();
          this.reportCircuits();
          void this.reportUsage();
          return true;
        }
        case 'config.update': {
          const update = message as ConfigUpdateMessage;
          await this.gatewayConfig.loadConfig(
            this.gatewayConfig.getTenantId() ?? '',
            update.payload,
            update.version,
          );
          this.applyPreference(update.payload);
          this.sendNow({
            type: 'config.ack',
            version: update.version,
          } as ConfigAckMessage);
          break;
        }
        case 'ping':
          this.sendNow({ type: 'pong' });
          break;
        case 'ack':
          if (message.id) this.handleAck(message.id);
          break;
      }
    } catch (err) {
      this.logger.error(`Failed to handle message: ${(err as Error).message}`);
    }
    return false;
  }

  /**
   * An intentional move reconnects at once to the first endpoint. A lost
   * session retries its endpoint first; failures rotate through the list,
   * backing off only after every endpoint has failed in turn.
   */
  private scheduleReconnect(wasAuthenticated: boolean) {
    if (this.stopped) return;
    let delay = this.reconnectDelays[0];
    if (this.switching) {
      this.switching = false;
      this.endpointIndex = 0;
      this.failedAttempts = 0;
      delay = 0;
    } else if (!wasAuthenticated) {
      this.failedAttempts++;
      this.endpointIndex = (this.endpointIndex + 1) % (this.order.length || 1);
      if (this.failedAttempts % (this.order.length || 1) === 0) {
        delay = this.reconnectDelays[this.reconnectIndex];
        this.reconnectIndex = Math.min(
          this.reconnectIndex + 1,
          this.reconnectDelays.length - 1,
        );
      }
    }
    this.logger.log(`Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  sendTransient(message: BaseWsMessage, maxBufferedBytes: number): boolean {
    if (!this.authenticated || this.ws?.readyState !== WebSocket.OPEN)
      return false;
    try {
      const serialized = JSON.stringify(message);
      if (
        this.ws.bufferedAmount + Buffer.byteLength(serialized) >
        maxBufferedBytes
      )
        return false;
      this.ws.send(serialized);
      return true;
    } catch {
      return false;
    }
  }

  private get open(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  /** In order: while a backlog drains, new messages queue behind it. */
  send(message: BaseWsMessage) {
    if (this.open && !this.messageBuffer.length) {
      this.ws?.send(JSON.stringify(message));
      return;
    }
    if (this.messageBuffer.length >= this.MAX_BUFFER_SIZE) {
      this.messageBuffer.shift(); // Drop oldest
    }
    this.messageBuffer.push(message);
    if (this.open) this.flushBuffer();
  }

  /** Configuration ACKs and pongs never wait behind buffered telemetry. */
  private sendNow(message: BaseWsMessage) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(message));
  }

  private flushBuffer() {
    if (this.draining) return;
    const tick = () => {
      this.draining = undefined;
      for (let i = 0; i < FLUSH_BATCH && this.messageBuffer.length; i++) {
        if (!this.open) return;
        this.ws?.send(JSON.stringify(this.messageBuffer.shift()));
      }
      if (this.messageBuffer.length && this.open) {
        this.draining = setTimeout(tick, FLUSH_INTERVAL_MS);
        this.draining.unref();
      }
    };
    tick();
  }

  private schedulePluginReport() {
    if (this.pluginReportTimer || this.stopped) return;
    this.pluginReportTimer = setTimeout(() => {
      this.pluginReportTimer = undefined;
      this.reportPlugins();
    }, PLUGIN_REPORT_DEBOUNCE_MS);
    this.pluginReportTimer.unref();
  }

  /** Transient snapshot: a missed report is replaced by the next one. */
  private reportPlugins() {
    const plugins = this.plugins?.statuses() ?? [];
    if (!plugins.length) return;
    this.sendTransient(
      { type: 'plugins.status', payload: { plugins } } as PluginsStatusMessage,
      PLUGIN_REPORT_MAX_BUFFERED_BYTES,
    );
  }

  private scheduleCircuitReport() {
    if (this.circuitReportTimer || this.stopped) return;
    this.circuitReportTimer = setTimeout(() => {
      this.circuitReportTimer = undefined;
      this.reportCircuits();
    }, CIRCUIT_REPORT_DEBOUNCE_MS);
    this.circuitReportTimer.unref();
  }

  /** Full transient snapshot; an empty list clears services that lost their breaker. */
  private reportCircuits() {
    if (!this.circuits) return;
    this.sendTransient(
      {
        type: 'circuit.state',
        payload: { services: this.circuits.statuses() },
      } as CircuitStateMessage,
      CIRCUIT_REPORT_MAX_BUFFERED_BYTES,
    );
  }

  /** Cumulative monthly counters for billing metering and consumer quotas. */
  async reportUsage() {
    const report = await this.metering?.report();
    if (!report) return;
    // One month per frame keeps a full consumer list under the frame limit.
    for (const month of report.months)
      this.sendTransient(
        {
          type: 'usage.report',
          payload: { source: report.source, months: [month] },
        } as UsageReportMessage,
        USAGE_REPORT_MAX_BUFFERED_BYTES,
      );
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private handleAck(_id: string) {
    // Logic for clearing high-priority errors from a local retry queue could go here
  }
}
