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
      expect(ctx.req.user?.id).toBe('user-42');
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
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(cachedResult));

      const ctx = makeCtx('cached-token', {
        introspectionEndpoint: 'http://should-not-be-called/introspect',
        clientId: 'id',
        clientSecret: 'secret',
      });

      const result = await plugin.onRequest(ctx);
      expect(result).toBeUndefined();
      expect(ctx.req.user?.id).toBe('cached-user');
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
        'EX',
        expect.any(Number),
      );
      const [, , , ttl] = mockRedis.set.mock.calls[0];
      expect(ttl).toBeGreaterThan(0);
    });

    it('fails open when Redis is unavailable', async () => {
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
});
