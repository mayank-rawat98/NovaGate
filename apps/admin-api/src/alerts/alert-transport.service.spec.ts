import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AlertWebhookPayload } from '@api-gateway/shared-types';
import {
  AlertTransportService,
  ALERT_TRANSPORT_CAPACITY,
} from './alert-transport.service';
import {
  AlertTransportError,
  ALERT_HTTP_MAX_BYTES,
  postAlertJson,
} from './alert-http';

const payload: AlertWebhookPayload = {
  version: 1,
  deliveryId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  event: {
    id: '00000000-0000-4000-8000-000000000003',
    ruleId: '00000000-0000-4000-8000-000000000004',
    ruleName: 'Errors <script> & <!channel>',
    metric: 'error_rate',
    operator: '>',
    threshold: 0.1,
    windowMinutes: 1,
    state: 'firing',
    value: 0.5,
    createdAt: '2026-10-06T00:00:00.000Z',
  },
};
const secret = 'fixture-signing-secret-never-used-in-production';
function captured<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error('Local fixture did not receive a request.');
  return value;
}
const signal = () => new AbortController().signal;
const credentials = (url: string) => ({ type: 'webhook', url, secret });

describe('bounded alert transport (actual local receivers)', () => {
  const servers: Server[] = [];
  const services: AlertTransportService[] = [];
  async function listen(server: Server, protocol = 'http'): Promise<string> {
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return `${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function receiver(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ) {
    return listen(createServer(handler));
  }
  function service(
    origins: string[] = [],
    overrides: Record<string, unknown> = {},
  ) {
    const result = new AlertTransportService(
      new ConfigService({
        SMTP_API_KEY: '',
        SMTP_API_BASE_URL: 'https://api.mailtr.co',
        SMTP_FROM: 'support@novagate.dev',
        ALERT_HTTP_TRUSTED_ORIGINS: JSON.stringify(origins),
        ...overrides,
      }),
    );
    services.push(result);
    return result;
  }
  afterEach(async () => {
    await Promise.allSettled(
      services.splice(0).map((instance) => instance.onModuleDestroy()),
    );
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      ),
    );
    jest.restoreAllMocks();
  });
  it('posts a signed, whitelisted webhook payload with stable delivery ID', async () => {
    let received:
      | { body: string; headers: IncomingMessage['headers'] }
      | undefined;
    const origin = await receiver((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          body: Buffer.concat(chunks).toString(),
          headers: req.headers,
        };
        res.writeHead(202);
        res.end('queued');
      });
    });
    await service([origin]).deliver(
      credentials(`${origin}/private-path?token=fixture-only`),
      {
        ...payload,
        event: {
          ...payload.event,
          credentials: 'must-not-be-serialized',
        } as AlertWebhookPayload['event'],
      },
      signal(),
    );
    expect(JSON.parse(captured(received).body)).toEqual(payload);
    expect(captured(received).headers['x-novagate-delivery-id']).toBe(
      payload.deliveryId,
    );
    const timestamp = captured(received).headers['x-novagate-timestamp'];
    expect(captured(received).headers['x-novagate-signature']).toBe(
      `v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(captured(received).body).digest('hex')}`,
    );
    expect(captured(received).headers.authorization).toBeUndefined();
    expect(captured(received).body).not.toContain(secret);
  });
  it('uses plain text Slack blocks with link unfurling and markdown disabled', async () => {
    let body: Record<string, unknown> | undefined;
    const origin = await receiver((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        body = JSON.parse(Buffer.concat(chunks).toString());
        res.end('ok');
      });
    });
    await service([origin]).deliver(
      { type: 'slack', webhookUrl: `${origin}/fixture-only-slack` },
      payload,
      signal(),
    );
    expect(body).toMatchObject({
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
      blocks: [{ type: 'section', text: { type: 'plain_text' } }],
    });
    expect(captured(body).text).not.toContain('<!channel>');
  });
  it('sends Mailtr-compatible email with escaped HTML and scoped credentials', async () => {
    let received:
      | {
          body: Record<string, unknown>;
          headers: IncomingMessage['headers'];
          path?: string;
        }
      | undefined;
    const origin = await receiver((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          body: JSON.parse(Buffer.concat(chunks).toString()),
          headers: req.headers,
          path: req.url,
        };
        res.writeHead(202);
        res.end('{}');
      });
    });
    const transport = service([origin], {
      SMTP_API_KEY: 'fixture-mail-key',
      SMTP_API_BASE_URL: origin,
      SMTP_FROM: 'support@novagate.dev',
    });
    expect(transport.emailEnabled).toBe(true);
    await transport.deliver(
      { type: 'email', address: 'fixture@example.com' },
      payload,
      signal(),
    );
    expect(captured(received).path).toBe('/api/v1/emails/send');
    expect(captured(received).headers.authorization).toBe(
      'Bearer fixture-mail-key',
    );
    expect(captured(received).headers['idempotency-key']).toBe(
      payload.deliveryId,
    );
    expect(captured(received).body).toMatchObject({
      from: 'support@novagate.dev',
      to: ['fixture@example.com'],
    });
    expect(captured(received).body.html).toContain('&lt;script&gt;');
    expect(captured(received).body.html).not.toContain('<script>');
    expect(JSON.stringify(captured(received).body)).not.toContain(
      'fixture-mail-key',
    );
  });
  it('reports email unavailability without a key and makes no network request', async () => {
    const transport = service();
    expect(transport.emailEnabled).toBe(false);
    await expect(
      transport.deliver(
        { type: 'email', address: 'fixture@example.com' },
        payload,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'configuration', retryable: false });
  });
  it('preserves Mailtr sender display names and rejects multiple sender mailboxes', () => {
    expect(
      service([], { SMTP_FROM: 'NovaGate <support@novagate.dev>' })
        .emailEnabled,
    ).toBe(false);
    expect(() =>
      service([], { SMTP_FROM: 'one@example.com,two@example.com' }),
    ).toThrow('Invalid alert email transport configuration.');
  });
  it.each([
    'http://example.com/private',
    'https://127.0.0.1/private',
    'https://169.254.169.254/latest',
    'https://[::ffff:127.0.0.1]/private',
    'https://user:password@example.com/',
    'https://example.com:8443/private',
    'https://example.com/private#fragment',
  ])('refuses unsafe destinations before DNS: %s', async (url) => {
    const dns = jest.spyOn(Resolver.prototype, 'resolve4');
    await expect(
      service().deliver(credentials(url), payload, signal()),
    ).rejects.toMatchObject({ code: 'blocked_destination' });
    expect(dns).not.toHaveBeenCalled();
  });
  it('requires exact trusted origins, rather than host/prefix matches', async () => {
    await expect(
      service(['http://127.0.0.1:2000']).deliver(
        credentials('http://127.0.0.1:2001/private'),
        payload,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'blocked_destination' });
  });
  it.each([
    [['8.8.8.8', '127.0.0.1'], []],
    [['8.8.8.8'], ['::ffff:169.254.169.254']],
    [['8.8.8.8'], ['2001:db8::1']],
    [Array.from({ length: 17 }, () => '8.8.8.8'), []],
  ])('checks every A/AAAA answer before selecting one', async (ipv4, ipv6) => {
    jest.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(ipv4);
    jest.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue(ipv6);
    await expect(
      service().deliver(
        credentials('https://receiver.example.com/private'),
        payload,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'blocked_destination' });
  });
  it('pins the validated DNS answer while preserving the hostname', async () => {
    let host: string | undefined;
    const origin = await receiver((req, res) => {
      host = req.headers.host;
      res.end('ok');
    });
    const url = new URL(origin);
    const fixtureOrigin = `http://receiver.novagate.test:${url.port}`;
    const ipv4 = jest
      .spyOn(Resolver.prototype, 'resolve4')
      .mockResolvedValue(['127.0.0.1']);
    const ipv6 = jest
      .spyOn(Resolver.prototype, 'resolve6')
      .mockResolvedValue([]);
    await service([fixtureOrigin]).deliver(
      credentials(`${fixtureOrigin}/private`),
      payload,
      signal(),
    );
    expect(host).toBe(`receiver.novagate.test:${url.port}`);
    expect(ipv4).toHaveBeenCalledTimes(1);
    expect(ipv6).toHaveBeenCalledTimes(1);
  });
  it.each(['ESERVFAIL', 'ETIMEOUT'])(
    'fails closed if one DNS family fails: %s',
    async (code) => {
      jest.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['8.8.8.8']);
      jest
        .spyOn(Resolver.prototype, 'resolve6')
        .mockRejectedValue(
          Object.assign(new Error('secret-dns-detail'), { code }),
        );
      await expect(
        service().deliver(
          credentials('https://receiver.example.com/private'),
          payload,
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'dns_failed', retryable: true });
    },
  );
  it('allows an absent family but rejects an entirely empty DNS result', async () => {
    jest.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue([]);
    jest
      .spyOn(Resolver.prototype, 'resolve6')
      .mockRejectedValue(Object.assign(new Error(), { code: 'ENODATA' }));
    await expect(
      service().deliver(
        credentials('https://receiver.example.com/private'),
        payload,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'dns_failed' });
  });
  it.each([301, 302, 307, 308, 400, 401, 408, 429, 500, 503])(
    'refuses redirects/classifies HTTP %s without leaking remote details',
    async (status) => {
      let requests = 0;
      const origin = await receiver((_req, res) => {
        requests++;
        res.writeHead(status, { Location: '/private-secret-redirect' });
        res.end('remote-secret-token');
      });
      const expected =
        status >= 300 && status < 400
          ? 'redirect_refused'
          : status === 408 || status === 429 || status >= 500
            ? 'http_retryable'
            : 'http_client_error';
      const error = await service([origin])
        .deliver(
          credentials(`${origin}/private-secret-path`),
          payload,
          signal(),
        )
        .catch((e) => e);
      expect(error).toBeInstanceOf(AlertTransportError);
      expect(error.code).toBe(expected);
      expect(error.message).not.toMatch(/secret|token|127\.0\.0\.1/);
      expect(requests).toBe(1);
    },
  );
  it.each([true, false])(
    'bounds success response bytes (declared length: %s)',
    async (declared) => {
      const origin = await receiver((_req, res) => {
        if (declared) res.setHeader('Content-Length', ALERT_HTTP_MAX_BYTES + 1);
        res.end(Buffer.alloc(ALERT_HTTP_MAX_BYTES + 1));
      });
      await expect(
        service([origin]).deliver(credentials(origin), payload, signal()),
      ).rejects.toMatchObject({ code: 'response_too_large', retryable: false });
    },
  );
  it('refuses a header block over 8KB', async () => {
    const origin = await receiver((_req, res) => {
      res.setHeader('X-Oversized', 'x'.repeat(9000));
      res.end('ok');
    });
    await expect(
      service([origin]).deliver(credentials(origin), payload, signal()),
    ).rejects.toMatchObject({ code: 'connection_failed' });
  });
  it('bounds outgoing bytes before attempting DNS', async () => {
    const dns = jest.spyOn(Resolver.prototype, 'resolve4');
    await expect(
      postAlertJson(
        new URL('https://receiver.example.com'),
        Buffer.alloc(ALERT_HTTP_MAX_BYTES + 1),
        {},
        new Set(),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(dns).not.toHaveBeenCalled();
  });
  it('cancels the actual response connection when a receiver stalls', async () => {
    let ready!: () => void;
    const received = new Promise<void>((done) => {
      ready = done;
    });
    const origin = await receiver((_req, res) => {
      res.writeHead(200);
      res.write('partial');
      ready();
    });
    const controller = new AbortController();
    const transport = service([origin]);
    const work = transport.deliver(
      credentials(origin),
      payload,
      controller.signal,
    );
    const outcome = work.catch((e) => e);
    await received;
    controller.abort();
    expect(await outcome).toMatchObject({ code: 'cancelled' });
  });
  it('enforces the full deadline even when response bytes keep arriving', async () => {
    let interval: NodeJS.Timeout | undefined;
    const origin = await receiver((_req, res) => {
      res.writeHead(200);
      res.write('x');
      interval = setInterval(() => res.write('x'), 20);
      res.on('close', () => clearInterval(interval));
    });
    const start = performance.now();
    await expect(
      service([origin]).deliver(credentials(origin), payload, signal()),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(performance.now() - start).toBeLessThan(7000);
    clearInterval(interval);
  }, 10000);
  it('cancels and drains both DNS queries on shutdown without starting a connection', async () => {
    let reject4!: (e: unknown) => void;
    let reject6!: (e: unknown) => void;
    jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(
      () =>
        new Promise((_, reject) => {
          reject4 = reject;
        }),
    );
    jest.spyOn(Resolver.prototype, 'resolve6').mockImplementation(
      () =>
        new Promise((_, reject) => {
          reject6 = reject;
        }),
    );
    const cancelled = jest
      .spyOn(Resolver.prototype, 'cancel')
      .mockImplementation(() => {
        reject4(new Error());
        reject6(new Error());
      });
    const transport = service();
    const outcome = transport
      .deliver(
        credentials('https://receiver.example.com/private'),
        payload,
        signal(),
      )
      .catch((e) => e);
    await new Promise((done) => setImmediate(done));
    await transport.onModuleDestroy();
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    expect(cancelled).toHaveBeenCalledTimes(1);
    await expect(
      transport.deliver(
        credentials('https://receiver.example.com/private'),
        payload,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('limits admitted work, cancels all active sockets and releases capacity', async () => {
    let ready!: () => void;
    const admitted = new Promise<void>((done) => {
      ready = done;
    });
    let count = 0;
    const origin = await receiver((_req, res) => {
      res.writeHead(200);
      res.write('partial');
      if (++count === ALERT_TRANSPORT_CAPACITY) ready();
    });
    const transport = service([origin]);
    const work = Array.from({ length: ALERT_TRANSPORT_CAPACITY }, () =>
      transport.deliver(credentials(origin), payload, signal()).catch((e) => e),
    );
    await admitted;
    await expect(
      transport.deliver(credentials(origin), payload, signal()),
    ).rejects.toMatchObject({ code: 'busy', retryable: true });
    await transport.onModuleDestroy();
    expect(
      (await Promise.all(work)).every((error) => error.code === 'cancelled'),
    ).toBe(true);
  });
  it('does not weaken TLS verification even for an explicitly trusted origin', async () => {
    const artifacts = resolve(__dirname, '../../../../.local-work');
    mkdirSync(artifacts, { recursive: true });
    const directory = mkdtempSync(resolve(artifacts, 'alert-tls-'));
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          'key.pem',
          '-out',
          'cert.pem',
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { cwd: directory, stdio: 'ignore', timeout: 15000 },
      );
      let requests = 0;
      const origin = await listen(
        createHttpsServer(
          {
            key: readFileSync(resolve(directory, 'key.pem')),
            cert: readFileSync(resolve(directory, 'cert.pem')),
          },
          (_req, res) => {
            requests++;
            res.end('ok');
          },
        ),
        'https',
      );
      await expect(
        service([origin]).deliver(credentials(origin), payload, signal()),
      ).rejects.toMatchObject({ code: 'connection_failed' });
      expect(requests).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects invalid event data before any transport work', async () => {
    await expect(
      service().deliver(
        credentials('https://receiver.example.com'),
        { ...payload, event: { ...payload.event, value: Number.NaN } },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });
  it.each([
    { SMTP_FROM: 'bad\r\nBcc: secret@example.com' },
    { SMTP_API_KEY: 'bad\nkey' },
    { SMTP_API_BASE_URL: 'http://127.0.0.1:1000' },
    { SMTP_API_BASE_URL: 'https://user:secret@example.com' },
  ])('redacts invalid operator configuration', (overrides) => {
    expect(() => service([], overrides)).toThrow(
      'Invalid alert email transport configuration.',
    );
  });
});
