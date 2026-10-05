import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { LogIngestionService } from './log-ingestion.service';
import { validateMetricPayload } from '@api-gateway/shared-types';
const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
const PAYLOAD = { rps: 1.25, p50: 1, p95: 2, p99: 3, errorRate: 0.25 };
describe('Telemetry ingestion safety', () => {
  it('stores a canonical snapshot with local deadlines, locking and retention without changing search path', async () => {
    const timestamp = new Date();
    const query = jest.fn(async (sql: string) =>
      sql.startsWith('INSERT')
        ? [
            {
              rps: 1.25,
              p50Ms: 1,
              p95Ms: 2,
              p99Ms: 3,
              errorRate: 0.25,
              timestamp,
            },
          ]
        : [],
    );
    const transaction = jest.fn(async (fn) => fn({ query }));
    const service = new LogIngestionService({
      transaction,
    } as unknown as DataSource);
    expect(await service.ingestMetrics(TENANT.toUpperCase(), PAYLOAD)).toEqual({
      rps: 1.25,
      p50Ms: 1,
      p95Ms: 2,
      p99Ms: 3,
      errorRate: 0.25,
      timestamp: timestamp.toISOString(),
    });
    expect(
      query.mock.calls.find(([sql]) => sql.startsWith('INSERT'))?.[0],
    ).toContain(
      'tenant_aabbccdd_1111_2222_3333_444455556666.metrics_snapshots',
    );
    expect(query.mock.calls.some(([sql]) => sql.includes('search_path'))).toBe(
      false,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it.each(
    [
      null,
      [],
      {},
      { ...PAYLOAD, tenantId: 'other' },
      { ...PAYLOAD, rps: Infinity },
      { ...PAYLOAD, rps: -1 },
      { ...PAYLOAD, rps: 1000000001 },
      { ...PAYLOAD, errorRate: 1.01 },
      { ...PAYLOAD, p95: 0 },
      { ...PAYLOAD, p99: 3600001 },
      { ...PAYLOAD, p50: '1' },
    ].map((payload) => [payload] as [unknown]),
  )('rejects malformed metric payloads before SQL: %j', async (payload) => {
    const transaction = jest.fn();
    const service = new LogIngestionService({
      transaction,
    } as unknown as DataSource);
    await expect(service.ingestMetrics(TENANT, payload)).rejects.toThrow(
      'Invalid metric',
    );
    expect(transaction).not.toHaveBeenCalled();
  });
  it('rejects invalid tenant identifiers before SQL', async () => {
    const transaction = jest.fn();
    const service = new LogIngestionService({
      transaction,
    } as unknown as DataSource);
    await expect(
      service.ingestMetrics('x; DROP SCHEMA public', PAYLOAD),
    ).rejects.toThrow('Invalid tenant');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('holds admission until actual transaction completion and recovers after failure', async () => {
    let reject!: (error: Error) => void;
    const transaction = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      )
      .mockRejectedValue(new Error('database deadline'));
    const service = new LogIngestionService(
      { transaction } as unknown as DataSource,
      new ConfigService({ metricIngestion: { maxConcurrent: 1 } }),
    );
    const pending = service.ingestMetrics(TENANT, PAYLOAD);
    await expect(service.ingestMetrics(TENANT, PAYLOAD)).rejects.toThrow(
      'capacity',
    );
    reject(new Error('database deadline'));
    await expect(pending).rejects.toThrow('database deadline');
    await expect(service.ingestMetrics(TENANT, PAYLOAD)).rejects.toThrow(
      'database deadline',
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });
  it('preserves valid zero/idle samples and does not coerce wire values', () => {
    expect(
      validateMetricPayload({ rps: 0, p50: 0, p95: 0, p99: 0, errorRate: 0 })
        .rps,
    ).toBe(0);
  });
  it('propagates storage failures so callers cannot acknowledge failed writes', async () => {
    const service = new LogIngestionService({
      query: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as DataSource);
    await expect(
      service.ingestErrors(TENANT, [{ id: 'error' }] as never),
    ).rejects.toThrow('database unavailable');
  });
  it('runs one retention timer, prevents overlap and waits for actual cleanup on shutdown', async () => {
    jest.useFakeTimers();
    let finish!: (rows: unknown[]) => void;
    const transaction = jest.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          finish = resolve;
        }),
    );
    const service = new LogIngestionService({
      transaction,
    } as unknown as DataSource);
    try {
      service.onModuleInit();
      service.onModuleInit();
      jest.advanceTimersByTime(60000);
      expect(transaction).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(120000);
      await service.cleanupExpired();
      expect(transaction).toHaveBeenCalledTimes(1);
      let stopped = false;
      const shutdown = service.onModuleDestroy().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish([]);
      await shutdown;
      expect(stopped).toBe(true);
      jest.advanceTimersByTime(120000);
      expect(transaction).toHaveBeenCalledTimes(1);
      await expect(service.ingestMetrics(TENANT, PAYLOAD)).rejects.toThrow(
        'stopping',
      );
    } finally {
      jest.useRealTimers();
    }
  });
  it('continues after one tenant cleanup fails and releases admission', async () => {
    const schemas = [TENANT, 'bbbbbbbb-1111-2222-3333-444455556666'].map(
      (id) => ({ table_schema: `tenant_${id.replace(/-/g, '_')}` }),
    );
    const query = jest
      .fn<Promise<unknown[]>, [string, unknown[]?]>()
      .mockResolvedValue([]);
    const transaction = jest
      .fn()
      .mockResolvedValueOnce(schemas)
      .mockRejectedValueOnce(new Error('lock deadline'))
      .mockImplementationOnce(async (fn) => fn({ query }))
      .mockRejectedValueOnce(new Error('subsequent storage failure'));
    const service = new LogIngestionService(
      { transaction } as unknown as DataSource,
      new ConfigService({ metricIngestion: { maxConcurrent: 1 } }),
    );
    await service.cleanupExpired();
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes(schemas[1].table_schema),
      ),
    ).toBe(true);
    await expect(service.ingestMetrics(TENANT, PAYLOAD)).rejects.toThrow(
      'subsequent storage failure',
    );
  });
  it('releases cleanup admission after discovery fails and honors ingestion capacity', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValue(new Error('discovery deadline'));
    const service = new LogIngestionService(
      { transaction } as unknown as DataSource,
      new ConfigService({ metricIngestion: { maxConcurrent: 1 } }),
    );
    await expect(service.cleanupExpired()).rejects.toThrow(
      'discovery deadline',
    );
    await expect(service.ingestMetrics(TENANT, PAYLOAD)).rejects.toThrow(
      'discovery deadline',
    );
    expect(transaction).toHaveBeenCalledTimes(2);
    let finish!: (rows: unknown[]) => void;
    transaction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = service.ingestMetrics(TENANT, PAYLOAD);
    await service.cleanupExpired();
    expect(transaction).toHaveBeenCalledTimes(3);
    finish([]);
    await pending;
  });
});
