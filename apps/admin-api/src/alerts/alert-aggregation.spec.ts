import {
  METRIC_LATENCY_BUCKETS,
  type AlertRuleConfig,
} from '@api-gateway/shared-types';
import {
  aggregateAlertWindow,
  MAX_ALERT_WINDOW_SAMPLES,
} from './alert-aggregation';

const now = new Date('2026-01-01T00:01:00Z');
const rule: AlertRuleConfig = {
  name: 'Errors',
  metric: 'error_rate',
  operator: '>',
  threshold: 0.1,
  windowMinutes: 1,
  minRequests: 1,
  channelIds: [],
  enabled: true,
};
function sample(
  offset: number,
  requests = 1,
  errors = 0,
  timeouts = 0,
  bucket = 5,
  windowMs = 1000,
) {
  return {
    timestamp: new Date(now.getTime() - offset),
    aggregateWindow: {
      windowMs,
      requestCount: requests,
      errorCount: errors,
      timeoutCount: timeouts,
      latencyCounts: METRIC_LATENCY_BUCKETS.map((value) =>
        value === bucket ? requests : 0,
      ),
    },
  };
}
const complete = () => Array.from({ length: 60 }, (_, i) => sample(i * 1000));
describe('Alert interval aggregation', () => {
  it('weights errors and timeouts by requests rather than averaging interval rates', () => {
    const rows = complete();
    rows[0] = sample(0, 100, 50, 20);
    const result = aggregateAlertWindow(rule, rows, now);
    expect(result).toMatchObject({
      state: 'firing',
      requestCount: 159,
      coverage: 1,
    });
    expect(result.value).toBeCloseTo(50 / 159);
    expect(
      aggregateAlertWindow(
        { ...rule, metric: 'downstream_timeout_rate' },
        rows,
        now,
      ).value,
    ).toBeCloseTo(20 / 159);
  });
  it('merges histograms before computing p95 instead of averaging percentiles', () => {
    const rows = complete();
    rows[0] = sample(0, 10000, 0, 0, 5);
    rows[1] = sample(1000, 1, 0, 0, 300000);
    expect(
      aggregateAlertWindow(
        { ...rule, metric: 'p95_latency_ms', threshold: 50 },
        rows,
        now,
      ),
    ).toMatchObject({ state: 'ok', value: 5 });
  });
  it('computes fractional RPS from whole reporting interval durations', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      sample(i * 2000, 1, 0, 0, 5, 2000),
    );
    expect(
      aggregateAlertWindow({ ...rule, metric: 'rps', threshold: 1 }, rows, now),
    ).toMatchObject({ state: 'ok', value: 0.5 });
  });
  it('distinguishes verified idle RPS from absent or legacy evidence', () => {
    const idle = complete().map((row) => ({
      ...row,
      aggregateWindow: {
        ...row.aggregateWindow,
        requestCount: 0,
        latencyCounts: METRIC_LATENCY_BUCKETS.map(() => 0),
      },
    }));
    expect(
      aggregateAlertWindow(
        { ...rule, metric: 'rps', minRequests: 0, operator: '<', threshold: 1 },
        idle,
        now,
      ),
    ).toMatchObject({ state: 'firing', value: 0 });
    expect(
      aggregateAlertWindow({ ...rule, minRequests: 0 }, idle, now).state,
    ).toBe('no_data');
    expect(aggregateAlertWindow(rule, [], now).state).toBe('no_data');
    expect(
      aggregateAlertWindow(
        rule,
        complete().map((row) => ({ ...row, aggregateWindow: null })),
        now,
      ).state,
    ).toBe('no_data');
  });
  it('requires coverage, freshness and the minimum request count', () => {
    expect(aggregateAlertWindow(rule, complete().slice(0, 47), now).state).toBe(
      'no_data',
    );
    expect(
      aggregateAlertWindow(rule, [sample(16000, 10, 10, 0, 5, 60000)], now)
        .state,
    ).toBe('no_data');
    expect(
      aggregateAlertWindow({ ...rule, minRequests: 61 }, complete(), now).state,
    ).toBe('no_data');
  });
  it('rejects corrupt, future, duplicated and oversized evidence instead of inventing health', () => {
    const rows = complete();
    expect(aggregateAlertWindow(rule, [...rows, sample(-1)], now).state).toBe(
      'no_data',
    );
    expect(
      aggregateAlertWindow(
        rule,
        [...rows, { ...rows[0], aggregateWindow: {} }],
        now,
      ).state,
    ).toBe('no_data');
    expect(
      aggregateAlertWindow(rule, [...rows, ...rows, ...rows], now).state,
    ).toBe('no_data');
    expect(
      aggregateAlertWindow(
        rule,
        Array.from({ length: MAX_ALERT_WINDOW_SAMPLES + 1 }, () => rows[0]),
        now,
      ).state,
    ).toBe('no_data');
  });
  it('clips coverage at the boundary without splitting count or histogram evidence', () => {
    const rows = [
      sample(0, 30, 0, 0, 5, 30000),
      sample(30000, 31, 0, 0, 5, 31000),
    ];
    expect(
      aggregateAlertWindow({ ...rule, metric: 'rps' }, rows, now),
    ).toMatchObject({ coverage: 1, value: 1, requestCount: 61 });
  });
  it.each([
    ['>', false],
    ['>=', true],
    ['<', false],
    ['<=', true],
  ] as const)('uses exact %s threshold semantics', (operator, firing) => {
    expect(
      aggregateAlertWindow(
        { ...rule, metric: 'rps', threshold: 1, operator },
        complete(),
        now,
      ).state,
    ).toBe(firing ? 'firing' : 'ok');
  });
});
