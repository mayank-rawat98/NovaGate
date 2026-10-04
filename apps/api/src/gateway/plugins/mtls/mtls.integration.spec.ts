import { bindTenantClientTrust } from '../../shared/tls-client-trust';
import { ConfigService } from '@nestjs/config';
import * as http from 'node:http';
import * as https from 'node:https';
import * as http2 from 'node:http2';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { PluginContext } from '@api-gateway/shared-types';
import { MtlsPlugin } from './mtls.plugin';
import { mtlsFixture } from './mtls-fixture';
import { listenerTlsOptions } from '../../../config/tls-options';

describe('real native TLS and proxy certificate assertions', () => {
  let fixture: ReturnType<typeof mtlsFixture>;
  let ca: string;
  let plugin: MtlsPlugin;
  const sockets = new Set<import('node:net').Socket>();
  const servers: Array<http.Server | http2.Http2SecureServer> = [];
  beforeAll(() => {
    fixture = mtlsFixture();
  }, 30000);
  afterAll(() => fixture.cleanup());
  beforeEach(() => {
    ca = fixture.read('ca.pem').toString();
    plugin = make();
  });
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const server of servers.splice(0))
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  function make(settings = {}) {
    return new MtlsPlugin(
      { getConfig: () => ({ caCertPem: ca }) } as never,
      new ConfigService({ mtls: settings }),
    );
  }
  function ctx(req: unknown, res: unknown): PluginContext {
    return {
      req: req as PluginContext['req'],
      res: res as PluginContext['res'],
      service: undefined,
      tenantId: 'tenant',
      requestId: 'request',
      route: {
        id: 'route',
        method: 'GET',
        pathPattern: '/',
        serviceId: 'service',
        enabled: true,
        authRequired: true,
        plugins: [{ name: 'mtls', config: { required: true } }],
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
  }
  const tlsOptions = () => {
    const options = listenerTlsOptions({
      certFile: fixture.file('server.pem'),
      keyFile: fixture.file('server.key'),
      clientCaFile: fixture.file('ca.pem'),
    });
    if (!options) throw new Error('Expected fixture TLS');
    return options;
  };
  async function listen(server: http.Server | http2.Http2SecureServer) {
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return (server.address() as AddressInfo).port;
  }
  const handler = async (req: unknown, res: http.ServerResponse) => {
    const context = ctx(req, res);
    const denied = await plugin.onRequest(context);
    res.statusCode = denied?.status ?? 200;
    res.end(
      denied?.body ??
        JSON.stringify({
          authentication: context.authentication,
          headers: context.req.headers,
        }),
    );
  };
  async function request(
    port: number,
    options: https.RequestOptions &
      Pick<import('node:tls').ConnectionOptions, 'session'> = {},
    secure = true,
  ) {
    return new Promise<{ status: number; body: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = (secure ? https : http).get(
          {
            hostname: '127.0.0.1',
            port,
            ca: fixture.read('ca.pem'),
            agent: false,
            ...options,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 500,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              }),
            );
          },
        );
        req.on('error', reject);
      },
    );
  }
  const credentials = (name = 'client') => ({
    cert: fixture.read(`${name}.pem`),
    key: fixture.read(`${name}.key`),
  });
  it('denies copied public certificates on HTTP without private-key possession', async () => {
    const port = await listen(http.createServer(handler));
    const result = await request(
      port,
      {
        headers: {
          ssl_client_cert: encodeURIComponent(
            fixture.read('client.pem').toString(),
          ),
          ssl_client_verify: 'SUCCESS',
          'x-forwarded-for': '127.0.0.1',
        },
      },
      false,
    );
    expect(result.status).toBe(403);
  });
  it('authenticates a verified TLS peer and removes spoofed certificate identity headers', async () => {
    const port = await listen(https.createServer(tlsOptions(), handler));
    const result = await request(port, {
      ...credentials(),
      headers: { 'x-ssl-client-subject': 'spoofed' },
    });
    expect(result.status).toBe(200);
    expect((result.body.authentication as { method: string }).method).toBe(
      'mtls',
    );
    expect(
      (result.body.headers as Record<string, string>)['x-ssl-client-subject'],
    ).toBe('CN=client');
  });
  it('accepts a valid intermediate chain and rotating CA bundle', async () => {
    ca += '\n' + fixture.read('other-ca.pem').toString();
    const port = await listen(https.createServer(tlsOptions(), handler));
    expect(
      (
        await request(port, {
          key: fixture.read('intermediate-client.key'),
          cert: Buffer.concat([
            fixture.read('intermediate-client.pem'),
            fixture.read('intermediate.pem'),
          ]),
        })
      ).status,
    ).toBe(200);
  });
  it.each(['missing', 'wrong-client', 'wrong-purpose'])(
    'denies an unverified native peer: %s',
    async (name) => {
      const port = await listen(https.createServer(tlsOptions(), handler));
      expect(
        (await request(port, name === 'missing' ? {} : credentials(name)))
          .status,
      ).toBe(403);
    },
  );
  it('rotates native listener and tenant trust without a restart', async () => {
    const options = tlsOptions();
    const server = https.createServer(options, handler);
    let refresh!: () => void;
    bindTenantClientTrust(server, options, {
      getConfig: () => ({ caCertPem: ca }),
      subscribeConfig: (listener: () => void) => {
        refresh = listener;
        return () => {
          /* Fixture cleanup. */
        };
      },
    });
    const port = await listen(server);
    expect((await request(port, credentials())).status).toBe(200);
    expect((await request(port, credentials('wrong-client'))).status).toBe(403);
    ca = 'invalid trust';
    refresh();
    expect((await request(port, credentials())).status).toBe(503);
    ca = fixture.read('other-ca.pem').toString();
    refresh();
    expect((await request(port, credentials())).status).toBe(403);
    expect((await request(port, credentials('wrong-client'))).status).toBe(200);
  });
  it('denies malformed and leaf-only tenant trust', async () => {
    const port = await listen(https.createServer(tlsOptions(), handler));
    for (const invalid of [
      'invalid',
      fixture.read('client.pem').toString(),
      fixture.read('ca.pem').toString() + '\nPRIVATE KEY',
    ]) {
      ca = invalid;
      expect((await request(port, credentials())).status).toBe(503);
    }
  });
  it('allows assertions only from an explicitly trusted socket peer with verified status', async () => {
    plugin = make({ trustedProxyCidrs: ['127.0.0.1/32'] });
    const port = await listen(http.createServer(handler));
    const headers = {
      ssl_client_cert: encodeURIComponent(
        fixture.read('client.pem').toString(),
      ),
      ssl_client_verify: 'SUCCESS',
    };
    expect((await request(port, { headers }, false)).status).toBe(200);
    expect(
      (
        await request(
          port,
          { headers: { ...headers, ssl_client_verify: 'NONE' } },
          false,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          port,
          {
            headers: {
              ...headers,
              'x-ssl-client-cert': headers.ssl_client_cert,
            },
          },
          false,
        )
      ).status,
    ).toBe(403);
    plugin = make({ trustedProxyCidrs: ['192.0.2.10'] });
    expect(
      (
        await request(
          port,
          { headers: { ...headers, 'x-forwarded-for': '192.0.2.10' } },
          false,
        )
      ).status,
    ).toBe(403);
  });
  it('bounds forwarded certificate and native chain bytes', async () => {
    plugin = make({
      trustedProxyCidrs: ['127.0.0.1'],
      maxCertificateBytes: 1024,
    });
    const port = await listen(http.createServer(handler));
    expect(
      (
        await request(
          port,
          {
            headers: {
              ssl_client_cert: encodeURIComponent(
                fixture.read('client.pem').toString(),
              ),
              ssl_client_verify: 'SUCCESS',
            },
          },
          false,
        )
      ).status,
    ).toBe(403);
    const secure = await listen(https.createServer(tlsOptions(), handler));
    expect((await request(secure, credentials())).status).toBe(403);
  });
  it('authenticates a real HTTP/2 TLS peer certificate', async () => {
    const server = http2.createSecureServer(tlsOptions());
    const port = await listen(server);
    server.on('request', async (req, res) => {
      const denied = await plugin.onRequest(ctx(req, res));
      res.writeHead(denied?.status ?? 200);
      res.end(denied?.body ?? 'verified');
    });
    const session = http2.connect(`https://127.0.0.1:${port}`, {
      ca: fixture.read('ca.pem'),
      ...credentials(),
    });
    try {
      await once(session, 'connect');
      const stream = session.request({ ':path': '/' });
      const [headers] = await once(stream, 'response');
      stream.resume();
      expect(headers[':status']).toBe(200);
      await once(stream, 'end');
    } finally {
      session.destroy();
    }
  });
  it('authenticates a real WSS upgrade with a verified TLS peer', async () => {
    const server = https.createServer(tlsOptions(), (_req, res) =>
      res.end('healthy'),
    );
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', async (req, socket, head) => {
      const denied = await plugin.onRequest(ctx(req, {}));
      if (denied) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        ws.on('message', (bytes) => ws.send(bytes)),
      );
    });
    const port = await listen(server);
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, {
      ca: fixture.read('ca.pem'),
      ...credentials(),
    });
    try {
      await once(ws, 'open');
      ws.send('verified');
      expect((await once(ws, 'message'))[0].toString()).toBe('verified');
    } finally {
      ws.terminate();
      wss.close();
    }
  });
  it('rejects a revoked native client certificate with the configured CRL', async () => {
    const options = listenerTlsOptions({
      certFile: fixture.file('server.pem'),
      keyFile: fixture.file('server.key'),
      clientCaFile: fixture.file('ca.pem'),
      crlFile: fixture.file('ca.crl'),
    });
    if (!options) throw new Error('Expected native TLS options');
    const port = await listen(https.createServer(options, handler));
    expect((await request(port, credentials())).status).toBe(403);
  });
  it('uses the verified terminator assertion over an explicitly trusted TLS proxy connection', async () => {
    plugin = make({ trustedProxyCidrs: ['127.0.0.1'] });
    const port = await listen(https.createServer(tlsOptions(), handler));
    expect(
      (
        await request(port, {
          headers: {
            'x-ssl-client-cert': encodeURIComponent(
              fixture.read('client.pem').toString(),
            ),
            'x-ssl-client-verify': 'SUCCESS',
          },
        })
      ).status,
    ).toBe(200);
  });
  it('rejects a resumed anonymous TLS session even if it reports authorization', async () => {
    const reused: boolean[] = [];
    const server = https.createServer(tlsOptions(), (req, res) => {
      reused.push(
        (req.socket as import('node:tls').TLSSocket).isSessionReused(),
      );
      void handler(req, res);
    });
    const port = await listen(server);
    let session: Buffer | undefined;
    await new Promise<void>((resolve, reject) => {
      const client = https.get(
        {
          hostname: '127.0.0.1',
          port,
          ca: fixture.read('ca.pem'),
          agent: false,
          minVersion: 'TLSv1.3',
        },
        (res) => {
          res.resume();
          res.once('end', resolve);
        },
      );
      client.on('socket', (socket) =>
        (socket as import('node:tls').TLSSocket).on('session', (ticket) => {
          session = ticket;
        }),
      );
      client.on('error', reject);
    });
    expect(session).toBeDefined();
    expect(
      (
        await request(port, {
          session,
          minVersion: 'TLSv1.3',
          headers: {
            ssl_client_cert: encodeURIComponent(
              fixture.read('client.pem').toString(),
            ),
            ssl_client_verify: 'SUCCESS',
          },
        })
      ).status,
    ).toBe(403);
    expect(reused).toEqual([false, true]);
  });
});
