import { Test, TestingModule } from '@nestjs/testing';
import { ServicesController } from './services.controller';
import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';

const TENANT = 'aabbccdd-1111-2222-3333-444455556666';

const mockDataSource = () => ({ query: jest.fn() });
const mockConfigPush = () => ({
  triggerUpdate: jest.fn().mockResolvedValue(undefined),
});

async function build(ds = mockDataSource(), cp = mockConfigPush()) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [ServicesController],
    providers: [
      { provide: DataSource, useValue: ds },
      { provide: ConfigPushService, useValue: cp },
    ],
  }).compile();
  return { controller: module.get(ServicesController), ds, cp };
}

describe('ServicesController', () => {
  describe('GET findAll', () => {
    it('returns active services', async () => {
      const ds = mockDataSource();
      ds.query.mockResolvedValue([{ id: 'svc-1' }]);
      const { controller } = await build(ds);
      const result = await controller.findAll(TENANT);
      expect(result).toEqual([{ id: 'svc-1' }]);
    });
  });

  describe('POST create', () => {
    it('inserts service with targets and triggers config push', async () => {
      const ds = mockDataSource();
      const cp = mockConfigPush();
      ds.query.mockResolvedValue([{ id: 'svc-new' }]);
      const { controller } = await build(ds, cp);

      const targets = [{ url: 'http://users:8080', weight: 100 }];
      const result = await controller.create(TENANT, {
        name: 'user-service',
        targets,
        healthCheckPath: '/health',
        timeoutMs: 5000,
      });

      expect(result).toEqual({ id: 'svc-new' });
      expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('INSERT'), [
        'user-service',
        JSON.stringify(targets),
        '/health',
        5000,
        false,
        false,
        10000,
        false,
        'http',
        '',
        'weighted-round-robin',
      ]);
      expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
    });

    it('inserts multi-target service for load balancing', async () => {
      const ds = mockDataSource();
      const cp = mockConfigPush();
      ds.query.mockResolvedValue([{ id: 'svc-lb' }]);
      const { controller } = await build(ds, cp);

      const targets = [
        { url: 'http://users-1:8080', weight: 50 },
        { url: 'http://users-2:8080', weight: 50 },
      ];
      const result = await controller.create(TENANT, {
        name: 'user-service',
        targets,
      });

      expect(result).toEqual({ id: 'svc-lb' });
      expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('INSERT'), [
        'user-service',
        JSON.stringify(targets),
        '/health',
        10000,
        false,
        false,
        10000,
        false,
        'http',
        '',
        'weighted-round-robin',
      ]);
      expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
    });
  });

  describe('PUT update', () => {
    it('updates service and triggers config push', async () => {
      const ds = mockDataSource();
      const cp = mockConfigPush();
      ds.query.mockResolvedValue([{ id: 'svc-1', timeoutMs: 3000 }]);
      const { controller } = await build(ds, cp);

      const result = await controller.update(TENANT, 'svc-1', {
        timeoutMs: 3000,
      });

      expect(result).toEqual({ id: 'svc-1', timeoutMs: 3000 });
      expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
    });
  });

  describe('health settings validation', () => {
    it.each([0, 999, 60001, 1500.5, NaN, null, '1000'])(
      'rejects invalid probe intervals: %s',
      async (interval) => {
        const { controller, ds, cp } = await build();
        await expect(
          controller.update(TENANT, 'svc', {
            healthCheckIntervalMs: interval,
          } as never),
        ).rejects.toMatchObject({ status: 400 });
        expect(ds.query).not.toHaveBeenCalled();
        expect(cp.triggerUpdate).not.toHaveBeenCalled();
      },
    );
    it.each([
      '//other/health',
      'https://other/health',
      '/\\other',
      '/health#fragment',
      '/health with-space',
      '',
      null,
    ])('rejects invalid health paths: %s', async (path) => {
      const { controller, ds } = await build();
      await expect(
        controller.update(TENANT, 'svc', { healthCheckPath: path } as never),
      ).rejects.toMatchObject({ status: 400 });
      expect(ds.query).not.toHaveBeenCalled();
    });
    it.each([null, 1, 'false'])(
      'rejects non-boolean fallback: %s',
      async (fallback) => {
        const { controller } = await build();
        await expect(
          controller.update(TENANT, 'svc', {
            unhealthyFallback: fallback,
          } as never),
        ).rejects.toMatchObject({ status: 400 });
      },
    );
  });

  it.each([
    { healthCheckProtocol: 'other' },
    { healthCheckProtocol: null },
    { healthCheckService: null },
    { healthCheckService: 'x'.repeat(257) },
    { healthCheckService: 'é'.repeat(129) },
    { healthCheckService: 'bad\nname' },
    { h2: 'true' },
    { supportsWebSocket: null },
    { timeoutMs: 99 },
    { timeoutMs: 3600001 },
    { timeoutMs: 100.5 },
  ])('rejects invalid protocol settings %j', async (body) => {
    const { controller, ds, cp } = await build();
    await expect(
      controller.update(TENANT, 'svc', body as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(ds.query).not.toHaveBeenCalled();
    expect(cp.triggerUpdate).not.toHaveBeenCalled();
  });
  describe('DELETE remove', () => {
    it('soft-deletes service and triggers config push', async () => {
      const ds = mockDataSource();
      const cp = mockConfigPush();
      ds.query.mockResolvedValue([]);
      const { controller } = await build(ds, cp);

      const result = await controller.remove(TENANT, 'svc-1');

      expect(result).toEqual({ success: true });
      expect(ds.query).toHaveBeenCalledWith(
        expect.stringContaining('"deletedAt" = NOW()'),
        ['svc-1'],
      );
      expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
    });
  });
  it.each(['round-robin', null, true, 1])(
    'rejects unsupported balancing policy %s before SQL',
    async (loadBalancing) => {
      const { controller, ds } = await build();
      await expect(
        controller.update(TENANT, 'svc', { loadBalancing } as never),
      ).rejects.toMatchObject({ status: 400 });
      expect(ds.query).not.toHaveBeenCalled();
    },
  );
  it.each([
    [{ url: 'http://one', weight: 1.5 }],
    [{ url: 'ftp://one', weight: 1 }],
    [{ url: 'http://user:secret@one', weight: 1 }],
    [
      { url: 'http://one', weight: 1 },
      { url: 'http://one/', weight: 2 },
    ],
  ])(
    'rejects malformed or duplicate target policy before SQL',
    async (...targets) => {
      const { controller, ds } = await build();
      await expect(
        controller.update(TENANT, 'svc', { targets }),
      ).rejects.toMatchObject({ status: 400 });
      expect(ds.query).not.toHaveBeenCalled();
    },
  );
});
