import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  DATADOG_LOG_SITES,
  type LogExportDeliveryBatch,
} from '@api-gateway/shared-types';
import {
  ExportTransportService,
  EXPORT_TRANSPORT_CAPACITY,
  EXPORT_DELIVERY_DEADLINE_MS,
  EXPORT_RESPONSE_MAX_BYTES,
} from './export-transport.service';
import {
  EXPORT_MAX_BODY_BYTES,
  EXPORT_MAX_RECORDS,
} from './export-delivery-payload';
import { OutboundHttpError } from '../shared/outbound-http';

const batch: LogExportDeliveryBatch = {
  version: 1,
  tenantId: '00000000-0000-4000-8000-000000000001',
  destinationId: '00000000-0000-4000-8000-000000000002',
  deliveryId: '00000000-0000-4000-8000-000000000003',
  privacy: { clientIp: 'omit', userAgent: 'omit' },
  records: [
    {
      id: '00000000-0000-4000-8000-000000000004',
      method: 'GET',
      path: '/users/fixture',
      statusCode: 200,
      responseTimeMs: 12,
      requestId: '00000000-0000-4000-8000-000000000005',
      clientIp: '192.168.0.1',
      userAgent: 'private-user-agent',
      timestamp: '2026-10-11T06:00:00.123456Z',
    },
  ],
};
const signal = () => new AbortController().signal;
const signingSecret = 'fixture-export-signing-secret-of-at-least-32-bytes';
const webhook = (url: string) => ({ type: 'webhook', url, signingSecret });
const s3 = (
  endpoint: string,
  forcePathStyle = true,
  sessionToken?: string,
) => ({
  type: 's3',
  endpoint,
  bucket: 'fixture-logs',
  region: 'us-east-1',
  accessKeyId: 'fixture-access',
  secretAccessKey: 'fixture-secret-access',
  forcePathStyle,
  ...(sessionToken ? { sessionToken } : {}),
});
interface Received {
  body: Buffer;
  headers: IncomingMessage['headers'];
  method: string;
  path: string;
}
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Fixture received no request');
  return value;
}

// Independently verify the SDK signature against the bytes/headers actually received.
function verifyS3(received: Received, secret: string) {
  const authorization = String(received.headers.authorization);
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8}\/[^/]+\/s3\/aws4_request), SignedHeaders=([^,]+), Signature=([a-f\d]{64})$/.exec(
      authorization,
    );
  if (!match) throw new Error('Missing SigV4 authorization');
  const [, access, scope, names, signature] = match;
  expect(access).toBe('fixture-access');
  const date = String(received.headers['x-amz-date']);
  const bodyHash = createHash('sha256').update(received.body).digest('hex');
  expect(received.headers['x-amz-content-sha256']).toBe(bodyHash);
  const url = new URL(received.path, 'https://fixture.invalid');
  const query = [...url.searchParams]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join('&');
  const canonicalHeaders = names
    .split(';')
    .map(
      (name) =>
        `${name}:${String(received.headers[name]).trim().replace(/\s+/g, ' ')}\n`,
    )
    .join('');
  const canonical = [
    received.method,
    url.pathname,
    query,
    canonicalHeaders,
    names,
    bodyHash,
  ].join('\n');
  const hash = createHash('sha256').update(canonical).digest('hex');
  const [day, region] = scope.split('/');
  const hmac = (key: string | Buffer, data: string) =>
    createHmac('sha256', key).update(data).digest();
  const key = hmac(
    hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'),
    'aws4_request',
  );
  expect(
    createHmac('sha256', key)
      .update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash}`)
      .digest('hex'),
  ).toBe(signature);
}

describe('external export transports (actual controlled receivers)', () => {
  const servers: Server[] = [];
  const services: ExportTransportService[] = [];
  const directories: string[] = [];
  async function listen(server: Server, protocol = 'http') {
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return `${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function receiver(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ) {
    return listen(createServer(handler));
  }
  function service(
    origins: string[] = [],
    overrides: Record<string, unknown> = {},
  ) {
    const result = new ExportTransportService(
      new ConfigService({
        LOG_EXPORT_HTTP_TRUSTED_ORIGINS: JSON.stringify(origins),
        ...overrides,
      }),
    );
    services.push(result);
    return result;
  }
  function capture(received: Received[], status = 202) {
    return (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          body: Buffer.concat(chunks),
          headers: req.headers,
          method: req.method ?? '',
          path: req.url ?? '',
        });
        res.writeHead(status);
        res.end('accepted');
      });
    };
  }
  // Test-only routing changes port and CA, retaining production URL, Host/SNI,
  // TLS identity checks, signer, DNS lookup and the actual body on the socket.
  async function tlsReceiver(
    hostnames: string[],
    received: Received[],
    trustCertificate = true,
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'novagate-export-tls-'));
    directories.push(directory);
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
        '/CN=fixture.novagate.test',
        '-addext',
        `subjectAltName=${hostnames.map((host) => `DNS:${host}`).join(',')}`,
      ],
      { cwd: directory, stdio: 'ignore', timeout: 15000 },
    );
    const cert = readFileSync(join(directory, 'cert.pem'));
    const origin = await listen(
      https.createServer(
        { key: readFileSync(join(directory, 'key.pem')), cert },
        capture(received),
      ),
      'https',
    );
    const port = Number(new URL(origin).port);
    const original = https.request;
    jest.spyOn(https, 'request').mockImplementation(((
      options: https.RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      expect(hostnames).toContain(options.hostname);
      expect(options.rejectUnauthorized).toBe(true);
      const request = original(
        {
          ...options,
          port,
          ca: trustCertificate ? cert : undefined,
          headers: {
            ...options.headers,
            Host: `${options.hostname}${options.port ? `:${options.port}` : ''}`,
          },
        },
        callback,
      );
      return request;
    }) as typeof https.request);
    jest.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['127.0.0.1']);
    jest.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
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
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });
  it('sends exact signed NDJSON bytes, stable identity and only documented private fields', async () => {
    const received: Received[] = [];
    const origin = await receiver(capture(received));
    const records = [
      {
        ...batch.records[0],
        credentials: 'never-serialize',
        receipt: 'never-serialize',
      },
    ];
    const transport = service([origin]);
    await transport.deliver(
      webhook(`${origin}/private-token?key=fixture-secret`),
      { ...batch, records },
      signal(),
    );
    const first = present(received[0]);
    expect(first.method).toBe('POST');
    expect(first.path).toBe('/private-token?key=fixture-secret');
    expect(first.headers['content-type']).toBe('application/x-ndjson');
    expect(first.headers['content-length']).toBe(String(first.body.length));
    expect(first.headers['x-novagate-delivery-id']).toBe(batch.deliveryId);
    const timestamp = String(first.headers['x-novagate-timestamp']);
    expect(first.headers['x-novagate-signature']).toBe(
      `v1=${createHmac('sha256', signingSecret).update(timestamp).update('.').update(batch.deliveryId).update('.').update(first.body).digest('hex')}`,
    );
    expect(first.body.toString()).toMatch(/\n$/);
    expect(first.body.toString()).not.toMatch(
      /never-serialize|private-user-agent|192\.168\.0\.1/,
    );
    expect(JSON.parse(first.body.toString())).toEqual({
      ...batch.records[0],
      clientIp: '[redacted]',
      userAgent: undefined,
    });
    await transport.deliver(webhook(origin), { ...batch, records }, signal());
    expect(received[1].headers['x-novagate-delivery-id']).toBe(
      batch.deliveryId,
    );
    expect(received[1].body).toEqual(first.body);
    expect(batch.records[0].clientIp).toBe('192.168.0.1');
  });
  it('enforces the union of tenant and destination redactions without changing source records', async () => {
    const received: Received[] = [];
    const origin = await receiver(capture(received));
    await service([origin]).deliver(
      webhook(origin),
      {
        ...batch,
        privacy: {
          clientIp: 'omit',
          userAgent: 'retain',
          redactedFields: ['path'],
        },
        payloadPrivacy: {
          clientIp: 'retain',
          userAgent: 'omit',
          redactedFields: ['requestId'],
        },
      },
      signal(),
    );
    const record = JSON.parse(received[0].body.toString());
    expect(record.path).toBe('[redacted]');
    expect(record.requestId).toBe('[redacted]');
    expect(record.clientIp).toBe('[redacted]');
    expect(record.userAgent).toBeUndefined();
    expect(batch.records[0].path).toBe('/users/fixture');
  });
  it.each([false, true])(
    'uses official SigV4 with immutable object keys and temporary credentials: %s',
    async (temporary) => {
      const received: Received[] = [];
      const origin = await receiver(capture(received, 200));
      const transport = service([origin]);
      const credentials = s3(
        origin,
        true,
        temporary ? 'fixture-session-token' : undefined,
      );
      await transport.deliver(credentials, batch, signal());
      await transport.deliver(credentials, batch, signal());
      expect(received).toHaveLength(2);
      for (const request of received) {
        expect(request.path.split('?')[0]).toBe(
          `/fixture-logs/novagate/${batch.tenantId}/${batch.destinationId}/${batch.deliveryId}.ndjson`,
        );
        expect(request.headers['x-amz-security-token']).toBe(
          temporary ? 'fixture-session-token' : undefined,
        );
        expect(request.headers['x-amz-meta-novagate-delivery-id']).toBe(
          batch.deliveryId,
        );
        expect(request.headers['content-type']).toBe('application/x-ndjson');
        verifyS3(request, 'fixture-secret-access');
      }
      expect(received[0].body).toEqual(received[1].body);
    },
  );
  it('uses verified TLS and virtual bucket addressing without a second DNS lookup', async () => {
    const received: Received[] = [];
    const hostname = 'fixture-logs.storage.novagate.test';
    await tlsReceiver([hostname], received);
    await service([`https://${hostname}`]).deliver(
      s3('https://storage.novagate.test', false),
      batch,
      signal(),
    );
    expect(received[0].headers.host).toBe(hostname);
    expect(received[0].path.split('?')[0]).toBe(
      `/novagate/${batch.tenantId}/${batch.destinationId}/${batch.deliveryId}.ndjson`,
    );
    verifyS3(received[0], 'fixture-secret-access');
    expect(Resolver.prototype.resolve4).toHaveBeenCalledTimes(1);
    expect(Resolver.prototype.resolve4).toHaveBeenCalledWith(hostname);
    expect(Resolver.prototype.resolve6).toHaveBeenCalledTimes(1);
  });
  it('keeps certificate verification enabled for an operator-trusted origin', async () => {
    const received: Received[] = [];
    const hostname = 'logs.novagate.test';
    await tlsReceiver([hostname], received, false);
    await expect(
      service([`https://${hostname}`]).deliver(
        webhook(`https://${hostname}`),
        batch,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'connection_failed' });
    expect(received).toHaveLength(0);
  });
  it('cancels an S3 request and releases its socket before returning', async () => {
    let started!: () => void;
    const admitted = new Promise<void>((done) => {
      started = done;
    });
    const origin = await receiver((_req, res) => {
      res.write('partial');
      started();
    });
    const controller = new AbortController();
    const transport = service([origin]);
    const outcome = transport
      .deliver(s3(origin), batch, controller.signal)
      .catch((error) => error);
    await admitted;
    controller.abort();
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    await transport.onModuleDestroy();
  });
  it('sends documented Datadog regional intake payloads with separate API credentials', async () => {
    const received: Received[] = [];
    const hostnames = DATADOG_LOG_SITES.map(
      (site) => `http-intake.logs.${site}`,
    );
    await tlsReceiver(hostnames, received);
    const transport = service(
      hostnames.map((hostname) => `https://${hostname}`),
    );
    for (const site of DATADOG_LOG_SITES)
      await transport.deliver(
        { type: 'datadog', site, apiKey: 'b'.repeat(32) },
        batch,
        signal(),
      );
    expect(received).toHaveLength(DATADOG_LOG_SITES.length);
    received.forEach((request, index) => {
      expect(request.headers.host).toBe(hostnames[index]);
      expect(request.path).toBe('/api/v2/logs');
      expect(request.headers['dd-api-key']).toBe('b'.repeat(32));
      expect(request.headers['content-type']).toBe('application/json');
      const records = JSON.parse(request.body.toString());
      expect(records).toHaveLength(1);
      expect(records[0].ddsource).toBe('novagate');
      expect(records[0].service).toBe('novagate-gateway');
      expect(records[0].novagate).toEqual({
        version: 1,
        tenantId: batch.tenantId,
        destinationId: batch.destinationId,
        deliveryId: batch.deliveryId,
        recordId: batch.records[0].id,
      });
      expect(JSON.parse(records[0].message).clientIp).toBe('[redacted]');
      expect(request.body.toString()).not.toMatch(
        /bbbbbbbb|private-user-agent|192\.168\.0\.1/,
      );
    });
  });
  it.each([301, 307, 400, 403, 408, 429, 500, 503])(
    'does not retry or follow redirects for S3 status %s',
    async (status) => {
      let requests = 0;
      const origin = await receiver((_req, res) => {
        requests++;
        res.writeHead(status, { Location: '/private-redirect' });
        res.end('provider-secret-details');
      });
      const error = await service([origin])
        .deliver(s3(origin), batch, signal())
        .catch((e) => e);
      expect(error).toBeInstanceOf(OutboundHttpError);
      expect(error.code).toBe(
        status >= 300 && status < 400
          ? 'redirect_refused'
          : [408, 429].includes(status) || status >= 500
            ? 'http_retryable'
            : 'http_client_error',
      );
      expect(error.retryable).toBe(
        [408, 429].includes(status) || status >= 500,
      );
      expect(error.message).not.toMatch(/secret|fixture|127\.0\.0\.1/);
      expect(requests).toBe(1);
    },
  );
  it.each([
    'http://example.com',
    'https://127.0.0.1',
    'https://169.254.169.254',
    'https://[::ffff:127.0.0.1]',
    'https://example.com:8443',
    'https://user:secret@example.com',
    'https://example.com/path#secret',
  ])('blocks unsafe export URL %s before DNS', async (url) => {
    const dns = jest.spyOn(Resolver.prototype, 'resolve4');
    await expect(
      service().deliver(webhook(url), batch, signal()),
    ).rejects.toMatchObject({ code: 'blocked_destination' });
    expect(dns).not.toHaveBeenCalled();
  });
  it('never inherits alert trusted origins', async () => {
    const origin = await receiver(capture([]));
    await expect(
      service([], {
        ALERT_HTTP_TRUSTED_ORIGINS: JSON.stringify([origin]),
      }).deliver(webhook(origin), batch, signal()),
    ).rejects.toMatchObject({ code: 'blocked_destination' });
  });
  it.each([
    [['8.8.8.8', '127.0.0.1'], []],
    [['8.8.8.8'], ['2001:db8::1']],
    [Array.from({ length: 17 }, () => '8.8.8.8'), []],
  ])('validates all resolved addresses for export egress', async (v4, v6) => {
    jest.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(v4);
    jest.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue(v6);
    await expect(
      service().deliver(webhook('https://logs.example.com'), batch, signal()),
    ).rejects.toMatchObject({ code: 'blocked_destination' });
  });
  it.each([true, false])(
    'bounds provider response bytes including a chunked body: %s',
    async (declared) => {
      const origin = await receiver((_req, res) => {
        if (declared)
          res.setHeader('Content-Length', EXPORT_RESPONSE_MAX_BYTES + 1);
        res.end(Buffer.alloc(EXPORT_RESPONSE_MAX_BYTES + 1));
      });
      await expect(
        service([origin]).deliver(webhook(origin), batch, signal()),
      ).rejects.toMatchObject({ code: 'response_too_large' });
    },
  );
  it.each([
    { ...batch, records: [] },
    {
      ...batch,
      records: Array.from(
        { length: EXPORT_MAX_RECORDS + 1 },
        () => batch.records[0],
      ),
    },
    { ...batch, privacy: undefined },
    {
      ...batch,
      privacy: {
        clientIp: 'retain',
        userAgent: 'retain',
        redactedFields: ['unknown'],
      },
    },
    { ...batch, deliveryId: 'not-a-uuid' },
    { ...batch, records: [{ ...batch.records[0], statusCode: 42 }] },
    { ...batch, records: [{ ...batch.records[0], responseTimeMs: NaN }] },
    { ...batch, records: [{ ...batch.records[0], path: 'x'.repeat(4097) }] },
    {
      ...batch,
      records: Array.from({ length: EXPORT_MAX_RECORDS }, () => ({
        ...batch.records[0],
        path: 'x'.repeat(4096),
      })),
    },
  ])('rejects invalid/oversized payloads without DNS', async (payload) => {
    const dns = jest.spyOn(Resolver.prototype, 'resolve4');
    await expect(
      service().deliver(
        webhook('https://logs.example.com'),
        payload as LogExportDeliveryBatch,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(dns).not.toHaveBeenCalled();
  });
  it('includes Datadog envelope overhead in the final byte limit', async () => {
    const dns = jest.spyOn(Resolver.prototype, 'resolve4');
    const payload = {
      ...batch,
      records: Array.from({ length: 200 }, () => ({
        ...batch.records[0],
        path: '"'.repeat(2200),
      })),
    };
    const ndjsonSize = Buffer.byteLength(
      payload.records
        .map((row) =>
          JSON.stringify({
            ...row,
            clientIp: '[redacted]',
            userAgent: undefined,
          }),
        )
        .join('\n') + '\n',
    );
    expect(ndjsonSize).toBeLessThan(EXPORT_MAX_BODY_BYTES);
    await expect(
      service().deliver(
        { type: 'datadog', site: 'datadoghq.com', apiKey: 'b'.repeat(32) },
        payload,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(dns).not.toHaveBeenCalled();
  });
  it('rejects a malformed dedicated trusted-origin setting at startup', () => {
    expect(() =>
      service([], {
        LOG_EXPORT_HTTP_TRUSTED_ORIGINS: '["https://example.com/path"]',
      }),
    ).toThrow('Invalid LOG_EXPORT_HTTP_TRUSTED_ORIGINS.');
  });
  it('owns capacity through actual cancellation and drains sockets on shutdown', async () => {
    let ready!: () => void;
    const admitted = new Promise<void>((done) => {
      ready = done;
    });
    let count = 0;
    const origin = await receiver((_req, res) => {
      res.write('partial');
      if (++count === EXPORT_TRANSPORT_CAPACITY) ready();
    });
    const transport = service([origin]);
    const work = Array.from({ length: EXPORT_TRANSPORT_CAPACITY }, () =>
      transport.deliver(webhook(origin), batch, signal()).catch((e) => e),
    );
    await admitted;
    await expect(
      transport.deliver(webhook(origin), batch, signal()),
    ).rejects.toMatchObject({ code: 'busy', retryable: true });
    await transport.onModuleDestroy();
    expect(
      (await Promise.all(work)).every((error) => error.code === 'cancelled'),
    ).toBe(true);
    await expect(
      transport.deliver(webhook(origin), batch, signal()),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('has an absolute deadline even when a receiver keeps streaming', async () => {
    const intervals: ReturnType<typeof setInterval>[] = [];
    const origin = await receiver((_req, res) => {
      res.write('start');
      const tick = setInterval(() => res.write('.'), 5);
      intervals.push(tick);
      res.on('close', () => clearInterval(tick));
    });
    const original = setTimeout;
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        original(
          callback,
          delay === EXPORT_DELIVERY_DEADLINE_MS ? 100 : delay,
          ...args,
        )) as typeof setTimeout);
    try {
      await expect(
        service([origin]).deliver(webhook(origin), batch, signal()),
      ).rejects.toMatchObject({ code: 'timeout', retryable: true });
    } finally {
      intervals.forEach(clearInterval);
    }
  });
  it('cancels DNS and preserves admission until the resolver actually settles', async () => {
    let release!: () => void;
    const settling = new Promise<string[]>((done) => {
      release = () => done([]);
    });
    jest.spyOn(Resolver.prototype, 'resolve4').mockReturnValue(settling);
    jest.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
    const cancelled = jest
      .spyOn(Resolver.prototype, 'cancel')
      .mockImplementation(() => undefined);
    const transport = service();
    const controllers = Array.from(
      { length: EXPORT_TRANSPORT_CAPACITY },
      () => new AbortController(),
    );
    const work = controllers.map((controller) =>
      transport
        .deliver(webhook('https://logs.example.com'), batch, controller.signal)
        .catch((e) => e),
    );
    await new Promise((done) => setImmediate(done));
    controllers.forEach((controller) => controller.abort());
    await expect(
      transport.deliver(webhook('https://logs.example.com'), batch, signal()),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(cancelled).toHaveBeenCalledTimes(EXPORT_TRANSPORT_CAPACITY);
    let destroyed = false;
    const shutdown = transport.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await new Promise((done) => setImmediate(done));
    expect(destroyed).toBe(false);
    release();
    await shutdown;
    expect(
      (await Promise.all(work)).every((error) => error.code === 'cancelled'),
    ).toBe(true);
  });
});
