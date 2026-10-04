import { EventEmitter } from 'events';
import * as net from 'net';
import type * as http from 'http';
import { WsProxyService } from './ws-proxy.service';
import { LoadBalancerService } from './load-balancer.service';
import type { TenantConfig } from '@api-gateway/shared-types';

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn().mockReturnValue({
    upgrade: jest.fn(),
  }),
}));

const BASE_CONFIG: TenantConfig = {
  routes: [
    {
      id: 'ws-route',
      method: 'GET',
      pathPattern: '/ws',
      serviceId: 'svc-1',
      authRequired: false,
      enabled: true,
    },
  ],
  services: [
    {
      id: 'svc-1',
      name: 'ws-service',
      targets: [{ url: 'http://ws-downstream:4000', weight: 100 }],
      healthCheckPath: '/health',
      timeoutMs: 5000,
      supportsWebSocket: true,
    },
  ],
  consumers: [],
  rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
};

function makeSocket() {
  const emitter = new EventEmitter();
  const writtenData: string[] = [];
  let isDestroyed = false;

  Object.defineProperty(emitter, 'destroyed', {
    get: () => isDestroyed,
    configurable: true,
  });

  Object.assign(emitter, {
    writtenData,
    write(data: string) {
      writtenData.push(data);
      return true;
    },
    destroy() {
      isDestroyed = true;
    },
  });

  return emitter as typeof emitter & {
    writtenData: string[];
    destroyed: boolean;
    destroy(): void;
  };
}

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  return {
    url,
    headers: { upgrade: 'websocket', ...headers },
    method: 'GET',
  } as unknown as http.IncomingMessage;
}

function makeService(
  configOverride?: TenantConfig,
  allDown = false,
): WsProxyService {
  const configManager = {
    getConfig: jest.fn().mockReturnValue(configOverride ?? BASE_CONFIG),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
  };
  const metrics = {
    incrementWsConnections: jest.fn(),
    decrementWsConnections: jest.fn(),
    incrementWsBytes: jest.fn(),
  };
  const loadBalancer = {
    selectTarget: jest.fn().mockReturnValue('http://ws-downstream:4000'),
  };
  const upstreamHealth = {
    getHealthyUrls: jest
      .fn()
      .mockReturnValue(new Set(allDown ? [] : ['http://ws-downstream:4000'])),
  };
  const configService = {
    get: jest
      .fn()
      .mockReturnValue({ secret: 'test-secret-longer-than-32-chars-here' }),
  };

  return new WsProxyService(
    configManager as never,
    metrics as never,
    (allDown ? new LoadBalancerService() : loadBalancer) as never,
    upstreamHealth as never,
    configService as never,
  );
}

describe('WsProxyService', () => {
  it('rejects an upgrade with unavailable when every peer has failed', () => {
    const socket = makeSocket();
    makeService(undefined, true).handleUpgrade(
      makeRequest('/ws'),
      socket as unknown as net.Socket,
      Buffer.alloc(0),
    );
    expect(socket.destroyed).toBe(true);
    expect(socket.writtenData.join('')).toContain('503');
    expect(socket.writtenData.join('')).toContain('NO_HEALTHY_TARGETS');
  });
  it('destroys socket for non-websocket upgrades', () => {
    const svc = makeService();
    const socket = makeSocket();
    const req = {
      url: '/ws',
      headers: { upgrade: 'h2c' },
    } as http.IncomingMessage;
    svc.handleUpgrade(req, socket as unknown as net.Socket, Buffer.alloc(0));
    expect(socket.destroyed).toBe(true);
  });

  it('rejects socket when config is not available', () => {
    const svc = makeService();
    (svc as never as { configManager: { getConfig: jest.Mock } })[
      'configManager'
    ].getConfig.mockReturnValueOnce(null);
    const socket = makeSocket();
    svc.handleUpgrade(
      makeRequest('/ws'),
      socket as unknown as net.Socket,
      Buffer.alloc(0),
    );
    expect(socket.destroyed).toBe(true);
    expect(socket.writtenData.some((d) => d.includes('503'))).toBe(true);
  });

  it('rejects socket when route is not found', () => {
    const svc = makeService();
    const socket = makeSocket();
    svc.handleUpgrade(
      makeRequest('/unknown-path'),
      socket as unknown as net.Socket,
      Buffer.alloc(0),
    );
    expect(socket.destroyed).toBe(true);
    expect(socket.writtenData.some((d) => d.includes('404'))).toBe(true);
  });

  it('rejects when service does not support WebSocket', () => {
    const configWithNoWs: TenantConfig = {
      ...BASE_CONFIG,
      services: [{ ...BASE_CONFIG.services[0], supportsWebSocket: false }],
    };
    const svc = makeService(configWithNoWs);
    const socket = makeSocket();
    svc.handleUpgrade(
      makeRequest('/ws'),
      socket as unknown as net.Socket,
      Buffer.alloc(0),
    );
    expect(socket.destroyed).toBe(true);
    expect(socket.writtenData.some((d) => d.includes('400'))).toBe(true);
  });

  it('rejects with 401 when route requires auth and no token is provided', () => {
    const configWithAuth: TenantConfig = {
      ...BASE_CONFIG,
      routes: [{ ...BASE_CONFIG.routes[0], authRequired: true }],
    };
    const svc = makeService(configWithAuth);
    const socket = makeSocket();
    svc.handleUpgrade(
      makeRequest('/ws'),
      socket as unknown as net.Socket,
      Buffer.alloc(0),
    );
    expect(socket.destroyed).toBe(true);
    expect(socket.writtenData.some((d) => d.includes('401'))).toBe(true);
  });

  it('calls upgrade handler and increments WS connections for valid request', () => {
    const { createProxyMiddleware } = jest.requireMock(
      'http-proxy-middleware',
    ) as { createProxyMiddleware: jest.Mock };
    const upgradeFn = jest.fn();
    createProxyMiddleware.mockReturnValue({ upgrade: upgradeFn });

    const svc = makeService();
    const socket = makeSocket();
    svc.handleUpgrade(
      makeRequest('/ws'),
      socket as unknown as net.Socket,
      Buffer.alloc(0),
    );

    expect(upgradeFn).toHaveBeenCalled();
  });
});
