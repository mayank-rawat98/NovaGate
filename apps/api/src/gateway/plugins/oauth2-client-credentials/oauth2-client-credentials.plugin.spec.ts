import { ConfigService } from '@nestjs/config';
import { IdentityProviderService } from '../identity-provider/identity-provider.service';
import { Test } from '@nestjs/testing';
import * as http from 'http';
import { OAuth2ClientCredentialsPlugin } from './oauth2-client-credentials.plugin';
import { REDIS_CLIENT } from '../../shared/redis.tokens';
import type { PluginContext } from '@api-gateway/shared-types';

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
      pathPattern: '/api',
      serviceId: 's1',
      authRequired: true,
      enabled: true,
      plugins: [{ name: 'oauth2-client-credentials', config: pluginConfig }],
    },
    service: undefined,
    tenantId: 't1',
    requestId: 'req-1',
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('OAuth2ClientCredentialsPlugin', () => {
  let plugin: OAuth2ClientCredentialsPlugin;
  let mockRedis: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const module = await Test.createTestingModule({
      providers: [
        OAuth2ClientCredentialsPlugin,
        IdentityProviderService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            identityProvider: { allowInsecureHttp: true },
          }),
        },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();
    plugin = module.get(OAuth2ClientCredentialsPlugin);
  });

  describe('introspection mode', () => {
    it('rejects request with no Bearer token', async () => {
      const ctx = makeCtx(null, {
        introspectionEndpoint: 'http://x/introspect',
        clientId: 'id',
        clientSecret: 'secret',
      });
      const result = await plugin.onRequest(ctx);
      expect(result).toBeDefined();
      expect(JSON.parse((result as { body: string }).body).error).toBe(
        'OAUTH2_TOKEN_MISSING',
      );
    });

    it('accepts active token from introspection', async () => {
      const server = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            active: true,
            sub: 'user-42',
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        );
      });
      const { port } = server.address() as { port: number };

      const ctx = makeCtx('active-token', {
        introspectionEndpoint: `http://127.0.0.1:${port}/introspect`,
        clientId: 'id',
        clientSecret: 'secret',
      });

      const result = await plugin.onRequest(ctx);
      await new Promise<void>((r) => server.close(() => r()));

      expect(result).toBeUndefined();
      expect(ctx.authentication?.subject).toBe('user-42');
    });

    it('rejects inactive token', async () => {
      const server = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: false }));
      });
      const { port } = server.address() as { port: number };

      const ctx = makeCtx('inactive-token', {
        introspectionEndpoint: `http://127.0.0.1:${port}/introspect`,
        clientId: 'id',
        clientSecret: 'secret',
      });

      const result = await plugin.onRequest(ctx);
      await new Promise<void>((r) => server.close(() => r()));

      expect(result).toBeDefined();
      expect(JSON.parse((result as { body: string }).body).error).toBe(
        'OAUTH2_TOKEN_INACTIVE',
      );
    });

    it('uses cached introspection result from Redis', async () => {
      const cachedResult = {
        active: true,
        sub: 'cached-user',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      mockRedis.get.mockImplementationOnce(async (scope: string) =>
        JSON.stringify({
          version: 2,
          scope,
          expiresAt: Date.now() + 10000,
          result: cachedResult,
        }),
      );

      const ctx = makeCtx('cached-token', {
        introspectionEndpoint: 'http://should-not-be-called/introspect',
        clientId: 'id',
        clientSecret: 'secret',
      });

      const result = await plugin.onRequest(ctx);
      expect(result).toBeUndefined();
      expect(ctx.authentication?.subject).toBe('cached-user');
    });

    it('caches introspection result in Redis with TTL', async () => {
      const exp = Math.floor(Date.now() / 1000) + 1000;
      const server = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: true, sub: 'u1', exp }));
      });
      const { port } = server.address() as { port: number };

      const ctx = makeCtx('new-token', {
        introspectionEndpoint: `http://127.0.0.1:${port}/introspect`,
        clientId: 'id',
        clientSecret: 'secret',
      });

      await plugin.onRequest(ctx);
      await new Promise<void>((r) => server.close(() => r()));

      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining('oauth2:introspect:'),
        expect.any(String),
        'PX',
        expect.any(Number),
      );
      const [, , , ttl] = mockRedis.set.mock.calls[0];
      expect(ttl).toBeGreaterThan(0);
    });

    it('verifies remotely when Redis is unavailable', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('Redis down'));

      const server = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: true, sub: 'u1' }));
      });
      const { port } = server.address() as { port: number };

      const ctx = makeCtx('token', {
        introspectionEndpoint: `http://127.0.0.1:${port}/introspect`,
        clientId: 'id',
        clientSecret: 'secret',
      });

      const result = await plugin.onRequest(ctx);
      await new Promise<void>((r) => server.close(() => r()));
      expect(result).toBeUndefined();
    });
  });

  describe('client credentials grant mode (outbound token injection)', () => {
    it('fetches token and injects into request header', async () => {
      const server = await startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'upstream-token-123',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
      });
      const { port } = server.address() as { port: number };

      const ctx = makeCtx(null, {
        tokenEndpoint: `http://127.0.0.1:${port}/token`,
        clientId: 'my-client',
        clientSecret: 'my-secret',
        scopes: ['read', 'write'],
      });

      const result = await plugin.onRequest(ctx);
      await new Promise<void>((r) => server.close(() => r()));

      expect(result).toBeUndefined();
      expect(ctx.req.headers['authorization']).toBe(
        'Bearer upstream-token-123',
      );
    });
  });
  it('isolates identical tokens across tenants, providers and credential rotation', async () => {
    const cache = new Map<string, string>();
    mockRedis.get.mockImplementation(
      async (key: string) => cache.get(key) ?? null,
    );
    mockRedis.set.mockImplementation(async (key: string, value: string) => {
      cache.set(key, value);
      return 'OK';
    });
    let calls = 0;
    const server = await startMockServer((req, res) => {
      calls++;
      const trusted =
        req.url === '/trusted' &&
        req.headers.authorization ===
          `Basic ${Buffer.from('id:secret').toString('base64')}`;
      res.end(
        JSON.stringify({
          active: trusted,
          sub: 'trusted-user',
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      );
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const config = {
      introspectionEndpoint: base + '/trusted',
      clientId: 'id',
      clientSecret: 'secret',
    };
    try {
      expect(
        await plugin.onRequest(makeCtx('same-token', config)),
      ).toBeUndefined();
      expect(
        await plugin.onRequest(makeCtx('same-token', config)),
      ).toBeUndefined();
      expect(calls).toBe(1);
      const otherTenant = makeCtx('same-token', config);
      otherTenant.tenantId = 'other';
      expect(await plugin.onRequest(otherTenant)).toBeUndefined();
      expect(calls).toBe(2);
      expect(
        (
          await plugin.onRequest(
            makeCtx('same-token', {
              ...config,
              introspectionEndpoint: base + '/untrusted',
            }),
          )
        )?.status,
      ).toBe(401);
      expect(
        (
          await plugin.onRequest(
            makeCtx('same-token', { ...config, clientSecret: 'rotated' }),
          )
        )?.status,
      ).toBe(401);
      expect(calls).toBe(4);
      expect([...cache.keys()].join()).not.toContain('same-token');
      expect([...cache.keys()].join()).not.toContain('secret');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('fetches new outbound credentials after a secret change', async () => {
    let calls = 0;
    const server = await startMockServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        calls++;
        res.end(
          JSON.stringify({
            access_token: new URLSearchParams(body).get('client_secret'),
            token_type: 'Bearer',
            expires_in: 300,
          }),
        );
      });
    });
    const config = {
      tokenEndpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      clientId: 'id',
      clientSecret: 'old',
    };
    try {
      const first = makeCtx(null, config);
      expect(await plugin.onRequest(first)).toBeUndefined();
      const cached = makeCtx(null, config);
      expect(await plugin.onRequest(cached)).toBeUndefined();
      const rotated = makeCtx(null, { ...config, clientSecret: 'new' });
      expect(await plugin.onRequest(rotated)).toBeUndefined();
      expect(first.req.headers.authorization).toBe('Bearer old');
      expect(rotated.req.headers.authorization).toBe('Bearer new');
      expect(rotated.authentication).toBeUndefined();
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([
    [{ active: 'false' }, 503],
    [{ active: true, exp: 1 }, 401],
    [{ active: true, exp: '3000000000' }, 503],
    [{ active: true, nbf: 3000000000 }, 401],
    [{ active: true, sub: {} }, 503],
    [{ active: false }, 401],
  ])(
    'never authenticates an invalid introspection result %j',
    async (response, status) => {
      const server = await startMockServer((_req, res) =>
        res.end(JSON.stringify(response)),
      );
      try {
        const ctx = makeCtx('token', {
          introspectionEndpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          clientId: 'id',
          clientSecret: 'secret',
        });
        expect((await plugin.onRequest(ctx))?.status).toBe(status);
        expect(ctx.authentication).toBeUndefined();
        expect(mockRedis.set).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it('rejects legacy cache entries and verifies remotely', async () => {
    mockRedis.get.mockResolvedValue(
      JSON.stringify({ active: true, sub: 'legacy' }),
    );
    const server = await startMockServer((_req, res) =>
      res.end(JSON.stringify({ active: false })),
    );
    try {
      expect(
        (
          await plugin.onRequest(
            makeCtx('token', {
              introspectionEndpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
              clientId: 'id',
              clientSecret: 'secret',
            }),
          )
        )?.status,
      ).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('bounds a stalled Redis read and retains capacity until the operation settles', async () => {
    const provider = new IdentityProviderService(
      new ConfigService({
        identityProvider: {
          allowInsecureHttp: true,
          timeoutMs: 100,
          maxPendingRequests: 1,
        },
      }),
    );
    let release!: (value: null) => void;
    mockRedis.get.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          release = resolve;
        }),
    );
    const bounded = new OAuth2ClientCredentialsPlugin(
      mockRedis as never,
      provider,
    );
    const config = {
      introspectionEndpoint: 'http://never-called.test',
      clientId: 'id',
      clientSecret: 'secret',
    };
    expect((await bounded.onRequest(makeCtx('token', config)))?.status).toBe(
      503,
    );
    expect(provider.occupiedAdmissions).toBe(1);
    expect(
      (await bounded.onRequest(makeCtx('other-token', config)))?.status,
    ).toBe(503);
    expect(mockRedis.get).toHaveBeenCalledTimes(1);
    release(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.occupiedAdmissions).toBe(0);
    provider.onModuleDestroy();
  });
  it('encodes introspection Basic credentials as form components', async () => {
    let header: string | undefined;
    const server = await startMockServer((req, res) => {
      header = req.headers.authorization;
      res.end(JSON.stringify({ active: true }));
    });
    try {
      expect(
        await plugin.onRequest(
          makeCtx('token', {
            introspectionEndpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
            clientId: 'client:one',
            clientSecret: 'secret +:å',
          }),
        ),
      ).toBeUndefined();
      expect(Buffer.from(header!.slice(6), 'base64').toString()).toBe(
        'client%3Aone:secret+%2B%3A%C3%A5',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('does not cache outbound tokens whose lifetime is shorter than the safety window', async () => {
    let calls = 0;
    const server = await startMockServer((_req, res) => {
      calls++;
      res.end(
        JSON.stringify({
          access_token: 'short-lived',
          token_type: 'Bearer',
          expires_in: 1,
        }),
      );
    });
    try {
      const config = {
        tokenEndpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        clientId: 'id',
        clientSecret: 'secret',
      };
      expect(await plugin.onRequest(makeCtx(null, config))).toBeUndefined();
      expect(await plugin.onRequest(makeCtx(null, config))).toBeUndefined();
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
