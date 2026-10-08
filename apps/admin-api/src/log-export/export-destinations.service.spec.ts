import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { ExportDestinationsService } from './export-destinations.service';

describe('Export destination operation admission and shutdown', () => {
  it('bounds admitted database work and drains existing operations before refusing new ones', async () => {
    const tenant = 'aabbccdd-1111-2222-3333-444455556666';
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const transaction = jest.fn(
      async (callback: (manager: EntityManager) => Promise<unknown>) => {
        await held;
        return callback({
          query: jest.fn().mockResolvedValue([]),
        } as unknown as EntityManager);
      },
    );
    const service = new ExportDestinationsService(
      { transaction } as unknown as DataSource,
      new ConfigService({
        LOG_EXPORT_DESTINATION_KEYS: '',
        LOG_EXPORT_DESTINATION_ACTIVE_KEY: '',
      }),
    );
    const existing = Array.from({ length: 8 }, () => service.list(tenant));
    try {
      await expect(service.list(tenant)).rejects.toThrow('settings are busy');
      expect(transaction).toHaveBeenCalledTimes(8);
      let stopped = false;
      const shutdown = service.onModuleDestroy().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      await expect(service.list(tenant)).rejects.toThrow('settings are busy');
      finish();
      await Promise.all(existing);
      await shutdown;
      expect(stopped).toBe(true);
      await expect(service.list(tenant)).rejects.toThrow('settings are busy');
      expect(transaction).toHaveBeenCalledTimes(8);
    } finally {
      finish();
      await Promise.allSettled(existing);
      await service.onModuleDestroy();
    }
  });
});
