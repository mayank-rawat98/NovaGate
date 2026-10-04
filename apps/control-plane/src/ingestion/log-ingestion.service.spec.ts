import { DataSource } from 'typeorm';
import { LogIngestionService } from './log-ingestion.service';

const TENANT = 'aabbccdd-1111-2222-3333-444455556666';

describe('Telemetry ingestion safety', () => {
  it('never changes a pooled connection search path', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new LogIngestionService({ query } as unknown as DataSource);
    await service.ingestMetrics(TENANT, { rps: 1 });
    expect(query.mock.calls[0][0]).toContain(
      'tenant_aabbccdd_1111_2222_3333_444455556666.metrics_snapshots',
    );
    expect(query.mock.calls.some(([sql]) => sql.includes('search_path'))).toBe(
      false,
    );
  });
  it('rejects invalid tenant identifiers before SQL', async () => {
    const query = jest.fn();
    const service = new LogIngestionService({ query } as unknown as DataSource);
    await expect(
      service.ingestMetrics('x; DROP SCHEMA public', {}),
    ).rejects.toThrow('Invalid tenant');
    expect(query).not.toHaveBeenCalled();
  });
  it('propagates storage failures so callers cannot acknowledge failed writes', async () => {
    const service = new LogIngestionService({
      query: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as DataSource);
    await expect(
      service.ingestErrors(TENANT, [{ id: 'error' }] as never),
    ).rejects.toThrow('database unavailable');
  });
});
