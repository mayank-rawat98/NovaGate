import { DataSource } from 'typeorm';
import { AlertEvaluatorService } from './alert-evaluator.service';
import { AlertRulesService } from './alert-rules.service';

describe('Alert evaluator lifecycle and admission', () => {
  it('uses one non-overlapping timer and waits for the real claim transaction on shutdown', async () => {
    jest.useFakeTimers();
    let release!: (rows: unknown[]) => void;
    const transaction = jest.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          release = resolve;
        }),
    );
    const service = new AlertEvaluatorService(
      { transaction } as unknown as DataSource,
      {} as AlertRulesService,
    );
    try {
      service.onApplicationBootstrap();
      service.onApplicationBootstrap();
      jest.advanceTimersByTime(1000);
      expect(transaction).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(5000);
      expect(transaction).toHaveBeenCalledTimes(1);
      let stopped = false;
      const shutdown = service.onModuleDestroy().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release([]);
      await shutdown;
      expect(stopped).toBe(true);
      jest.advanceTimersByTime(5000);
      expect(transaction).toHaveBeenCalledTimes(1);
      await service.tick();
      expect(transaction).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
  it('releases its tick admission after a database failure', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(new Error('database deadline'))
      .mockResolvedValue([]);
    const service = new AlertEvaluatorService(
      { transaction } as unknown as DataSource,
      {} as AlertRulesService,
    );
    await expect(service.tick()).rejects.toThrow('database deadline');
    await service.tick();
    expect(transaction).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });
  it('rejects malformed internal leases before calling storage', async () => {
    const transaction = jest.fn();
    const service = new AlertEvaluatorService(
      { transaction } as unknown as DataSource,
      {} as AlertRulesService,
    );
    await expect(
      service.evaluateLease({
        tenantId: 'invalid',
        ruleId: 'invalid',
        leaseToken: 'invalid',
      }),
    ).rejects.toThrow();
    await expect(
      service.evaluateLease({
        tenantId: 'aabbccdd-1111-2222-3333-444455556666',
        ruleId: 'invalid',
        leaseToken: 'invalid',
      }),
    ).rejects.toThrow('Invalid alert evaluation lease');
    expect(transaction).not.toHaveBeenCalled();
  });
});

it('bounds idle discovery, shares retention admission, continues after one tenant fails and resets its cursor', async () => {
  const tenants = [
    'aabbccdd-1111-2222-3333-444455556666',
    'bbbbbbbb-1111-2222-3333-444455556666',
  ].map((id) => ({ id }));
  const discovery = jest
    .fn()
    .mockResolvedValueOnce(tenants)
    .mockResolvedValue([]);
  const query = jest.fn(async (sql: string, params?: unknown[]) =>
    sql.includes('SELECT id FROM public.tenants') ? discovery(sql, params) : [],
  );
  const transaction = jest.fn(
    async (fn: (manager: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
  );
  const tenantQuery = jest.fn().mockResolvedValue([]);
  const withTenantTransaction = jest
    .fn()
    .mockRejectedValueOnce(new Error('lock deadline'))
    .mockImplementation(async (_tenant, fn) => fn({ query: tenantQuery }));
  const service = new AlertEvaluatorService(
    { transaction } as unknown as DataSource,
    { withTenantTransaction } as unknown as AlertRulesService,
  );
  const first = service.cleanupExpired();
  const second = service.cleanupExpired();
  await Promise.all([first, second]);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(withTenantTransaction).toHaveBeenCalledTimes(2);
  expect(tenantQuery).toHaveBeenCalledTimes(2);
  expect(discovery.mock.calls[0][0]).toContain('LIMIT 64');
  await service.cleanupExpired();
  expect(discovery.mock.calls[1][1]).toEqual([null]);
  await service.onModuleDestroy();
});

it('waits for explicitly started retention work before completing shutdown', async () => {
  let release!: (rows: unknown[]) => void;
  const transaction = jest.fn(
    () =>
      new Promise<unknown[]>((resolve) => {
        release = resolve;
      }),
  );
  const service = new AlertEvaluatorService(
    { transaction } as unknown as DataSource,
    {} as AlertRulesService,
  );
  const cleanup = service.cleanupExpired();
  let stopped = false;
  const shutdown = service.onModuleDestroy().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release([]);
  await cleanup;
  await shutdown;
  expect(stopped).toBe(true);
  await service.cleanupExpired();
  expect(transaction).toHaveBeenCalledTimes(1);
});
