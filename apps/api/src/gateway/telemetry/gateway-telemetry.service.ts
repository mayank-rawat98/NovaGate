import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  RequestLog,
  HealthSnapshot,
  ErrorEvent,
  BaseWsMessage,
  TraceSpan,
} from '@api-gateway/shared-types';
import { ControlPlaneConnectorService } from '../connector/control-plane-connector.service';

@Injectable()
export class GatewayTelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayTelemetryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private logBuffer: RequestLog[] = [];
  private readonly MAX_LOG_BATCH = 100;
  private readonly LOG_FLUSH_INTERVAL = 500;

  constructor(private readonly connector: ControlPlaneConnectorService) {}

  onModuleInit() {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => this.flushLogs(), this.LOG_FLUSH_INTERVAL);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flushLogs();
  }

  logRequest(log: RequestLog) {
    if (this.stopping) return;
    this.logBuffer.push(log);
    if (this.logBuffer.length >= this.MAX_LOG_BATCH) {
      this.flushLogs();
    }
  }

  private flushLogs() {
    if (this.logBuffer.length === 0) return;
    const batch = [...this.logBuffer];
    this.logBuffer = [];
    this.send({ type: 'logs', payload: batch });
  }

  sendHealth(snapshots: HealthSnapshot[]) {
    this.send({ type: 'health', payload: snapshots });
  }

  sendError(error: ErrorEvent) {
    // Errors are high priority - send immediately with ID for ACK
    this.send({
      type: 'errors',
      id: error.id,
      payload: [error],
    });
  }

  private send(message: BaseWsMessage): void {
    try {
      this.connector.send(message);
    } catch {
      this.logger.warn('Telemetry delivery failed');
    }
  }

  sendTraces(spans: TraceSpan[], maxBufferedBytes: number): boolean {
    return this.connector.sendTransient(
      { type: 'traces', payload: spans },
      maxBufferedBytes,
    );
  }

  sendMetrics(metrics: Record<string, unknown>) {
    this.send({ type: 'metrics', payload: metrics });
  }
}
