'use client';
import { useId, useState } from 'react';
import useSWR from 'swr';
import type { ConsumerAnalyticsPeriod } from '@api-gateway/shared-types';
import { getKeys, getUsage } from '../../../../lib/portal-api';
import { usePortal } from '../../../../components/portal-provider';
import { RequireSession } from '../../../../components/require-session';
import { LoadNotice } from '../../../../components/load-notice';

const PERIODS: Array<[ConsumerAnalyticsPeriod, string]> = [
  ['1h', 'Last hour'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
];

export default function UsagePage() {
  return (
    <RequireSession>
      <Usage />
    </RequireSession>
  );
}

function ms(value: number | null) {
  return value === null ? 'No samples' : `${Math.round(value)} ms`;
}

function Usage() {
  const { tenant } = usePortal();
  const keyId = useId();
  const periodId = useId();
  const { data: keys, error: keysError } = useSWR(['portal-keys', tenant], () =>
    getKeys(tenant),
  );
  const [selected, setSelected] = useState('');
  const [period, setPeriod] = useState<ConsumerAnalyticsPeriod>('24h');
  const key = selected || keys?.[0]?.id || '';
  const { data, error, mutate } = useSWR(
    key ? ['portal-usage', tenant, key, period] : null,
    () => getUsage(tenant, key, period),
    { refreshInterval: 30000 },
  );
  const peak = Math.max(1, ...(data?.series.map((b) => b.requests) ?? [1]));
  return (
    <>
      <h1 className="text-3xl font-semibold text-slate-900">Usage</h1>
      <p className="mt-2 max-w-2xl text-slate-700">
        Requests recorded for your keys. Figures come from the provider&apos;s
        retained request logs and are not a billing statement.
      </p>
      {keysError && <LoadNotice message="Your keys could not be loaded." />}
      {keys && keys.length === 0 && (
        <p className="mt-6 text-slate-700">Create a key to see its usage.</p>
      )}
      {keys && keys.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-4">
          <div>
            <label
              htmlFor={keyId}
              className="block text-sm font-medium text-slate-800"
            >
              Key
            </label>
            <select
              id={keyId}
              value={key}
              onChange={(event) => setSelected(event.target.value)}
              className="mt-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {keys.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {entry.revokedAt ? ' (revoked)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor={periodId}
              className="block text-sm font-medium text-slate-800"
            >
              Period
            </label>
            <select
              id={periodId}
              value={period}
              onChange={(event) =>
                setPeriod(event.target.value as ConsumerAnalyticsPeriod)
              }
              className="mt-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {PERIODS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {error && (
        <LoadNotice
          message="Usage could not be loaded."
          onRetry={() => mutate()}
        />
      )}
      {key && !data && !error && (
        <p role="status" className="mt-6 text-slate-700">
          Loading usage…
        </p>
      )}
      {data && (
        <>
          <dl className="mt-6 grid gap-3 sm:grid-cols-4">
            {[
              ['Requests', data.requests.toLocaleString()],
              ['Server errors', data.serverErrors.toLocaleString()],
              ['Error rate', `${(data.errorRate * 100).toFixed(1)}%`],
              ['p95 latency', ms(data.p95Ms)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl bg-white p-4">
                <dt className="text-sm text-slate-600">{label}</dt>
                <dd className="mt-1 text-xl font-semibold text-slate-900">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <h2 className="mt-8 text-lg font-semibold text-slate-900">
            Requests over time
          </h2>
          <div
            className="mt-3 overflow-x-auto rounded-2xl bg-white p-4"
            tabIndex={0}
            role="region"
            aria-label="Requests over time"
          >
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead className="text-slate-600">
                <tr>
                  <th className="py-1 font-medium">Interval start (UTC)</th>
                  <th className="py-1 font-medium">Requests</th>
                  <th className="py-1 font-medium">
                    <span className="sr-only">Relative volume</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.series
                  .filter((bucket) => bucket.requests > 0)
                  .slice(-48)
                  .map((bucket) => (
                    <tr
                      key={bucket.timestamp}
                      className="border-t border-slate-100"
                    >
                      <td className="py-1">
                        {bucket.timestamp.replace('T', ' ').slice(0, 16)}
                      </td>
                      <td className="py-1">{bucket.requests}</td>
                      <td className="w-1/2 py-1">
                        <div
                          aria-hidden="true"
                          className="h-2 rounded-full bg-indigo-600"
                          style={{
                            width: `${(bucket.requests / peak) * 100}%`,
                          }}
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {data.series.every((bucket) => bucket.requests === 0) && (
              <p className="text-slate-700">
                No requests recorded in this period.
              </p>
            )}
          </div>
          {data.topPaths.length > 0 && (
            <>
              <h2 className="mt-8 text-lg font-semibold text-slate-900">
                Top paths
              </h2>
              <ul className="mt-3 grid gap-2">
                {data.topPaths.map((entry) => (
                  <li
                    key={`${entry.method} ${entry.path}`}
                    className="flex justify-between rounded-xl bg-white px-4 py-2 text-sm"
                  >
                    <span className="font-mono">
                      {entry.method} {entry.path}
                    </span>
                    <span>{entry.requests.toLocaleString()} requests</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}
