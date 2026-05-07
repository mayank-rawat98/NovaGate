import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis-mock';
import { ExecutionContext } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';
import { MetricsService } from '../metrics/metrics.service';
import { REDIS_CLIENT } from '../shared/redis.tokens';
import { GatewayError } from '../shared/gateway-error';
import type { GatewayConfig } from '../../config/configuration';

const createContext = (ip = '127.0.0.1') => {
  const req = {
    ip,
    headers: {},
  };
  const res = {
    setHeader: jest.fn(),
    once: jest.fn(),
    locals: {},
  };
  return {
    req,
    res,
    context: {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    },
  };
};

describe('RateLimitGuard', () => {
  const createConfigService = () =>
    ({
      get: jest.fn().mockImplementation((key: keyof GatewayConfig) => {
        if (key === 'rateLimit') {
          return { windowMs: 60000, unauthMax: 2, authMax: 3 };
        }
        return undefined;
      }),
    }) as unknown as ConfigService<GatewayConfig, true>;

  it('allows requests under the limit', async () => {
    const redis = new Redis();
    await redis.flushall();
    const module = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        RateLimitService,
        MetricsService,
        { provide: ConfigService, useValue: createConfigService() },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    const guard = module.get(RateLimitGuard);
    const { context } = createContext();

    await expect(guard.canActivate(context as unknown as ExecutionContext)).resolves.toBe(
      true,
    );
    await expect(guard.canActivate(context as unknown as ExecutionContext)).resolves.toBe(
      true,
    );
  });

  it('blocks requests over the limit', async () => {
    const redis = new Redis();
    await redis.flushall();
    const module = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        RateLimitService,
        MetricsService,
        { provide: ConfigService, useValue: createConfigService() },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    const guard = module.get(RateLimitGuard);
    const { context, res } = createContext();

    await guard.canActivate(context as unknown as ExecutionContext);
    await guard.canActivate(context as unknown as ExecutionContext);

    await expect(
      guard.canActivate(context as unknown as ExecutionContext),
    ).rejects.toBeInstanceOf(GatewayError);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });

  it('fails open on Redis errors', async () => {
    const metricsService = new MetricsService();
    const incrementSpy = jest.spyOn(metricsService, 'incrementRateLimitRedisError');
    const module = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        { provide: RateLimitService, useValue: { check: jest.fn().mockRejectedValue(new Error('boom')) } },
        { provide: MetricsService, useValue: metricsService },
        { provide: ConfigService, useValue: createConfigService() },
      ],
    }).compile();

    const guard = module.get(RateLimitGuard);
    const { context } = createContext();

    await expect(guard.canActivate(context as unknown as ExecutionContext)).resolves.toBe(
      true,
    );
    expect(incrementSpy).toHaveBeenCalled();
  });
});
