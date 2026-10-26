import * as http from 'node:http';
import * as http2 from 'node:http2';
import * as https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import type { ServiceConfig, TenantConfig } from '@api-gateway/shared-types';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { UpstreamHealthService } from './upstream-health.service';
import { grpcHealthRequest } from './grpc-health-wire';
import { DEFAULT_UPSTREAM_HEALTH } from '../../config/configuration';

async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Health state did not converge');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('active upstream health with real network peers', () => {
  const servers: Array<http.Server | http2.Http2Server> = [];
  const workers: UpstreamHealthService[] = [];
  let manager: GatewayConfigManagerService;
  let version: number;
  const config = (services: ServiceConfig[]): TenantConfig => ({
    services,
    routes: [],
    consumers: [],
    rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
  });
  const service = (url: string, id = 'one'): ServiceConfig => ({
    id,
    name: id,
    targets: [{ url, weight: 1 }],
    healthCheckPath: '/health',
    healthCheckIntervalMs: 1000,
    timeoutMs: 1000,
  });
  async function listen(
    server: http.Server | http2.Http2Server,
    host = '127.0.0.1',
  ) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const port = (server.address() as { port: number }).port;
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  }
  async function install(services: ServiceConfig[]) {
    await manager.loadConfig('tenant', config(services), ++version);
  }
  function start(settings = {}) {
    const telemetry = { sendHealth: jest.fn() };
    const health = new UpstreamHealthService(
      manager,
      telemetry as never,
      new ConfigService({
        upstreamHealth: {
          ...DEFAULT_UPSTREAM_HEALTH,
          probeTimeoutMs: 100,
          schedulerIntervalMs: 10,
          telemetryIntervalMs: 20,
          ...settings,
        },
      }),
    );
    workers.push(health);
    health.onModuleInit();
    return health;
  }
  beforeEach(() => {
    version = 0;
    manager = new GatewayConfigManagerService({
      set: jest.fn().mockResolvedValue('OK'),
    } as never);
  });
  afterEach(async () => {
    await Promise.all(
      workers.splice(0).map((worker) => worker.onModuleDestroy()),
    );
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
  });

  it('isolates checks sharing a URL, reports degraded pools and excludes removed targets immediately', async () => {
    const url = await listen(
      http.createServer((req, res) => {
        res.writeHead(req.url === '/health' ? 204 : 401);
        res.end();
      }),
    );
    const other = await listen(
      http.createServer((_, res) => {
        res.writeHead(503);
        res.end();
      }),
    );
    const good = {
      ...service(url),
      targets: [
        { url, weight: 1 },
        { url: other, weight: 1 },
      ],
    };
    const bad = { ...service(url, 'two'), healthCheckPath: '/private' };
    await install([good, bad]);
    const health = start({ failureThreshold: 1 });
    await until(() => {
      const snapshots = health.getSnapshots([good, bad]);
      return (
        snapshots[0].status === 'degraded' &&
        snapshots[1].status === 'unhealthy'
      );
    });
    expect(health.getHealthyUrls(good.targets, good.id)).toEqual(
      new Set([url]),
    );
    expect(health.getHealthyUrls(bad.targets, bad.id)).toEqual(new Set());
    await install([{ ...good, targets: [{ url: other, weight: 1 }] }]);
    expect(health.getHealthyUrls(good.targets, good.id)).toEqual(new Set());
  });

  it('evicts after three failures and waits for two consecutive successes before recovery', async () => {
    let code = 200;
    let hits = 0;
    const url = await listen(
      http.createServer((_, res) => {
        hits++;
        res.writeHead(code);
        res.end();
      }),
    );
    const svc = service(url);
    await install([svc]);
    const health = start();
    await until(() => health.getSnapshots([svc])[0].status === 'healthy');
    code = 503;
    const baseline = hits;
    await until(() => hits >= baseline + 2);
    expect(health.getHealthyUrls(svc.targets, svc.id)).toEqual(new Set([url]));
    await until(() => health.getSnapshots([svc])[0].status === 'unhealthy');
    code = 204;
    const recoveryHits = hits;
    await until(() => hits > recoveryHits);
    expect(health.getHealthyUrls(svc.targets, svc.id)).toEqual(new Set());
    await until(() => health.getSnapshots([svc])[0].status === 'healthy');
    expect(health.getHealthyUrls(svc.targets, svc.id)).toEqual(new Set([url]));
  }, 10000);

  it.each([301, 401, 404, 500])(
    'rejects HTTP %i as a successful health check',
    async (code) => {
      const url = await listen(
        http.createServer((_, res) => {
          res.writeHead(code);
          res.end();
        }),
      );
      const svc = service(url);
      await install([svc]);
      const health = start({ failureThreshold: 1 });
      await until(() => health.getSnapshots([svc])[0].status === 'unhealthy');
    },
  );

  it('keeps HTTP/1 peers healthy for an h2 service using verified predispatch fallback', async () => {
    let checked = 0;
    const http1 = http.createServer((req, res) => {
      expect(req.url).toBe('/health');
      checked++;
      res.end('healthy');
    });
    const url = await listen(http1);
    const svc = { ...service(url), h2: true };
    await install([svc]);
    const health = start();
    await until(() => health.getSnapshots([svc])[0].status === 'healthy');
    expect(checked).toBeGreaterThan(0);
    expect(health.getHealthyUrls(svc.targets, svc.id)).toEqual(new Set([url]));
  });
  it.each([false, true])(
    'rejects an untrusted HTTPS certificate without disabling TLS verification (h2=%s)',
    async (h2) => {
      const artifacts = resolve(__dirname, '../../../../..', '.local-work');
      mkdirSync(artifacts, { recursive: true });
      const directory = mkdtempSync(resolve(artifacts, 'health-tls-'));
      try {
        const key = resolve(directory, 'key.pem');
        const cert = resolve(directory, 'cert.pem');
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            key,
            '-out',
            cert,
            '-days',
            '1',
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=IP:127.0.0.1',
          ],
          { stdio: 'ignore' },
        );
        let requests = 0;
        const server = https.createServer(
          { key: readFileSync(key), cert: readFileSync(cert) },
          (_, response) => {
            requests++;
            response.end('ok');
          },
        );
        const url = (await listen(server)).replace('http:', 'https:');
        const svc = { ...service(url), h2 };
        await install([svc]);
        const health = start({ failureThreshold: 1, probeTimeoutMs: 1000 });
        await until(() => health.getSnapshots([svc])[0].status === 'unhealthy');
        expect(requests).toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('checks named gRPC health services separately and switches from HTTP probes', async () => {
    const requests: Buffer[] = [];
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
      stream.on('error', () => {
        /* Cancellation is observed by the probe worker. */
      });
      if (headers[':method'] !== 'POST') {
        stream.respond({ ':status': 404 });
        stream.end();
        return;
      }
      expect(headers[':path']).toBe('/grpc.health.v1.Health/Check');
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const request = Buffer.concat(chunks);
        requests.push(request);
        const status = request.equals(grpcHealthRequest('Echo')) ? 1 : 2;
        stream.respond(
          { ':status': 200, 'content-type': 'application/grpc' },
          { waitForTrailers: true },
        );
        stream.on('wantTrailers', () =>
          stream.sendTrailers({ 'grpc-status': '0' }),
        );
        stream.end(Buffer.from([0, 0, 0, 0, 2, 8, status]));
      });
    });
    const url = await listen(server);
    const initial = { ...service(url), h2: true };
    await install([initial]);
    const health = start({ failureThreshold: 1 });
    await until(() => health.getSnapshots([initial])[0].status === 'unhealthy');
    const good = {
      ...initial,
      healthCheckProtocol: 'grpc' as const,
      healthCheckService: 'Echo',
    };
    const bad = { ...good, id: 'bad', healthCheckService: 'Other' };
    await install([good, bad]);
    await until(() => {
      const states = health.getSnapshots([good, bad]);
      return states[0].status === 'healthy' && states[1].status === 'unhealthy';
    });
    expect(requests).toEqual(
      expect.arrayContaining([
        grpcHealthRequest('Echo'),
        grpcHealthRequest('Other'),
      ]),
    );
    expect(health.getHealthyUrls(good.targets, good.id)).toEqual(
      new Set([url]),
    );
    expect(health.getHealthyUrls(bad.targets, bad.id)).toEqual(new Set());
  });

  it.each([
    'not-serving',
    'missing-status',
    'rpc-error',
    'oversize',
    'malformed',
    'stall',
  ])('rejects gRPC health failure %s', async (mode) => {
    const server = http2.createServer();
    server.on('stream', (stream) => {
      stream.on('error', () => {
        /* Deliberately invalid/stalled peer. */
      });
      stream.resume();
      if (mode === 'stall') return;
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () =>
        stream.sendTrailers(
          mode === 'missing-status'
            ? {}
            : { 'grpc-status': mode === 'rpc-error' ? '7' : '0' },
        ),
      );
      stream.end(
        mode === 'oversize'
          ? Buffer.alloc(4097)
          : mode === 'malformed'
            ? Buffer.from([0, 0])
            : Buffer.from([0, 0, 0, 0, 2, 8, mode === 'not-serving' ? 2 : 1]),
      );
    });
    const url = await listen(server);
    const svc = { ...service(url), healthCheckProtocol: 'grpc' as const };
    await install([svc]);
    const health = start({ failureThreshold: 1 });
    await until(() => health.getSnapshots([svc])[0].status === 'unhealthy');
  });

  it('supports IPv6 HTTP and HTTP/2 checks', async () => {
    const v6 = await listen(
      http.createServer((_, res) => {
        res.writeHead(204);
        res.end();
      }),
      '::1',
    );
    const h2 = http2.createServer();
    h2.on('stream', (stream) => {
      stream.respond({ ':status': 200 });
      stream.end();
    });
    const h2url = await listen(h2);
    const services = [service(v6), { ...service(h2url, 'h2'), h2: true }];
    await install(services);
    const health = start();
    await until(() =>
      health.getSnapshots(services).every((item) => item.status === 'healthy'),
    );
  });

  it('does not overlap a check when the probe deadline exceeds its cadence', async () => {
    let requests = 0;
    const url = await listen(
      http.createServer(() => {
        requests++;
      }),
    );
    const svc = service(url);
    await install([svc]);
    const health = start({ failureThreshold: 1, probeTimeoutMs: 1500 });
    await until(() => requests === 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(requests).toBe(1);
    await until(() => health.getSnapshots([svc])[0].status === 'unhealthy');
    expect(health.getHealthyUrls(svc.targets, svc.id)).toEqual(new Set());
  });

  it('bounds stalled-header probes, obeys concurrency and cancels removed checks and shutdown', async () => {
    let active = 0;
    let maxActive = 0;
    const url = await listen(
      http.createServer((req) => {
        active++;
        maxActive = Math.max(active, maxActive);
        req.on('close', () => active--);
      }),
    );
    const services = Array.from({ length: 5 }, (_, i) =>
      service(url, String(i)),
    );
    await install(services);
    const health = start({ failureThreshold: 1, concurrency: 2 });
    await until(() =>
      health
        .getSnapshots(services)
        .every((item) => item.status === 'unhealthy'),
    );
    expect(maxActive).toBeLessThanOrEqual(2);
    await until(() => active === 0);
    await install(
      services.map((item) => ({ ...item, healthCheckPath: '/changed' })),
    );
    await until(() => active > 0);
    await install([]);
    await until(() => active === 0);
    await install(
      services.map((item) => ({ ...item, healthCheckPath: '/shutdown' })),
    );
    await until(() => active > 0);
    await health.onModuleDestroy();
    await until(() => active === 0);
    expect(
      health.getSnapshots(services).every((item) => item.status === 'unknown'),
    ).toBe(true);
  });
});
