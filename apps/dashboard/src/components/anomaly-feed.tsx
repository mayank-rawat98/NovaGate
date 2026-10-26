'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { Activity } from 'lucide-react';
import type { Anomaly } from '@api-gateway/shared-types';
import { getAnomalies } from '../lib/api-client';
import { DataLoadNotice } from './data-load-notice';

const FEED_SIZE = 5;

/** Recent statistical anomalies with links to the related logs and traces. */
export function AnomalyFeed({ tenantId }: { tenantId: string }) {
  const { data, error, mutate } = useSWR(
    tenantId ? ['anomalies', tenantId] : null,
    () => getAnomalies(tenantId, 'all'),
    { refreshInterval: 30000 },
  );
  const items = (data ?? []).slice(0, FEED_SIZE);
  return (
    <section aria-label="Anomaly feed" className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <Activity aria-hidden="true" className="h-4 w-4 text-indigo-700" />
        <h2 className="text-base font-semibold text-gray-900">Anomalies</h2>
        <Link
          href="/alerts"
          className="ml-auto text-sm font-medium text-indigo-800 underline"
        >
          Detection settings
        </Link>
      </div>
      {error && !data ? (
        <DataLoadNotice label="Anomalies" onRetry={() => mutate()} />
      ) : !data ? (
        <p role="status" className="text-sm text-gray-600">
          Loading anomalies…
        </p>
      ) : !items.length ? (
        <p className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
          No unusual behaviour. Each route is compared with its own last 7 days
          in 15-minute windows; new routes need about an hour of traffic first.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((anomaly) => (
            <AnomalyItem key={anomaly.id} anomaly={anomaly} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AnomalyItem({ anomaly }: { anomaly: Anomaly }) {
  const active = anomaly.state === 'active';
  const from = new Date(Date.parse(anomaly.startedAt) - 5 * 60000);
  const to = new Date(
    Date.parse(anomaly.resolvedAt ?? anomaly.lastSeenAt) + 60000,
  );
  const logs = `/logs?${new URLSearchParams({
    path: anomaly.path,
    from: from.toISOString(),
    to: to.toISOString(),
  })}`;
  const traces = `/traces?${new URLSearchParams({ route: anomaly.path })}`;
  return (
    <li
      className={`rounded-xl border bg-white p-4 shadow-sm ${active ? 'border-amber-300' : 'border-gray-200'}`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${active ? 'bg-amber-100 text-amber-950' : 'bg-gray-100 text-gray-700'}`}
        >
          {active ? 'Active' : 'Resolved'}
        </span>
        <p className="min-w-0 flex-1 break-words text-sm text-gray-900">
          {anomaly.summary}
        </p>
      </div>
      <p className="mt-2 text-xs text-gray-600">
        Started {new Date(anomaly.startedAt).toLocaleString()}
        {anomaly.resolvedAt
          ? ` · resolved ${new Date(anomaly.resolvedAt).toLocaleString()}`
          : ''}{' '}
        · z-score {anomaly.zScore.toFixed(1)} over {anomaly.baseline.windows}{' '}
        windows
      </p>
      <div className="mt-2 flex gap-4 text-sm">
        <Link href={logs} className="font-medium text-indigo-800 underline">
          View logs
          <span className="sr-only">
            {' '}
            for {anomaly.method} {anomaly.path}
          </span>
        </Link>
        <Link href={traces} className="font-medium text-indigo-800 underline">
          View traces
          <span className="sr-only">
            {' '}
            for {anomaly.method} {anomaly.path}
          </span>
        </Link>
      </div>
    </li>
  );
}
