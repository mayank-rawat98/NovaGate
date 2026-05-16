import { Test } from '@nestjs/testing';
import * as crypto from 'crypto';
import * as http from 'http';
import jwt from 'jsonwebtoken';
import { OidcPlugin } from './oidc.plugin';
import type { PluginContext } from '@api-gateway/shared-types';

// Generate an RSA key pair for tests
let rsaPrivate: crypto.KeyObject;
let rsaPublicJwk: Record<string, unknown>;

beforeAll(() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  rsaPrivate = privateKey;
  rsaPublicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
});

function makeCtx(
  token: string | null,
  pluginConfig: Record<string, unknown>,
): PluginContext {
  const headers: Record<string, string> = token
    ? { authorization: `Bearer ${token}` }
    : {};
  return {
    req: { headers, user: undefined } as unknown as PluginContext['req'],
    res: {} as PluginContext['res'],
    route: {
      id: 'r1',
      method: 'GET',
      pathPattern: '/test',
      serviceId: 's1',
      authRequired: true,
      enabled: true,
      plugins: [{ name: 'oidc', config: pluginConfig }],
    },
    service: undefined,
    tenantId: 't1',
    requestId: 'req-1',
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

function startMockJwks(keys: unknown[]): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('OidcPlugin', () => {
  let plugin: OidcPlugin;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [OidcPlugin],
    }).compile();
    plugin = module.get(OidcPlugin);
    plugin.clearCache();
  });

  it('rejects request with no Authorization header', async () => {
    const ctx = makeCtx(null, {
      jwksUri: 'http://x',
      issuer: 'https://issuer',
    });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    const body = JSON.parse((result as { body: string }).body);
    expect(body.error).toBe('OIDC_TOKEN_MISSING');
  });

  it('rejects malformed token', async () => {
    const server = await startMockJwks([
      { ...rsaPublicJwk, kid: 'k1', kty: 'RSA' },
    ]);
    const { port } = server.address() as { port: number };
    const ctx2 = makeCtx('not.a.jwt', {
      jwksUri: `http://127.0.0.1:${port}/jwks`,
      issuer: 'https://issuer',
    });
    const result = await plugin.onRequest(ctx2);
    await new Promise<void>((r) => server.close(() => r()));
    expect(result).toBeDefined();
    const body = JSON.parse((result as { body: string }).body);
    expect(body.error).toBe('OIDC_TOKEN_INVALID');
  });

  it('accepts a valid RS256 token and forwards claims', async () => {
    const server = await startMockJwks([
      { ...rsaPublicJwk, kid: 'k1', kty: 'RSA', alg: 'RS256' },
    ]);
    const { port } = server.address() as { port: number };

    const token = jwt.sign(
      { sub: 'user-123', email: 'test@example.com' },
      rsaPrivate,
      {
        algorithm: 'RS256',
        issuer: 'https://issuer',
        keyid: 'k1',
        expiresIn: '1h',
      },
    );

    const ctx = makeCtx(token, {
      jwksUri: `http://127.0.0.1:${port}/jwks`,
      issuer: 'https://issuer',
      claimsToForward: ['sub', 'email'],
    });

    const result = await plugin.onRequest(ctx);
    await new Promise<void>((r) => server.close(() => r()));

    expect(result).toBeUndefined();
    expect(ctx.req.headers['x-claim-sub']).toBe('user-123');
    expect(ctx.req.headers['x-claim-email']).toBe('test@example.com');
  });

  it('rejects token with wrong issuer', async () => {
    const server = await startMockJwks([
      { ...rsaPublicJwk, kid: 'k1', kty: 'RSA', alg: 'RS256' },
    ]);
    const { port } = server.address() as { port: number };

    const token = jwt.sign({ sub: 'u1' }, rsaPrivate, {
      algorithm: 'RS256',
      issuer: 'https://wrong-issuer',
      keyid: 'k1',
      expiresIn: '1h',
    });

    const ctx = makeCtx(token, {
      jwksUri: `http://127.0.0.1:${port}/jwks`,
      issuer: 'https://issuer',
    });

    const result = await plugin.onRequest(ctx);
    await new Promise<void>((r) => server.close(() => r()));

    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'OIDC_TOKEN_INVALID',
    );
  });

  it('refreshes JWKS cache on kid miss', async () => {
    let callCount = 0;
    const server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((_req, res) => {
        callCount++;
        const keys =
          callCount === 1
            ? []
            : [{ ...rsaPublicJwk, kid: 'k2', kty: 'RSA', alg: 'RS256' }];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys }));
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as { port: number };

    const token = jwt.sign({ sub: 'u1' }, rsaPrivate, {
      algorithm: 'RS256',
      issuer: 'https://issuer',
      keyid: 'k2',
      expiresIn: '1h',
    });

    const ctx = makeCtx(token, {
      jwksUri: `http://127.0.0.1:${port}/jwks`,
      issuer: 'https://issuer',
    });

    const result = await plugin.onRequest(ctx);
    await new Promise<void>((r) => server.close(() => r()));

    // First fetch returns empty (kid miss), second fetch returns key k2
    expect(result).toBeUndefined();
    expect(callCount).toBe(2);
  });

  it('rejects expired token', async () => {
    const server = await startMockJwks([
      { ...rsaPublicJwk, kid: 'k1', kty: 'RSA', alg: 'RS256' },
    ]);
    const { port } = server.address() as { port: number };

    const token = jwt.sign({ sub: 'u1' }, rsaPrivate, {
      algorithm: 'RS256',
      issuer: 'https://issuer',
      keyid: 'k1',
      expiresIn: -10, // already expired
    });

    const ctx = makeCtx(token, {
      jwksUri: `http://127.0.0.1:${port}/jwks`,
      issuer: 'https://issuer',
    });

    const result = await plugin.onRequest(ctx);
    await new Promise<void>((r) => server.close(() => r()));

    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'OIDC_TOKEN_INVALID',
    );
  });
});
