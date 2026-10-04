import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as http from 'node:http';
import * as https from 'node:https';
import * as http2 from 'node:http2';
import type { ServiceConfig, HealthSnapshot } from '@api-gateway/shared-types';
import {
  DEFAULT_UPSTREAM_HEALTH,
  UpstreamHealthSettings,
} from '../../config/configuration';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { grpcHealthRequest, grpcHealthServing } from './grpc-health-wire';
import { GatewayTelemetryService } from '../telemetry/gateway-telemetry.service';

interface TargetState {
  key: string;
  serviceId: string;
  url: string;
  path: string;
  h2: boolean;
  protocol: 'http' | 'grpc';
  healthService: string;
  intervalMs: number;
  nextAt: number;
  status: 'unknown' | 'healthy' | 'unhealthy';
  failures: number;
  successes: number;
  checkedAt?: Date;
  latencyMs?: number;
  active?: AbortController;
}

@Injectable()
export class UpstreamHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpstreamHealthService.name);
  private readonly states = new Map<string, TargetState>();
  private readonly running = new Set<Promise<void>>();
  private readonly settings: UpstreamHealthSettings;
  private interval?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private stopped = false;
  private nextTelemetryAt = 0;

  constructor(
    private readonly configManager: GatewayConfigManagerService,
    private readonly telemetry: GatewayTelemetryService,
    config: ConfigService,
  ) {
    this.settings =
      config.get<UpstreamHealthSettings>('upstreamHealth') ??
      DEFAULT_UPSTREAM_HEALTH;
  }
  onModuleInit() {
    this.unsubscribe = this.configManager.subscribeConfig(() =>
      this.schedule(),
    );
    this.interval = setInterval(
      () => this.schedule(),
      this.settings.schedulerIntervalMs,
    );
    this.interval.unref();
    this.schedule();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.interval);
    this.unsubscribe?.();
    for (const state of this.states.values()) state.active?.abort();
    await Promise.allSettled(this.running);
    this.states.clear();
  }
  private key(service: ServiceConfig, url: string) {
    return JSON.stringify([
      this.configManager.getTenantId(),
      service.id,
      url,
      service.healthCheckPath,
      service.h2 === true,
      service.healthCheckProtocol ?? 'http',
      service.healthCheckService ?? '',
    ]);
  }
  private reconcile() {
    const config = this.configManager.getConfig();
    const retained = new Set<string>();
    for (const service of config?.services ?? []) {
      for (const target of service.targets) {
        const key = this.key(service, target.url);
        retained.add(key);
        const rawInterval =
          service.healthCheckIntervalMs ?? this.settings.defaultIntervalMs;
        // Defend the scheduler against malformed cached/legacy configuration.
        const intervalMs =
          Number.isSafeInteger(rawInterval) &&
          rawInterval >= 1000 &&
          rawInterval <= 60000
            ? rawInterval
            : this.settings.defaultIntervalMs;
        const previous = this.states.get(key);
        if (previous) {
          if (previous.intervalMs !== intervalMs) {
            previous.intervalMs = intervalMs;
            previous.nextAt = 0;
          }
        } else
          this.states.set(key, {
            key,
            serviceId: service.id,
            url: target.url,
            path: service.healthCheckPath,
            h2: service.h2 === true,
            protocol: service.healthCheckProtocol ?? 'http',
            healthService: service.healthCheckService ?? '',
            intervalMs,
            nextAt: 0,
            status: 'unknown',
            failures: 0,
            successes: 0,
          });
      }
    }
    for (const [key, state] of this.states) {
      if (!retained.has(key)) {
        this.states.delete(key);
        state.active?.abort();
      }
    }
    return config;
  }
  getHealthyUrls(
    targets: Array<{ url: string; weight: number }>,
    serviceId: string,
  ): Set<string> {
    const config = this.configManager.getConfig();
    const service = config?.services.find((item) => item.id === serviceId);
    const healthy = new Set<string>();
    if (!service) return healthy;
    const configured = new Set(service.targets.map((target) => target.url));
    for (const target of targets) {
      if (
        configured.has(target.url) &&
        this.states.get(this.key(service, target.url))?.status !== 'unhealthy'
      )
        healthy.add(target.url);
    }
    return healthy;
  }
  getSnapshots(services: ServiceConfig[]): HealthSnapshot[] {
    return services.map((service) => {
      const states = service.targets.map((target) =>
        this.states.get(this.key(service, target.url)),
      );
      const healthy = states.filter(
        (state) => state?.status === 'healthy',
      ).length;
      const unhealthy = states.filter(
        (state) => state?.status === 'unhealthy',
      ).length;
      const status: HealthSnapshot['status'] =
        states.length && unhealthy === states.length
          ? 'unhealthy'
          : healthy === states.length && states.length
            ? 'healthy'
            : healthy && unhealthy
              ? 'degraded'
              : 'unknown';
      const checked = states.flatMap((state) =>
        state?.checkedAt ? [state.checkedAt] : [],
      );
      const latest = checked.length
        ? new Date(Math.max(...checked.map((date) => date.getTime())))
        : new Date();
      return {
        serviceId: service.id,
        status,
        checkedAt: latest.toISOString(),
        latencyMs: Math.max(0, ...states.map((state) => state?.latencyMs ?? 0)),
        ...(unhealthy
          ? {
              errorMessage: `${unhealthy} of ${states.length} targets failed consecutive health checks`,
            }
          : {}),
      };
    });
  }
  private schedule() {
    if (this.stopped) return;
    const config = this.reconcile();
    const now = Date.now();
    const due = [...this.states.values()]
      .filter((state) => !state.active && state.nextAt <= now)
      .sort((a, b) => a.nextAt - b.nextAt);
    for (const state of due) {
      if (this.running.size >= this.settings.concurrency) break;
      const abort = new AbortController();
      state.active = abort;
      state.nextAt = now + state.intervalMs;
      const started = performance.now();
      const operation = this.probe(state, abort.signal)
        .then((ok) => {
          if (
            this.stopped ||
            abort.signal.aborted ||
            this.states.get(state.key) !== state
          )
            return;
          state.checkedAt = new Date();
          state.latencyMs = Math.round(performance.now() - started);
          const previous = state.status;
          if (ok) {
            state.failures = 0;
            state.successes++;
            if (
              state.status !== 'unhealthy' ||
              state.successes >= this.settings.recoveryThreshold
            )
              state.status = 'healthy';
          } else {
            state.successes = 0;
            state.failures++;
            if (state.failures >= this.settings.failureThreshold)
              state.status = 'unhealthy';
          }
          if (previous !== state.status)
            this.logger.debug(
              `Service ${state.serviceId} target health is ${state.status}`,
            );
        })
        .finally(() => {
          state.active = undefined;
          this.running.delete(operation);
        });
      this.running.add(operation);
    }
    if (config && now >= this.nextTelemetryAt) {
      this.nextTelemetryAt = now + this.settings.telemetryIntervalMs;
      this.telemetry.sendHealth(this.getSnapshots(config.services));
    }
  }
  private probe(state: TargetState, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let request: http.ClientRequest | http2.ClientHttp2Stream | undefined;
      let session: http2.ClientHttp2Session | undefined;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
        request?.destroy();
        session?.destroy();
        resolve(ok);
      };
      const abort = () => finish(false);
      const deadline = setTimeout(
        () => finish(false),
        this.settings.probeTimeoutMs,
      );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        finish(false);
        return;
      }
      try {
        const base = new URL(state.url);
        const url = new URL(state.path || '/', base);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.origin !== base.origin
        ) {
          finish(false);
          return;
        }
        if (state.h2 || state.protocol === 'grpc') {
          const connection = http2.connect(url.origin);
          session = connection;
          connection.on('error', () => finish(false));
          connection.once('connect', () => {
            if (settled) return;
            try {
              const headers: http2.OutgoingHttpHeaders = {
                ':method': state.protocol === 'grpc' ? 'POST' : 'GET',
                ':path':
                  state.protocol === 'grpc'
                    ? '/grpc.health.v1.Health/Check'
                    : url.pathname + url.search,
              };
              if (url.username || url.password)
                headers.authorization =
                  'Basic ' +
                  Buffer.from(
                    `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
                  ).toString('base64');
              if (state.protocol === 'grpc') {
                headers['content-type'] = 'application/grpc';
                headers.te = 'trailers';
                headers['grpc-timeout'] = `${this.settings.probeTimeoutMs}m`;
              }
              // Headers must be complete before opening the HTTP/2 stream.
              request = connection.request(headers);
              request.on('error', () => finish(false));
              if (state.protocol === 'grpc') {
                const chunks: Buffer[] = [];
                let bytes = 0;
                let responseOk = false;
                let grpcStatus: string | number | string[] | undefined;
                request.once('response', (response) => {
                  responseOk =
                    response[':status'] === 200 &&
                    typeof response['content-type'] === 'string' &&
                    /^application\/grpc(?:\+[\w.-]+)?(?:\s*;.*)?$/i.test(
                      response['content-type'],
                    );
                  grpcStatus = response['grpc-status'];
                  if (!responseOk) finish(false);
                });
                request.on('trailers', (trailers) => {
                  grpcStatus = trailers['grpc-status'];
                });
                request.on('data', (chunk: Buffer) => {
                  bytes += chunk.length;
                  if (bytes > this.settings.grpcMaxResponseBytes) finish(false);
                  else chunks.push(chunk);
                });
                request.once('end', () =>
                  finish(
                    responseOk &&
                      grpcStatus === '0' &&
                      grpcHealthServing(Buffer.concat(chunks)),
                  ),
                );
                request.end(grpcHealthRequest(state.healthService));
              } else {
                request.once('response', (response) =>
                  finish(
                    Number(response[':status']) >= 200 &&
                      Number(response[':status']) < 300,
                  ),
                );
                request.end();
              }
            } catch {
              finish(false);
            }
          });
        } else {
          const client = url.protocol === 'https:' ? https : http;
          request = client.get(url, { agent: false }, (response) => {
            const code = response.statusCode ?? 500;
            response.destroy();
            finish(code >= 200 && code < 300);
          });
          request.on('error', () => finish(false));
        }
      } catch {
        finish(false);
      }
    });
  }
}
