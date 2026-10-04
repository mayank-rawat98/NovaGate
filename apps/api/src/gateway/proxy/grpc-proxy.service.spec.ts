import {
  parseGrpcPath,
  isGrpcRequest,
  GrpcProxyService,
} from './grpc-proxy.service';
import { LoadBalancerService } from './load-balancer.service';
import type { TenantConfig } from '@api-gateway/shared-types';

// Mock http2 module entirely so tests don't open real network connections
jest.mock('http2', () => ({
  connect: jest.fn().mockReturnValue({
    destroyed: false,
    remoteSettings: { maxConcurrentStreams: 100 },
    request: jest.fn(),
    on: jest.fn(),
    destroy: jest.fn(),
  }),
}));

const BASE_CONFIG: TenantConfig = {
  routes: [
    {
      id: 'grpc-route',
      method: 'POST',
      pathPattern: '/helloworld.Greeter/SayHello',
      serviceId: 'grpc-svc',
      authRequired: false,
      enabled: true,
    },
  ],
  services: [
    {
      id: 'grpc-svc',
      name: 'greeter',
      targets: [{ url: 'http://grpc-downstream:50051', weight: 100 }],
      healthCheckPath: '/health',
      timeoutMs: 5000,
    },
  ],
  consumers: [],
  rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
};

function makeService(allDown = false): GrpcProxyService {
  const configManager = {
    getConfig: jest.fn().mockReturnValue(BASE_CONFIG),
  };
  const metrics = {
    incrementGrpcRequests: jest.fn(),
  };
  const loadBalancer = {
    selectTarget: jest.fn().mockReturnValue('http://grpc-downstream:50051'),
  };
  const upstreamHealth = {
    getHealthyUrls: jest
      .fn()
      .mockReturnValue(
        new Set(allDown ? [] : ['http://grpc-downstream:50051']),
      ),
  };
  return new GrpcProxyService(
    configManager as never,
    metrics as never,
    (allDown ? new LoadBalancerService() : loadBalancer) as never,
    upstreamHealth as never,
  );
}

describe('parseGrpcPath', () => {
  it('parses standard gRPC path', () => {
    expect(parseGrpcPath('/helloworld.Greeter/SayHello')).toEqual({
      grpcService: 'helloworld.Greeter',
      grpcMethod: 'SayHello',
    });
  });

  it('handles short paths gracefully', () => {
    expect(parseGrpcPath('/Service')).toEqual({
      grpcService: 'Service',
      grpcMethod: 'unknown',
    });
  });

  it('returns unknown for empty path', () => {
    expect(parseGrpcPath('/')).toEqual({
      grpcService: 'unknown',
      grpcMethod: 'unknown',
    });
  });
});

describe('isGrpcRequest', () => {
  it('returns true for application/grpc', () => {
    expect(isGrpcRequest({ 'content-type': 'application/grpc' })).toBe(true);
  });

  it('returns true for application/grpc+proto', () => {
    expect(isGrpcRequest({ 'content-type': 'application/grpc+proto' })).toBe(
      true,
    );
  });

  it('returns false for application/json', () => {
    expect(isGrpcRequest({ 'content-type': 'application/json' })).toBe(false);
  });

  it('returns false when content-type is absent', () => {
    expect(isGrpcRequest({})).toBe(false);
  });

  it('handles content-type with extra parameters', () => {
    expect(
      isGrpcRequest({
        'content-type': 'application/grpc+proto; charset=utf-8',
      }),
    ).toBe(true);
  });
});

describe('GrpcProxyService.proxyStream', () => {
  it('calls sendResponse with gRPC error status when config is unavailable', async () => {
    const svc = makeService();
    (svc as never as { configManager: { getConfig: jest.Mock } })[
      'configManager'
    ].getConfig.mockReturnValueOnce(null);

    const sendResponse = jest.fn();
    await svc.proxyStream(
      {
        ':path': '/svc/method',
        ':method': 'POST',
        'content-type': 'application/grpc',
      },
      Buffer.alloc(0),
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'grpc-status': '14' }),
      expect.any(Buffer),
      expect.anything(),
    );
  });

  it('calls sendResponse with error when route is not found', async () => {
    const svc = makeService();
    const sendResponse = jest.fn();
    await svc.proxyStream(
      {
        ':path': '/unknown/method',
        ':method': 'POST',
        'content-type': 'application/grpc',
      },
      Buffer.alloc(0),
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'grpc-status': '12' }),
      expect.any(Buffer),
      expect.anything(),
    );
  });

  it('records gRPC metrics on successful proxy', async () => {
    const http2 = jest.requireMock('http2') as { connect: jest.Mock };

    const endFn = jest.fn();
    const mockReq = new (require('events').EventEmitter)();
    mockReq.end = endFn;

    const mockSession = {
      destroyed: false,
      remoteSettings: { maxConcurrentStreams: 100 },
      request: jest.fn().mockReturnValue(mockReq),
      on: jest.fn(),
      destroy: jest.fn(),
    };
    http2.connect.mockReturnValue(mockSession);

    const svc = makeService();
    const sendResponse = jest.fn();

    const proxyPromise = svc.proxyStream(
      {
        ':path': '/helloworld.Greeter/SayHello',
        ':method': 'POST',
        'content-type': 'application/grpc',
      },
      Buffer.from([0, 0, 0, 0, 5, 1, 2, 3, 4, 5]),
      sendResponse,
    );

    // Simulate downstream response
    process.nextTick(() => {
      mockReq.emit('response', {
        ':status': 200,
        'content-type': 'application/grpc',
      });
      mockReq.emit('trailers', { 'grpc-status': '0' });
      mockReq.emit('data', Buffer.alloc(0));
      mockReq.emit('end');
    });

    await proxyPromise;

    const metricsService = (
      svc as never as { metricsService: { incrementGrpcRequests: jest.Mock } }
    )['metricsService'];
    expect(metricsService.incrementGrpcRequests).toHaveBeenCalledWith(
      'helloworld.Greeter',
      'SayHello',
      '0',
    );
  });
});

describe('gRPC unhealthy pool', () => {
  it('returns gRPC unavailable before creating a downstream session', async () => {
    const send = jest.fn();
    await makeService(true).proxyStream(
      {
        ':path': '/helloworld.Greeter/SayHello',
        ':method': 'POST',
        'content-type': 'application/grpc',
      },
      Buffer.alloc(0),
      send,
    );
    expect(send).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'grpc-status': '14' }),
      expect.any(Buffer),
      {},
    );
  });
});
