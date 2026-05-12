import { Test, TestingModule } from '@nestjs/testing';
import { RoutesController } from './routes.controller';
import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';

const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
const SCHEMA = 'tenant_aabbccdd_1111_2222_3333_444455556666';

const mockDataSource = () => ({ query: jest.fn() });
const mockConfigPush = () => ({ triggerUpdate: jest.fn().mockResolvedValue(undefined) });

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
      expect(ds.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT'),
        ['GET', '/api/users', 'svc-1', true, null, true, null, null, null, null],
      );
      expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
    });
  });

  describe('PUT update', () => {
    it('updates route and triggers config push', async () => {
      const ds = mockDataSource();
      const cp = mockConfigPush();
      ds.query.mockResolvedValue([{ id: 'route-1', method: 'POST' }]);
      const { controller } = await build(ds, cp);

      const result = await controller.update(TENANT, 'route-1', { method: 'POST' });

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
});
