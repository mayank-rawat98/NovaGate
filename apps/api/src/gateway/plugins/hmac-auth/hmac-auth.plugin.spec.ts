import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
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
      providers: [
        HmacAuthPlugin,
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
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
    const timestamp = String(oldTimestamp);
    const ctx = makeCtx(
      body,
      sign(`${timestamp}.${body}`, 'sha256'),
      clockConfig,
      true,
    );
    (ctx.req.headers as Record<string, string>)['x-timestamp'] =
      String(oldTimestamp);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'HMAC_TIMESTAMP_INVALID',
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
    const ctx = makeCtx(
      body,
      sign(`${nowTimestamp}.${body}`, 'sha256'),
      clockConfig,
      true,
    );
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
  it.each([undefined, 'nonsense', '123junk', '1e10', '-1', '01'])(
    'rejects absent or malformed signed timestamps: %s',
    async (timestamp) => {
      const ctx = makeCtx(
        'hello',
        sign('hello'),
        { ...config, timestampHeader: 'x-time' },
        true,
      );
      if (timestamp !== undefined) ctx.req.headers['x-time'] = timestamp;
      expect((await plugin.onRequest(ctx))?.status).toBe(401);
      expect(ctx.authentication).toBeUndefined();
    },
  );
  it('rejects invalid hex suffixes instead of decoding them partially', async () => {
    expect(
      (
        await plugin.onRequest(
          makeCtx('hello', sign('hello') + 'ZZ', config, true),
        )
      )?.status,
    ).toBe(401);
  });
  it('rejects unsupported algorithm, missing/empty keys and invalid policy', async () => {
    for (const bad of [
      { ...config, algorithm: 'md5' },
      { ...config, secrets: [] },
      { ...config, secrets: [''] },
      { ...config, maxClockSkewSeconds: 0 },
      { ...config, mode: 'stripe', algorithm: 'sha512' },
    ]) {
      expect(
        (await plugin.onRequest(makeCtx('hello', sign('hello'), bad, true)))
          ?.status,
      ).toBe(500);
    }
  });
  it('does not authenticate a body-only signature with a replaced fresh timestamp', async () => {
    const ctx = makeCtx(
      'hello',
      sign('hello'),
      { ...config, timestampHeader: 'x-time' },
      true,
    );
    ctx.req.headers['x-time'] = String(Math.floor(Date.now() / 1000));
    expect((await plugin.onRequest(ctx))?.status).toBe(401);
  });
  it('uses original signature headers even after a header transform', async () => {
    const ctx = makeCtx('hello', sign('hello'), config, true);
    ctx.req.rawHeaders = ['x-hub-signature-256', 'invalid'];
    expect((await plugin.onRequest(ctx))?.status).toBe(401);
  });
  it('rejects duplicate wire signature headers and duplicate timestamp fields', async () => {
    const ctx = makeCtx('hello', sign('hello'), config, true);
    ctx.req.rawHeaders = [
      'x-hub-signature-256',
      sign('hello'),
      'X-Hub-Signature-256',
      sign('hello'),
    ];
    expect((await plugin.onRequest(ctx))?.status).toBe(401);
    (ctx.req as unknown as { rawHeaders?: string[] }).rawHeaders = undefined;
    const timestamp = Math.floor(Date.now() / 1000);
    ctx.route.plugins = [
      { name: 'hmac-auth', config: { ...config, mode: 'stripe' } },
    ];
    ctx.req.headers['x-hub-signature-256'] =
      `t=${timestamp},t=${timestamp},v1=${sign(`${timestamp}.hello`, 'sha256', false)}`;
    expect((await plugin.onRequest(ctx))?.status).toBe(401);
  });
  it('accepts Stripe rotation signatures over exact timestamp.body bytes', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = `t=${ts},v0=ignored,v1=${'0'.repeat(64)},v1=${sign(`${ts}.hello`, 'sha256', false)}`;
    const ctx = makeCtx(
      'hello',
      sig,
      { ...config, mode: 'stripe', secrets: ['old-key', SECRET] },
      true,
    );
    expect(await plugin.onRequest(ctx)).toBeUndefined();
    expect(ctx.authentication).toEqual({ method: 'hmac-auth' });
    const tampered = makeCtx(
      'changed',
      sig,
      { ...config, mode: 'stripe' },
      true,
    );
    expect((await plugin.onRequest(tampered))?.status).toBe(401);
  });
  it('verifies the independent published GitHub webhook reference vector', async () => {
    const ctx = makeCtx(
      'Hello, World!',
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      { ...config, secrets: ["It's a Secret to Everybody"] },
      true,
    );
    expect(await plugin.onRequest(ctx)).toBeUndefined();
  });

  it('bounds cached body and header bytes before authentication', async () => {
    const bounded = new HmacAuthPlugin(
      new ConfigService({ hmac: { maxBodyBytes: 4, maxHeaderBytes: 128 } }),
    );
    expect(
      (await bounded.onRequest(makeCtx('hello', sign('hello'), config, true)))
        ?.status,
    ).toBe(413);
    expect(
      (await bounded.onRequest(makeCtx('hi', 'a'.repeat(129), config, true)))
        ?.status,
    ).toBe(401);
  });
  it('releases upload admission after deadline and cancellation without leaving listeners', async () => {
    const bounded = new HmacAuthPlugin(
      new ConfigService({
        hmac: { bodyTimeoutMs: 100, maxPendingRequests: 1 },
      }),
    );
    const controller = new AbortController();
    const request = new PassThrough();
    Object.assign(request, {
      headers: { 'x-hub-signature-256': sign('hello') },
    });
    const stalled = makeCtx('hello', sign('hello'), config, true);
    stalled.req = request as unknown as PluginContext['req'];
    stalled.signal = controller.signal;
    const pending = bounded.onRequest(stalled);
    expect(
      (await bounded.onRequest(makeCtx('hello', sign('hello'), config, true)))
        ?.status,
    ).toBe(503);
    controller.abort();
    expect((await pending)?.status).toBe(400);
    expect(request.listenerCount('data')).toBe(0);
    expect(
      await bounded.onRequest(makeCtx('hello', sign('hello'), config, true)),
    ).toBeUndefined();
    stalled.signal = undefined;
    expect((await bounded.onRequest(stalled))?.status).toBe(408);
    expect(request.listenerCount('data')).toBe(0);
    request.destroy();
  });
  it('preparation never authenticates and keeps admission until the real response finishes', async () => {
    const bounded = new HmacAuthPlugin(
      new ConfigService({ hmac: { maxPendingRequests: 1 } }),
    );
    const response = new EventEmitter();
    const first = makeCtx('hello', sign('hello'), config, true);
    first.res = response as unknown as PluginContext['res'];
    expect(await bounded.prepareRequest(first)).toBeUndefined();
    expect(first.authentication).toBeUndefined();
    expect(await bounded.onRequest(first)).toBeUndefined();
    expect(first.authentication).toEqual({ method: 'hmac-auth' });
    expect(
      (await bounded.onRequest(makeCtx('hello', sign('hello'), config, true)))
        ?.status,
    ).toBe(503);
    response.emit('finish');
    response.emit('close'); // Idempotent release must not grant extra capacity.
    expect(response.listenerCount('finish')).toBe(0);
    expect(
      await bounded.onRequest(makeCtx('hello', sign('hello'), config, true)),
    ).toBeUndefined();
  });
  it('rejects too many Stripe rotation signatures and oversized keys', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig =
      `t=${ts},` +
      Array(9)
        .fill(`v1=${sign(`${ts}.hello`, 'sha256', false)}`)
        .join(',');
    expect(
      (
        await plugin.onRequest(
          makeCtx('hello', sig, { ...config, mode: 'stripe' }, true),
        )
      )?.status,
    ).toBe(401);
    expect(
      (
        await plugin.onRequest(
          makeCtx(
            'hello',
            sign('hello'),
            { ...config, secrets: ['x'.repeat(4097)] },
            true,
          ),
        )
      )?.status,
    ).toBe(500);
  });
});
