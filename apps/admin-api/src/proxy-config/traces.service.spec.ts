import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { TracesService } from './traces.service';
import { validateTraceQueryConfiguration } from './traces.configuration';

const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
const TRACE = '0123456789abcdef0123456789abcdef';
describe('Bounded trace queries', () => {
  const sql = jest.fn();
  const transaction = jest.fn();
  let service: TracesService;
  beforeEach(() => {
    sql.mockReset().mockResolvedValue([]);
    transaction.mockReset().mockImplementation((fn) => fn({ query: sql }));
    service = new TracesService(
      { transaction } as unknown as DataSource,
      new ConfigService({
        traceQueries: { maxConcurrent: 1, pageSize: 1, maxDetailSpans: 1 },
      }),
    );
  });
  it.each([
    { from: 'yesterday' },
    { from: ['2026-01-01T00:00:00Z'] },
    { from: '2026-01-01T00:00:00Z', to: '2026-01-10T00:00:00Z' },
    { traceId: '0'.repeat(32) },
    { requestId: 'invalid' },
    { route: '/private?token=secret' },
    { errorsOnly: 'yes' },
    { cursor: 'invalid' },
    { tenantId: TENANT },
  ])('rejects invalid filters before database admission: %j', async (input) => {
    await expect(service.list(TENANT, input)).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it('rejects schema injection and malformed detail IDs', async () => {
    await expect(service.list('bad; DROP SCHEMA public', {})).rejects.toThrow();
    await expect(service.detail(TENANT, 'bad')).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it('applies a transaction-local deadline and parameterizes filters', async () => {
    await service.list(TENANT, {
      route: "/route' OR true --",
      requestId: TENANT,
    });
    expect(sql.mock.calls[0]).toEqual([
      "SELECT set_config('statement_timeout', $1, true)",
      ['3000'],
    ]);
    const [query, params] = sql.mock.calls[1];
    expect(query).not.toContain("/route' OR true --");
    expect(params).toContain("/route' OR true --");
    expect(query).toContain(
      'tenant_aabbccdd_1111_2222_3333_444455556666.trace_spans',
    );
  });
  it('keeps admission held until the database settles and releases it after failure', async () => {
    let reject!: (reason: Error) => void;
    transaction.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const pending = service.list(TENANT, {});
    await expect(service.list(TENANT, {})).rejects.toThrow('busy');
    reject(new Error('database deadline'));
    await expect(pending).rejects.toThrow('database deadline');
    await expect(service.list(TENANT, {})).resolves.toEqual({
      traces: [],
      nextCursor: null,
    });
  });
  it('reports missing traces and bounded, canonical span details', async () => {
    await expect(service.detail(TENANT, TRACE)).rejects.toThrow('not found');
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        traceId: TRACE,
        spanId: '0123456789abcdef',
        parentSpanId: null,
        timestamp: new Date(0),
        durationMs: 1.25,
      },
      { traceId: TRACE, spanId: '1123456789abcdef', timestamp: new Date(1) },
    ]);
    const result = await service.detail(TENANT, TRACE);
    expect(result.truncated).toBe(true);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({
      timestamp: '1970-01-01T00:00:00.000Z',
      durationMs: 1.25,
    });
    expect(result.spans[0].parentSpanId).toBeUndefined();
  });
  it('returns a stable keyset cursor and omits null request IDs', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { traceId: TRACE, timestamp: new Date(0), requestId: null },
      { traceId: '1123456789abcdef0123456789abcdef', timestamp: new Date(0) },
    ]);
    const page = await service.list(TENANT, {});
    expect(page.traces).toHaveLength(1);
    expect(page.traces[0].requestId).toBeUndefined();
    expect(
      JSON.parse(Buffer.from(page.nextCursor ?? '', 'base64url').toString()),
    ).toEqual({ traceId: TRACE, timestamp: '1970-01-01T00:00:00.000Z' });
    await service.list(TENANT, { cursor: page.nextCursor });
    expect(sql.mock.calls.at(-1)[1]).toEqual(
      expect.arrayContaining([TRACE, '1970-01-01T00:00:00.000Z']),
    );
  });
  it.each([
    'TRACE_QUERY_MAX_CONCURRENT',
    'TRACE_QUERY_STATEMENT_TIMEOUT_MS',
    'TRACE_QUERY_MAX_RANGE_DAYS',
    'TRACE_QUERY_PAGE_SIZE',
    'TRACE_QUERY_MAX_DETAIL_SPANS',
  ])('validates %s at startup', (key) => {
    expect(() => validateTraceQueryConfiguration({ [key]: '0' })).toThrow(key);
    expect(() => validateTraceQueryConfiguration({ [key]: '1.5' })).toThrow(
      key,
    );
    expect(() =>
      validateTraceQueryConfiguration({ [key]: 'Infinity' }),
    ).toThrow(key);
  });
});
