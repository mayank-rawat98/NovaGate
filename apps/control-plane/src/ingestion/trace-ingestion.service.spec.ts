import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  TraceIngestionService,
  validateTraceBatch,
} from './trace-ingestion.service';
import type { TraceSpan } from '@api-gateway/shared-types';
const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
function span(): TraceSpan {
  return {
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: '0123456789abcdef',
    name: 'Gateway request',
    kind: 'server',
    timestamp: new Date().toISOString(),
    durationMs: 1.25,
    status: 'ok',
    attributes: { 'http.route': '/users/:id' },
  };
}
describe('validated tenant trace ingestion', () => {
  it('retains fractional duration and normalizes timestamp', () =>
    expect(validateTraceBatch([span()], 7)[0].durationMs).toBe(1.25));
  it.each(
    [
      [],
      [null],
      [{ ...span(), traceId: '0'.repeat(32) }],
      [{ ...span(), spanId: 'invalid' }],
      [{ ...span(), parentSpanId: '0123456789abcdef' }],
      [{ ...span(), tenantId: 'other-tenant' }],
      [{ ...span(), durationMs: -1 }],
      [{ ...span(), timestamp: 'invalid' }],
      [{ ...span(), timestamp: new Date(Date.now() + 600000).toISOString() }],
      [{ ...span(), attributes: { authorization: 'secret' } }],
      [{ ...span(), attributes: { 'http.route': '/users?token=secret' } }],
      [{ ...span(), attributes: { 'gateway.request.id': 'private-token' } }],
      [{ ...span(), attributes: { 'http.route': 'x'.repeat(257) } }],
      [{ ...span(), kind: ['server'] }],
      [{ ...span(), status: ['ok'] }],
      Array.from({ length: 129 }, () => span()),
    ].map((payload) => [payload] as [unknown]),
  )('rejects malformed or private payloads before SQL %j', (payload) =>
    expect(() => validateTraceBatch(payload, 7)).toThrow('Invalid'),
  );
  it('writes only the authenticated tenant schema and applies transactional limits/retention', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const transaction = jest.fn(async (fn) => fn({ query }));
    const service = new TraceIngestionService({
      transaction,
    } as unknown as DataSource);
    await service.ingest(TENANT, [span()]);
    expect(query.mock.calls.some(([sql]) => sql.includes('search_path'))).toBe(
      false,
    );
    const insert = query.mock.calls.find(([sql]) => sql.startsWith('INSERT'));
    expect(insert?.[0]).toContain(
      'tenant_aabbccdd_1111_2222_3333_444455556666.trace_spans',
    );
    expect(insert?.[1]).toContain(1.25);
    expect(query.mock.calls[0][1]).toEqual(['5000', '1000']);
    expect(query.mock.calls[1][1]).toEqual([`trace-ingestion:${TENANT}`]);
    expect(query.mock.calls.at(-1)?.[1]).toEqual([100000]);
    expect(service.activeIngestions).toBe(0);
  });
  it('keeps concurrent admission until the actual transaction settles and recovers after failure', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = jest
      .fn()
      .mockImplementationOnce(() => pending)
      .mockRejectedValue(new Error('database unavailable'));
    const service = new TraceIngestionService(
      { transaction } as unknown as DataSource,
      new ConfigService({ traceIngestion: { maxConcurrent: 1 } }),
    );
    const first = service.ingest(TENANT, [span()]);
    await expect(service.ingest(TENANT, [span()])).rejects.toThrow('capacity');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(service.activeIngestions).toBe(1);
    release();
    await first;
    await expect(service.ingest(TENANT, [span()])).rejects.toThrow(
      'database unavailable',
    );
    expect(service.activeIngestions).toBe(0);
  });
  it('continues retention after a failed tenant and prevents overlapping sweeps', async () => {
    const first = `tenant_${TENANT.replace(/-/g, '_')}`;
    const second = first.slice(0, -1) + '7';
    const query = jest.fn().mockResolvedValue([]);
    query.mockImplementation(async (sql: string) =>
      sql.startsWith('SELECT table_schema')
        ? [{ table_schema: first }, { table_schema: second }]
        : [],
    );
    const transaction = jest
      .fn()
      .mockImplementationOnce((fn) => fn({ query }))
      .mockRejectedValueOnce(new Error('tenant deleted'))
      .mockImplementation((fn) => fn({ query }));
    const service = new TraceIngestionService({
      transaction,
    } as unknown as DataSource);
    await service.cleanupExpired();
    expect(
      query.mock.calls.some(([sql]) =>
        sql.startsWith(`DELETE FROM ${second}.trace_spans`),
      ),
    ).toBe(true);
    let finish!: () => void;
    transaction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([]);
        }),
    );
    const pending = service.cleanupExpired();
    const calls = transaction.mock.calls.length;
    await service.cleanupExpired();
    expect(transaction).toHaveBeenCalledTimes(calls);
    finish();
    await pending;
    expect(service.activeIngestions).toBe(0);
  });
  it('clears the lifecycle timer and waits for the actual cleanup on shutdown', async () => {
    jest.useFakeTimers();
    try {
      let finish!: () => void;
      const transaction = jest.fn(
        () =>
          new Promise((resolve) => {
            finish = () => resolve([]);
          }),
      );
      const service = new TraceIngestionService({
        transaction,
      } as unknown as DataSource);
      service.onModuleInit();
      jest.advanceTimersByTime(60000);
      expect(transaction).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(120000);
      expect(transaction).toHaveBeenCalledTimes(1);
      let stopped = false;
      const shutdown = service.onModuleDestroy().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish();
      await shutdown;
      expect(stopped).toBe(true);
      jest.advanceTimersByTime(120000);
      expect(transaction).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
  it('cleans idle tenants with the same lock/deadline and excludes malformed schemas', async () => {
    const schema = `tenant_${TENANT.replace(/-/g, '_')}`;
    const query = jest.fn().mockResolvedValue([]);
    query.mockImplementation(async (sql: string) =>
      sql.startsWith('SELECT table_schema') ? [{ table_schema: schema }] : [],
    );
    const transaction = jest.fn(async (fn) => fn({ query }));
    const service = new TraceIngestionService({
      transaction,
    } as unknown as DataSource);
    await service.cleanupExpired();
    expect(
      query.mock.calls.some(([sql]) =>
        sql.startsWith(`DELETE FROM ${schema}.trace_spans`),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('pg_advisory_xact_lock'),
      )?.[1],
    ).toEqual([`trace-ingestion:${TENANT}`]);
    expect(service.activeIngestions).toBe(0);
    query.mockImplementation(async (sql: string) =>
      sql.startsWith('SELECT table_schema')
        ? [{ table_schema: 'public; DROP TABLE secrets' }]
        : [],
    );
    await expect(service.cleanupExpired()).rejects.toThrow(
      'Invalid trace retention schema',
    );
    expect(service.activeIngestions).toBe(0);
    await service.onModuleDestroy();
    transaction.mockClear();
    await service.cleanupExpired();
    expect(transaction).not.toHaveBeenCalled();
  });
  it('rejects tenant SQL injection and malformed data before acquiring a connection', async () => {
    const transaction = jest.fn();
    const service = new TraceIngestionService({
      transaction,
    } as unknown as DataSource);
    await expect(
      service.ingest('x; DROP SCHEMA public', [span()]),
    ).rejects.toThrow('Invalid tenant');
    await expect(
      service.ingest(TENANT, [{ ...span(), tenantId: TENANT }]),
    ).rejects.toThrow('Invalid trace');
    expect(transaction).not.toHaveBeenCalled();
  });
});
