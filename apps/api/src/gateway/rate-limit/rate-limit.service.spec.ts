import { ConfigService } from '@nestjs/config';
import { RateLimitService } from './rate-limit.service';

describe('quota storage result validation', () => {
  const exec = jest.fn();
  const pipeline = {
    zremrangebyscore: jest.fn(),
    zadd: jest.fn(),
    zcard: jest.fn(),
    zrange: jest.fn(),
    expire: jest.fn(),
    exec,
  };
  const service = new RateLimitService(
    { pipeline: () => pipeline } as never,
    new ConfigService({ rateLimit: { windowMs: 60000 } }),
  );
  it.each([
    null,
    [],
    [[null, 0]],
    [
      [new Error('Redis command failed'), 0],
      [null, 1],
      [null, 1],
      [null, []],
      [null, 1],
    ],
    [
      [null, 0],
      [null, 1],
      [null, 'invalid'],
      [null, []],
      [null, 1],
    ],
  ])('never grants a quota from invalid storage results %#', async (result) => {
    exec.mockResolvedValueOnce(result);
    await expect(service.check('ws:tenant:route:consumer', 10)).rejects.toThrow(
      'Quota storage',
    );
  });
  it('enforces an actual count and computes retry duration', async () => {
    exec.mockResolvedValueOnce([
      [null, 0],
      [null, 1],
      [null, 2],
      [null, ['entry', String(Date.now())]],
      [null, 1],
    ]);
    const result = await service.check('ws:tenant:route:consumer', 1);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(59000);
  });
});
