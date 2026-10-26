import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { MetricsStreamService } from './metrics-stream.service';
import { metricStreamConfiguration } from './metrics-stream.configuration';
jest.mock('ioredis');
const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
const OTHER = 'aabbccdd-1111-2222-3333-444455556667';
const snapshot = () => ({
  rps: 1.25,
  p50Ms: 1,
  p95Ms: 2,
  p99Ms: 3,
  errorRate: 0.5,
  timestamp: new Date().toISOString(),
});
describe('Bounded tenant metric stream lifecycle', () => {
  let service: MetricsStreamService;
  let redis: EventEmitter & {
    status: string;
    connect: jest.Mock;
    psubscribe: jest.Mock;
    disconnect: jest.Mock;
  };
  let query: jest.Mock;
  function response() {
    const value = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      writableLength: 0,
      write: jest.fn().mockReturnValue(true),
      end: jest.fn(),
      status: jest.fn(),
      set: jest.fn(),
      flushHeaders: jest.fn(),
    });
    value.status.mockReturnValue(value);
    value.set.mockReturnValue(value);
    value.flushHeaders.mockImplementation(() => {
      value.headersSent = true;
    });
    return value;
  }
  beforeEach(async () => {
    jest.useFakeTimers();
    redis = Object.assign(new EventEmitter(), {
      status: 'ready',
      connect: jest.fn().mockResolvedValue(undefined),
      psubscribe: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn(),
    });
    (Redis as unknown as jest.Mock).mockImplementation(() => redis);
    query = jest.fn().mockResolvedValue([]);
    const dataSource = {
      transaction: async (fn: (manager: { query: jest.Mock }) => unknown) =>
        fn({ query }),
    };
    service = new MetricsStreamService(
      dataSource as unknown as DataSource,
      new ConfigService({
        metricStream: {
          maxConnections: 2,
          maxPerTenant: 1,
          maxPendingReads: 1,
        },
      }),
    );
    await service.onModuleInit();
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });
  it('fans out only to admitted tenant streams and drops malformed Redis frames', async () => {
    const first = response();
    const second = response();
    await service.open(TENANT, first as unknown as Response);
    await service.open(OTHER, second as unknown as Response);
    first.write.mockClear();
    second.write.mockClear();
    redis.emit(
      'pmessage',
      'metrics:*',
      `metrics:${TENANT}`,
      JSON.stringify(snapshot()),
    );
    expect(first.write).toHaveBeenCalledTimes(1);
    expect(second.write).not.toHaveBeenCalled();
    expect(first.write.mock.calls[0][0]).toContain('event: metrics');
    redis.emit(
      'pmessage',
      'metrics:*',
      `metrics:${TENANT}`,
      JSON.stringify({ ...snapshot(), rps: -1 }),
    );
    redis.emit('pmessage', 'metrics:*', `metrics:${TENANT}`, 'x'.repeat(1025));
    redis.emit(
      'pmessage',
      'metrics:*',
      `metrics:${TENANT}`,
      JSON.stringify({ ...snapshot(), timestamp: new Date(0).toISOString() }),
    );
    expect(first.write).toHaveBeenCalledTimes(1);
  });
  it('releases capacity after disconnect and closes slow consumers without accumulating frames', async () => {
    const first = response();
    await service.open(TENANT, first as unknown as Response);
    await expect(
      service.open(TENANT, response() as unknown as Response),
    ).rejects.toThrow('unavailable');
    first.emit('close');
    const slow = response();
    await service.open(TENANT, slow as unknown as Response);
    slow.write.mockReturnValue(false);
    redis.emit(
      'pmessage',
      'metrics:*',
      `metrics:${TENANT}`,
      JSON.stringify(snapshot()),
    );
    expect(slow.end).toHaveBeenCalledTimes(1);
    await service.open(TENANT, response() as unknown as Response);
  });
  it('releases setup failures before committing headers and keeps the HTTP error response available', async () => {
    query.mockRejectedValueOnce(new Error('SQL deadline'));
    const failed = response();
    await expect(
      service.open(TENANT, failed as unknown as Response),
    ).rejects.toThrow('SQL deadline');
    expect(failed.flushHeaders).not.toHaveBeenCalled();
    expect(failed.end).not.toHaveBeenCalled();
    await service.open(TENANT, response() as unknown as Response);
  });
  it('closes on subscription loss and requires successful resubscription before admitting clients', async () => {
    const first = response();
    await service.open(TENANT, first as unknown as Response);
    redis.emit('close');
    expect(first.end).toHaveBeenCalledTimes(1);
    await expect(
      service.open(TENANT, response() as unknown as Response),
    ).rejects.toThrow('unavailable');
    redis.emit('ready');
    await Promise.resolve();
    await service.open(TENANT, response() as unknown as Response);
  });
  it('does not emit a snapshot past session expiry and stops admission at shutdown', async () => {
    const expired = response();
    await service.open(TENANT, expired as unknown as Response, Date.now() - 1);
    expect(expired.write).not.toHaveBeenCalled();
    expect(expired.end).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    await expect(
      service.open(TENANT, response() as unknown as Response),
    ).rejects.toThrow('unavailable');
    expect(redis.disconnect).toHaveBeenCalled();
  });
  it('coalesces samples received during a bounded initial read and emits the newest stored/live snapshot', async () => {
    let finish!: (rows: unknown[]) => void;
    query.mockResolvedValueOnce([]).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = response();
    const opening = service.open(TENANT, first as unknown as Response);
    await Promise.resolve();
    await Promise.resolve();
    const latest = snapshot();
    redis.emit(
      'pmessage',
      'metrics:*',
      `metrics:${TENANT}`,
      JSON.stringify(latest),
    );
    redis.emit(
      'pmessage',
      'metrics:*',
      `metrics:${TENANT}`,
      JSON.stringify({ ...latest, rps: 7.5 }),
    );
    await expect(service.history(OTHER)).rejects.toThrow('busy');
    finish([{ ...latest, timestamp: new Date(Date.now() - 1000) }]);
    await opening;
    expect(
      first.write.mock.calls.filter(([frame]) =>
        frame.includes('event: metrics'),
      ),
    ).toHaveLength(1);
    expect(first.write.mock.calls.at(-1)?.[0]).toContain('"rps":7.5');
  });
  it('emits heartbeats only after setup and closes the stream at session expiry', async () => {
    const first = response();
    await service.open(
      TENANT,
      first as unknown as Response,
      Date.now() + 30000,
    );
    first.write.mockClear();
    jest.advanceTimersByTime(15000);
    expect(first.write).toHaveBeenCalledWith(': heartbeat\n\n');
    jest.advanceTimersByTime(15000);
    expect(first.end).toHaveBeenCalledTimes(1);
    expect(first.write).toHaveBeenCalledTimes(1);
    await service.open(TENANT, response() as unknown as Response);
  });
  it('keeps pending SQL setup free of premature heartbeat headers and closes it at shutdown', async () => {
    let finish!: (rows: unknown[]) => void;
    query.mockResolvedValueOnce([]).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = response();
    const opening = service.open(TENANT, pending as unknown as Response);
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(15000);
    expect(pending.write).not.toHaveBeenCalled();
    expect(pending.flushHeaders).not.toHaveBeenCalled();
    service.onModuleDestroy();
    expect(pending.end).toHaveBeenCalledTimes(1);
    finish([]);
    await opening;
    expect(pending.flushHeaders).not.toHaveBeenCalled();
  });
  it.each([
    'METRICS_STREAM_MAX_CONNECTIONS',
    'METRICS_STREAM_MAX_PER_TENANT',
    'METRICS_STREAM_MAX_PENDING_READS',
    'METRICS_STREAM_MAX_BUFFERED_BYTES',
    'METRICS_STREAM_HEARTBEAT_MS',
    'METRICS_STREAM_MAX_LIFETIME_MS',
    'METRICS_QUERY_STATEMENT_TIMEOUT_MS',
    'METRICS_HISTORY_LIMIT',
    'METRICS_RETENTION_DAYS',
  ])('rejects invalid startup budget %s', (key) => {
    expect(() => metricStreamConfiguration({ [key]: 0 })).toThrow(key);
    expect(() => metricStreamConfiguration({ [key]: Infinity })).toThrow(key);
  });
});
