import { Test } from '@nestjs/testing';
import { EventEmitter } from 'events';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { Options } from 'http-proxy-middleware/dist/types';
import { ProxyService } from './proxy.service';
import { ProxyMiddleware } from './proxy.middleware';
import { MetricsService } from '../metrics/metrics.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { LoadBalancerService } from './load-balancer.service';
import { UpstreamHealthService } from '../health/upstream-health.service';
import type { TenantConfig } from '@api-gateway/shared-types';
import type { RequestWithUser, ResponseWithLocals } from '../shared/request-context';

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
}));

type ProxyHandler = ReturnType<typeof createProxyMiddleware>;

class MockResponse extends EventEmitter implements Partial<ResponseWithLocals> {
  locals: ResponseWithLocals['locals'] = {};
  statusCode = 200;
  headersSent = false;
  private headers: Record<string, string> = {};

  setHeader(name: string, value: string): this {
    this.headersSent = true;
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(body: unknown): this {
    this.headersSent = true;
    this.emit('finish');
    return this;
  }
  end(body?: string): this {
    if (!this.headersSent) this.headersSent = true;
    this.emit('finish');
    return this;
  }
  once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener) as this;
  }
  off(event: string, listener: (...args: any[]) => void): this {
    return super.off(event, listener) as this;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

const SERVICE_ID = 'svc-1';
const TENANT_CONFIG: TenantConfig = {
  routes: [
    {
      id: 'route-1',
      method: 'GET',
      pathPattern: '/service',
      serviceId: SERVICE_ID,
      authRequired: false,
      enabled: true,
    },
  ],
  services: [
    {
      id: SERVICE_ID,
      name: 'test-service',
      targets: [{ url: 'http://downstream', weight: 100 }],
      healthCheckPath: '/health',
      timeoutMs: 1000,
    },
  ],
  consumers: [],
  rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
};

const mockConfigManager = () => ({
  getConfig: jest.fn().mockReturnValue(TENANT_CONFIG),
});

const mockMetrics = () => ({
  incrementDownstreamTimeout: jest.fn(),
  incrementProxyRetry: jest.fn(),
});

const mockLoadBalancer = () => ({
  selectTarget: jest.fn().mockReturnValue('http://downstream'),
});

const mockUpstreamHealth = () => ({
  getHealthyUrls: jest.fn().mockReturnValue(new Set(['http://downstream'])),
});

async function buildModule() {
  const module = await Test.createTestingModule({
    providers: [
      ProxyService,
      ProxyMiddleware,
      { provide: GatewayConfigManagerService, useValue: mockConfigManager() },
      { provide: MetricsService, useValue: mockMetrics() },
      { provide: LoadBalancerService, useValue: mockLoadBalancer() },
      { provide: UpstreamHealthService, useValue: mockUpstreamHealth() },
    ],
  }).compile();

  return {
    proxyService: module.get(ProxyService),
    proxyMiddleware: module.get(ProxyMiddleware),
  };
}

describe('ProxyService', () => {
  beforeEach(() => {
    (createProxyMiddleware as jest.Mock).mockReset();
  });

  it('forwards GET request to the matching downstream target', async () => {
    const handler: ProxyHandler = jest.fn((req, res, next) => {
      const options = (createProxyMiddleware as jest.Mock).mock.calls[0][0] as Options;
      const proxyReq = { setHeader: jest.fn() };
      options.on?.proxyReq?.(proxyReq as any, req, res as any);

      const proxyRes = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        pipe: (target: MockResponse) => {
          target.end('{}');
        },
        resume: jest.fn(),
      };
      options.on?.proxyRes?.(proxyRes as any, req, res as any);
    });
    (createProxyMiddleware as jest.Mock).mockReturnValue(handler);

    const { proxyService } = await buildModule();
    const req = {
      headers: {},
      originalUrl: '/service/hello',
      url: '/service/hello',
      baseUrl: '',
      method: 'GET',
      path: '/service/hello',
    } as RequestWithUser;
    const res = new MockResponse();

    await proxyService.forward(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect((handler as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 502 when downstream responds with 5xx', async () => {
    const handler: ProxyHandler = jest.fn((req, res, next) => {
      const options = (createProxyMiddleware as jest.Mock).mock.calls[0][0] as Options;
      const proxyRes = {
        statusCode: 500,
        headers: {},
        pipe: jest.fn(),
        resume: jest.fn(),
      };
      options.on?.proxyRes?.(proxyRes as any, req, res as any);
    });
    (createProxyMiddleware as jest.Mock).mockReturnValue(handler);

    const { proxyService } = await buildModule();
    const req = {
      headers: { 'x-request-id': 'req-1' },
      originalUrl: '/service/error',
      url: '/service/error',
      baseUrl: '',
      method: 'GET',
      path: '/service/error',
    } as RequestWithUser;
    const res = new MockResponse();

    await proxyService.forward(req as any, res as any);

    expect(res.statusCode).toBe(502);
  });

  it('returns 504 on ETIMEDOUT proxy error', async () => {
    const handler: ProxyHandler = jest.fn((req, res, next) => {
      const options = (createProxyMiddleware as jest.Mock).mock.calls[0][0] as Options;
      const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      options.on?.error?.(error, req, res as any);
    });
    (createProxyMiddleware as jest.Mock).mockReturnValue(handler);

    const { proxyService } = await buildModule();
    const req = {
      headers: { 'x-request-id': 'req-2' },
      originalUrl: '/service/slow',
      url: '/service/slow',
      baseUrl: '',
      method: 'GET',
      path: '/service/slow',
    } as RequestWithUser;
    const res = new MockResponse();

    await proxyService.forward(req as any, res as any);

    expect(res.statusCode).toBe(504);
  });

  it('retries on 502 when route has retry config', async () => {
    const configWithRetry: TenantConfig = {
      ...TENANT_CONFIG,
      routes: [
        {
          ...TENANT_CONFIG.routes[0],
          retry: { attempts: 1, on: [502], methods: ['GET'] },
        },
      ],
    };
    let callCount = 0;

    const handler: ProxyHandler = jest.fn((req, res, next) => {
      const options = (createProxyMiddleware as jest.Mock).mock.calls[
        (createProxyMiddleware as jest.Mock).mock.calls.length - 1
      ][0] as Options;
      callCount++;
      if (callCount === 1) {
        // First attempt: simulate 502
        const proxyRes = { statusCode: 502, headers: {}, pipe: jest.fn(), resume: jest.fn() };
        options.on?.proxyRes?.(proxyRes as any, req, res as any);
      } else {
        // Second attempt: success
        const proxyRes = { statusCode: 200, headers: {}, pipe: (r: any) => r.end('ok'), resume: jest.fn() };
        options.on?.proxyRes?.(proxyRes as any, req, res as any);
      }
    });
    (createProxyMiddleware as jest.Mock).mockReturnValue(handler);

    const module = await Test.createTestingModule({
      providers: [
        ProxyService,
        ProxyMiddleware,
        { provide: GatewayConfigManagerService, useValue: { getConfig: jest.fn().mockReturnValue(configWithRetry) } },
        { provide: MetricsService, useValue: mockMetrics() },
        { provide: LoadBalancerService, useValue: mockLoadBalancer() },
        { provide: UpstreamHealthService, useValue: mockUpstreamHealth() },
      ],
    }).compile();

    const proxyService = module.get(ProxyService);
    const req = {
      headers: {},
      originalUrl: '/service/retry',
      url: '/service/retry',
      baseUrl: '',
      method: 'GET',
      path: '/service/retry',
    } as RequestWithUser;
    const res = new MockResponse();

    await proxyService.forward(req as any, res as any);

    expect(callCount).toBe(2);
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when no route matches', async () => {
    const { proxyService } = await buildModule();
    const req = {
      headers: {},
      originalUrl: '/unknown',
      url: '/unknown',
      baseUrl: '',
      method: 'GET',
      path: '/unknown',
    } as RequestWithUser;
    const res = new MockResponse();

    await expect(proxyService.forward(req as any, res as any)).rejects.toMatchObject({
      code: 'SERVICE_NOT_FOUND',
    });
  });
});
