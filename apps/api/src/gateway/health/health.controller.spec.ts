import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { ControlPlaneConnectorService } from '../connector/control-plane-connector.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';

const makeConnector = (
  connected: boolean,
): Partial<ControlPlaneConnectorService> => ({
  isConnected: () => connected,
});

const makeConfigManager = (
  source: 'live' | 'cache' | 'none' = 'live',
  version: number | null = 42,
  cachedAt: Date | null = new Date('2026-01-01'),
  tenantId: string | null = 'tenant-123',
): Partial<GatewayConfigManagerService> => ({
  get configSource() {
    return source;
  },
  get configVersion() {
    return version;
  },
  get configCachedAt() {
    return cachedAt;
  },
  getTenantId: () => tenantId,
});

async function buildModule(
  connected: boolean,
  source: 'live' | 'cache' | 'none' = 'live',
  version: number | null = 42,
  cachedAt: Date | null = new Date('2026-01-01'),
  tenantId: string | null = 'tenant-123',
): Promise<TestingModule> {
  return Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      {
        provide: ControlPlaneConnectorService,
        useValue: makeConnector(connected),
      },
      {
        provide: GatewayConfigManagerService,
        useValue: makeConfigManager(source, version, cachedAt, tenantId),
      },
    ],
  }).compile();
}

describe('HealthController', () => {
  describe('GET /health', () => {
    it('returns 200 with controlPlaneConnected=true when connected', async () => {
      const module = await buildModule(true);
      const controller = module.get(HealthController);
      const result = controller.getHealth();

      expect(result.status).toBe('ok');
      expect(result.controlPlaneConnected).toBe(true);
      expect(result.configSource).toBe('live');
      expect(result.configVersion).toBe(42);
      expect(result.configCachedAt).toBeInstanceOf(Date);
      expect(typeof result.uptime).toBe('number');
    });

    it('returns 200 with controlPlaneConnected=false when disconnected', async () => {
      const module = await buildModule(
        false,
        'cache',
        41,
        new Date('2025-12-01'),
      );
      const controller = module.get(HealthController);
      const result = controller.getHealth();

      expect(result.status).toBe('ok');
      expect(result.controlPlaneConnected).toBe(false);
      expect(result.configSource).toBe('cache');
      expect(result.configVersion).toBe(41);
    });

    it('returns configSource=none and nulls when no config loaded', async () => {
      const module = await buildModule(false, 'none', null, null, null);
      const controller = module.get(HealthController);
      const result = controller.getHealth();

      expect(result.status).toBe('ok');
      expect(result.configSource).toBe('none');
      expect(result.configVersion).toBeNull();
      expect(result.configCachedAt).toBeNull();
    });
  });

  describe('GET /health/gateway-info', () => {
    it('includes version string', async () => {
      const module = await buildModule(true);
      const controller = module.get(HealthController);
      const result = controller.getGatewayInfo();

      expect(result.status).toBe('ok');
      expect(typeof result.version).toBe('string');
      expect(result.version.length).toBeGreaterThan(0);
    });

    it('includes tenantId', async () => {
      const module = await buildModule(
        true,
        'live',
        42,
        new Date(),
        'my-tenant',
      );
      const controller = module.get(HealthController);
      const result = controller.getGatewayInfo();

      expect(result.tenantId).toBe('my-tenant');
    });

    it('includes tenantId=null when not yet connected', async () => {
      const module = await buildModule(false, 'none', null, null, null);
      const controller = module.get(HealthController);
      const result = controller.getGatewayInfo();

      expect(result.tenantId).toBeNull();
    });
  });
});
