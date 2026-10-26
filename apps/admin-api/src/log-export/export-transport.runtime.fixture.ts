import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import https from 'node:https';
import { Resolver } from 'node:dns/promises';
import type {
  ResolveOptions,
  ResolveWithTtlOptions,
  RecordWithTtl,
} from 'node:dns';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import type { LogExportDeliveryBatch } from '@api-gateway/shared-types';
import { ExportTransportService } from './export-transport.service';

function fixtureAddresses(hostname: string): Promise<string[]>;
function fixtureAddresses(
  hostname: string,
  options: ResolveWithTtlOptions,
): Promise<RecordWithTtl[]>;
function fixtureAddresses(
  hostname: string,
  options: ResolveOptions,
): Promise<string[] | RecordWithTtl[]>;
function fixtureAddresses(
  _hostname: string,
  options?: ResolveOptions,
): Promise<string[] | RecordWithTtl[]> {
  return Promise.resolve(
    options?.ttl ? [{ address: '127.0.0.1', ttl: 1 }] : ['127.0.0.1'],
  );
}

async function verify() {
  assert.notEqual(
    process.getuid?.(),
    0,
    'Verify in the actual non-root production image.',
  );
  const servers: Server[] = [];
  const services: ExportTransportService[] = [];
  const received: Array<{
    body: Buffer;
    headers: IncomingMessage['headers'];
    path: string;
    method: string;
  }> = [];
  const handler: Parameters<typeof createServer>[1] = (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        body: Buffer.concat(chunks),
        headers: request.headers,
        path: request.url ?? '',
        method: request.method ?? '',
      });
      response.writeHead(202);
      response.end();
    });
  };
  async function listen(server: Server, protocol = 'http') {
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return `${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const originalHttps = https.request;
  const originalV4 = Resolver.prototype.resolve4;
  const originalV6 = Resolver.prototype.resolve6;
  try {
    const origin = await listen(createServer(handler));
    const cert = readFileSync('/app/fixture-tls/cert.pem');
    const secure = await listen(
      https.createServer(
        { key: readFileSync('/app/fixture-tls/key.pem'), cert },
        handler,
      ),
      'https',
    );
    const port = Number(new URL(secure).port);
    https.request = ((
      options: https.RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      assert.ok(
        [
          'http-intake.logs.datadoghq.eu',
          'fixture-logs.storage.novagate.test',
        ].includes(String(options.hostname)),
      );
      assert.equal(options.rejectUnauthorized, true);
      return originalHttps(
        {
          ...options,
          port,
          ca: cert,
          headers: { ...options.headers, Host: String(options.hostname) },
        },
        callback,
      );
    }) as typeof https.request;
    Resolver.prototype.resolve4 = fixtureAddresses;
    Resolver.prototype.resolve6 = (async () => []) as Resolver['resolve6'];
    const transport = new ExportTransportService(
      new ConfigService({
        LOG_EXPORT_HTTP_TRUSTED_ORIGINS: JSON.stringify([
          origin,
          'https://http-intake.logs.datadoghq.eu',
          'https://fixture-logs.storage.novagate.test',
        ]),
      }),
    );
    services.push(transport);
    const batch: LogExportDeliveryBatch = {
      version: 1,
      tenantId: randomUUID(),
      destinationId: randomUUID(),
      deliveryId: randomUUID(),
      privacy: {
        clientIp: 'omit',
        userAgent: 'omit',
        redactedFields: ['path'],
      },
      records: [
        {
          id: randomUUID(),
          method: 'GET',
          path: '/private-path',
          statusCode: 200,
          responseTimeMs: 1,
          requestId: randomUUID(),
          timestamp: '2026-10-11T00:00:00.000001Z',
          clientIp: '192.168.0.1',
          userAgent: 'private-agent',
        },
      ],
    };
    const signingSecret = 'container-fixture-export-signing-secret-only';
    await transport.deliver(
      { type: 'webhook', url: `${origin}/fixture`, signingSecret },
      batch,
      new AbortController().signal,
    );
    await transport.deliver(
      {
        type: 's3',
        endpoint: origin,
        bucket: 'fixture-logs',
        region: 'us-east-1',
        accessKeyId: 'fixture-key',
        secretAccessKey: 'fixture-secret-only',
        sessionToken: 'fixture-session',
        forcePathStyle: true,
      },
      batch,
      new AbortController().signal,
    );
    await transport.deliver(
      {
        type: 's3',
        endpoint: 'https://storage.novagate.test',
        bucket: 'fixture-logs',
        region: 'us-east-1',
        accessKeyId: 'fixture-key',
        secretAccessKey: 'fixture-secret-only',
        forcePathStyle: false,
      },
      batch,
      new AbortController().signal,
    );
    await transport.deliver(
      { type: 'datadog', site: 'datadoghq.eu', apiKey: 'b'.repeat(32) },
      batch,
      new AbortController().signal,
    );
    assert.equal(received.length, 4);
    const [webhook, pathS3, virtualS3, datadog] = received;
    assert.equal(webhook.headers['content-type'], 'application/x-ndjson');
    assert.equal(webhook.headers['x-novagate-delivery-id'], batch.deliveryId);
    assert.equal(
      webhook.headers['x-novagate-signature'],
      `v1=${createHmac('sha256', signingSecret).update(String(webhook.headers['x-novagate-timestamp'])).update('.').update(batch.deliveryId).update('.').update(webhook.body).digest('hex')}`,
    );
    for (const request of [pathS3, virtualS3]) {
      assert.equal(request.method, 'PUT');
      assert.match(String(request.headers.authorization), /^AWS4-HMAC-SHA256 /);
      assert.match(request.path, new RegExp(`${batch.deliveryId}\\.ndjson`));
      assert.equal(
        request.headers['x-amz-meta-novagate-delivery-id'],
        batch.deliveryId,
      );
      assert.deepEqual(request.body, webhook.body);
    }
    assert.equal(pathS3.headers['x-amz-security-token'], 'fixture-session');
    assert.equal(virtualS3.headers.host, 'fixture-logs.storage.novagate.test');
    assert.equal(datadog.path, '/api/v2/logs');
    assert.equal(datadog.headers['dd-api-key'], 'b'.repeat(32));
    const intake = JSON.parse(datadog.body.toString());
    assert.equal(intake[0].novagate.deliveryId, batch.deliveryId);
    for (const record of [
      JSON.parse(webhook.body.toString()),
      JSON.parse(intake[0].message),
    ]) {
      assert.equal(record.path, '[redacted]');
      assert.equal(record.clientIp, '[redacted]');
      assert.equal(record.userAgent, undefined);
    }
    await transport.onModuleDestroy();
    await assert.rejects(
      transport.deliver(
        { type: 'webhook', url: origin, signingSecret },
        batch,
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'cancelled',
    );
    console.log(
      JSON.stringify({
        externalExportTransport: 'passed',
        providers: [
          'signed-ndjson',
          's3-path-temporary',
          's3-virtual-tls',
          'datadog-eu-tls',
        ],
        uid: process.getuid?.(),
        shutdown: 'drained',
      }),
    );
  } finally {
    https.request = originalHttps;
    Resolver.prototype.resolve4 = originalV4;
    Resolver.prototype.resolve6 = originalV6;
    await Promise.allSettled(
      services.map((service) => service.onModuleDestroy()),
    );
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      ),
    );
  }
}
void verify().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
