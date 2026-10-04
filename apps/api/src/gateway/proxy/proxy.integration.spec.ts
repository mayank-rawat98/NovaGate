import { Global, INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHash, generateKeyPairSync } from 'crypto';
import * as http from 'http';
import * as http2 from 'http2';
import { sign } from 'jsonwebtoken';
import type { TenantConfig } from '@api-gateway/shared-types';
import { ProxyController } from './proxy.controller';
import { ProxyMiddleware } from './proxy.middleware';
import { ProxyService } from './proxy.service';
import { LoadBalancerService } from './load-balancer.service';
import { Http2SessionPool } from './http2-session-pool.service';
import { MetricsService } from '../metrics/metrics.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { ConfigManagerModule } from '../config-manager/config-manager.module';
import { UpstreamHealthService } from '../health/upstream-health.service';
import { JwtMiddleware } from '../auth/jwt.middleware';
import { PluginsModule } from '../plugins/plugins.module';
import { REDIS_CLIENT } from '../shared/redis.tokens';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { GatewayExceptionFilter } from '../shared/gateway-exception.filter';
import { GatewayTelemetryService } from '../telemetry/gateway-telemetry.service';

@Global()
@Module({
  providers: [{ provide: REDIS_CLIENT, useValue: {} }],
  exports: [REDIS_CLIENT],
})
class TestRedisModule {}

describe('HTTP gateway with real plugins and upstream servers', () => {
  let app: INestApplication;
  let upstream: http.Server;
  let h2upstream: http2.Http2Server;
  let jwks: http.Server;
  let pool: Http2SessionPool;
  let url: string;
  let target: string;
  let h2target: string;
  let jwksUrl: string;
  let config: TenantConfig;
  let allUnhealthy = false;
  let received: Array<{
    body: string;
    url: string;
    headers: http.IncomingHttpHeaders;
  }>;
  let mode: { status: number; failOnce: boolean };
  const rateLimit = {
    check: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: null }),
  };
  const metrics = {
    incrementDownstreamTimeout: jest.fn(),
    incrementProxyRetry: jest.fn(),
  };
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  async function listen(
    server: http.Server | http2.Http2Server,
  ): Promise<string> {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server');
    return `http://127.0.0.1:${address.port}`;
  }

  async function upload(
    chunks: Buffer[],
    headers: Record<string, string> = {},
  ) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `${url}/api`,
        { method: 'POST', headers },
        (res) => {
          const body: Buffer[] = [];
          res.on('data', (chunk) => body.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(body).toString(),
            }),
          );
        },
      );
      req.on('error', reject);
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });
  }

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const entry = {
          body: Buffer.concat(chunks).toString('base64'),
          url: req.url ?? '',
          headers: req.headers,
        };
        received.push(entry);
        res.statusCode =
          mode.failOnce && received.length === 1 ? 502 : mode.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(entry));
      });
    });
    target = await listen(upstream);
    h2upstream = http2.createServer();
    h2upstream.on('stream', (stream) => {
      stream.respond({ ':status': 200, 'x-upstream': 'remove-me' });
      stream.end('h2-body');
    });
    h2target = await listen(h2upstream);
    jwks = http.createServer((_, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          keys: [
            { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key' },
          ],
        }),
      );
    });
    jwksUrl = await listen(jwks);
    const module = await Test.createTestingModule({
      imports: [TestRedisModule, ConfigManagerModule, PluginsModule],
      controllers: [ProxyController],
      providers: [
        ProxyService,
        ProxyMiddleware,
        LoadBalancerService,
        Http2SessionPool,
        JwtMiddleware,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({
                jwt: { secret: 'test-secret-with-more-than-32-characters' },
                rateLimit: { windowMs: 60000, authMax: 500, unauthMax: 100 },
              })[key as 'jwt' | 'rateLimit'],
          },
        },
        { provide: MetricsService, useValue: metrics },
        {
          provide: UpstreamHealthService,
          useValue: {
            getHealthyUrls: (targets: Array<{ url: string }>) =>
              new Set(allUnhealthy ? [] : targets.map((t) => t.url)),
          },
        },
        {
          provide: GatewayTelemetryService,
          useValue: { sendError: jest.fn() },
        },
        { provide: APP_FILTER, useClass: GatewayExceptionFilter },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        RateLimitService,
      ],
    })
      .overrideProvider(GatewayConfigManagerService)
      .useValue({ getConfig: () => config, getTenantId: () => 'tenant' })
      .overrideProvider(RateLimitService)
      .useValue(rateLimit)
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    const jwt = module.get(JwtMiddleware);
    app.use(jwt.use.bind(jwt));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    pool = module.get(Http2SessionPool);
  });

  beforeEach(() => {
    allUnhealthy = false;
    received = [];
    mode = { status: 200, failOnce: false };
    rateLimit.check.mockClear();
    metrics.incrementProxyRetry.mockClear();
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
          name: 'test',
          targets: [{ url: target, weight: 1 }],
          timeoutMs: 1000,
          healthCheckPath: '/health',
        },
      ],
      consumers: [],
      rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
    };
  });

  it('returns normalized unavailable without touching failed peers, unless fallback is enabled', async () => {
    allUnhealthy = true;
    let response = await fetch(`${url}/api`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'NO_HEALTHY_TARGETS',
      requestId: expect.any(String),
    });
    expect(received).toHaveLength(0);
    config.services[0].unhealthyFallback = true;
    response = await fetch(`${url}/api`);
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  afterAll(async () => {
    pool?.destroyAll();
    await app?.close();
    for (const server of [upstream, jwks]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await new Promise<void>((resolve) => h2upstream.close(() => resolve()));
  });

  it('rejects oversized chunked uploads without any upstream request', async () => {
    config.routes[0].plugins = [
      { name: 'request-size-limit', config: { maxBodyBytes: 8 } },
    ];
    const result = await upload([Buffer.from('12345'), Buffer.from('67890')]);
    expect(result.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it('replays accepted chunked binary bodies byte for byte', async () => {
    config.routes[0].plugins = [
      { name: 'request-size-limit', config: { maxBodyBytes: 8 } },
    ];
    const bytes = Buffer.from([0, 255, 1, 254]);
    const result = await upload([bytes]);
    expect(result.status).toBe(200);
    expect(received[0].body).toBe(bytes.toString('base64'));
  });

  it('rejects oversized declared lengths without reaching upstream', async () => {
    config.routes[0].plugins = [
      { name: 'request-size-limit', config: { maxBodyBytes: 8 } },
    ];
    expect(
      (await upload([Buffer.alloc(10)], { 'content-length': '10' })).status,
    ).toBe(413);
    expect(received).toHaveLength(0);
  });

  it('resolves authenticated GET preflight before auth and rate limiting', async () => {
    config.routes[0].method = 'GET';
    config.routes[0].authRequired = true;
    config.routes[0].plugins = [
      { name: 'cors', config: { origins: ['https://app.example.test'] } },
    ];
    const response = await fetch(`${url}/api`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.test',
        'access-control-request-method': 'GET',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://app.example.test',
    );
    expect(rateLimit.check).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it('does not accept spoofed forwarding headers for IP allowlists', async () => {
    config.routes[0].plugins = [
      { name: 'ip-restriction', config: { allow: ['203.0.113.0/24'] } },
    ];
    const response = await fetch(`${url}/api`, {
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    expect(response.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('authenticates basic credentials on authRequired routes', async () => {
    config.routes[0].authRequired = true;
    config.routes[0].plugins = [
      {
        name: 'basic-auth',
        config: {
          credentials: [
            {
              username: 'client',
              passwordHash: createHash('sha256')
                .update('password')
                .digest('hex'),
            },
          ],
        },
      },
    ];
    expect((await fetch(`${url}/api`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api`, {
          headers: {
            authorization: `Basic ${Buffer.from('client:password').toString('base64')}`,
          },
        })
      ).status,
    ).toBe(200);
    expect(received).toHaveLength(1);
  });

  it('authenticates OIDC through a real JWKS endpoint before authRequired', async () => {
    config.routes[0].authRequired = true;
    config.routes[0].plugins = [
      {
        name: 'oidc',
        config: {
          jwksUri: jwksUrl,
          issuer: 'https://issuer.example.test',
          audience: 'nova-api',
        },
      },
    ];
    const token = sign({ sub: 'auth0|external-subject' }, keys.privateKey, {
      algorithm: 'RS256',
      keyid: 'test-key',
      issuer: 'https://issuer.example.test',
      audience: 'nova-api',
      expiresIn: 60,
    });
    expect(
      (
        await fetch(`${url}/api`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    expect(received).toHaveLength(1);
  });

  it('forwards modified query parameters and headers', async () => {
    config.routes[0].plugins = [
      {
        name: 'request-transform',
        config: {
          addQueryParams: { added: 'yes' },
          removeQueryParams: ['remove'],
          addHeaders: { 'x-injected': 'value' },
        },
      },
    ];
    expect((await fetch(`${url}/api?remove=x&keep=y`)).status).toBe(200);
    expect(received[0].url).toBe('/?keep=y&added=yes');
    expect(received[0].headers['x-injected']).toBe('value');
  });

  it('automatically applies GraphQL route depth policy', async () => {
    config.routes[0].graphql = { maxDepth: 2 };
    const response = await fetch(`${url}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ a { b { c } } }' }),
    });
    expect(response.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it('sends POST errors without suppressing the response for an unsafe retry', async () => {
    config.routes[0].retry = { attempts: 2, on: [502], methods: ['POST'] };
    mode.status = 502;
    expect((await upload([Buffer.from('body')])).status).toBe(502);
    expect(received).toHaveLength(1);
  });

  it('recovers a GET from a transient upstream 502', async () => {
    config.routes[0].retry = { attempts: 2, on: [502], methods: ['GET'] };
    mode.failOnce = true;
    expect((await fetch(`${url}/api`)).status).toBe(200);
    expect(received).toHaveLength(2);
    expect(metrics.incrementProxyRetry).toHaveBeenCalledTimes(1);
  });

  it('runs HTTP/2 response transforms before committing headers and body', async () => {
    config.services[0].h2 = true;
    config.services[0].targets = [{ url: h2target, weight: 1 }];
    config.routes[0].plugins = [
      {
        name: 'response-transform',
        config: {
          addHeaders: { 'x-transformed': 'yes' },
          removeHeaders: ['x-upstream'],
          statusOverride: 201,
        },
      },
    ];
    const response = await fetch(`${url}/api`);
    expect(response.status).toBe(201);
    expect(response.headers.get('x-transformed')).toBe('yes');
    expect(response.headers.get('x-upstream')).toBeNull();
    expect(await response.text()).toBe('h2-body');
  });
});
