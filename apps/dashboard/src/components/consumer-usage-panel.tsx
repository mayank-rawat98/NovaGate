'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Activity, AlertTriangle, Clock3, RefreshCw, X } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CONSUMER_ANALYTICS_ROW_LIMIT } from '@api-gateway/shared-types';
import type {
  ConsumerAnalyticsPeriod,
  ConsumerUsageStats,
} from '@api-gateway/shared-types';
import { getConsumerUsage } from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';

function number(value: number, digits = 0) {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}
function latency(value: number | null) {
  return value === null ? 'No samples' : `${number(value, 2)} ms`;
}
function time(value: string) {
  return new Date(value).toLocaleString();
}

function UsageDetails({ data }: { data: ConsumerUsageStats }) {
  const [bucket, setBucket] = useState(0);
  const selected = data.series[Math.min(bucket, data.series.length - 1)];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Recorded requests', number(data.requests), Activity],
          ['Average requests/sec', number(data.rps, 6), Activity],
          [
            'Server error rate',
            `${number(data.errorRate * 100, 2)}%`,
            AlertTriangle,
          ],
          ['P95 response time', latency(data.p95Ms), Clock3],
        ].map(([label, value, Icon]) => {
          const Glyph = Icon as typeof Activity;
          return (
            <div
              key={String(label)}
              className="rounded-2xl border border-indigo-100 bg-white p-4 shadow-sm"
            >
              <Glyph
                aria-hidden="true"
                className="mb-2 h-4 w-4 text-indigo-600"
              />
              <p className="text-xs font-medium text-slate-600">
                {String(label)}
              </p>
              <p className="mt-1 break-words text-lg font-semibold text-slate-900">
                {String(value)}
              </p>
            </div>
          );
        })}
      </div>
      {data.requests === 0 && (
        <p
          role="status"
          className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-700"
        >
          No recorded requests for this consumer in this period. Confirm the
          gateway is connected and this consumer key is being used.
        </p>
      )}
      <section
        aria-label="Consumer request trend"
        className="mt-5 rounded-2xl border border-slate-200 bg-white p-4"
      >
        <h3 className="font-semibold text-slate-900">Request trend</h3>
        <p className="mt-1 text-xs text-slate-600">
          Each point is the average recorded requests per second over{' '}
          {data.bucketSeconds / 60}{' '}
          {data.bucketSeconds === 60 ? 'minute' : 'minutes'}. Empty intervals
          remain visible.
        </p>
        <div
          className="mt-4 h-44"
          role="img"
          aria-label={`Recorded request rate across ${data.series.length} intervals. Use the interval control below for exact values.`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.series}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="timestamp"
                minTickGap={55}
                tick={{ fontSize: 10 }}
                tickFormatter={(value: string) =>
                  data.period === '7d'
                    ? new Date(value).toLocaleDateString([], {
                        month: 'short',
                        day: 'numeric',
                      })
                    : new Date(value).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                }
              />
              <YAxis
                width={45}
                tick={{ fontSize: 10 }}
                tickFormatter={(value: number) => number(value, 6)}
              />
              <Tooltip
                labelFormatter={(value) => time(String(value))}
                formatter={(value) => [
                  number(Number(value), 6),
                  'Recorded requests/sec',
                ]}
              />
              <Area
                dataKey="rps"
                type="linear"
                stroke="#4f46e5"
                fill="#e0e7ff"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <label
          htmlFor="consumer-usage-interval"
          className="mt-4 block text-xs font-medium text-slate-700"
        >
          Inspect an interval
        </label>
        <input
          id="consumer-usage-interval"
          className="mt-2 w-full accent-indigo-600"
          type="range"
          min={0}
          max={Math.max(0, data.series.length - 1)}
          value={Math.min(bucket, data.series.length - 1)}
          onChange={(event) => setBucket(Number(event.target.value))}
          aria-valuetext={
            selected
              ? `${time(selected.timestamp)}: ${selected.requests} requests`
              : 'No interval'
          }
        />
        {selected && (
          <p aria-live="polite" className="mt-2 text-xs text-slate-600">
            {time(selected.timestamp)} · {number(selected.requests)} requests ·{' '}
            {number(selected.serverErrors)} server errors · P95{' '}
            {latency(selected.p95Ms)}
          </p>
        )}
      </section>
      <section aria-label="Consumer top paths" className="mt-5">
        <h3 className="font-semibold text-slate-900">Top paths</h3>
        <p className="mb-3 mt-1 text-xs text-slate-600">
          Up to 10 method/path groups. Query strings are removed; paths longer
          than 512 characters are grouped by their prefix.
        </p>
        <div
          role="region"
          aria-label="Consumer top paths table"
          tabIndex={0}
          className="overflow-x-auto rounded-xl border border-slate-200"
        >
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="p-3">Path</th>
                <th className="p-3">Requests</th>
                <th className="p-3">Server errors</th>
                <th className="p-3">P95</th>
              </tr>
            </thead>
            <tbody>
              {data.topPaths.length ? (
                data.topPaths.map((path) => (
                  <tr
                    key={`${path.method}:${path.path}`}
                    className="border-t border-slate-100"
                  >
                    <td className="max-w-xs break-all p-3 font-mono text-xs text-slate-800">
                      {path.method} {path.path}
                    </td>
                    <td className="p-3">{number(path.requests)}</td>
                    <td className="p-3">
                      {number(path.serverErrors)} (
                      {number(path.errorRate * 100, 2)}%)
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {latency(path.p95Ms)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="p-4 text-sm text-slate-600">
                    No paths recorded in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <p className="mt-5 text-xs leading-5 text-slate-600">
        Based on received request logs. Window: {time(data.from)} to{' '}
        {time(data.to)}. RPS averages the entire window, including empty
        intervals; server errors are status codes 500 and above. Latency uses{' '}
        {number(data.latencySamples)} valid samples and interpolated
        percentiles. Updated {time(data.generatedAt)}.
      </p>
    </>
  );
}

export function ConsumerUsagePanel({
  tenantId,
  consumerId,
  onClose,
}: {
  tenantId: string;
  consumerId: string;
  onClose: () => void;
}) {
  const [period, setPeriod] = useState<ConsumerAnalyticsPeriod>('24h');
  const requests = useRef(new Set<AbortController>());
  useEffect(() => {
    const active = requests.current;
    return () => {
      for (const request of active) request.abort();
      active.clear();
    };
  }, []);
  const { data, error, isValidating, mutate } = useSWR(
    ['consumer-usage', tenantId, consumerId, period],
    async () => {
      const controller = new AbortController();
      requests.current.add(controller);
      try {
        return await getConsumerUsage(
          tenantId,
          consumerId,
          period,
          controller.signal,
        );
      } finally {
        requests.current.delete(controller);
      }
    },
    { refreshInterval: 30000, shouldRetryOnError: false },
  );
  return (
    <WorkspaceDialog label="Consumer usage" onClose={onClose}>
      <div className="relative flex h-full w-full max-w-3xl flex-col bg-[#fbfaf6] shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-emerald-100 bg-emerald-50 px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-emerald-800">
              Consumer insights
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">
              {data?.consumer.name ?? 'Consumer usage'}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close consumer usage"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-600 hover:bg-emerald-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <p className="mb-4 text-sm leading-6 text-slate-600">
            Explore this consumer’s recorded activity, response times and
            most-used paths. Recent activity may take a moment to arrive from
            your gateway.
          </p>
          {data?.consumer.revokedAt && (
            <p className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              This consumer is revoked. Its recorded history remains available.
            </p>
          )}
          <div className="mb-5 flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <label
                htmlFor="consumer-usage-period"
                className="block text-sm font-medium text-slate-700"
              >
                Usage period
              </label>
              <select
                id="consumer-usage-period"
                value={period}
                onChange={(event) =>
                  setPeriod(event.target.value as ConsumerAnalyticsPeriod)
                }
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"
              >
                <option value="1h">Last hour</option>
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() => void mutate()}
              disabled={isValidating}
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh usage
            </button>
          </div>
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
            >
              <p>
                Consumer usage could not be refreshed. Retry, or choose a
                shorter period if the window contains too many requests.
              </p>
              {data && (
                <p className="mt-1">
                  The figures below are from the previous successful refresh.
                </p>
              )}
              <p className="mt-1">
                This view supports up to {number(CONSUMER_ANALYTICS_ROW_LIMIT)}{' '}
                recorded requests per window.
              </p>
            </div>
          )}
          {!data && !error && (
            <p
              role="status"
              className="rounded-xl bg-white p-5 text-sm text-slate-600"
            >
              Loading consumer usage…
            </p>
          )}
          {data && <UsageDetails key={period} data={data} />}
        </div>
      </div>
    </WorkspaceDialog>
  );
}
