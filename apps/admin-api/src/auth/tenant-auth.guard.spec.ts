import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { TenantAuthGuard } from './tenant-auth.guard';
import { AnalyticsController } from '../proxy-config/analytics.controller';
import { ConfigPushService } from '../config-push/config-push.service';
import { HealthController } from '../app/health.controller';
import { MetricsStreamService } from '../proxy-config/metrics-stream.service';

const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
const OTHER = 'aabbccdd-1111-2222-3333-444455556667';
const SECRET = 'test-platform-secret-with-at-least-32-chars';

describe('Tenant authorization through the HTTP pipeline', () => {
  let app: INestApplication;
  let url: string;
  const previousSecret = process.env.PLATFORM_JWT_SECRET;
  const query = jest.fn().mockResolvedValue([]);

  beforeAll(async () => {
    process.env.PLATFORM_JWT_SECRET = SECRET;
    const module = await Test.createTestingModule({
      controllers: [AnalyticsController, HealthController],
      providers: [
        { provide: APP_GUARD, useClass: TenantAuthGuard },
        {
          provide: MetricsStreamService,
          useValue: { history: jest.fn(), open: jest.fn() },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: async (fn: (m: { query: jest.Mock }) => unknown) =>
              fn({ query }),
          },
        },
        {
          provide: ConfigPushService,
          useValue: { isOnline: async () => true },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
    if (previousSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previousSecret;
  });
  beforeEach(() => query.mockClear());

  it('keeps the health endpoint public', async () => {
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
  it.each([
    ['missing', undefined],
    ['malformed', 'Bearer garbage'],
    ['expired', `Bearer ${sign({ sub: TENANT }, SECRET, { expiresIn: -1 })}`],
    ['wrong signature', `Bearer ${sign({ sub: TENANT }, 'wrong-secret')}`],
    [
      'wrong algorithm',
      `Bearer ${sign({ sub: TENANT }, SECRET, { algorithm: 'HS384' })}`,
    ],
    ['missing subject', `Bearer ${sign({}, SECRET)}`],
  ])(
    'rejects %s sessions before accessing the database',
    async (_, authorization) => {
      const response = await fetch(`${url}/tenants/${TENANT}/logs`, {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(401);
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('rejects another tenant even with a valid session', async () => {
    const response = await fetch(`${url}/tenants/${OTHER}/logs`, {
      headers: { authorization: `Bearer ${sign({ sub: TENANT }, SECRET)}` },
    });
    expect(response.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it('allows the session owner to read their logs', async () => {
    const response = await fetch(`${url}/tenants/${TENANT}/logs`, {
      headers: { authorization: `Bearer ${sign({ sub: TENANT }, SECRET)}` },
    });
    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalled();
  });
});
