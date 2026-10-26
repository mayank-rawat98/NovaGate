import { Global, INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { usageMonth, type TenantConfig } from '@api-gateway/shared-types';
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
import { JwtMiddleware } from '../auth/jwt.middleware';
import { MeteringService } from '../metering/metering.service';

const redisUrl = process.env.TEST_REDIS_URL;
const integration = redisUrl ? describe : describe.skip;
const redis = redisUrl ? new Redis(`${redisUrl}/12`) : undefined;

@Global()
@Module({
  providers: [
    { provide: REDIS_CLIENT, useValue: redis },
    { provide: ConfigService, useValue: new ConfigService({}) },
  ],
  exports: [REDIS_CLIENT, ConfigService],
})
class TestRedisModule {}

integration('monthly quotas through the real proxy and Redis', () => {
  let app: INestApplication;
  let upstream: http.Server;
  let url: string;
  let config: TenantConfig;
  let hits = 0;
  const key = 'quota-verification-consumer-key';
  const consumerId = randomUUID();
  const metrics = {
    incrementActiveConnections: jest.fn(),
    decrementActiveConnections: jest.fn(),
    incrementHttpRequests: jest.fn(),
    observeRequestDuration: jest.fn(),
    incrementDownstreamTimeout: jest.fn(),
    incrementRateLimitHit: jest.fn(),
    incrementRateLimitRedisError: jest.fn(),
    incrementProxyRetry: jest.fn(),
    incrementQuotaRejection: jest.fn(),
    incrementMeteringError: jest.fn(),
    setTraceActiveSpans: jest.fn(),
    setTraceQueuedSpans: jest.fn(),
    incrementTraceDropped: jest.fn(),
  };

  beforeAll(async () => {
    await redis?.flushdb();
    upstream = http.createServer((req, res) => {
      hits++;
      req.resume();
      res.end('ok');
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    config = {
      routes: [
        {
          id: 'route',
          serviceId: 'service',
          method: 'ANY',
          pathPattern: '/api',
          enabled: true,
          authRequired: false,
        },
      ],
      services: [
        {
          id: 'service',
          name: 'api',
          targets: [{ url: target, weight: 1 }],
          timeoutMs: 1000,
          healthCheckPath: '/health',
        },
      ],
      consumers: [
        {
          id: consumerId,
          name: 'mobile',
          keyHash: createHash('sha256').update(key).digest('hex'),
          rateLimitTier: 'authenticated',
          monthlyQuota: 2,
        },
      ],
      rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
    };
    const module = await Test.createTestingModule({
      imports: [TestRedisModule, ConfigManagerModule, PluginsModule],
      controllers: [ProxyController],
      providers: [
        ProxyService,
        ProxyMiddleware,
        LoadBalancerService,
        Http2SessionPool,
        MeteringService,
        JwtMiddleware,
        {
          provide: ConfigService,
          useValue: {
            get: (name: string) =>
              ({
                jwt: {
                  secret: 'quota-test-secret-with-more-than-32-characters',
                },
                rateLimit: { windowMs: 60000, authMax: 500, unauthMax: 100 },
              })[name as 'jwt'],
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
      .useValue({ getConfig: () => config, getTenantId: () => 'tenant' })
      .overrideProvider(RateLimitService)
      .useValue({
        check: jest
          .fn()
          .mockResolvedValue({ allowed: true, retryAfterMs: null }),
      })
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    const jwt = module.get(JwtMiddleware);
    app.use(jwt.use.bind(jwt));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    upstream?.closeAllConnections();
    await new Promise((done) => upstream?.close(done));
    await redis?.flushdb();
    redis?.disconnect();
  });

  const call = (authorization?: string) =>
    fetch(`${url}/api`, {
      headers: authorization ? { authorization } : {},
    });

  it('refuses a consumer over its monthly quota without reaching the upstream', async () => {
    for (let i = 0; i < 2; i++)
      expect((await call(`Bearer ${key}`)).status).toBe(200);
    const refused = await call(`Bearer ${key}`);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe(
      'QUOTA_EXCEEDED',
    );
    expect(refused.headers.get('x-quota-limit')).toBe('2');
    expect(refused.headers.get('x-quota-remaining')).toBe('0');
    const reset = Date.parse(refused.headers.get('x-quota-reset') as string);
    expect(new Date(reset).getUTCDate()).toBe(1);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(hits).toBe(2);
    expect(metrics.incrementQuotaRejection).toHaveBeenCalledWith('consumer');
    // Anonymous traffic is metered for the workspace but has no quota.
    expect((await call()).status).toBe(200);
    const month = usageMonth(new Date());
    expect(await redis?.get(`meter:${month}:requests`)).toBe('3');
    expect(await redis?.get(`meter:${month}:c:${consumerId}`)).toBe('2');
    // Raising the quota in configuration takes effect immediately.
    config.consumers[0].monthlyQuota = 3;
    expect((await call(`Bearer ${key}`)).status).toBe(200);
  });

  it('refuses every route while the workspace is suspended', async () => {
    const until = new Date(Date.now() + 3600000).toISOString();
    config.suspended = { reason: 'QUOTA_EXCEEDED', until };
    const before = hits;
    for (const authorization of [undefined, `Bearer ${key}`]) {
      const refused = await call(authorization);
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { error: string }).error).toBe(
        'QUOTA_EXCEEDED',
      );
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(3500);
    }
    expect(hits).toBe(before);
    expect(metrics.incrementQuotaRejection).toHaveBeenCalledWith('workspace');
    // An expired suspension no longer applies.
    config.suspended = {
      reason: 'QUOTA_EXCEEDED',
      until: new Date(Date.now() - 1).toISOString(),
    };
    expect((await call()).status).toBe(200);
    config.suspended = null;
  });
});
