import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  RequestLog,
  HealthSnapshot,
  ErrorEvent,
} from '@api-gateway/shared-types';
import { ControlPlaneConnectorService } from '../connector/control-plane-connector.service';

@Injectable()
export class GatewayTelemetryService implements OnModuleInit {
  private readonly logger = new Logger(GatewayTelemetryService.name);
  private logBuffer: RequestLog[] = [];
  private healthBuffer: HealthSnapshot[] = [];
  private readonly MAX_LOG_BATCH = 100;
  private readonly LOG_FLUSH_INTERVAL = 500;

  constructor(private readonly connector: ControlPlaneConnectorService) {}

  onModuleInit() {
    setInterval(() => this.flushLogs(), this.LOG_FLUSH_INTERVAL);
  }

  logRequest(log: RequestLog) {
    this.logBuffer.push(log);
    if (this.logBuffer.length >= this.MAX_LOG_BATCH) {
      this.flushLogs();
    }
  }

  private flushLogs() {
    if (this.logBuffer.length === 0) return;
    const batch = [...this.logBuffer];
    this.logBuffer = [];
    this.connector.send({ type: 'logs', payload: batch });
  }

  sendHealth(snapshots: HealthSnapshot[]) {
    this.connector.send({ type: 'health', payload: snapshots });
  }

  sendError(error: ErrorEvent) {
    // Errors are high priority - send immediately with ID for ACK
    this.connector.send({
      type: 'errors',
      id: error.id,
      payload: [error],
    });
  }

  sendMetrics(metrics: any) {
    this.connector.send({ type: 'metrics', payload: metrics });
  }
}
