import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConsumerAnalyticsService } from './consumer-analytics.service';
const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
const CONSUMER = '56789012-1234-1234-1234-123456789abc';
function fixture() {
  const manager = {
    query: jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: CONSUMER, name: 'Shop' }])
      .mockResolvedValueOnce([
        {
          logRetentionDays: 30,
          logRetentionRevision: TENANT,
          cutoff: '2026-09-01T00:00:00.000000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          logPrivacy: { clientIp: 'omit', userAgent: 'omit' },
          logPrivacyRevision: CONSUMER,
        },
      ])
      .mockResolvedValue([
        { matched: 0, totals: { requests: 0 }, series: [], paths: [] },
      ]),
  };
  const ds = {
    transaction: jest.fn(async (isolation, fn) =>
      typeof isolation === 'function'
        ? isolation({ query: jest.fn().mockResolvedValue([{ valid: true }]) })
        : fn(manager),
    ),
  };
  return {
    manager,
    ds,
    service: new ConsumerAnalyticsService(ds as unknown as DataSource),
  };
}
describe('Consumer analytics bounds and lifecycle', () => {
  it.each(['bad', '', null, [], "x');DROP TABLE consumers;--"])(
    'rejects malformed consumer %p before database admission',
    async (consumer) => {
      const { service, ds } = fixture();
      await expect(service.get(TENANT, consumer)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(ds.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['30d', '', '__proto__', ['1h'], null])(
    'rejects unsupported periods %p',
    async (period) => {
      const { service, ds } = fixture();
      await expect(
        service.get(TENANT, CONSUMER, period),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ds.transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects invalid tenant identifiers before admission', async () => {
    const { service, ds } = fixture();
    await expect(service.get('public', CONSUMER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ds.transaction).not.toHaveBeenCalled();
  });
  it('rejects a missing consumer without reading other traffic', async () => {
    const { service, manager } = fixture();
    manager.query.mockReset().mockResolvedValue([]);
    await expect(service.get(TENANT, CONSUMER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(manager.query).toHaveBeenCalledTimes(2);
  });
  it('never returns partial totals after a row-limit breach', async () => {
    const { service, manager } = fixture();
    manager.query
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: CONSUMER }])
      .mockResolvedValueOnce([
        {
          logRetentionDays: 30,
          logRetentionRevision: TENANT,
          cutoff: '2026-09-01T00:00:00.000000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          logPrivacy: { clientIp: 'omit', userAgent: 'omit' },
          logPrivacyRevision: CONSUMER,
        },
      ])
      .mockResolvedValue([
        { matched: 100001, totals: { requests: 0 }, series: [], paths: [] },
      ]);
    await expect(service.get(TENANT, CONSUMER)).rejects.toThrow(
      'shorter period',
    );
  });
  it('rejects a result if retention changed during the aggregate snapshot', async () => {
    const { service, ds } = fixture();
    ds.transaction
      .mockImplementationOnce(async (_isolation, fn) =>
        fn({
          query: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: CONSUMER, name: 'Shop' }])
            .mockResolvedValueOnce([
              {
                logRetentionDays: 30,
                logRetentionRevision: TENANT,
                cutoff: '2026-09-01T00:00:00.123456Z',
              },
            ])
            .mockResolvedValueOnce([
              {
                logPrivacy: { clientIp: 'omit', userAgent: 'omit' },
                logPrivacyRevision: CONSUMER,
              },
            ])
            .mockResolvedValueOnce([
              { matched: 1, totals: { requests: 1 }, series: [], paths: [] },
            ]),
        }),
      )
      .mockImplementationOnce(async (fn) =>
        fn({ query: jest.fn().mockResolvedValue([{ valid: false }]) }),
      );
    await expect(service.get(TENANT, CONSUMER)).rejects.toThrow(
      'Log privacy or retention changed',
    );
  });
  it('bounds actual tenant work, canonicalizes uppercase IDs, drains it and stops new work', async () => {
    let release!: (value: unknown) => void;
    const result = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const ds = {
      transaction: jest.fn((arg) =>
        typeof arg === 'function'
          ? arg({ query: jest.fn().mockResolvedValue([{ valid: true }]) })
          : result,
      ),
    };
    const service = new ConsumerAnalyticsService(ds as unknown as DataSource);
    const first = service.get(TENANT, CONSUMER);
    const second = service.get(TENANT.toUpperCase(), CONSUMER);
    await expect(service.get(TENANT, CONSUMER)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(ds.transaction).toHaveBeenCalledTimes(2);
    let drained = false;
    const closing = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(service.get(TENANT, CONSUMER)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    release({ requests: 0 });
    await Promise.all([first, second, closing]);
    expect(drained).toBe(true);
  });
  it('bounds global work independently of tenant limits and releases failed slots', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const ds = {
      transaction: jest.fn((arg) =>
        typeof arg === 'function'
          ? arg({ query: jest.fn().mockResolvedValue([{ valid: true }]) })
          : pending,
      ),
    };
    const service = new ConsumerAnalyticsService(ds as unknown as DataSource);
    const jobs = Array.from({ length: 8 }, (_, i) =>
      service.get(
        `aabbccdd-1111-2222-3333-${String(i).padStart(12, '0')}`,
        CONSUMER,
      ),
    );
    await expect(service.get(TENANT, CONSUMER)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    release({ requests: 0 });
    await Promise.all(jobs);
    ds.transaction.mockRejectedValueOnce(new Error('private database detail'));
    await expect(service.get(TENANT, CONSUMER)).rejects.toThrow(
      'temporarily unavailable',
    );
    await expect(service.get(TENANT, CONSUMER)).resolves.toEqual({
      requests: 0,
    });
  });
});
