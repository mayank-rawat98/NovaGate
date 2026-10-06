import { ConsumerAnalyticsService } from './consumer-analytics.service';
import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsController } from './analytics.controller';
import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';
import { ConfigService } from '@nestjs/config';
import { MetricsStreamService } from './metrics-stream.service';

const TENANT = 'aabbccdd-1111-2222-3333-444455556666';

type MockManager = { query: jest.Mock };
type MockDs = { transaction: jest.Mock };

function mockManager(rows: unknown[] = []): MockManager {
  return { query: jest.fn().mockResolvedValue(rows) };
}

const mockConfigPush = () => ({
  isOnline: jest.fn().mockResolvedValue(false),
});

async function build(ds: MockDs, cp = mockConfigPush()) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [AnalyticsController],
    providers: [
      { provide: ConsumerAnalyticsService, useValue: {} },
      { provide: DataSource, useValue: ds },
      { provide: ConfigPushService, useValue: cp },
      {
        provide: MetricsStreamService,
        useValue: new MetricsStreamService(
          ds as unknown as DataSource,
          new ConfigService(),
        ),
      },
    ],
  }).compile();
  return { controller: module.get(AnalyticsController), ds, cp };
}

describe('AnalyticsController', () => {
  describe('GET logs', () => {
    it('keeps database receipt metadata out of public request log records', async () => {
      const manager = mockManager([
        { id: 'log-1', path: '/users', receivedAt: new Date() },
      ]);
      const ds = { transaction: jest.fn(async (fn) => fn(manager)) };
      const { controller } = await build(ds);
      expect(await controller.getLogs(TENANT)).toEqual([
        { id: 'log-1', path: '/users', clientIp: '[redacted]' },
      ]);
    });
    it('executes SET LOCAL search_path and queries request_logs', async () => {
      const manager = mockManager([{ id: 'log-1' }]);
      const ds = {
        transaction: jest
          .fn()
          .mockImplementation(
            async (fn: (m: MockManager) => Promise<unknown>) => fn(manager),
          ),
      };
      const { controller } = await build(ds);
      await controller.getLogs(TENANT);

      const calls = manager.query.mock.calls;
      expect(calls[0][0]).toContain('SET LOCAL search_path');
      expect(calls[0][0]).toContain(
        'tenant_aabbccdd_1111_2222_3333_444455556666',
      );
      expect(calls[3][0]).toContain('request_logs');
      expect(calls[3][0]).toContain('LIMIT 50');
    });

    it('applies path filter', async () => {
      const manager = mockManager([]);
      const ds = {
        transaction: jest
          .fn()
          .mockImplementation(
            async (fn: (m: MockManager) => Promise<unknown>) => fn(manager),
          ),
      };
      const { controller } = await build(ds);
      await controller.getLogs(TENANT, undefined, undefined, '/users');

      const queryCall = manager.query.mock.calls[3];
      expect(queryCall[0]).toContain('ILIKE');
      expect(queryCall[1]).toContain('%/users%');
    });

    it('applies statusCode filter', async () => {
      const manager = mockManager([]);
      const ds = {
        transaction: jest
          .fn()
          .mockImplementation(
            async (fn: (m: MockManager) => Promise<unknown>) => fn(manager),
          ),
      };
      const { controller } = await build(ds);
      await controller.getLogs(TENANT, undefined, undefined, undefined, '500');

      const queryCall = manager.query.mock.calls[3];
      expect(queryCall[1]).toContain(500);
    });
  });

  describe('GET health', () => {
    it('returns latest snapshot per service', async () => {
      const manager = mockManager([{ serviceId: 's1', status: 'healthy' }]);
      const ds = {
        transaction: jest
          .fn()
          .mockImplementation(
            async (fn: (m: MockManager) => Promise<unknown>) => fn(manager),
          ),
      };
      const { controller } = await build(ds);
      const result = await controller.getHealth(TENANT);
      expect(result).toEqual([{ serviceId: 's1', status: 'healthy' }]);

      const queryCall = manager.query.mock.calls[1];
      expect(queryCall[0]).toContain('DISTINCT ON');
      expect(queryCall[0]).toContain('health_snapshots');
    });
  });

  describe('GET errors', () => {
    it('filters by resolved=false', async () => {
      const manager = mockManager([]);
      const ds = {
        transaction: jest
          .fn()
          .mockImplementation(
            async (fn: (m: MockManager) => Promise<unknown>) => fn(manager),
          ),
      };
      const { controller } = await build(ds);
      await controller.getErrors(TENANT, 'false');

      const queryCall = manager.query.mock.calls[1];
      expect(queryCall[0]).toContain('resolved');
      expect(queryCall[1]).toContain(false);
    });
  });

  describe('PATCH errors/:errorId', () => {
    it('marks error as resolved', async () => {
      const manager = mockManager([]);
      const ds = {
        transaction: jest
          .fn()
          .mockImplementation(
            async (fn: (m: MockManager) => Promise<unknown>) => fn(manager),
          ),
      };
      const { controller } = await build(ds);
      const result = await controller.resolveError(TENANT, 'err-1', {
        resolved: true,
      });

      expect(result).toEqual({ success: true });
      const queryCall = manager.query.mock.calls[1];
      expect(queryCall[0]).toContain('UPDATE error_events');
      expect(queryCall[1]).toEqual(['err-1', true]);
    });
  });

  describe('GET metrics', () => {
    it('defaults to 24h period', async () => {
      const manager = mockManager([]);
      const ds = {
        transaction: jest
          .fn()
          .mockImplementation(
            async (fn: (m: MockManager) => Promise<unknown>) => fn(manager),
          ),
      };
      const { controller } = await build(ds);
      await controller.getMetrics(TENANT);

      const queryCall = manager.query.mock.calls[1];
      expect(queryCall[1]).toEqual([86400, 600]);
      expect(queryCall[0]).toContain('LIMIT $2');
    });

    it('accepts 7d period', async () => {
      const manager = mockManager([]);
      const ds = {
        transaction: jest
          .fn()
          .mockImplementation(
            async (fn: (m: MockManager) => Promise<unknown>) => fn(manager),
          ),
      };
      const { controller } = await build(ds);
      await controller.getMetrics(TENANT, '7d');

      const queryCall = manager.query.mock.calls[1];
      expect(queryCall[1]).toEqual([604800, 600]);
    });
  });

  describe('GET gateway-status', () => {
    it('returns online=false when gateway is offline', async () => {
      const ds = { transaction: jest.fn() };
      const cp = { isOnline: jest.fn().mockResolvedValue(false) };
      const { controller } = await build(ds, cp);

      const result = await controller.getGatewayStatus(TENANT);
      expect(result).toEqual({ tenantId: TENANT, online: false });
      expect(cp.isOnline).toHaveBeenCalledWith(TENANT);
    });

    it('returns online=true when gateway is connected', async () => {
      const ds = { transaction: jest.fn() };
      const cp = { isOnline: jest.fn().mockResolvedValue(true) };
      const { controller } = await build(ds, cp);

      const result = await controller.getGatewayStatus(TENANT);
      expect(result).toEqual({ tenantId: TENANT, online: true });
    });
  });
});
