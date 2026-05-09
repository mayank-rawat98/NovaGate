import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { Options } from 'http-proxy-middleware/dist/types';
import { ProxyService } from './proxy.service';
import { ProxyMiddleware } from './proxy.middleware';
import { MetricsService } from '../metrics/metrics.service';
import { JwtMiddleware } from '../auth/jwt.middleware';
import type { GatewayConfig, ProxyServiceConfig } from '../../config/configuration';
import type { RequestWithUser, ResponseWithLocals } from '../shared/request-context';

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
}));

const secret = 'test-secret-with-min-length-32-chars';

type ProxyHandler = ReturnType<typeof createProxyMiddleware>;

class MockResponse extends EventEmitter implements ResponseWithLocals {
  locals: ResponseWithLocals['locals'] = {};
  statusCode = 200;
  headersSent = false;
  private headers: Record<string, string> = {};
  setHeader(name: string, value: string): void {
    this.headersSent = true;
    this.headers[name.toLowerCase()] = value;
  }
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
  end(body?: string): void {
    if (!this.headersSent) {
      this.headersSent = true;
    }
    this.emit('finish');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

const createConfigService = (services: ProxyServiceConfig[], timeout = 1000) =>
  ({
    get: jest.fn().mockImplementation((key: keyof GatewayConfig) => {
      if (key === 'proxy') {
        return { timeout, services };
      }
      if (key === 'jwt') {
        return { secret };
      }
      return undefined;
    }),
  }) as unknown as ConfigService<GatewayConfig, true>;

const setupModule = async (services: ProxyServiceConfig[]) => {
  const module = await Test.createTestingModule({
    providers: [
      ProxyService,
      ProxyMiddleware,
      MetricsService,
      JwtMiddleware,
      { provide: ConfigService, useValue: createConfigService(services) },
    ],
  }).compile();

  return {
    proxyMiddleware: module.get(ProxyMiddleware),
    jwtMiddleware: module.get(JwtMiddleware),
  };
};

describe('ProxyMiddleware', () => {
  const services = [
    { name: 'test', targetUrl: 'http://downstream', pathPrefix: '/service' },
  ];

  beforeEach(() => {
    (createProxyMiddleware as jest.Mock).mockReset();
  });

  it('forwards requests and strips the prefix', async () => {
    const handler: ProxyHandler = jest.fn((req, res) => {
      const options = (createProxyMiddleware as jest.Mock).mock.calls[0][0] as Options;
      const proxyReq = { setHeader: jest.fn() };
      options.onProxyReq?.(
        proxyReq as unknown as Parameters<NonNullable<Options['onProxyReq']>>[0],
        req,
        res,
      );

      const proxyRes = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        pipe: (target: MockResponse) => {
          target.end(JSON.stringify({ ok: true, path: req.url }));
        },
        resume: jest.fn(),
      };
      options.onProxyRes?.(
        proxyRes as unknown as Parameters<NonNullable<Options['onProxyRes']>>[0],
        req,
        res,
      );
    });

    (createProxyMiddleware as jest.Mock).mockReturnValue(handler);

    const { proxyMiddleware, jwtMiddleware } = await setupModule(services);
    const req = {
      headers: {},
      originalUrl: '/service/hello',
      url: '/service/hello',
      baseUrl: '',
      method: 'GET',
      path: '/service/hello',
    } as RequestWithUser;
    const res = new MockResponse();
    const next = jest.fn();

    jwtMiddleware.use(req, res, next);
    await proxyMiddleware.handle(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('x-request-id')).toBeDefined();
    expect((handler as jest.Mock).mock.calls.length).toBe(1);
  });

  it('maps downstream 5xx to DOWNSTREAM_ERROR', async () => {
    const handler: ProxyHandler = jest.fn((req, res) => {
      const options = (createProxyMiddleware as jest.Mock).mock.calls[0][0] as Options;
      const proxyRes = {
        statusCode: 500,
        headers: {},
        pipe: () => undefined,
        resume: jest.fn(),
      };
      options.onProxyRes?.(
        proxyRes as unknown as Parameters<NonNullable<Options['onProxyRes']>>[0],
        req,
        res,
      );
    });

    (createProxyMiddleware as jest.Mock).mockReturnValue(handler);

    const { proxyMiddleware } = await setupModule(services);
    const req = {
      headers: { 'x-request-id': 'req-1' },
      originalUrl: '/service/error',
      url: '/service/error',
      baseUrl: '',
      method: 'GET',
      path: '/service/error',
    } as RequestWithUser;
    const res = new MockResponse();

    await proxyMiddleware.handle(req, res);

    expect(res.statusCode).toBe(502);
  });

  it('maps downstream timeout to DOWNSTREAM_TIMEOUT', async () => {
    const handler: ProxyHandler = jest.fn((req, res) => {
      const options = (createProxyMiddleware as jest.Mock).mock.calls[0][0] as Options;
      const error = new Error('timeout') as NodeJS.ErrnoException;
      error.code = 'ETIMEDOUT';
      options.onError?.(error, req, res);
    });

    (createProxyMiddleware as jest.Mock).mockReturnValue(handler);

    const { proxyMiddleware } = await setupModule(services);
    const req = {
      headers: { 'x-request-id': 'req-2' },
      originalUrl: '/service/slow',
      url: '/service/slow',
      baseUrl: '',
      method: 'GET',
      path: '/service/slow',
    } as RequestWithUser;
    const res = new MockResponse();

    await proxyMiddleware.handle(req, res);

    expect(res.statusCode).toBe(504);
  });
});
