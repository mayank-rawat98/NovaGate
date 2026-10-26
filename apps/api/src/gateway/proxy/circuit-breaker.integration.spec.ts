import { Global, INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as http from 'http';
import * as http2 from 'http2';
import type { AddressInfo } from 'net';
import {
  DEFAULT_CIRCUIT_BREAKER,
  type TenantConfig,
} from '@api-gateway/shared-types';
import { ProxyController } from './proxy.controller';
import { ProxyMiddleware } from './proxy.middleware';
import { ProxyService } from './proxy.service';
import { LoadBalancerService } from './load-balancer.service';
import { Http2SessionPool } from './http2-session-pool.service';
import { MetricsService } from '../metrics/metrics.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { ConfigManagerModule } from '../config-manager/config-manager.module';
import { UpstreamHealthService } from '../health/upstream-health.service';
import { PluginsModule } from '../plugins/plugins.module';
import { REDIS_CLIENT } from '../shared/redis.tokens';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { GatewayExceptionFilter } from '../shared/gateway-exception.filter';
import { GatewayTelemetryService } from '../telemetry/gateway-telemetry.service';
import { CircuitBreakerService } from '../circuit-breaker/circuit-breaker.service';

@Global()
@Module({
  providers: [
    { provide: REDIS_CLIENT, useValue: {} },
    { provide: ConfigService, useValue: new ConfigService({}) },
  ],
  exports: [REDIS_CLIENT, ConfigService],
})
class TestRedisModule {}

const SERVICE = '33333333-3333-4333-8333-333333333333';
const OPEN_MS = 1000;

describe('circuit breaker with real upstream servers', () => {
  let app: INestApplication;
  let upstream: http.Server;
  let h2upstream: http2.Http2Server;
  let url: string;
  let target: string;
  let h2target: string;
  let config: TenantConfig;
  let breaker: CircuitBreakerService;
  let listener: () => void = () => undefined;
  /** Statuses the HTTP/1 upstream answers, in order; 'hang' never answers. */
  let script: Array<number | 'hang'>;
  let hits: number;
  let h2Fail: boolean;
  const metrics = {
    incrementActiveConnections: jest.fn(),
    decrementActiveConnections: jest.fn(),
    incrementHttpRequests: jest.fn(),
    observeRequestDuration: jest.fn(),
    incrementDownstreamTimeout: jest.fn(),
    incrementRateLimitHit: jest.fn(),
    incrementRateLimitRedisError: jest.fn(),
    incrementProxyRetry: jest.fn(),
    incrementCircuitRejection: jest.fn(),
    setCircuitStates: jest.fn(),
    setTraceActiveSpans: jest.fn(),
    setTraceQueuedSpans: jest.fn(),
    incrementTraceDropped: jest.fn(),
  };

  async function listen(server: http.Server | http2.Http2Server) {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const setConfig = (next: Partial<TenantConfig['services'][number]> = {}) => {
    config = {
      routes: [
        {
          id: 'route',
          serviceId: SERVICE,
          method: 'ANY',
          pathPattern: '/api',
          enabled: true,
          authRequired: false,
        },
      ],
      services: [
        {
          id: SERVICE,
          name: 'orders',
          targets: [{ url: target, weight: 1 }],
          timeoutMs: 300,
          healthCheckPath: '/health',
          circuitBreaker: { ...DEFAULT_CIRCUIT_BREAKER, openMs: OPEN_MS },
          ...next,
        },
      ],
      consumers: [],
      rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
    };
    listener();
  };
  const get = async (path = '/api') => {
    let response: Response;
    try {
      response = await fetch(`${url}${path}`);
    } catch {
      // On an upstream timeout the gateway may close the client connection
      // (the shared socket timeout) instead of answering 504.
      return { status: 'closed' as const, retryAfter: null, body: '' };
    }
    return {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      body: await response.text(),
    };
  };
  const timedOut = (status: number | 'closed') =>
    status === 504 || status === 'closed';
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      hits++;
      req.resume();
      const next = script.length ? script.shift() : 200;
      if (next === 'hang') return;
      res.statusCode = next as number;
      res.end('upstream');
    });
    target = await listen(upstream);
    h2upstream = http2.createServer();
    h2upstream.on('stream', (stream) => {
      hits++;
      stream.on('error', () => undefined);
      if (h2Fail) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        return;
      }
      stream.respond({ ':status': 200 });
      stream.end('h2');
    });
    h2target = await listen(h2upstream);
    const module = await Test.createTestingModule({
      imports: [TestRedisModule, ConfigManagerModule, PluginsModule],
      controllers: [ProxyController],
      providers: [
        ProxyService,
        ProxyMiddleware,
        LoadBalancerService,
        Http2SessionPool,
        CircuitBreakerService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({
                rateLimit: { windowMs: 60000, authMax: 500, unauthMax: 100 },
              })[key as 'rateLimit'],
          },
        },
        { provide: MetricsService, useValue: metrics },
        {
          provide: UpstreamHealthService,
          useValue: {
            getHealthyUrls: (targets: Array<{ url: string }>) =>
              new Set(targets.map((t) => t.url)),
          },
        },
        {
          provide: GatewayTelemetryService,
          useValue: { sendError: jest.fn(), logRequest: jest.fn() },
        },
        { provide: APP_FILTER, useClass: GatewayExceptionFilter },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        RateLimitService,
      ],
    })
      .overrideProvider(GatewayConfigManagerService)
      .useValue({
        getConfig: () => config,
        getTenantId: () => 'tenant',
        subscribeConfig: (next: () => void) => {
          listener = next;
          return () => undefined;
        },
      })
      .overrideProvider(RateLimitService)
      .useValue({
        check: jest
          .fn()
          .mockResolvedValue({ allowed: true, retryAfterMs: null }),
      })
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    breaker = module.get(CircuitBreakerService);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  beforeEach(() => {
    script = [];
    hits = 0;
    h2Fail = false;
    for (const method of Object.values(metrics)) method.mockClear();
    // Identical settings keep a circuit; drop it so each test starts closed.
    setConfig({ circuitBreaker: null });
    setConfig();
  });

  afterAll(async () => {
    await app?.close();
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
    await new Promise((done) => h2upstream.close(done));
  });

  it('opens at a 60% failure rate, refuses without upstream traffic, then recovers', async () => {
    script = [500, 200, 503, 200, 502];
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await get()).status);
    // Upstream 5xx are surfaced as 502 DOWNSTREAM_ERROR.
    expect(statuses).toEqual([502, 200, 502, 200, 502]);
    expect(breaker.stateOf(SERVICE)).toBe('open');
    const refused = await get();
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body).error).toBe('CIRCUIT_OPEN');
    expect(refused.retryAfter).toBe('1');
    expect(hits).toBe(5);
    expect(metrics.incrementCircuitRejection).toHaveBeenCalledWith('orders');
    expect(metrics.setCircuitStates).toHaveBeenLastCalledWith([
      { service: 'orders', state: 'open' },
    ]);

    await wait(OPEN_MS + 50);
    expect((await get()).status).toBe(200);
    expect(breaker.stateOf(SERVICE)).toBe('half-open');
    expect((await get()).status).toBe(200);
    expect(breaker.stateOf(SERVICE)).toBe('closed');
    expect(hits).toBe(7);
    expect(metrics.setCircuitStates).toHaveBeenLastCalledWith([
      { service: 'orders', state: 'closed' },
    ]);
  });

  it('reopens when the probe fails and lets only one probe through at a time', async () => {
    script = [500, 500, 500, 500, 500];
    for (let i = 0; i < 5; i++) await get();
    await wait(OPEN_MS + 50);
    script = ['hang'];
    const probe = get();
    await wait(50);
    // The hanging probe holds the half-open slot.
    const concurrent = await get();
    expect(concurrent.status).toBe(503);
    expect(JSON.parse(concurrent.body).error).toBe('CIRCUIT_OPEN');
    // Its timeout (300 ms) is a failure: the circuit reopens.
    expect(timedOut((await probe).status)).toBe(true);
    expect(breaker.stateOf(SERVICE)).toBe('open');
    expect(hits).toBe(6);
  });

  it('counts connection failures and timeouts, but not 4xx responses', async () => {
    script = [404, 404, 404, 404, 404, 404];
    for (let i = 0; i < 6; i++) expect((await get()).status).toBe(404);
    expect(breaker.stateOf(SERVICE)).toBe('closed');
    const closed = http.createServer();
    const dead = await listen(closed);
    await new Promise((done) => closed.close(done));
    // Start from an empty window: the 404s above were successes.
    setConfig({ circuitBreaker: null });
    setConfig({ targets: [{ url: dead, weight: 1 }] });
    for (let i = 0; i < 5; i++) expect((await get()).status).toBe(502);
    expect(breaker.stateOf(SERVICE)).toBe('open');
    setConfig({ timeoutMs: 100 });
    expect(breaker.stateOf(SERVICE)).toBe('open');
    // Changing a breaker setting resets the circuit.
    setConfig({
      timeoutMs: 100,
      circuitBreaker: { ...DEFAULT_CIRCUIT_BREAKER, openMs: 2000 },
    });
    expect(breaker.stateOf(SERVICE)).toBe('closed');
    script = ['hang', 'hang', 'hang', 'hang', 'hang'];
    for (let i = 0; i < 5; i++)
      expect(timedOut((await get()).status)).toBe(true);
    expect(breaker.stateOf(SERVICE)).toBe('open');
  });

  it('ignores callers that disconnect', async () => {
    for (let i = 0; i < 5; i++) {
      script = ['hang'];
      const controller = new AbortController();
      const pending = fetch(`${url}/api`, { signal: controller.signal }).catch(
        () => undefined,
      );
      await wait(30);
      controller.abort();
      await pending;
    }
    await wait(50);
    expect(breaker.statuses()[0]).toMatchObject({
      state: 'closed',
      requests: 0,
    });
  });

  it('stops retrying once the circuit opens', async () => {
    setConfig({
      circuitBreaker: {
        ...DEFAULT_CIRCUIT_BREAKER,
        openMs: OPEN_MS,
        minimumRequests: 2,
      },
    });
    config.routes[0].retry = { attempts: 4, on: [502], methods: ['GET'] };
    script = [502, 502, 502, 502, 502];
    const result = await get();
    // Two failed attempts open the circuit; the third attempt is refused.
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body).error).toBe('CIRCUIT_OPEN');
    expect(hits).toBe(2);
  });

  it('applies to HTTP/2 upstreams', async () => {
    setConfig({ targets: [{ url: h2target, weight: 1 }], h2: true });
    h2Fail = true;
    for (let i = 0; i < 5; i++) expect((await get()).status).toBe(502);
    expect(breaker.stateOf(SERVICE)).toBe('open');
    expect((await get()).status).toBe(503);
    h2Fail = false;
    await wait(OPEN_MS + 50);
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect(breaker.stateOf(SERVICE)).toBe('closed');
  });

  it('leaves services without a breaker untouched', async () => {
    setConfig({ circuitBreaker: null });
    script = Array(10).fill(500);
    for (let i = 0; i < 10; i++) expect((await get()).status).toBe(502);
    expect(hits).toBe(10);
    expect(breaker.statuses()).toEqual([]);
  });
});
