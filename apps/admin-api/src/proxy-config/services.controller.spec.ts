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
});
