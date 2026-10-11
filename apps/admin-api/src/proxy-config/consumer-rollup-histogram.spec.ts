import {
  CONSUMER_ROLLUP_HISTOGRAM_BOUNDS,
  consumerHistogramPercentile,
  mergeConsumerHistograms,
} from '@api-gateway/shared-types';

describe('Mergeable consumer histogram', () => {
  const empty = () => CONSUMER_ROLLUP_HISTOGRAM_BOUNDS.map(() => 0n);
  it('merges counts above JavaScript integer precision without rounding rank', () => {
    const left = empty(),
      right = empty();
    left[0] = 9007199254740993n;
    right[1] = 9007199254740994n;
    const merged = mergeConsumerHistograms(left, right);
    expect(merged[0] + merged[1]).toBe(18014398509481987n);
    expect(consumerHistogramPercentile(merged, 50)).toBe(1);
    expect(left[1]).toBe(0n);
  });
  it('uses nearest rank upper bounds, including zero and the maximum stored latency', () => {
    const histogram = empty();
    expect(consumerHistogramPercentile(histogram, 99)).toBeNull();
    histogram[0] = 50n;
    histogram[7] = 49n;
    histogram[histogram.length - 1] = 1n;
    expect(consumerHistogramPercentile(histogram, 50)).toBe(0);
    expect(consumerHistogramPercentile(histogram, 95)).toBe(64);
    expect(consumerHistogramPercentile(histogram, 99)).toBe(64);
    histogram[histogram.length - 1] = 2n;
    expect(consumerHistogramPercentile(histogram, 99)).toBe(2147483647);
  });
  it('rejects corrupt histograms before merging or estimating', () => {
    expect(() => mergeConsumerHistograms([], empty())).toThrow('Invalid');
    const bad = empty();
    bad[0] = -1n;
    expect(() => consumerHistogramPercentile(bad, 95)).toThrow('Invalid');
  });
});
