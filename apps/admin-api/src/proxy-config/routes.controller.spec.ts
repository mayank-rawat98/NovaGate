import { Test, TestingModule } from '@nestjs/testing';
import { RoutesController } from './routes.controller';
import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';

const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
const SCHEMA = 'tenant_aabbccdd_1111_2222_3333_444455556666';

const mockDataSource = () => ({ query: jest.fn() });
const mockConfigPush = () => ({
  triggerUpdate: jest.fn().mockResolvedValue(undefined),
});

async function build(ds = mockDataSource(), cp = mockConfigPush()) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [RoutesController],
    providers: [
      { provide: DataSource, useValue: ds },
      { provide: ConfigPushService, useValue: cp },
    ],
  }).compile();
  return { controller: module.get(RoutesController), ds, cp };
}

describe('RoutesController', () => {
  describe('GET findAll', () => {
    it('returns active routes', async () => {
      const ds = mockDataSource();
      ds.query.mockResolvedValue([{ id: '1' }]);
      const { controller } = await build(ds);
      const result = await controller.findAll(TENANT);
      expect(result).toEqual([{ id: '1' }]);
      expect(ds.query).toHaveBeenCalledWith(expect.stringContaining(SCHEMA));
    });
  });

  describe('POST create', () => {
    it('inserts route and triggers config push', async () => {
      const ds = mockDataSource();
      const cp = mockConfigPush();
      ds.query.mockResolvedValue([{ id: 'new-route' }]);
      const { controller } = await build(ds, cp);

      const result = await controller.create(TENANT, {
        method: 'GET',
        pathPattern: '/api/users',
        serviceId: 'svc-1',
        authRequired: true,
      });

      expect(result).toEqual({ id: 'new-route' });
      expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('INSERT'), [
        'GET',
        '/api/users',
        'svc-1',
        true,
        null,
        true,
        null,
        null,
        null,
      ]);
      expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
    });
  });

  describe('PUT update', () => {
    it('updates route and triggers config push', async () => {
      const ds = mockDataSource();
      const cp = mockConfigPush();
      ds.query.mockResolvedValue([{ id: 'route-1', method: 'POST' }]);
      const { controller } = await build(ds, cp);

      const result = await controller.update(TENANT, 'route-1', {
        method: 'POST',
      });

      expect(result).toEqual({ id: 'route-1', method: 'POST' });
      expect(ds.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE'),
        expect.arrayContaining(['route-1']),
      );
      expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
    });
  });

  describe('DELETE remove', () => {
    it('soft-deletes route and triggers config push', async () => {
      const ds = mockDataSource();
      const cp = mockConfigPush();
      ds.query.mockResolvedValue([]);
      const { controller } = await build(ds, cp);

      const result = await controller.remove(TENANT, 'route-1');

      expect(result).toEqual({ success: true });
      expect(ds.query).toHaveBeenCalledWith(
        expect.stringContaining('"deletedAt" = NOW()'),
        ['route-1'],
      );
      expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
    });
  });
  it.each([
    ['oidc', { jwksUri: 'file:///jwks', issuer: 'issuer' }],
    [
      'oidc',
      { jwksUri: 'https://user:secret@example.com/jwks', issuer: 'issuer' },
    ],
    ['oidc', { jwksUri: 'https://example.com/jwks' }],
    [
      'oidc',
      {
        jwksUri: 'https://example.com/jwks',
        issuer: 'issuer',
        claimsToForward: ['unsafe\r\nheader'],
      },
    ],
    ['oauth2-client-credentials', { clientId: 'id', clientSecret: 'secret' }],
    [
      'oauth2-client-credentials',
      {
        clientId: 'id',
        clientSecret: 'secret',
        tokenEndpoint: 'https://example.com/token',
        introspectionEndpoint: 'https://example.com/introspect',
      },
    ],
    [
      'oauth2-client-credentials',
      { clientId: 'id', tokenEndpoint: 'https://example.com/token' },
    ],
    [
      'oauth2-client-credentials',
      {
        clientId: 'id',
        clientSecret: 'secret',
        tokenEndpoint: 'https://example.com/token',
        headerName: 'Host',
      },
    ],
  ])(
    'rejects invalid %s settings before saving or broadcasting',
    async (name, config) => {
      const { controller, ds, cp } = await build();
      await expect(
        controller.create(TENANT, {
          plugins: [
            { name: name as string, config: config as Record<string, unknown> },
          ],
        }),
      ).rejects.toThrow('configuration');
      await expect(
        controller.update(TENANT, 'route', {
          plugins: [
            { name: name as string, config: config as Record<string, unknown> },
          ],
        }),
      ).rejects.toThrow('configuration');
      expect(ds.query).not.toHaveBeenCalled();
      expect(cp.triggerUpdate).not.toHaveBeenCalled();
    },
  );
  it.each([
    { algorithm: 'md5' },
    { secrets: [] },
    { secrets: [''] },
    { secrets: ['x'.repeat(4097)] },
    { secrets: Array(9).fill('fixture') },
    { header: 'invalid header' },
    { mode: 'stripe', algorithm: 'sha512' },
    { mode: 'stripe', timestampHeader: 'x-time' },
    { maxClockSkewSeconds: 0 },
    { maxClockSkewSeconds: 300 },
    { timestampHeader: 'x-signature' },
    { timestampHeader: 'x-time', maxClockSkewSeconds: '300' },
  ])('rejects invalid HMAC policy before persistence: %j', async (bad) => {
    const { controller, ds, cp } = await build();
    await expect(
      controller.create(TENANT, {
        plugins: [
          {
            name: 'hmac-auth',
            config: {
              header: 'x-signature',
              algorithm: 'sha256',
              secrets: ['fixture'],
              ...bad,
            },
          },
        ],
      }),
    ).rejects.toThrow();
    expect(ds.query).not.toHaveBeenCalled();
    expect(cp.triggerUpdate).not.toHaveBeenCalled();
  });
  it('persists Stripe signing mode with overlapping rotation keys', async () => {
    const { controller, ds, cp } = await build();
    ds.query.mockResolvedValue([{ id: 'fixture' }]);
    const config = {
      mode: 'stripe',
      header: 'stripe-signature',
      algorithm: 'sha256',
      secrets: ['old', 'new'],
      maxClockSkewSeconds: 300,
    };
    await controller.create(TENANT, {
      plugins: [{ name: 'hmac-auth', config }],
    });
    expect(ds.query).toHaveBeenCalled();
    expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
  });
  it.each([
    { maxDepth: 0 },
    { maxDepth: 101 },
    { maxDepth: '10' },
    { maxComplexity: 0 },
    { maxComplexity: 100001 },
    { introspectionAllowed: 'false' },
    { unknown: true },
  ])(
    'rejects unsafe route and plugin GraphQL policies before persistence %j',
    async (policy) => {
      const { controller, ds, cp } = await build();
      await expect(
        controller.create(TENANT, { graphql: policy as never }),
      ).rejects.toThrow();
      await expect(
        controller.create(TENANT, {
          plugins: [{ name: 'graphql-guard', config: policy }],
        }),
      ).rejects.toThrow();
      expect(ds.query).not.toHaveBeenCalled();
      expect(cp.triggerUpdate).not.toHaveBeenCalled();
    },
  );
  it('rejects duplicate policy names instead of applying an ambiguous first configuration', async () => {
    const { controller, ds } = await build();
    await expect(
      controller.create(TENANT, {
        plugins: [
          { name: 'graphql-guard', config: { maxDepth: 10 } },
          { name: 'graphql-guard', config: { maxDepth: 2 } },
        ],
      }),
    ).rejects.toThrow('Duplicate plugin');
    expect(ds.query).not.toHaveBeenCalled();
  });
  it('persists explicit GraphQL clearing and removal of all plugins on edit', async () => {
    const { controller, ds, cp } = await build();
    ds.query.mockResolvedValue([{ id: 'fixture' }]);
    await controller.update(TENANT, 'fixture', { graphql: null, plugins: [] });
    expect(ds.query.mock.calls[0][1][8]).toBe('[]');
    expect(ds.query.mock.calls[0][1][9]).toBeNull();
    expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
  });
});
