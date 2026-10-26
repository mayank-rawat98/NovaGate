'use client';
import { useEffect, useState } from 'react';
import {
  getMetrics,
  streamMetrics,
  validateMetricSnapshot,
  type MetricsSnapshot,
} from './api-client';
const MAX_SAMPLES = 600;
type Connection = 'connecting' | 'live' | 'reconnecting';
type State = {
  tenant: string;
  samples: MetricsSnapshot[];
  connection: Connection;
  loading: boolean;
  error: boolean;
};
function merge(samples: MetricsSnapshot[], updates: MetricsSnapshot[]) {
  const cutoff = Date.now() - 3600000;
  const received = new Map<string, MetricsSnapshot>();
  for (const sample of [...samples, ...updates])
    if (
      Date.parse(sample.timestamp) >= cutoff &&
      Date.parse(sample.timestamp) <= Date.now() + 300000
    )
      received.set(sample.timestamp, sample);
  return [...received.values()]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(-MAX_SAMPLES);
}
export function useLiveMetrics(tenantId: string) {
  const [state, setState] = useState<State>({
    tenant: '',
    samples: [],
    connection: 'connecting',
    loading: true,
    error: false,
  });
  const [attempt, setAttempt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!tenantId) return;
    let disposed = false;
    let current: AbortController;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const update = (fn: (value: State) => State) => {
      if (!disposed)
        setState((value) =>
          fn(
            value.tenant === tenantId
              ? value
              : {
                  tenant: tenantId,
                  samples: [],
                  connection: 'connecting',
                  loading: true,
                  error: false,
                },
          ),
        );
    };
    async function connect() {
      current = new AbortController();
      const controller = current;
      update((value) => ({
        ...value,
        connection: value.samples.length ? 'reconnecting' : 'connecting',
      }));
      void getMetrics(tenantId, '1h', controller.signal)
        .then((history) => {
          if (disposed || controller.signal.aborted) return;
          if (!Array.isArray(history) || history.length > 3600)
            throw new Error('Invalid metric history');
          const samples = history.map(validateMetricSnapshot);
          update((value) => ({
            ...value,
            samples: merge(samples, value.samples),
            loading: false,
          }));
        })
        .catch(() => {
          if (!disposed && !controller.signal.aborted)
            update((value) => ({ ...value, error: true, loading: false }));
        });
      try {
        await streamMetrics(
          tenantId,
          controller.signal,
          (snapshot) => {
            if (disposed || controller.signal.aborted) return;
            failures = 0;
            update((value) => ({
              ...value,
              samples: merge(value.samples, [snapshot]),
              loading: false,
              error: false,
              connection: 'live',
            }));
          },
          () => update((value) => ({ ...value, connection: 'live' })),
        );
      } catch {
        /* Reconnect below; retain existing samples for this workspace. */
      }
      if (disposed) return;
      controller.abort();
      update((value) => ({
        ...value,
        connection: 'reconnecting',
        loading: false,
        error: true,
      }));
      timer = setTimeout(
        connect,
        Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)),
      );
    }
    const staleClock = setInterval(() => setClock(Date.now()), 5000);
    void connect();
    return () => {
      disposed = true;
      current?.abort();
      clearTimeout(timer);
      clearInterval(staleClock);
    };
  }, [tenantId, attempt]);
  const sameTenant = state.tenant === tenantId;
  const samples = sameTenant ? state.samples : [];
  const latest = samples.at(-1);
  const connection = sameTenant ? state.connection : 'connecting';
  const stale = !!latest && clock - Date.parse(latest.timestamp) > 45000;
  return {
    data: samples,
    isLoading: sameTenant ? state.loading : true,
    error: sameTenant && state.error,
    connection,
    stale,
    retry: () => setAttempt((value) => value + 1),
  };
}
