import { describeAnomaly } from '@api-gateway/shared-types';
import {
  scoreRoute,
  stats,
  windowStart,
  type Moments,
  type RouteBaseline,
} from './anomaly-scoring';

const moments = (values: number[]): Moments => ({
  n: values.length,
  sum: values.reduce((a, b) => a + b, 0),
  sumSq: values.reduce((a, b) => a + b * b, 0),
});
const settings = { zThreshold: 3, minRequests: 20 };
const baseline = (overrides: Partial<RouteBaseline> = {}): RouteBaseline => ({
  method: 'GET',
  path: '/orders',
  span: 8,
  // 120 requests per 15-minute window.
  rps: moments(Array(8).fill(120 / 900)),
  errorRate: moments([0.01, 0, 0.02, 0.01, 0, 0.01, 0.01, 0]),
  p95: moments([40, 42, 44, 41, 43, 40, 45, 42]),
  ...overrides,
});
const current = (
  requests: number,
  serverErrors = 0,
  p95Ms: number | null = 42,
) => ({
  method: 'GET',
  path: '/orders',
  requests,
  serverErrors,
  p95Ms,
});

describe('anomaly scoring', () => {
  it('computes sample statistics, including zero-filled windows', () => {
    expect(stats(moments([2, 4, 4, 4, 5, 5, 7, 9]))).toEqual({
      mean: 5,
      stddev: Math.sqrt(32 / 7),
    });
    // Two windows with traffic out of four: mean halves, spread grows.
    const filled = stats(moments([4, 4]), 4);
    expect(filled.mean).toBe(2);
    expect(filled.stddev).toBeCloseTo(Math.sqrt(16 / 3));
    expect(stats(moments([]))).toEqual({ mean: 0, stddev: 0 });
  });

  it('stays quiet for normal traffic', () => {
    expect(scoreRoute(current(40, 0, 44), baseline(), settings)).toEqual([]);
  });

  it('flags a latency spike, an error spike and a traffic spike', () => {
    const [latency] = scoreRoute(current(40, 0, 380), baseline(), settings);
    expect(latency).toMatchObject({
      metric: 'p95_latency_ms',
      direction: 'up',
      current: 380,
      requests: 40,
    });
    expect(latency.baseline.mean).toBeCloseTo(42.125);
    expect(latency.zScore).toBeGreaterThan(50);
    expect(
      scoreRoute(current(40, 8), baseline(), settings).map((f) => f.metric),
    ).toEqual(['error_rate']);
    expect(
      scoreRoute(current(400), baseline(), settings).map((f) => [
        f.metric,
        f.direction,
      ]),
    ).toEqual([['rps', 'up']]);
  });

  it('flags a traffic drop only when the baseline expects enough requests', () => {
    expect(
      scoreRoute(undefined, baseline(), settings).map((f) => [
        f.metric,
        f.direction,
      ]),
    ).toEqual([['rps', 'down']]);
    // 12 requests per window: fewer than 20 expected in 5 minutes.
    expect(
      scoreRoute(
        undefined,
        baseline({ rps: moments(Array(8).fill(12 / 900)) }),
        settings,
      ),
    ).toEqual([]);
  });

  it('applies the guards', () => {
    // Too few requests in the current window for rates and latency (the
    // traffic itself is a drop: 10 where 40 are expected).
    expect(
      scoreRoute(current(10, 5, 900), baseline(), settings).map(
        (f) => f.metric,
      ),
    ).toEqual(['rps']);
    // Too few baseline windows.
    expect(
      scoreRoute(
        current(40, 8, 900),
        baseline({
          span: 3,
          errorRate: moments([0, 0, 0]),
          p95: moments([40, 40, 40]),
        }),
        settings,
      ),
    ).toEqual([]);
    // A constant baseline does not turn a small shift into an alert.
    expect(
      scoreRoute(
        current(40, 0, 50),
        baseline({ p95: moments(Array(8).fill(40)) }),
        settings,
      ),
    ).toEqual([]);
    // One extra error is below the 2-point absolute floor.
    expect(
      scoreRoute(
        current(100, 1),
        baseline({
          // 100 requests per 5 minutes is this route's normal traffic.
          rps: moments(Array(8).fill(300 / 900)),
          errorRate: moments(Array(8).fill(0)),
        }),
        settings,
      ),
    ).toEqual([]);
    // A stricter threshold suppresses a moderate spike (z about 9.9).
    expect(scoreRoute(current(40, 0, 63), baseline(), settings)).toHaveLength(
      1,
    );
    expect(
      scoreRoute(current(40, 0, 63), baseline(), {
        ...settings,
        zThreshold: 10,
      }),
    ).toEqual([]);
  });

  it('describes anomalies and aligns windows to UTC quarter hours', () => {
    expect(
      describeAnomaly({
        method: 'GET',
        path: '/api/orders',
        metric: 'p95_latency_ms',
        direction: 'up',
        baseline: { mean: 42 },
        current: 380,
      }),
    ).toBe(
      'Unusual 805% rise in p95 latency on GET /api/orders: baseline 42 ms, current 380 ms',
    );
    expect(
      describeAnomaly({
        method: 'POST',
        path: '/pay',
        metric: 'error_rate',
        direction: 'up',
        baseline: { mean: 0.002 },
        current: 0.018,
      }),
    ).toBe(
      'Unusual 800% rise in 5xx rate on POST /pay: baseline 0.20%, current 1.80%',
    );
    expect(
      windowStart(new Date('2026-10-25T10:29:59.999Z')).toISOString(),
    ).toBe('2026-10-25T10:15:00.000Z');
  });
});
