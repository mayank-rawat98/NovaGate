import * as http from 'node:http';
import * as net from 'node:net';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';
import WebSocket, { WebSocketServer } from 'ws';
import type { GatewayPlugin, TenantConfig } from '@api-gateway/shared-types';
import { WsProxyService } from './ws-proxy.service';
import {
  DEFAULT_WEBSOCKET,
  type WebSocketSettings,
} from '../../config/configuration';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { LoadBalancerService } from './load-balancer.service';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginRunnerService } from '../plugins/plugin-runner.service';
import { BasicAuthPlugin } from '../plugins/basic-auth/basic-auth.plugin';
import { AclPlugin } from '../plugins/acl/acl.plugin';
import { IpRestrictionPlugin } from '../plugins/ip-restriction/ip-restriction.plugin';
import { OidcPlugin } from '../plugins/oidc/oidc.plugin';
import { OAuth2ClientCredentialsPlugin } from '../plugins/oauth2-client-credentials/oauth2-client-credentials.plugin';

const secret = 'websocket-verification-secret-at-least-32-characters';
const key = 'websocket-consumer-verification-key';
async function until(predicate: () => boolean) {
  const expires = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > expires) throw new Error('Condition did not converge');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('authenticated WebSocket tunnels over real sockets', () => {
  let upstream: http.Server;
  let listener: http.Server;
  let wss: WebSocketServer;
  let gateway: WsProxyService;
  let manager: GatewayConfigManagerService;
  let config: TenantConfig;
  let healthy: boolean;
  let mode: 'echo' | 'stall' | 'refuse' | 'invalid' | 'flood';
  let received: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  let version: number;
  let base: string;
  let floodProduced: number;
  const floodPrefix = Buffer.alloc(10);
  floodPrefix[0] = 0x82;
  floodPrefix[1] = 127;
  floodPrefix.writeBigUInt64BE(65536n, 2);
  const floodPacket = Buffer.concat([floodPrefix, Buffer.alloc(65536, 19)]);
  const floodSize = floodPacket.length * 256;
  const sockets = new Set<net.Socket>();
  const clients = new Set<WebSocket>();
  const quota = { check: jest.fn() };
  const metrics = {
    incrementWsConnections: jest.fn(),
    decrementWsConnections: jest.fn(),
    incrementWsBytes: jest.fn(),
  };
  let extraPlugins: GatewayPlugin[];
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
  function makeGateway(settings: Partial<WebSocketSettings> = {}) {
    return new WsProxyService(
      manager,
      metrics as never,
      new LoadBalancerService(),
      {
        getHealthyUrls: () =>
          new Set(
            healthy ? config.services[0].targets.map((item) => item.url) : [],
          ),
      } as never,
      new ConfigService({
        websocket: { ...DEFAULT_WEBSOCKET, shutdownGraceMs: 20, ...settings },
        jwt: { secret },
        rateLimit: config.rateLimit,
      }),
      quota as never,
      new PluginRegistryService([
        new BasicAuthPlugin(),
        new AclPlugin(manager),
        new IpRestrictionPlugin(),
        new OidcPlugin(),
        new OAuth2ClientCredentialsPlugin(redis as never),
        { name: 'body-plugin', onRequest: jest.fn() },
        ...extraPlugins,
      ]),
      new PluginRunnerService(),
    );
  }
  async function restart(settings: Partial<WebSocketSettings> = {}) {
    await gateway.onModuleDestroy();
    gateway = makeGateway(settings);
    gateway.onModuleInit();
  }
  async function install(tenant = 'tenant') {
    await manager.loadConfig(tenant, config, ++version);
  }
  function connect(
    options: WebSocket.ClientOptions = {},
    path = '/ws',
    protocols: string[] = [],
  ) {
    const ws = new WebSocket(base + path, protocols, options);
    clients.add(ws);
    ws.on('error', () => {
      /* Errors are asserted through the handshake result or socket closure. */
    });
    return ws;
  }
  async function reject(options: WebSocket.ClientOptions = {}, path = '/ws') {
    const ws = connect(options, path);
    return new Promise<{
      status: number;
      body: Record<string, string>;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      ws.once('open', () => reject(new Error('Unexpected accepted upgrade')));
      ws.once('unexpected-response', (_req, response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () => {
          ws.terminate();
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString()),
            headers: response.headers,
          });
        });
      });
      ws.once('error', reject);
    });
  }
  beforeEach(async () => {
    version = 0;
    healthy = true;
    mode = 'echo';
    received = [];
    extraPlugins = [];
    floodProduced = 0;
    for (const mock of Object.values(metrics)) mock.mockClear();
    quota.check
      .mockReset()
      .mockResolvedValue({ allowed: true, retryAfterMs: null });
    redis.get.mockReset().mockResolvedValue(null);
    redis.set.mockReset().mockResolvedValue('OK');
    upstream = http.createServer((_req, res) => res.end('ok'));
    upstream.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
    });
    wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
    upstream.on('upgrade', (req, socket, head) => {
      received.push({ url: req.url ?? '', headers: { ...req.headers } });
      if (mode === 'stall') return;
      if (mode === 'refuse') {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (mode === 'invalid') {
        socket.end(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n',
        );
        return;
      }
      if (mode === 'flood') {
        const accept = createHash('sha1')
          .update(
            req.headers['sec-websocket-key'] +
              '258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
          )
          .digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        const produce = () => {
          while (!socket.destroyed && floodProduced < floodSize) {
            floodProduced += floodPacket.length;
            if (!socket.write(floodPacket)) {
              socket.once('drain', produce);
              return;
            }
          }
          if (!socket.destroyed) socket.end();
        };
        produce();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => ws.terminate());
        ws.on('message', (data, binary) => ws.send(data, { binary }));
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    config = {
      routes: [
        {
          id: 'route',
          method: 'GET',
          pathPattern: '/ws',
          serviceId: 'service',
          enabled: true,
          authRequired: false,
        },
      ],
      services: [
        {
          id: 'service',
          name: 'Echo',
          targets: [
            {
              url: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`,
              weight: 100,
            },
          ],
          timeoutMs: 5000,
          healthCheckPath: '/health',
          supportsWebSocket: true,
        },
      ],
      consumers: [
        {
          id: 'consumer',
          keyHash: createHash('sha256').update(key).digest('hex'),
          name: 'app',
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
    listener = http.createServer((_req, res) => res.end('healthy'));
    listener.on('upgrade', (req, socket, head) => {
      void gateway.handleUpgrade(req, socket as net.Socket, head);
    });
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );
    base = `ws://127.0.0.1:${(listener.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const client of clients) client.terminate();
    clients.clear();
    await gateway?.onModuleDestroy();
    for (const socket of sockets) socket.destroy();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await Promise.all([
      new Promise<void>((resolve) => upstream.close(() => resolve())),
      new Promise<void>((resolve) => listener.close(() => resolve())),
    ]);
  });
  it('relays text, binary, fragments, subprotocol, negotiated compression, ping/pong and close; counts only accepted traffic', async () => {
    const ws = connect({ perMessageDeflate: true }, '/ws?room=one', ['chat']);
    await once(ws, 'open');
    expect(ws.protocol).toBe('chat');
    expect(ws.extensions).toContain('permessage-deflate');
    let reply = once(ws, 'message');
    ws.send('hello');
    expect((await reply)[0].toString()).toBe('hello');
    const binary = Buffer.from([0, 255, 128, 1]);
    reply = once(ws, 'message');
    ws.send(binary);
    const result = await reply;
    expect(result[0]).toEqual(binary);
    expect(result[1]).toBe(true);
    reply = once(ws, 'message');
    ws.send('frag', { fin: false });
    ws.send('ment', { fin: true });
    expect((await reply)[0].toString()).toBe('fragment');
    const pong = once(ws, 'pong');
    ws.ping('check');
    expect((await pong)[0].toString()).toBe('check');
    expect(metrics.incrementWsConnections).toHaveBeenCalledTimes(1);
    expect(metrics.decrementWsConnections).not.toHaveBeenCalled();
    const closed = once(ws, 'close');
    ws.close(1000, 'done');
    expect((await closed)[0]).toBe(1000);
    await until(() => metrics.decrementWsConnections.mock.calls.length === 1);
    expect(
      metrics.incrementWsBytes.mock.calls.some(
        ([direction, bytes]) => direction === 'inbound' && bytes > 0,
      ),
    ).toBe(true);
    expect(
      metrics.incrementWsBytes.mock.calls.some(
        ([direction, bytes]) => direction === 'outbound' && bytes > 0,
      ),
    ).toBe(true);
    expect(received[0].url).toBe('/ws?room=one');
    expect(gateway.occupiedConnections).toBe(0);
  });
  it('rejects missing or forged identity before dispatch, then accepts signed HS256 and a configured API key', async () => {
    config.routes[0].authRequired = true;
    await install();
    for (const token of [
      undefined,
      'forged',
      sign({ sub: 'consumer' }, secret, { algorithm: 'HS384' }),
    ]) {
      const result = await reject(
        token ? { headers: { authorization: `Bearer ${token}` } } : {},
      );
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({
        error: 'TOKEN_INVALID',
        requestId: expect.any(String),
      });
    }
    expect(received).toHaveLength(0);
    expect(metrics.incrementWsConnections).not.toHaveBeenCalled();
    for (const token of [sign({ sub: 'consumer' }, secret), key]) {
      const ws = connect({ headers: { authorization: `Bearer ${token}` } });
      await once(ws, 'open');
      ws.terminate();
    }
    expect(quota.check).toHaveBeenCalledWith('ws:tenant:route:consumer', 100);
  });
  it('rejects expired JWT credentials', async () => {
    const result = await reject({
      headers: {
        authorization: `Bearer ${sign({ sub: 'consumer', exp: 1 }, secret)}`,
      },
    });
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('TOKEN_EXPIRED');
    expect(received).toHaveLength(0);
  });
  it('rejects malformed query credentials without crashing and disables query authentication by default', async () => {
    config.routes[0].authRequired = true;
    await install();
    expect((await reject({}, '/ws?token=%QQ')).status).toBe(401);
    expect((await reject({}, `/ws?token=${key}`)).status).toBe(401);
    await restart({ allowQueryToken: true });
    expect((await reject({}, '/ws?token=%QQ')).status).toBe(400);
    expect((await reject({}, '/ws?token=a&token=b')).status).toBe(401);
    const ws = connect({}, `/ws?room=a%2fb&token=${key}&room=x+y`);
    await once(ws, 'open');
    expect(received[0].url).toBe('/ws?room=a%2fb&room=x+y');
  });
  it('enforces Basic Auth and rejects body plugins explicitly', async () => {
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
    const challenge = await reject();
    expect(challenge.status).toBe(401);
    expect(challenge.headers['www-authenticate']).toBe('Basic realm="Gateway"');
    const ws = connect({
      headers: {
        authorization: `Basic ${Buffer.from('app:password').toString('base64')}`,
      },
    });
    await once(ws, 'open');
    config.routes[0].plugins = [{ name: 'body-plugin', config: {} }];
    await install();
    const result = await reject();
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('WS_PLUGIN_UNSUPPORTED');
  });
  it('applies ACL and IP rules to verified identity and the raw peer, stripping forwarding/certificate assertions', async () => {
    config.routes[0].authRequired = true;
    config.routes[0].plugins = [
      { name: 'acl', config: { allow: ['apps'] } },
      { name: 'ip-restriction', config: { allow: ['127.0.0.1/32'] } },
    ];
    await install();
    const ws = connect({
      headers: {
        authorization: `Bearer ${key}`,
        'x-forwarded-for': '10.2.3.4',
        'x-forwarded-host': 'spoof',
        forwarded: 'for=10.2.3.4',
        'x-real-ip': '10.2.3.4',
        'x-ssl-client-cert': 'spoof',
        ssl_client_cert: 'spoof',
      },
    });
    await once(ws, 'open');
    for (const name of [
      'x-forwarded-for',
      'x-forwarded-host',
      'forwarded',
      'x-real-ip',
      'x-ssl-client-cert',
      'ssl_client_cert',
    ])
      expect(received[0].headers[name]).toBeUndefined();
    config.routes[0].plugins[1].config = { allow: ['10.0.0.0/8'] };
    await install();
    expect(
      (
        await reject({
          headers: {
            authorization: `Bearer ${key}`,
            'x-forwarded-for': '10.2.3.4',
          },
        })
      ).status,
    ).toBe(403);
  });
  it('fails closed on exhausted quota and failed quota storage before connecting', async () => {
    quota.check.mockResolvedValueOnce({ allowed: false, retryAfterMs: 100 });
    expect((await reject()).status).toBe(429);
    quota.check.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect((await reject()).status).toBe(503);
    expect(received).toHaveLength(0);
    expect(metrics.incrementWsConnections).not.toHaveBeenCalled();
  });
  it('counts pending cancelled quota work against admission capacity until it settles', async () => {
    await restart({ maxConnections: 1, handshakeTimeoutMs: 100 });
    let release!: (value: unknown) => void;
    quota.check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const ws = connect();
    await until(() => quota.check.mock.calls.length === 1);
    ws.terminate();
    await until(() => gateway.occupiedConnections === 1);
    expect((await reject()).status).toBe(503);
    expect(quota.check).toHaveBeenCalledTimes(1);
    release({ allowed: true, retryAfterMs: null });
    await until(() => gateway.occupiedConnections === 0);
    const next = connect();
    await once(next, 'open');
    expect(received).toHaveLength(1);
  });
  it('includes asynchronous plugins in the absolute handshake deadline and aborts their context', async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    extraPlugins = [
      {
        name: 'stall-auth',
        protocols: ['websocket'],
        onRequest: async (ctx) => {
          signal = ctx.signal;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    ];
    config.routes[0].plugins = [{ name: 'stall-auth', config: {} }];
    await install();
    await restart({ maxConnections: 1, handshakeTimeoutMs: 100 });
    expect((await reject()).status).toBe(504);
    expect(signal?.aborted).toBe(true);
    expect(gateway.occupiedConnections).toBe(1);
    release();
    await until(() => gateway.occupiedConnections === 0);
    expect(quota.check).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });
  it('retains admission capacity for cancelled response hooks until they settle', async () => {
    let release!: () => void;
    let signal: AbortSignal | undefined;
    extraPlugins = [
      {
        name: 'response-hook',
        protocols: ['websocket'],
        onResponse: async (ctx) => {
          signal = ctx.signal;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    ];
    config.routes[0].plugins = [{ name: 'response-hook', config: {} }];
    await install();
    await restart({ maxConnections: 1, handshakeTimeoutMs: 100 });
    expect((await reject()).status).toBe(504);
    expect(signal?.aborted).toBe(true);
    expect(metrics.incrementWsConnections).not.toHaveBeenCalled();
    expect(gateway.occupiedConnections).toBe(1);
    expect((await reject()).body.error).toBe('WS_CAPACITY_EXHAUSTED');
    release();
    await until(() => gateway.occupiedConnections === 0);
  });
  it('bounds stalled upstream upgrades and never counts them as accepted', async () => {
    mode = 'stall';
    await restart({ handshakeTimeoutMs: 100 });
    expect((await reject()).status).toBe(504);
    expect(metrics.incrementWsConnections).not.toHaveBeenCalled();
    expect(gateway.occupiedConnections).toBe(0);
    mode = 'echo';
    const ws = connect();
    await once(ws, 'open');
  });
  it.each(['refuse', 'invalid'] as const)(
    'normalizes %s upstream handshakes',
    async (value) => {
      mode = value;
      const result = await reject();
      expect(result.status).toBe(502);
      expect(result.body.error).toBe('DOWNSTREAM_ERROR');
      expect(metrics.incrementWsConnections).not.toHaveBeenCalled();
    },
  );
  it('rejects unavailable peers unless fallback is explicitly enabled', async () => {
    healthy = false;
    expect((await reject()).body.error).toBe('NO_HEALTHY_TARGETS');
    expect(received).toHaveLength(0);
    config.services[0].unhealthyFallback = true;
    await install();
    const ws = connect();
    await once(ws, 'open');
  });
  it.each([
    'tenant',
    'route',
    'service',
    'target',
    'consumer',
    'policy',
  ] as const)(
    'closes accepted tunnels on %s removal/change and reconciles metrics exactly once',
    async (change) => {
      const ws = connect({ headers: { authorization: `Bearer ${key}` } });
      await once(ws, 'open');
      const closed = once(ws, 'close');
      if (change === 'route') config.routes = [];
      if (change === 'service') config.services = [];
      if (change === 'target') config.services[0].targets = [];
      if (change === 'consumer') config.consumers = [];
      if (change === 'policy') config.routes[0].authRequired = true;
      await install(change === 'tenant' ? 'other-tenant' : 'tenant');
      await closed;
      expect(gateway.occupiedConnections).toBe(0);
      expect(metrics.decrementWsConnections).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps accepted tunnels on an unrelated configuration version change', async () => {
    const ws = connect();
    await once(ws, 'open');
    await install();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(gateway.occupiedConnections).toBe(1);
  });
  it('caps accepted connections and expires idle tunnels', async () => {
    await restart({ maxConnections: 1, idleTimeoutMs: 1000 });
    const ws = connect();
    await once(ws, 'open');
    expect((await reject()).body.error).toBe('WS_CAPACITY_EXHAUSTED');
    await once(ws, 'close');
    expect(gateway.occupiedConnections).toBe(0);
  });
  it('permits a normal close during shutdown grace, rejects new upgrades, and bounds forced shutdown', async () => {
    await restart({ shutdownGraceMs: 300 });
    const ws = connect();
    await once(ws, 'open');
    const draining = gateway.onModuleDestroy();
    expect((await reject()).status).toBe(503);
    const closed = once(ws, 'close');
    ws.close(1000);
    await closed;
    await draining;
    await restart({ shutdownGraceMs: 20 });
    const stuck = connect();
    await once(stuck, 'open');
    const forced = once(stuck, 'close');
    await gateway.onModuleDestroy();
    await forced;
    expect(gateway.occupiedConnections).toBe(0);
  });
  it('propagates backpressure from a slow receiver and flushes all buffered bytes on normal upstream EOF', async () => {
    mode = 'flood';
    const socket = net.connect(
      (listener.address() as net.AddressInfo).port,
      '127.0.0.1',
    );
    sockets.add(socket);
    socket.write(
      'GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AQEBAQEBAQEBAQEBAQEBAQ==\r\n\r\n',
    );
    let header = Buffer.alloc(0);
    let bodyBytes = 0;
    let ready = false;
    socket.on('data', (chunk) => {
      if (!ready) {
        header = Buffer.concat([header, chunk]);
        const index = header.indexOf('\r\n\r\n');
        if (index < 0) return;
        bodyBytes += header.length - index - 4;
        ready = true;
        socket.pause();
      } else bodyBytes += chunk.length;
    });
    await until(() => ready);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const produced = floodProduced;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(floodProduced).toBeLessThan(floodSize);
    expect(floodProduced - produced).toBeLessThan(1024 * 1024);
    const ended = once(socket, 'end');
    socket.resume();
    await ended;
    expect(bodyBytes).toBe(floodSize);
    socket.destroy();
  });
  it('bounds early frame bytes while quota is pending and never dispatches rejected uploads', async () => {
    await restart({ maxBufferedHeadBytes: 64 });
    let release!: (value: unknown) => void;
    quota.check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const socket = net.connect(
      (listener.address() as net.AddressInfo).port,
      '127.0.0.1',
    );
    sockets.add(socket);
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.write(
      'GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AQEBAQEBAQEBAQEBAQEBAQ==\r\n\r\n',
    );
    await until(() => quota.check.mock.calls.length === 1);
    const ended = once(socket, 'end');
    socket.write(Buffer.alloc(65));
    await ended;
    expect(Buffer.concat(chunks).toString()).toContain('413');
    expect(gateway.occupiedConnections).toBe(1);
    release({ allowed: true, retryAfterMs: null });
    await until(() => gateway.occupiedConnections === 0);
    expect(received).toHaveLength(0);
    socket.destroy();
  });
  it('aborts a real pending JWKS request at the handshake deadline', async () => {
    let providerClosed = false;
    const provider = http.createServer((req) => {
      req.socket.once('close', () => {
        providerClosed = true;
      });
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, '127.0.0.1', resolve),
    );
    try {
      config.routes[0].authRequired = true;
      config.routes[0].plugins = [
        {
          name: 'oidc',
          config: {
            jwksUri: `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}`,
            issuer: 'issuer',
          },
        },
      ];
      await install();
      await restart({ handshakeTimeoutMs: 100 });
      expect(
        (await reject({ headers: { authorization: 'Bearer opaque' } })).status,
      ).toBe(504);
      await until(() => providerClosed && gateway.occupiedConnections === 0);
      expect(received).toHaveLength(0);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
  it('uses real OIDC signing keys and rejects incorrect issuer/audience', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = {
      ...pair.publicKey.export({ format: 'jwk' }),
      kid: 'live-key',
      alg: 'RS256',
    };
    const provider = http.createServer((_req, res) =>
      res.end(JSON.stringify({ keys: [jwk] })),
    );
    await new Promise<void>((resolve) =>
      provider.listen(0, '127.0.0.1', resolve),
    );
    try {
      config.routes[0].authRequired = true;
      config.routes[0].plugins = [
        {
          name: 'oidc',
          config: {
            jwksUri: `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}`,
            issuer: 'issuer',
            audience: 'gateway',
          },
        },
      ];
      await install();
      const token = sign({ sub: 'external' }, pair.privateKey, {
        algorithm: 'RS256',
        keyid: 'live-key',
        issuer: 'issuer',
        audience: 'gateway',
      });
      const ws = connect({ headers: { authorization: `Bearer ${token}` } });
      await once(ws, 'open');
      const wrong = sign({ sub: 'external' }, pair.privateKey, {
        algorithm: 'RS256',
        keyid: 'live-key',
        issuer: 'other',
        audience: 'gateway',
      });
      expect(
        (await reject({ headers: { authorization: `Bearer ${wrong}` } }))
          .status,
      ).toBe(401);
    } finally {
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
  it('verifies OAuth introspection and never treats outbound token injection as client authentication', async () => {
    let active = true;
    const provider = http.createServer((req, res) => {
      req.resume();
      req.once('end', () =>
        res.end(
          JSON.stringify(
            req.url === '/token'
              ? { access_token: 'upstream-only', expires_in: 3600 }
              : { active, sub: 'external' },
          ),
        ),
      );
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, '127.0.0.1', resolve),
    );
    const url = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}`;
    try {
      config.routes[0].authRequired = true;
      config.routes[0].plugins = [
        {
          name: 'oauth2-client-credentials',
          config: {
            introspectionEndpoint: `${url}/introspect`,
            clientId: 'gateway',
            clientSecret: 'verification',
          },
        },
      ];
      await install();
      const ws = connect({
        headers: { authorization: 'Bearer opaque-external' },
      });
      await once(ws, 'open');
      active = false;
      expect(
        (await reject({ headers: { authorization: 'Bearer inactive' } }))
          .status,
      ).toBe(401);
      config.routes[0].plugins[0].config = {
        tokenEndpoint: `${url}/token`,
        clientId: 'gateway',
        clientSecret: 'verification',
      };
      await install();
      expect((await reject()).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
});
