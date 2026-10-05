import { Global, INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac, createHash, generateKeyPairSync } from 'crypto';
import * as http from 'http';
import * as http2 from 'http2';
import { sign } from 'jsonwebtoken';
import type { TenantConfig } from '@api-gateway/shared-types';
import { ProxyController } from './proxy.controller';
import { ProxyMiddleware } from './proxy.middleware';
import { ProxyService } from './proxy.service';
import { LoadBalancerService } from './load-balancer.service';
import { Http2SessionPool } from './http2-session-pool.service';
import { LoggingInterceptor } from '../logging/logging.interceptor';
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
  providers: [
    { provide: REDIS_CLIENT, useValue: {} },
    {
      provide: ConfigService,
      useValue: new ConfigService({
        identityProvider: { allowInsecureHttp: true },
        hmac: { maxBodyBytes: 128, bodyTimeoutMs: 200, maxPendingRequests: 1 },
      }),
    },
  ],
  exports: [REDIS_CLIENT, ConfigService],
})
class TestRedisModule {}

describe('HTTP gateway with real plugins and upstream servers', () => {
  let app: INestApplication;
  let upstream: http.Server;
  let h2upstream: http2.Http2Server;
  let jwks: http.Server;
  let pool: Http2SessionPool;
  let balancer: LoadBalancerService;
  let url: string;
  let target: string;
  let h2target: string;
  let h1Trickle: boolean;
  let h2Mode: 'normal' | 'reset' | 'stall';
  let h2Bodies: Buffer[];
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
  const telemetry = { sendError: jest.fn(), logRequest: jest.fn() };
  const metrics = {
    incrementActiveConnections: jest.fn(),
    decrementActiveConnections: jest.fn(),
    incrementHttpRequests: jest.fn(),
    observeRequestDuration: jest.fn(),
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
        if (h1Trickle) {
          const timer = setInterval(() => res.write('x'), 20);
          res.once('close', () => clearInterval(timer));
          return;
        }
        res.end(JSON.stringify(entry));
      });
    });
    target = await listen(upstream);
    h2upstream = http2.createServer();
    h2upstream.on('stream', (stream) => {
      stream.on('error', () => undefined);
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('end', () => {
        h2Bodies.push(Buffer.concat(chunks));
        if (h2Mode === 'stall') return;
        if (h2Mode === 'reset') {
          stream.close(http2.constants.NGHTTP2_CANCEL);
          return;
        }
        stream.respond({ ':status': 200, 'x-upstream': 'yes' });
        stream.end('h2-body');
      });
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
          useValue: telemetry,
        },
        { provide: APP_FILTER, useClass: GatewayExceptionFilter },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
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
    balancer = module.get(LoadBalancerService);
  });

  beforeEach(() => {
    allUnhealthy = false;
    h1Trickle = false;
    h2Mode = 'normal';
    h2Bodies = [];
    received = [];
    mode = { status: 200, failOnce: false };
    rateLimit.check.mockClear();
    for (const method of Object.values(metrics)) method.mockClear();
    telemetry.sendError.mockClear();
    telemetry.logRequest.mockClear();
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

  it.each([false, true])(
    'avoids active work and releases actual upstream reservations (h2=%s)',
    async (h2) => {
      let fastCalls = 0;
      const sessions = new Set<http2.ServerHttp2Session>();
      const fast = h2
        ? http2.createServer()
        : http.createServer((_req, res) => {
            fastCalls++;
            res.end('fast');
          });
      if (h2) {
        const server = fast as http2.Http2Server;
        server.on('session', (session) => {
          sessions.add(session);
          session.on('error', () => undefined);
        });
        server.on('stream', (stream) => {
          stream.on('error', () => undefined);
          fastCalls++;
          stream.respond({ ':status': 200 });
          stream.end('fast');
        });
      }
      const fastTarget = await listen(fast);
      const cancel = new AbortController();
      try {
        config.services[0].h2 = h2;
        config.services[0].loadBalancing = 'least-connections';
        config.services[0].targets = [
          { url: h2 ? h2target : target, weight: 1 },
          { url: fastTarget, weight: 1 },
        ];
        h1Trickle = !h2;
        h2Mode = 'stall';
        const pending = fetch(`${url}/api`, { signal: cancel.signal }).then(
          (response) => response.text(),
        );
        const cancelled = expect(pending).rejects.toThrow();
        const deadline = Date.now() + 2000;
        while ((h2 ? h2Bodies.length : received.length) !== 1) {
          if (Date.now() > deadline)
            throw new Error('Busy request did not reach upstream');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(balancer.activeReservations).toBe(1);
        const response = await fetch(`${url}/api`);
        expect(await response.text()).toBe('fast');
        expect(fastCalls).toBe(1);
        cancel.abort();
        await cancelled;
        const releasedBy = Date.now() + 2000;
        while (balancer.activeReservations) {
          if (Date.now() > releasedBy)
            throw new Error('Target reservation did not release');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        h1Trickle = false;
        h2Mode = 'normal';
        for (let i = 0; i < 2; i++) await (await fetch(`${url}/api`)).text();
        expect(h2 ? h2Bodies.length : received.length).toBe(2);
      } finally {
        cancel.abort();
        for (const session of sessions) session.destroy();
        if (!h2) (fast as http.Server).closeAllConnections();
        await new Promise<void>((resolve) => fast.close(() => resolve()));
      }
    },
  );
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
  it('falls back before dispatch and sends a binary POST exactly once through HTTP/1', async () => {
    config.services[0].h2 = true;
    config.routes[0].plugins = [
      {
        name: 'response-transform',
        config: { addHeaders: { 'x-fallback': 'verified' } },
      },
    ];
    const bytes = Buffer.from([0, 255, 13, 10, 1, 32]);
    const response = await fetch(`${url}/api?hello=world`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-fallback')).toBe('verified');
    expect(received).toHaveLength(1);
    expect(received[0].body).toBe(bytes.toString('base64'));
    expect(received[0].url).toBe('/?hello=world');
  });
  it('enforces the remaining absolute deadline when HTTP/1 fallback continuously streams', async () => {
    config.services[0].h2 = true;
    config.services[0].timeoutMs = 150;
    h1Trickle = true;
    const started = Date.now();
    const response = await fetch(`${url}/api`, {
      signal: AbortSignal.timeout(1000),
    });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(600);
    expect(received).toHaveLength(1);
  });
  it('never falls back or retries a POST after an HTTP/2 application stream was dispatched', async () => {
    config.services[0].h2 = true;
    config.services[0].targets = [{ url: h2target, weight: 1 }];
    config.routes[0].retry = { attempts: 2, on: [502], methods: ['POST'] };
    h2Mode = 'reset';
    const response = await fetch(`${url}/api`, {
      method: 'POST',
      body: 'mutation',
    });
    expect(response.status).toBe(502);
    expect(h2Bodies).toEqual([Buffer.from('mutation')]);
    expect(received).toHaveLength(0);
    expect(metrics.incrementProxyRetry).not.toHaveBeenCalled();
  });
  it('maps an absolute HTTP/2 deadline to 504 with the normalized request ID', async () => {
    config.services[0].h2 = true;
    config.services[0].timeoutMs = 100;
    config.services[0].targets = [{ url: h2target, weight: 1 }];
    h2Mode = 'stall';
    const response = await fetch(`${url}/api`);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: 'DOWNSTREAM_TIMEOUT',
      requestId: expect.any(String),
    });
    expect(metrics.incrementDownstreamTimeout).toHaveBeenCalledWith(
      config.services[0].name,
    );
    expect(received).toHaveLength(0);
  });
  it('cancels HTTP provider verification when the client disconnects', async () => {
    let started!: () => void;
    let closed!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const provider = http.createServer((req) => {
      req.socket.once('close', closed);
      started();
    });
    const endpoint = await listen(provider);
    try {
      config.routes[0].authRequired = true;
      config.routes[0].plugins = [
        { name: 'oidc', config: { jwksUri: endpoint, issuer: 'issuer' } },
      ];
      const token = sign({ sub: 'external' }, keys.privateKey, {
        algorithm: 'RS256',
        issuer: 'issuer',
        keyid: 'pending',
        expiresIn: 300,
      });
      const client = http.get(`${url}/api`, {
        headers: { authorization: `Bearer ${token}` },
      });
      client.on('error', () => {
        /* Deliberate disconnect. */
      });
      await pending;
      client.destroy();
      await Promise.race([
        cancelled,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Provider connection was not cancelled')),
            1000,
          );
          cancelled.then(() => clearTimeout(timer));
        }),
      ]);
      expect(received).toHaveLength(0);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
  it('never forwards unchecked certificate assertions on ordinary HTTP routes', async () => {
    const response = await fetch(`${url}/api`, {
      headers: {
        ssl_client_cert: 'copied-public-certificate',
        ssl_client_verify: 'SUCCESS',
        'x-ssl-client-subject': 'administrator',
        'x-ssl-client-fingerprint': 'spoofed',
      },
    });
    expect(response.status).toBe(200);
    for (const name of [
      'ssl_client_cert',
      'ssl_client_verify',
      'x-ssl-client-subject',
      'x-ssl-client-fingerprint',
    ])
      expect(received[0].headers[name]).toBeUndefined();
  });
  function webhook(mode: 'generic' | 'stripe' = 'stripe') {
    config.routes[0].authRequired = true;
    config.routes[0].plugins = [
      {
        name: 'hmac-auth',
        config: {
          mode,
          header: 'stripe-signature',
          algorithm: 'sha256',
          secrets: ['old-secret', 'fixture-secret'],
        },
      },
    ];
  }
  function webhookSignature(
    body: Buffer,
    timestamp = Math.floor(Date.now() / 1000),
  ): string {
    return `t=${timestamp},v1=${createHmac('sha256', 'fixture-secret').update(`${timestamp}.`).update(body).digest('hex')}`;
  }
  it('authenticates Stripe binary chunked bytes and forwards them unchanged exactly once', async () => {
    webhook();
    const body = Buffer.from([0, 255, 128, 13, 10, 32, 123, 125]);
    expect(
      (
        await upload([body.subarray(0, 3), body.subarray(3)], {
          'stripe-signature': webhookSignature(body),
        })
      ).status,
    ).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].body).toBe(body.toString('base64'));
    expect(received[0].headers['content-length']).toBe(String(body.length));
    expect(received[0].headers['transfer-encoding']).toBeUndefined();
  });
  it('rejects tampered or stale Stripe deliveries without contacting upstream', async () => {
    webhook();
    const body = Buffer.from('{ "event": "fixture" }');
    for (const sig of [
      webhookSignature(body),
      webhookSignature(
        Buffer.from('changed'),
        Math.floor(Date.now() / 1000) - 600,
      ),
    ])
      expect(
        (await upload([Buffer.from('changed')], { 'stripe-signature': sig }))
          .status,
      ).toBe(401);
    expect(received).toHaveLength(0);
  });
  it('rejects oversized chunked signed uploads before upstream and retains admission', async () => {
    webhook();
    const body = Buffer.alloc(129, 1);
    expect(
      (
        await upload([body.subarray(0, 64), body.subarray(64)], {
          'stripe-signature': webhookSignature(body),
        })
      ).status,
    ).toBe(413);
    expect(received).toHaveLength(0);
    const next = Buffer.from('next');
    expect(
      (await upload([next], { 'stripe-signature': webhookSignature(next) }))
        .status,
    ).toBe(200);
  });
  it('times out a stalled HTTP upload and accepts a subsequent delivery', async () => {
    webhook();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${url}/api`,
        {
          method: 'POST',
          headers: {
            'stripe-signature': webhookSignature(Buffer.from('x')),
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          res.once('end', () => {
            req.destroy();
            resolve(res.statusCode ?? 0);
          });
        },
      );
      req.once('error', reject);
      req.write('x');
    });
    expect(status).toBe(408);
    expect(received).toHaveLength(0);
    const next = Buffer.from('next');
    expect(
      (await upload([next], { 'stripe-signature': webhookSignature(next) }))
        .status,
    ).toBe(200);
  });

  it('prepares bounded signed bytes before earlier size and GraphQL body hooks while preserving policy order', async () => {
    webhook();
    config.routes[0].graphql = { maxDepth: 3 };
    config.routes[0].plugins?.unshift(
      { name: 'request-size-limit', config: { maxBodyBytes: 256 } },
      { name: 'graphql-guard', config: {} },
    );
    const body = Buffer.alloc(129, 32);
    expect(
      (
        await upload([body], {
          'stripe-signature': webhookSignature(body),
          'content-type': 'application/json',
        })
      ).status,
    ).toBe(413);
    expect(received).toHaveLength(0);
    const valid = Buffer.from('{"query":"{ hello }"}');
    expect(
      (
        await upload([valid], {
          'stripe-signature': webhookSignature(valid),
          'content-type': 'application/json',
        })
      ).status,
    ).toBe(200);
    expect(received[0].body).toBe(valid.toString('base64'));
  });
  it('blocks GraphQL GET fragment depth and later transformed query bypasses before upstream', async () => {
    config.routes[0].graphql = { maxDepth: 2 };
    const query = '{ root { ...A } } fragment A on Node { child { value } }';
    expect(
      (await fetch(`${url}/api?query=${encodeURIComponent(query)}`)).status,
    ).toBe(400);
    config.routes[0].plugins = [
      { name: 'graphql-guard', config: { maxDepth: 2 } },
      { name: 'request-transform', config: { addQueryParams: { query } } },
    ];
    expect(
      (await fetch(`${url}/api?query=${encodeURIComponent('{ user { id } }')}`))
        .status,
    ).toBe(400);
    expect(received).toHaveLength(0);
  });
  it('preserves GraphQL POST bytes through the shared body capture and HMAC verifier', async () => {
    config.routes[0].graphql = null;
    config.routes[0].authRequired = true;
    const body = Buffer.from(
      '{  "query": "{ user { id } }", "variables": {} }',
    );
    const sig = createHmac('sha256', 'fixture-secret')
      .update(body)
      .digest('hex');
    config.routes[0].plugins = [
      { name: 'graphql-guard', config: { maxDepth: 3 } },
      { name: 'request-size-limit', config: { maxBodyBytes: 128 } },
      {
        name: 'hmac-auth',
        config: {
          header: 'x-signature',
          algorithm: 'sha256',
          secrets: ['fixture-secret'],
        },
      },
    ];
    expect(
      (
        await upload([body.subarray(0, 10), body.subarray(10)], {
          'content-type': 'application/json',
          'x-signature': sig,
        })
      ).status,
    ).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].body).toBe(body.toString('base64'));
  });
  it('rejects unsupported GraphQL payloads, GET mutations and duplicate configured policies before upstream', async () => {
    config.routes[0].graphql = {};
    expect(
      (
        await fetch(
          `${url}/api?query=${encodeURIComponent('mutation { update }')}`,
        )
      ).status,
    ).toBe(405);
    for (const payload of [
      '[]',
      '{"extensions":{"persistedQuery":{"sha256Hash":"fixture"}}}',
      '{"query":"{"}',
    ])
      expect(
        (
          await upload([Buffer.from(payload)], {
            'content-type': 'application/json',
          })
        ).status,
      ).toBe(400);
    config.routes[0].plugins = [
      { name: 'graphql-guard', config: {} },
      { name: 'graphql-guard', config: {} },
    ];
    expect(
      (await fetch(`${url}/api?query=${encodeURIComponent('{ a }')}`)).status,
    ).toBe(500);
    expect(received).toHaveLength(0);
  });
  it('keeps GraphQL query/header payloads out of request/error telemetry and normalized metric labels', async () => {
    const marker = 'private-query-marker';
    config.routes[0].graphql = {};
    const query = `{ user(name: "${marker}") { id } }`;
    const response = await fetch(
      `${url}/api?query=${encodeURIComponent(query)}`,
      { headers: { 'x-request-id': marker, 'user-agent': marker } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(telemetry.logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api' }),
    );
    expect(JSON.stringify(telemetry.logRequest.mock.calls)).not.toContain(
      marker,
    );
    expect(metrics.incrementHttpRequests).toHaveBeenCalledWith(
      'GET',
      '/api',
      200,
    );
    config.routes[0].plugins = [
      { name: 'graphql-guard', config: {} },
      { name: 'graphql-guard', config: {} },
    ];
    expect(
      (await fetch(`${url}/api?query=${encodeURIComponent(query)}`)).status,
    ).toBe(500);
    expect(telemetry.sendError).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api',
        errorCode: 'PLUGIN_CONFIG_INVALID',
      }),
    );
    expect(JSON.stringify(telemetry.sendError.mock.calls)).not.toContain(
      marker,
    );
  });
});
