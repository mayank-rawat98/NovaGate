import type Redis from 'ioredis';
import type { TenantConfig } from '@api-gateway/shared-types';
import { GatewayConfigManagerService } from './gateway-config-manager.service';

const config: TenantConfig = {
  routes: [],
  services: [],
  consumers: [],
  rateLimit: { windowMs: 60000, authMax: 500, unauthMax: 100 },
};

describe('Gateway configuration recovery', () => {
  it('does not replace a newer snapshot with delayed older updates', async () => {
    const redis = { set: jest.fn().mockResolvedValue('OK') };
    const service = new GatewayConfigManagerService(redis as unknown as Redis);
    await Promise.all([
      service.loadConfig('tenant', config, 5),
      service.loadConfig(
        'tenant',
        { ...config, services: [{ id: 'stale' }] } as TenantConfig,
        4,
      ),
    ]);
    expect(service.configVersion).toBe(5);
    expect(service.getConfig()).toEqual(config);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });
  it('restores tenant identity and config from the offline cache', async () => {
    const redis = {
      get: jest
        .fn()
        .mockResolvedValue(
          JSON.stringify({ tenantId: 'tenant', config, version: 7 }),
        ),
    };
    const service = new GatewayConfigManagerService(redis as unknown as Redis);
    await service.warmStart();
    expect(service.getTenantId()).toBe('tenant');
    expect(service.configVersion).toBe(7);
    expect(service.configSource).toBe('cache');
  });
  it('rejects invalid versions', async () => {
    const service = new GatewayConfigManagerService({
      set: jest.fn(),
    } as unknown as Redis);
    await expect(service.loadConfig('tenant', config, -1)).rejects.toThrow(
      'Invalid tenant',
    );
  });
  it('keeps the last installed snapshot if durable storage fails', async () => {
    const redis = {
      set: jest
        .fn()
        .mockResolvedValueOnce('OK')
        .mockRejectedValueOnce(new Error('Redis unavailable')),
    };
    const service = new GatewayConfigManagerService(redis as unknown as Redis);
    await service.loadConfig('tenant', config, 1);
    await expect(
      service.loadConfig('tenant', { ...config, routes: [] }, 2),
    ).rejects.toThrow('Redis unavailable');
    expect(service.configVersion).toBe(1);
    expect(service.getConfig()).toBe(config);
  });
});
