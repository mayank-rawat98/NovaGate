'use client';
import { useEffect, useState } from 'react';
import type {
  CircuitBreakerSnapshot,
  ServiceCircuitStatus,
} from '@api-gateway/shared-types';
import { getCircuitBreakers, streamCircuitBreakers } from './api-client';

type Connection = 'connecting' | 'live' | 'reconnecting';
type State = {
  tenant: string;
  snapshot: CircuitBreakerSnapshot | null;
  connection: Connection;
};

/**
 * Per-service circuit states for the workspace's gateway: one REST snapshot,
 * then the live stream, with bounded reconnect backoff. State never crosses
 * workspaces.
 */
export function useLiveCircuits(tenantId: string) {
  const [state, setState] = useState<State>({
    tenant: '',
    snapshot: null,
    connection: 'connecting',
  });
  useEffect(() => {
    if (!tenantId) return;
    let disposed = false;
    let current: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const update = (fn: (value: State) => State) => {
      if (!disposed)
        setState((value) =>
          fn(
            value.tenant === tenantId
              ? value
              : { tenant: tenantId, snapshot: null, connection: 'connecting' },
          ),
        );
    };
    async function connect() {
      current = new AbortController();
      const controller = current;
      update((value) => ({
        ...value,
        connection: value.snapshot ? 'reconnecting' : 'connecting',
      }));
      void getCircuitBreakers(tenantId, controller.signal)
        .then((snapshot) =>
          update((value) => ({
            ...value,
            snapshot: value.snapshot ?? snapshot,
          })),
        )
        .catch(() => undefined);
      try {
        await streamCircuitBreakers(tenantId, controller.signal, (snapshot) => {
          if (disposed || controller.signal.aborted) return;
          failures = 0;
          update((value) => ({ ...value, snapshot, connection: 'live' }));
        });
      } catch {
        /* Reconnect below; keep this workspace's last snapshot. */
      }
      if (disposed) return;
      controller.abort();
      update((value) => ({ ...value, connection: 'reconnecting' }));
      timer = setTimeout(
        connect,
        Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)),
      );
    }
    void connect();
    return () => {
      disposed = true;
      current?.abort();
      clearTimeout(timer);
    };
  }, [tenantId]);
  const sameTenant = state.tenant === tenantId;
  const snapshot = sameTenant ? state.snapshot : null;
  const byService = new Map<string, ServiceCircuitStatus>(
    (snapshot?.services ?? []).map((status) => [status.serviceId, status]),
  );
  return {
    reportedAt: snapshot?.reportedAt ?? null,
    byService,
    connection: sameTenant ? state.connection : 'connecting',
  };
}
