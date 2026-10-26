import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  MAX_REPORTED_CONSUMERS,
  nextMonthStart,
  previousUsageMonth,
  usageMonth,
  type MonthlyUsage,
  type UsageReport,
} from '@api-gateway/shared-types';
import { REDIS_CLIENT } from '../shared/redis.tokens';

/** Counters outlive their month so the next month can still report them. */
const COUNTER_TTL_SECONDS = 40 * 86400;

/**
 * Admits one request atomically: refuses a consumer at its quota without
 * counting it, otherwise increments the workspace counter and the consumer's.
 * KEYS: workspace counter, consumer counter ('' when anonymous), consumer set.
 * ARGV: quota (-1 unlimited), TTL seconds, consumer ID.
 */
const ADMIT = `
local quota = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
if KEYS[2] ~= '' then
  if quota >= 0 then
    local used = tonumber(redis.call('GET', KEYS[2]) or '0')
    if used >= quota then return {0, used} end
  end
  redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('SADD', KEYS[3], ARGV[3])
  redis.call('EXPIRE', KEYS[3], ttl)
end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ttl)
return {1, 0}`;

export type MeteringResult =
  | { allowed: true; degraded?: boolean }
  | { allowed: false; quota: number; resetAt: Date };

type MeteredRedis = Redis & {
  meterAdmit(
    workspace: string,
    consumer: string,
    consumers: string,
    quota: number,
    ttl: number,
    consumerId: string,
  ): Promise<[number, number]>;
};

/**
 * Monthly usage counters in the gateway's local Redis (no tenant prefix: one
 * workspace per gateway). Counting fails open; quotas are enforced only while
 * Redis answers.
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);
  private readonly redis: MeteredRedis;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.redis = redis as MeteredRedis;
    this.redis.defineCommand?.('meterAdmit', { numberOfKeys: 3, lua: ADMIT });
  }

  async admit(
    consumerId: string | undefined,
    monthlyQuota: number | null | undefined,
    now = new Date(),
  ): Promise<MeteringResult> {
    const month = usageMonth(now);
    const quota =
      typeof monthlyQuota === 'number' && Number.isSafeInteger(monthlyQuota)
        ? monthlyQuota
        : -1;
    try {
      const [allowed] = await this.redis.meterAdmit(
        `meter:${month}:requests`,
        consumerId ? `meter:${month}:c:${consumerId}` : '',
        `meter:${month}:consumers`,
        quota,
        COUNTER_TTL_SECONDS,
        consumerId ?? '',
      );
      if (allowed === 1) return { allowed: true };
      return { allowed: false, quota, resetAt: nextMonthStart(now) };
    } catch {
      this.logger.warn('Usage metering is unavailable; admitting the request');
      return { allowed: true, degraded: true };
    }
  }

  /** Cumulative totals for this month and the previous one, if counted. */
  async report(now = new Date()): Promise<UsageReport | null> {
    try {
      let source = await this.redis.get('meter:source');
      if (!source) {
        await this.redis.set('meter:source', randomUUID(), 'NX');
        source = await this.redis.get('meter:source');
      }
      if (!source) return null;
      const months: MonthlyUsage[] = [];
      for (const month of [usageMonth(now), previousUsageMonth(now)]) {
        const requests = await this.redis.get(`meter:${month}:requests`);
        if (requests === null && months.length) continue;
        months.push({
          month,
          requests: Number(requests ?? 0),
          consumers: await this.consumers(month),
        });
      }
      return { source, months };
    } catch {
      return null;
    }
  }

  private async consumers(month: string) {
    const ids: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.sscan(
        `meter:${month}:consumers`,
        cursor,
        'COUNT',
        500,
      );
      cursor = next;
      ids.push(...batch);
    } while (cursor !== '0' && ids.length < MAX_REPORTED_CONSUMERS);
    const selected = ids.slice(0, MAX_REPORTED_CONSUMERS);
    if (!selected.length) return [];
    const counts = await this.redis.mget(
      selected.map((id) => `meter:${month}:c:${id}`),
    );
    return selected.map((consumerId, index) => ({
      consumerId,
      requests: Number(counts[index] ?? 0),
    }));
  }
}
