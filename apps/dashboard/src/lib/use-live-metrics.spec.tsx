import { act, renderHook, waitFor } from '@testing-library/react';
import { getMetrics, streamMetrics } from './api-client';
import { useLiveMetrics } from './use-live-metrics';
jest.mock('./api-client', () => ({
  getMetrics: jest.fn(),
  streamMetrics: jest.fn(),
  validateMetricSnapshot: (value: unknown) => value,
}));
const snapshot = (rps: number, offset = 0) => ({
  rps,
  p50Ms: 1,
  p95Ms: 2,
  p99Ms: 3,
  errorRate: 0,
  timestamp: new Date(Date.now() + offset).toISOString(),
});
describe('Live metrics workspace lifecycle', () => {
  let callbacks: Array<(value: ReturnType<typeof snapshot>) => void>;
  let signals: AbortSignal[];
  let disconnect: () => void;
  beforeEach(() => {
    callbacks = [];
    signals = [];
    (getMetrics as jest.Mock).mockReset().mockResolvedValue([snapshot(1)]);
    (streamMetrics as jest.Mock)
      .mockReset()
      .mockImplementation((_tenant, signal, sample, ready) => {
        signals.push(signal);
        callbacks.push(sample);
        ready();
        return new Promise<void>((_, reject) => {
          disconnect = () => reject(new Error('offline'));
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      });
  });
  it('loads history once and updates from pushed samples without polling', async () => {
    const hook = renderHook(() => useLiveMetrics('tenant'));
    await waitFor(() => expect(hook.result.current.data).toHaveLength(1));
    act(() => callbacks[0](snapshot(7.25, 1)));
    expect(hook.result.current.data.at(-1)?.rps).toBe(7.25);
    expect(hook.result.current.connection).toBe('live');
    expect(getMetrics).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(signals[0].aborted).toBe(true);
  });
  it('preserves same-workspace samples on disconnect and refreshes them on manual reconnect', async () => {
    const hook = renderHook(() => useLiveMetrics('tenant'));
    await waitFor(() => expect(hook.result.current.data).toHaveLength(1));
    await act(async () => disconnect());
    expect(hook.result.current.connection).toBe('reconnecting');
    expect(hook.result.current.data[0].rps).toBe(1);
    act(() => hook.result.current.retry());
    await waitFor(() => expect(streamMetrics).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(getMetrics).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
  it('clears prior-workspace samples and ignores callbacks after switching tenants', async () => {
    const hook = renderHook(({ tenant }) => useLiveMetrics(tenant), {
      initialProps: { tenant: 'first' },
    });
    await waitFor(() => expect(hook.result.current.data).toHaveLength(1));
    (getMetrics as jest.Mock).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    hook.rerender({ tenant: 'second' });
    expect(hook.result.current.data).toEqual([]);
    act(() => callbacks[0](snapshot(999, 1)));
    expect(hook.result.current.data).toEqual([]);
    expect(signals[0].aborted).toBe(true);
    hook.unmount();
  });
  it('caps client history and marks old samples stale', async () => {
    (getMetrics as jest.Mock).mockResolvedValue(
      Array.from({ length: 1000 }, (_, i) => snapshot(i, -1000000 + i * 10)),
    );
    const hook = renderHook(() => useLiveMetrics('tenant'));
    await waitFor(() => expect(hook.result.current.data).toHaveLength(600));
    expect(hook.result.current.stale).toBe(true);
    hook.unmount();
  });
});
