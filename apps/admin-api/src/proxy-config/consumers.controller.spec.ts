import { Test, TestingModule } from '@nestjs/testing';
import { ConsumersController } from './consumers.controller';
import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';

const TENANT = 'aabbccdd-1111-2222-3333-444455556666';

const mockDataSource = () => ({ query: jest.fn() });
const mockConfigPush = () => ({
  triggerUpdate: jest.fn().mockResolvedValue(undefined),
});

async function build(ds = mockDataSource(), cp = mockConfigPush()) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [ConsumersController],
    providers: [
      { provide: DataSource, useValue: ds },
      { provide: ConfigPushService, useValue: cp },
    ],
  }).compile();
  return { controller: module.get(ConsumersController), ds, cp };
}

describe('ConsumersController', () => {
  describe('GET findAll', () => {
    it('returns active consumers without keyHash', async () => {
      const ds = mockDataSource();
      ds.query.mockResolvedValue([{ id: 'c-1', name: 'mobile-app' }]);
      const { controller } = await build(ds);
      const result = await controller.findAll(TENANT);
      expect(result).toEqual([{ id: 'c-1', name: 'mobile-app' }]);
      expect(ds.query).toHaveBeenCalledWith(
        expect.stringContaining('"revokedAt" IS NULL'),
      );
    });
  });

  describe('POST create', () => {
    it('generates a key, stores hash, returns plaintext once, triggers push', async () => {
      const ds = mockDataSource();
      const cp = mockConfigPush();
      ds.query.mockResolvedValue([
        { id: 'c-new', name: 'web-app', rateLimitTier: 'authenticated' },
      ]);
      const { controller } = await build(ds, cp);

      const result = await controller.create(TENANT, { name: 'web-app' });

      expect(result.id).toBe('c-new');
      expect(result.apiKey).toMatch(
        /^gw_aabbccdd-1111-2222-3333-444455556666_[0-9a-f]{32}$/,
      );

      const [sql, params] = ds.query.mock.calls[0];
      expect(sql).toContain('INSERT');
      expect(params[0]).toBe('web-app');
      // params[1] is the SHA-256 hash — verify it matches the returned key
      const crypto = require('crypto');
      const expectedHash = crypto
        .createHash('sha256')
        .update(result.apiKey)
        .digest('hex');
      expect(params[1]).toBe(expectedHash);

      expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
    });

    it('each call generates a unique key', async () => {
      const ds = mockDataSource();
      ds.query.mockResolvedValue([{ id: 'c-1', name: 'app' }]);
      const { controller } = await build(ds);

      const r1 = await controller.create(TENANT, { name: 'app' });
      ds.query.mockResolvedValue([{ id: 'c-2', name: 'app' }]);
      const r2 = await controller.create(TENANT, { name: 'app' });

      expect(r1.apiKey).not.toBe(r2.apiKey);
    });
  });

  describe('DELETE remove', () => {
    it('sets revokedAt and triggers push', async () => {
      const ds = mockDataSource();
      const cp = mockConfigPush();
      ds.query.mockResolvedValue([]);
      const { controller } = await build(ds, cp);

      const result = await controller.remove(TENANT, 'c-1');

      expect(result).toEqual({ success: true });
      expect(ds.query).toHaveBeenCalledWith(
        expect.stringContaining('"revokedAt" = NOW()'),
        ['c-1'],
      );
      expect(cp.triggerUpdate).toHaveBeenCalledWith(TENANT);
    });
  });
});
