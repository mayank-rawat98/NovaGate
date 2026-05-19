import { Test } from '@nestjs/testing';
import * as crypto from 'crypto';
import { HmacAuthPlugin } from './hmac-auth.plugin';
import type { PluginContext } from '@api-gateway/shared-types';

const SECRET = 'test-secret-key';

function sign(
  body: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
  prefix = true,
): string {
  const sig = crypto.createHmac(algorithm, SECRET).update(body).digest('hex');
  return prefix ? `${algorithm}=${sig}` : sig;
}

function makeCtx(
  body: string | null,
  signatureHeader: string | undefined,
  config: Record<string, unknown>,
  rawBodyPreloaded = false,
): PluginContext {
  const headers: Record<string, string | undefined> = {};
  if (signatureHeader !== undefined) {
    headers['x-hub-signature-256'] = signatureHeader;
  }

  const req: Record<string, unknown> = { headers, user: undefined };

  if (rawBodyPreloaded && body !== null) {
    req.rawBody = Buffer.from(body);
  } else if (body !== null) {
    const { Readable } = require('stream');
    const stream = Readable.from([Buffer.from(body)]);
    Object.assign(req, stream);
    req.headers = headers;
    req.rawBody = undefined;
  }

  return {
    req: req as unknown as PluginContext['req'],
    res: {} as PluginContext['res'],
    route: {
      id: 'r1',
      method: 'POST',
      pathPattern: '/webhook',
      serviceId: 's1',
      authRequired: false,
      enabled: true,
      plugins: [{ name: 'hmac-auth', config }],
    },
    service: undefined,
    tenantId: 't1',
    requestId: 'req-1',
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

describe('HmacAuthPlugin', () => {
  let plugin: HmacAuthPlugin;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [HmacAuthPlugin],
    }).compile();
    plugin = module.get(HmacAuthPlugin);
  });

  const config = {
    header: 'x-hub-signature-256',
    algorithm: 'sha256',
    secrets: [SECRET],
  };

  it('rejects request with no signature header', async () => {
    const ctx = makeCtx('hello', undefined, config, true);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'HMAC_SIGNATURE_MISSING',
    );
  });

  it('accepts valid sha256 signature with prefix', async () => {
    const body = '{"event":"push"}';
    const ctx = makeCtx(body, sign(body, 'sha256'), config, true);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('accepts valid sha256 signature without prefix', async () => {
    const body = '{"event":"push"}';
    const ctx = makeCtx(body, sign(body, 'sha256', false), config, true);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('rejects invalid signature', async () => {
    const body = '{"event":"push"}';
    const ctx = makeCtx(body, 'sha256=deadbeef', config, true);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'HMAC_SIGNATURE_INVALID',
    );
  });

  it('accepts with any matching secret from the list (rotation)', async () => {
    const body = '{"event":"push"}';
    const oldSecret = 'old-secret';
    const multiConfig = { ...config, secrets: [oldSecret, SECRET] };
    const ctx = makeCtx(body, sign(body, 'sha256'), multiConfig, true);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('rejects when no secret in list matches', async () => {
    const body = '{"event":"push"}';
    const wrongConfig = { ...config, secrets: ['wrong-secret'] };
    const ctx = makeCtx(body, sign(body, 'sha256'), wrongConfig, true);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'HMAC_SIGNATURE_INVALID',
    );
  });

  it('rejects request outside clock skew window', async () => {
    const body = '{"event":"push"}';
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const clockConfig = {
      ...config,
      timestampHeader: 'x-timestamp',
      maxClockSkewSeconds: 300,
    };
    const ctx = makeCtx(body, sign(body, 'sha256'), clockConfig, true);
    (ctx.req.headers as Record<string, string>)['x-timestamp'] =
      String(oldTimestamp);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'HMAC_CLOCK_SKEW',
    );
  });

  it('accepts request within clock skew window', async () => {
    const body = '{"event":"push"}';
    const nowTimestamp = Math.floor(Date.now() / 1000);
    const clockConfig = {
      ...config,
      timestampHeader: 'x-timestamp',
      maxClockSkewSeconds: 300,
    };
    const ctx = makeCtx(body, sign(body, 'sha256'), clockConfig, true);
    (ctx.req.headers as Record<string, string>)['x-timestamp'] =
      String(nowTimestamp);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('supports sha512 algorithm', async () => {
    const body = '{"event":"push"}';
    const sha512Config = { ...config, algorithm: 'sha512' };
    const ctx = makeCtx(body, sign(body, 'sha512'), sha512Config, true);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });
});
