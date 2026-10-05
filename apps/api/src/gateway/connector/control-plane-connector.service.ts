import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import {
  AuthMessage,
  AuthOkMessage,
  BaseWsMessage,
  ConfigAckMessage,
  ConfigUpdateMessage,
} from '@api-gateway/shared-types';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';

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

  constructor(
    private readonly configService: ConfigService,
    private readonly gatewayConfig: GatewayConfigManagerService,
  ) {}

  async onModuleInit() {
    await this.gatewayConfig.warmStart();
    this.connect();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
    }
  }

  private connect() {
    if (this.stopped) return;
    this.authenticated = false;
    const url = this.configService.get<string>('CONTROL_PLANE_URL');
    const apiKey = this.configService.get<string>('GATEWAY_API_KEY');

    if (!url || !apiKey) {
      this.logger.error(
        'CONTROL_PLANE_URL or GATEWAY_API_KEY missing - cannot connect',
      );
      return;
    }

    this.logger.log(`Connecting to control plane at ${url}`);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.logger.log('WebSocket connected - sending auth');
      this.reconnectIndex = 0;
      const auth: AuthMessage = {
        type: 'auth',
        payload: { apiKey },
      };
      this.ws?.send(JSON.stringify(auth));
    });

    this.ws.on('message', (data) => this.handleMessage(data));

    this.ws.on('close', (code) => {
      this.authenticated = false;
      this.logger.warn(`Disconnected from control plane (code: ${code})`);
      if ([4001, 4003, 4004].includes(code)) {
        this.logger.error(
          'Permanent failure code received - stopping reconnection',
        );
        return;
      }
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.logger.error(`WebSocket error: ${err.message}`);
    });

    this.ws.on('ping', () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong();
      }
    });
  }

  private async handleMessage(data: RawData) {
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
          this.send({
            type: 'config.ack',
            version: payload.configVersion,
          } as ConfigAckMessage);
          this.flushBuffer();
          break;
        }
        case 'config.update': {
          const update = message as ConfigUpdateMessage;
          await this.gatewayConfig.loadConfig(
            this.gatewayConfig.getTenantId() ?? '',
            update.payload,
            update.version,
          );
          this.send({
            type: 'config.ack',
            version: update.version,
          } as ConfigAckMessage);
          break;
        }
        case 'ping':
          this.send({ type: 'pong' });
          break;
        case 'ack':
          if (message.id) this.handleAck(message.id);
          break;
      }
    } catch (err) {
      this.logger.error(`Failed to handle message: ${(err as Error).message}`);
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.reconnectDelays[this.reconnectIndex];
    this.logger.log(`Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectIndex = Math.min(
        this.reconnectIndex + 1,
        this.reconnectDelays.length - 1,
      );
      this.connect();
    }, delay);
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

  send(message: BaseWsMessage) {
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      if (this.messageBuffer.length >= this.MAX_BUFFER_SIZE) {
        this.messageBuffer.shift(); // Drop oldest
      }
      this.messageBuffer.push(message);
    }
  }

  private flushBuffer() {
    while (
      this.messageBuffer.length > 0 &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      const msg = this.messageBuffer.shift();
      if (msg) this.send(msg);
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private handleAck(_id: string) {
    // Logic for clearing high-priority errors from a local retry queue could go here
  }
}
