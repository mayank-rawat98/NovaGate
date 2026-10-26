import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { MeteringService } from './metering.service';

const url = process.env.TEST_REDIS_URL;
const integration = url ? describe : describe.skip;

integration('usage metering on real Redis', () => {
  let redis: Redis;
  let metering: MeteringService;
  const october = new Date('2026-10-25T12:00:00.000Z');
  const november = new Date('2026-11-01T00:00:01.000Z');

  beforeAll(async () => {
    // A dedicated logical database keeps the counters isolated.
    redis = new Redis(`${url}/11`);
    await redis.flushdb();
    metering = new MeteringService(redis);
  });
  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it('counts the workspace and consumers, and refuses a consumer at its quota', async () => {
    const consumer = randomUUID();
    const unlimited = randomUUID();
    expect(await metering.admit(undefined, undefined, october)).toEqual({
      allowed: true,
    });
    for (let i = 0; i < 3; i++)
      expect(await metering.admit(consumer, 3, october)).toEqual({
        allowed: true,
      });
    expect(await metering.admit(consumer, 3, october)).toEqual({
      allowed: false,
      quota: 3,
      resetAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(await metering.admit(unlimited, null, october)).toEqual({
      allowed: true,
    });
    // Refused requests are not counted.
    expect(await redis.get('meter:202610:c:' + consumer)).toBe('3');
    expect(await redis.get('meter:202610:requests')).toBe('5');
    expect(await redis.ttl('meter:202610:requests')).toBeGreaterThan(
      39 * 86400,
    );

    // A new month starts from zero and still reports the previous one.
    expect(await metering.admit(consumer, 3, november)).toEqual({
      allowed: true,
    });
    const report = await metering.report(november);
    expect(report?.source).toMatch(/^[\da-f-]{36}$/);
    expect(
      report?.months.map((month) => [month.month, month.requests]),
    ).toEqual([
      ['202611', 1],
      ['202610', 5],
    ]);
    expect(
      report?.months[1].consumers.sort((a, b) => a.requests - b.requests),
    ).toEqual([
      { consumerId: unlimited, requests: 1 },
      { consumerId: consumer, requests: 3 },
    ]);
    // The source is stable across reports and service instances.
    expect((await new MeteringService(redis).report(november))?.source).toBe(
      report?.source,
    );
  });

  it('fails open when Redis is unavailable', async () => {
    const broken = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    broken.on('error', () => undefined);
    const offline = new MeteringService(broken);
    expect(await offline.admit(randomUUID(), 1)).toEqual({
      allowed: true,
      degraded: true,
    });
    expect(await offline.report()).toBeNull();
    broken.disconnect();
  });
});
