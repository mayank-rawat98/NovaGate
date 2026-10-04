import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import RedisMock from 'ioredis-mock';
import { REDIS_CLIENT } from '../gateway/shared/redis.tokens';
import { GatewayConfigManagerService } from '../gateway/config-manager/gateway-config-manager.service';
import { ControlPlaneConnectorService } from '../gateway/connector/control-plane-connector.service';
import { GatewayTelemetryService } from '../gateway/telemetry/gateway-telemetry.service';

describe('data-plane application without PostgreSQL', () => {
  let app: INestApplication;
  let base: string;
  const names = ['DATABASE_URL', 'JWT_SECRET', 'REDIS_URL', 'GRPC_ENABLED'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.JWT_SECRET =
      'data-plane-verification-secret-at-least-32-characters';
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    process.env.GRPC_ENABLED = 'false';
    // Exercise the real application module/configuration and HTTP pipeline.
    // Only external Redis/control-plane/telemetry IO is replaced.
    const { AppModule } = jest.requireActual<{ AppModule: Type<unknown> }>(
      './app.module',
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue(new RedisMock())
      .overrideProvider(ControlPlaneConnectorService)
      .useValue({
        isConnected: () => false,
        send: jest.fn(),
      })
      .overrideProvider(GatewayTelemetryService)
      .useValue({
        logRequest: jest.fn(),
        sendHealth: jest.fn(),
        sendError: jest.fn(),
        sendMetrics: jest.fn(),
      })
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    await app.get(GatewayConfigManagerService).loadConfig(
      'tenant',
      {
        routes: [],
        services: [],
        consumers: [],
        rateLimit: { windowMs: 60000, authMax: 100, unauthMax: 100 },
      },
      1,
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  it('starts health and metrics without a database setting', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      configVersion: 1,
    });
    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('gateway_grpc_active_calls');
  });
  it.each([
    ['GET', '/admin/services'],
    ['GET', '/admin/services/unused'],
    ['POST', '/admin/services'],
    ['PUT', '/admin/services/unused'],
    ['DELETE', '/admin/services/unused'],
  ])(
    'has no local administrative operation for %s %s',
    async (method, path) => {
      const response = await fetch(`${base}${path}`, { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: 'SERVICE_NOT_FOUND',
        requestId: expect.any(String),
      });
    },
  );
});
