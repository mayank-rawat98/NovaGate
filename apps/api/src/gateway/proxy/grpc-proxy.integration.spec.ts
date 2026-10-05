import * as http2 from 'node:http2';
import { once } from 'node:events';
import * as net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';
import type { TenantConfig } from '@api-gateway/shared-types';
import { GrpcProxyService } from './grpc-proxy.service';
import { DEFAULT_GRPC, type GrpcSettings } from '../../config/configuration';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { LoadBalancerService } from './load-balancer.service';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginRunnerService } from '../plugins/plugin-runner.service';
import { GraphqlGuardPlugin } from '../plugins/graphql-guard/graphql-guard.plugin';
import { BasicAuthPlugin } from '../plugins/basic-auth/basic-auth.plugin';
import { AclPlugin } from '../plugins/acl/acl.plugin';
import { IpRestrictionPlugin } from '../plugins/ip-restriction/ip-restriction.plugin';

const secret = 'grpc-verification-secret-at-least-32-characters';
const consumerKey = 'grpc-consumer-secret';
const frame = (text: string) => {
  const bytes = Buffer.from(text);
  const prefix = Buffer.alloc(5);
  prefix.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([prefix, bytes]);
};

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition did not converge');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('native gRPC through a real listener and upstream', () => {
  let server: http2.Http2Server;
  let balancer: LoadBalancerService;
  let gateway: GrpcProxyService;
  let manager: GatewayConfigManagerService;
  let client: http2.ClientHttp2Session;
  let config: TenantConfig;
  let version: number;
  let received: http2.IncomingHttpHeaders[];
  let mode: 'echo' | 'stall' | 'oversize' | 'early' | 'trailers-only' | 'flood';
  let closures: number;
  let floodProduced: number;
  const floodPacket = Buffer.concat(
    Array.from({ length: 256 }, () => frame('x'.repeat(60))),
  );
  const floodPackets = 512;
  let healthy: boolean;
  const quota = { check: jest.fn() };
  const metrics = {
    incrementGrpcRequests: jest.fn(),
    setGrpcActiveCalls: jest.fn(),
  };
  const upstreamSessions = new Set<http2.ServerHttp2Session>();
  function makeGateway(settings: Partial<GrpcSettings> = {}) {
    const registry = new PluginRegistryService([
      new BasicAuthPlugin(),
      new GraphqlGuardPlugin(new ConfigService({})),
      new AclPlugin(manager),
      new IpRestrictionPlugin(),
      { name: 'body-plugin', onRequest: jest.fn() },
    ]);
    return new GrpcProxyService(
      manager,
      metrics as never,
      (balancer = new LoadBalancerService()),
      {
        getHealthyUrls: () =>
          new Set(
            healthy ? config.services[0].targets.map((item) => item.url) : [],
          ),
      } as never,
      new ConfigService({
        grpc: {
          ...DEFAULT_GRPC,
          enabled: true,
          allowInsecure: true,
          port: 0,
          maxMessageBytes: 64,
          shutdownGraceMs: 20,
          ...settings,
        },
        jwt: { secret },
        rateLimit: config.rateLimit,
      }),
      quota as never,
      registry,
      new PluginRunnerService(),
    );
  }
  async function restart(settings: Partial<GrpcSettings>, ca?: Buffer) {
    client.destroy();
    await gateway.onModuleDestroy();
    gateway = makeGateway(settings);
    gateway.onModuleInit();
    await gateway.onApplicationBootstrap();
    client = http2.connect(
      `${settings.tlsCertFile ? 'https' : 'http'}://127.0.0.1:${gateway.listeningPort}`,
      ca ? { ca } : undefined,
    );
    client.on('error', () => {
      /* Cancellation is verified through stream/session closure. */
    });
    await once(client, 'connect');
  }
  async function install() {
    await manager.loadConfig('tenant', config, ++version);
  }
  function request(headers: http2.OutgoingHttpHeaders = {}, session = client) {
    const stream = session.request({
      ':method': 'POST',
      ':path': '/test.Echo/Call',
      'content-type': 'application/grpc',
      te: 'trailers',
      ...headers,
    });
    const chunks: Buffer[] = [];
    let response: http2.IncomingHttpHeaders = {};
    let trailers: http2.IncomingHttpHeaders = {};
    stream.on('response', (value) => {
      response = value;
    });
    stream.on('trailers', (value) => {
      trailers = value;
    });
    stream.on('data', (chunk) => chunks.push(chunk));
    const finished = new Promise<{
      body: Buffer;
      status: string;
      response: http2.IncomingHttpHeaders;
      trailers: http2.IncomingHttpHeaders;
    }>((resolve, reject) => {
      stream.on('error', reject);
      stream.on('end', () =>
        resolve({
          body: Buffer.concat(chunks),
          status: String(trailers['grpc-status'] ?? response['grpc-status']),
          response,
          trailers,
        }),
      );
    });
    return { stream, finished };
  }
  beforeEach(async () => {
    version = 0;
    received = [];
    closures = 0;
    floodProduced = 0;
    healthy = true;
    mode = 'echo';
    quota.check
      .mockReset()
      .mockResolvedValue({ allowed: true, retryAfterMs: null });
    metrics.incrementGrpcRequests.mockClear();
    server = http2.createServer();
    server.on('session', (session) => {
      upstreamSessions.add(session);
      session.on('error', () => {
        /* Peer cancellation is asserted through stream status and close events. */
      });
      session.once('close', () => upstreamSessions.delete(session));
    });
    server.on('stream', (stream, headers) => {
      received.push(headers);
      stream.on('error', () => {
        /* Peer cancellation is asserted through stream status and close events. */
      });
      stream.once('close', () => closures++);
      if (mode === 'stall') {
        stream.resume();
        return;
      }
      if (mode === 'trailers-only') {
        stream.respond({
          ':status': 200,
          'content-type': 'application/grpc',
          'grpc-status': '7',
          'grpc-message': 'denied',
        });
        stream.end();
        return;
      }
      stream.respond(
        {
          ':status': 200,
          'content-type': 'application/grpc',
          'x-upstream': 'yes',
        },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () =>
        stream.sendTrailers({
          'grpc-status': '0',
          'custom-result-bin': 'AQID',
        }),
      );
      if (mode === 'flood') {
        stream.resume();
        const produce = () => {
          while (
            !stream.destroyed &&
            floodProduced < floodPacket.length * floodPackets
          ) {
            floodProduced += floodPacket.length;
            if (!stream.write(floodPacket)) {
              stream.once('drain', produce);
              return;
            }
          }
          if (!stream.destroyed) stream.end();
        };
        produce();
        return;
      }
      if (mode === 'oversize') {
        stream.end(frame('x'.repeat(65)));
        return;
      }
      if (mode === 'early') {
        stream.end(frame('early'));
        return;
      }
      stream.on('data', (chunk) => stream.write(chunk));
      stream.on('end', () => stream.end());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const target = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    config = {
      routes: [
        {
          id: 'route',
          method: 'POST',
          pathPattern: '/test.Echo/Call',
          serviceId: 'service',
          authRequired: false,
          enabled: true,
        },
      ],
      services: [
        {
          id: 'service',
          name: 'echo',
          targets: [{ url: target, weight: 1 }],
          healthCheckPath: '/health',
          h2: true,
          timeoutMs: 1000,
        },
      ],
      consumers: [
        {
          id: 'consumer',
          name: 'test',
          keyHash: createHash('sha256').update(consumerKey).digest('hex'),
          rateLimitTier: 'authenticated',
          groups: ['apps'],
        },
      ],
      rateLimit: { windowMs: 60000, authMax: 100, unauthMax: 10 },
    };
    manager = new GatewayConfigManagerService({
      set: jest.fn().mockResolvedValue('OK'),
    } as never);
    await install();
    gateway = makeGateway();
    gateway.onModuleInit();
    await gateway.onApplicationBootstrap();
    client = http2.connect(`http://127.0.0.1:${gateway.listeningPort}`);
    client.on('error', () => {
      /* Peer cancellation is asserted through stream status and close events. */
    });
    await once(client, 'connect');
  });
  afterEach(async () => {
    client?.destroy();
    await gateway?.onModuleDestroy();
    for (const session of upstreamSessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('retains admission capacity while timed-out quota work is still pending', async () => {
    await restart({ maxActiveCalls: 1 });
    let release!: (value: { allowed: boolean }) => void;
    quota.check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = request({ 'grpc-timeout': '50m' });
    first.stream.end(frame('test'));
    expect((await first.finished).status).toBe('4');
    expect(metrics.setGrpcActiveCalls).toHaveBeenLastCalledWith(1);
    const rejected = request();
    rejected.stream.end(frame('test'));
    expect((await rejected.finished).status).toBe('8');
    expect(received).toHaveLength(0);
    release({ allowed: true });
    await until(() => metrics.setGrpcActiveCalls.mock.calls.at(-1)?.[0] === 0);
    const next = request();
    next.stream.end(frame('test'));
    expect((await next.finished).status).toBe('0');
  });
  it('rejects a cold upstream advertising zero stream capacity before dispatch', async () => {
    server.updateSettings({ maxConcurrentStreams: 0 });
    await restart({ maxSessionsPerTarget: 1 });
    const call = request();
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('8');
    expect(received).toHaveLength(0);
  });
  it('releases active call capacity after cancellation', async () => {
    await restart({ maxActiveCalls: 1 });
    mode = 'stall';
    const first = request();
    first.finished.catch(() => {
      /* Cancellation is verified through stream/session closure. */
    });
    first.stream.write(frame('test'));
    await until(() => received.length === 1);
    const rejected = request();
    rejected.stream.end(frame('test'));
    expect((await rejected.finished).status).toBe('8');
    first.stream.close(http2.constants.NGHTTP2_CANCEL);
    await until(() => closures === 1);
    mode = 'echo';
    const next = request();
    next.stream.end(frame('test'));
    expect((await next.finished).status).toBe('0');
  });
  it('bounds upstream sessions and reuses capacity after a cancelled stream', async () => {
    server.updateSettings({ maxConcurrentStreams: 1 });
    await restart({ maxSessionsPerTarget: 1, maxConcurrentStreams: 1 });
    const other = http2.connect(`http://127.0.0.1:${gateway.listeningPort}`);
    other.on('error', () => {
      /* Cancellation is verified through stream/session closure. */
    });
    await once(other, 'connect');
    await until(() => other.remoteSettings.maxConcurrentStreams === 1);
    try {
      mode = 'stall';
      const first = request();
      first.finished.catch(() => {
        /* Cancellation is verified through stream/session closure. */
      });
      first.stream.write(frame('test'));
      await until(() => received.length === 1);
      const rejected = request({}, other);
      rejected.stream.end(frame('test'));
      expect((await rejected.finished).status).toBe('8');
      await until(() => rejected.stream.destroyed);
      expect(upstreamSessions.size).toBe(1);
      expect(received).toHaveLength(1);
      first.stream.close(http2.constants.NGHTTP2_CANCEL);
      await until(() => closures === 1);
      mode = 'echo';
      const next = request({}, other);
      next.stream.end(frame('test'));
      expect((await next.finished).status).toBe('0');
      expect(upstreamSessions.size).toBe(1);
    } finally {
      other.destroy();
    }
  });
  it('cancels a cold connection that never sends peer settings', async () => {
    const sockets = new Set<net.Socket>();
    const blackhole = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {
        /* Cancellation is verified through stream/session closure. */
      });
      socket.once('close', () => sockets.delete(socket));
      socket.resume();
    });
    await new Promise<void>((resolve) =>
      blackhole.listen(0, '127.0.0.1', resolve),
    );
    try {
      config.services[0].targets = [
        {
          url: `http://127.0.0.1:${(blackhole.address() as net.AddressInfo).port}`,
          weight: 1,
        },
      ];
      await install();
      const call = request({ 'grpc-timeout': '100m' });
      call.stream.end(frame('test'));
      await until(() => sockets.size === 1);
      expect((await call.finished).status).toBe('4');
      await until(() => sockets.size === 0);
      expect(metrics.setGrpcActiveCalls).toHaveBeenLastCalledWith(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => blackhole.close(() => resolve()));
    }
  });
  it('serves native gRPC over verified TLS and rejects an untrusted listener certificate', async () => {
    const artifacts = resolve(__dirname, '../../../../..', '.local-work');
    mkdirSync(artifacts, { recursive: true });
    const directory = mkdtempSync(resolve(artifacts, 'grpc-tls-'));
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
      await restart(
        { tlsCertFile: cert, tlsKeyFile: key, allowInsecure: false },
        readFileSync(cert),
      );
      const call = request();
      call.stream.end(frame('encrypted'));
      expect((await call.finished).status).toBe('0');
      expect(client.alpnProtocol).toBe('h2');
      const untrusted = http2.connect(
        `https://127.0.0.1:${gateway.listeningPort}`,
      );
      try {
        const failure = await new Promise<Error>((resolve) =>
          untrusted.once('error', resolve),
        );
        expect(failure.message).toMatch(/self-signed|certificate/i);
        expect(received).toHaveLength(1);
      } finally {
        untrusted.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('reuses a frontend session configured for one concurrent stream', async () => {
    await restart({ maxConcurrentStreams: 1 });
    await until(() => client.remoteSettings.maxConcurrentStreams === 1);
    for (let index = 0; index < 3; index++) {
      const call = request();
      call.stream.end(frame('test'));
      expect((await call.finished).status).toBe('0');
      await until(() => call.stream.destroyed);
    }
  });
  it('closes a rejected unfinished upload and permits the next call', async () => {
    config.routes[0].authRequired = true;
    await install();
    await restart({ maxConcurrentStreams: 1 });
    await until(() => client.remoteSettings.maxConcurrentStreams === 1);
    const rejected = request();
    rejected.stream.write(frame('unfinished'));
    expect((await rejected.finished).status).toBe('16');
    await until(() => rejected.stream.destroyed);
    const next = request({ authorization: `Bearer ${consumerKey}` });
    next.stream.end(frame('test'));
    expect((await next.finished).status).toBe('0');
    expect(received).toHaveLength(1);
  });
  it('drains an active bidirectional call during shutdown grace', async () => {
    await restart({ shutdownGraceMs: 500 });
    const call = request();
    call.stream.write(frame('first'));
    await until(() => received.length === 1);
    const stopping = gateway.onModuleDestroy();
    call.stream.end(frame('last'));
    expect((await call.finished).status).toBe('0');
    await stopping;
    await until(() => upstreamSessions.size === 0);
  });
  it('sends unavailable before terminating calls beyond shutdown grace', async () => {
    mode = 'stall';
    const call = request();
    call.stream.end(frame('test'));
    await until(() => received.length === 1);
    const stopping = gateway.onModuleDestroy();
    expect((await call.finished).status).toBe('14');
    await stopping;
    await until(() => upstreamSessions.size === 0);
  });
  it('propagates slow-client backpressure instead of buffering the full response', async () => {
    mode = 'flood';
    config.services[0].timeoutMs = 5000;
    await install();
    const call = request();
    call.stream.pause();
    call.stream.end(frame('test'));
    await until(() => floodProduced > 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const held = floodProduced;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(floodProduced).toBe(held);
    expect(held).toBeLessThan(1024 * 1024);
    call.stream.resume();
    const result = await call.finished;
    expect(result.status).toBe('0');
    expect(result.body.length).toBe(floodPacket.length * floodPackets);
    expect(floodProduced).toBe(result.body.length);
  });
  it('preserves binary unary frames, metadata and trailers and records bounded route labels', async () => {
    const { stream, finished } = request({
      'custom-request-bin': 'BAUG',
      'x-id': 'correlation',
    });
    const body = frame('hello');
    stream.end(body);
    const result = await finished;
    expect(result.body).toEqual(body);
    expect(result.status).toBe('0');
    expect(result.response['x-upstream']).toBe('yes');
    expect(result.trailers['custom-result-bin']).toBe('AQID');
    expect(received[0]).toMatchObject({
      'custom-request-bin': 'BAUG',
      'x-id': 'correlation',
    });
    expect(metrics.incrementGrpcRequests).toHaveBeenCalledWith(
      'test.Echo',
      'Call',
      '0',
    );
  });
  it('relays messages before the client ends the request (bidirectional streaming)', async () => {
    const { stream, finished } = request();
    const first = frame('first');
    stream.write(first);
    let echoed = 0;
    stream.on('data', (chunk: Buffer) => {
      echoed += chunk.length;
    });
    await until(() => echoed >= first.length);
    stream.end(frame('second'));
    expect((await finished).body).toEqual(
      Buffer.concat([first, frame('second')]),
    );
  });
  it('handles a trailers-only upstream rejection', async () => {
    mode = 'trailers-only';
    const { stream, finished } = request();
    stream.end(frame('test'));
    expect((await finished).status).toBe('7');
  });
  it.each(['invalid', 'expired', 'missing'])(
    'rejects %s credentials before dispatch',
    async (kind) => {
      config.routes[0].authRequired = true;
      await install();
      const token =
        kind === 'expired'
          ? sign({ sub: 'consumer' }, secret, { expiresIn: -1 })
          : 'unverified-token';
      const { stream, finished } = request(
        kind === 'missing' ? {} : { authorization: `Bearer ${token}` },
      );
      stream.end(frame('test'));
      expect((await finished).status).toBe('16');
      expect(received).toHaveLength(0);
    },
  );
  it.each(['jwt', 'consumer'])(
    'accepts verified %s authentication',
    async (kind) => {
      config.routes[0].authRequired = true;
      await install();
      const token =
        kind === 'jwt' ? sign({ sub: 'consumer' }, secret) : consumerKey;
      const { stream, finished } = request({
        authorization: `Bearer ${token}`,
      });
      stream.end(frame('test'));
      expect((await finished).status).toBe('0');
    },
  );
  it('does not accept a consumer key removed from the current configuration', async () => {
    config.routes[0].authRequired = true;
    config.consumers = [];
    await install();
    const { stream, finished } = request({
      authorization: `Bearer ${consumerKey}`,
    });
    stream.end(frame('test'));
    expect((await finished).status).toBe('16');
    expect(received).toHaveLength(0);
  });
  it('runs Basic auth and ACL rather than treating header presence as proof', async () => {
    config.routes[0].authRequired = true;
    config.routes[0].plugins = [
      {
        name: 'basic-auth',
        config: {
          credentials: [
            {
              username: 'app',
              passwordHash: createHash('sha256')
                .update('password')
                .digest('hex'),
            },
          ],
        },
      },
    ];
    await install();
    let call = request({
      authorization: 'Basic ' + Buffer.from('app:wrong').toString('base64'),
    });
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('16');
    call = request({
      authorization: 'Basic ' + Buffer.from('app:password').toString('base64'),
    });
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('0');
    config.routes[0].plugins = [{ name: 'acl', config: { allow: ['other'] } }];
    await install();
    call = request({ authorization: `Bearer ${consumerKey}` });
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('7');
  });
  it('rejects unsupported configured plugins explicitly', async () => {
    config.routes[0].plugins = [{ name: 'body-plugin', config: {} }];
    await install();
    const call = request();
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('12');
    expect(received).toHaveLength(0);
  });
  it('ignores spoofed forwarding metadata during IP access checks', async () => {
    config.routes[0].plugins = [
      { name: 'ip-restriction', config: { allow: ['192.0.2.0/24'] } },
    ];
    await install();
    const call = request({ 'x-forwarded-for': '192.0.2.1' });
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('7');
  });
  it('rejects quota exhaustion and quota service errors before dispatch', async () => {
    quota.check.mockResolvedValueOnce({ allowed: false });
    let call = request();
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('8');
    quota.check.mockRejectedValueOnce(new Error('redis unavailable'));
    call = request();
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('14');
    expect(received).toHaveLength(0);
  });
  it('enforces caller deadlines and cancels stalled upstream work', async () => {
    mode = 'stall';
    const call = request({ 'grpc-timeout': '50m' });
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('4');
    await until(() => closures === 1);
  });
  it('rejects malformed deadlines', async () => {
    const call = request({ 'grpc-timeout': 'forever' });
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('3');
    expect(received).toHaveLength(0);
  });
  it('bounds request and response messages', async () => {
    let call = request();
    call.stream.end(frame('x'.repeat(65)));
    expect((await call.finished).status).toBe('8');
    mode = 'oversize';
    call = request();
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('8');
  });
  it('returns unavailable when all peers are unhealthy, with explicit fallback', async () => {
    healthy = false;
    let call = request();
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('14');
    expect(received).toHaveLength(0);
    config.services[0].unhealthyFallback = true;
    await install();
    call = request();
    call.stream.end(frame('test'));
    expect((await call.finished).status).toBe('0');
  });
  it('cancels upstream work when the caller cancels or configuration removes the target', async () => {
    mode = 'stall';
    let call = request();
    call.finished.catch(() => {
      /* Peer cancellation is asserted through stream status and close events. */
    });
    call.stream.write(frame('test'));
    await until(() => received.length === 1);
    call.stream.close(http2.constants.NGHTTP2_CANCEL);
    await until(() => closures === 1);
    call = request();
    call.stream.write(frame('test'));
    await until(() => received.length === 2);
    config.services = [];
    await install();
    expect((await call.finished).status).toBe('14');
    await until(() => closures === 2);
  });
  it('cancels calls on a tenant change even when service IDs and URLs are identical', async () => {
    mode = 'stall';
    const call = request();
    call.stream.write(frame('test'));
    await until(() => received.length === 1);
    await manager.loadConfig('another-tenant', config, ++version);
    expect((await call.finished).status).toBe('14');
    await until(() => closures === 1);
    expect(metrics.setGrpcActiveCalls).toHaveBeenLastCalledWith(0);
  });
  it('cancels active calls and rejects new calls when an HTTP GraphQL policy is enabled', async () => {
    mode = 'stall';
    const call = request();
    call.stream.write(frame('test'));
    await until(() => received.length === 1);
    config.routes[0].graphql = {};
    await install();
    expect((await call.finished).status).toBe('14');
    await until(() => closures === 1);
    const blocked = request();
    blocked.stream.end(frame('test'));
    expect((await blocked.finished).status).toBe('12');
    expect(received).toHaveLength(1);
  });
  it('selects another target while a gRPC call is active and releases cancelled work', async () => {
    const sessions = new Set<http2.ServerHttp2Session>();
    let fastCalls = 0;
    const fast = http2.createServer();
    fast.on('session', (session) => {
      sessions.add(session);
      session.on('error', () => undefined);
    });
    fast.on('stream', (stream) => {
      stream.on('error', () => undefined);
      fastCalls++;
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.resume();
      stream.once('end', () => stream.end(frame('fast')));
      stream.once('wantTrailers', () =>
        stream.sendTrailers({ 'grpc-status': '0' }),
      );
    });
    fast.listen(0, '127.0.0.1');
    await once(fast, 'listening');
    const fastTarget = `http://127.0.0.1:${(fast.address() as net.AddressInfo).port}`;
    try {
      config.services[0].loadBalancing = 'least-connections';
      config.services[0].targets.push({ url: fastTarget, weight: 1 });
      await install();
      mode = 'stall';
      const first = request();
      first.finished.catch(() => undefined);
      first.stream.write(frame('busy'));
      await until(() => received.length === 1);
      const second = request();
      second.stream.end(frame('test'));
      expect((await second.finished).status).toBe('0');
      expect(fastCalls).toBe(1);
      first.stream.close(http2.constants.NGHTTP2_CANCEL);
      await until(() => balancer.activeReservations === 0);
      expect(received).toHaveLength(1);
    } finally {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => fast.close(() => resolve()));
    }
  });
});
