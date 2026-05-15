'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { ChevronDown, ChevronRight, CheckCircle } from 'lucide-react';
import { getErrors, resolveError } from '../../../lib/api-client';
import { getTenantId } from '../../../lib/auth';
import type { ErrorEvent } from '../../../lib/api-client';

type ErrorEventEx = ErrorEvent & { resolved?: boolean };

const ERROR_CODE_STYLES: Record<string, string> = {
  DOWNSTREAM_TIMEOUT: 'bg-red-100 text-red-700',
  DOWNSTREAM_ERROR: 'bg-red-100 text-red-700',
  TOKEN_EXPIRED: 'bg-amber-100 text-amber-700',
  RATE_LIMIT_EXCEEDED: 'bg-purple-100 text-purple-700',
};

function errorCodeStyle(code: string): string {
  return ERROR_CODE_STYLES[code] ?? 'bg-gray-100 text-gray-600';
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function ErrorsPage() {
  const tenantId = getTenantId() ?? '';
  const [showAll, setShowAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const { data: result, mutate } = useSWR(
    tenantId ? `errors-${tenantId}-${showAll}` : null,
    () => getErrors(tenantId, { resolved: showAll ? undefined : false }),
    { refreshInterval: 30000 },
  );

  const errors = (result?.items ?? []) as ErrorEventEx[];

  async function handleResolve(id: string) {
    if (!tenantId) return;
    setResolving(id);
    try {
      await resolveError(tenantId, id);
      if (!showAll) {
        await mutate(
          (prev) =>
            prev
              ? { ...prev, items: prev.items.filter((e) => e.id !== id) }
              : prev,
          { revalidate: false },
        );
      } else {
        await mutate();
      }
    } finally {
      setResolving(null);
    }
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Errors</h1>
        <div className="flex rounded-lg border border-gray-200 bg-white shadow-sm">
          <button
            onClick={() => setShowAll(false)}
            className={`rounded-l-lg px-4 py-2 text-sm font-medium transition-colors ${
              !showAll
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            Unresolved
          </button>
          <button
            onClick={() => setShowAll(true)}
            className={`rounded-r-lg px-4 py-2 text-sm font-medium transition-colors ${
              showAll
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            All
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="w-6 px-2 py-3" />
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Timestamp
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Error Code
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Path
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Service
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Request ID
              </th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {!result ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-gray-400"
                >
                  Loading…
                </td>
              </tr>
            ) : errors.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-gray-400"
                >
                  {showAll ? 'No errors recorded' : 'No unresolved errors'}
                </td>
              </tr>
            ) : (
              errors.map((err) => {
                const expanded = expandedId === err.id;
                return (
                  <>
                    <tr
                      key={err.id}
                      onClick={() => setExpandedId(expanded ? null : err.id)}
                      className="cursor-pointer border-b border-gray-100 hover:bg-gray-50 last:border-0"
                    >
                      <td className="px-2 py-3 text-gray-400">
                        {expanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-500">
                        {formatTs(err.timestamp)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded px-2 py-0.5 font-mono text-xs font-medium ${errorCodeStyle(err.errorCode)}`}
                        >
                          {err.errorCode}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">
                        {err.path ?? '—'}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-gray-700">
                        {err.statusCode ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {err.serviceId ? (
                          <span className="font-mono text-xs">
                            {err.serviceId.slice(0, 8)}…
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">
                        {err.requestId.slice(0, 8)}…
                      </td>
                      <td
                        className="px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {!err.resolved && (
                          <button
                            onClick={() => handleResolve(err.id)}
                            disabled={resolving === err.id}
                            className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
                          >
                            <CheckCircle className="h-3.5 w-3.5" />
                            {resolving === err.id ? '…' : 'Resolve'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr
                        key={`${err.id}-detail`}
                        className="border-b border-gray-100 bg-gray-50"
                      >
                        <td colSpan={8} className="px-6 py-4">
                          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                Request ID
                              </dt>
                              <dd className="mt-0.5 font-mono text-xs text-gray-700 break-all">
                                {err.requestId}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                Error Code
                              </dt>
                              <dd className="mt-0.5 font-mono text-xs text-gray-700">
                                {err.errorCode}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                Message
                              </dt>
                              <dd className="mt-0.5 text-xs text-gray-700">
                                {err.message}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                Service ID
                              </dt>
                              <dd className="mt-0.5 font-mono text-xs text-gray-700">
                                {err.serviceId ?? '—'}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                Path
                              </dt>
                              <dd className="mt-0.5 font-mono text-xs text-gray-700">
                                {err.path ?? '—'}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                Status Code
                              </dt>
                              <dd className="mt-0.5 text-xs text-gray-700">
                                {err.statusCode ?? '—'}
                              </dd>
                            </div>
                          </dl>
                          <p className="mt-3 text-xs text-gray-400">
                            Find full request context in{' '}
                            <a
                              href={`/logs?requestId=${err.requestId}`}
                              className="text-blue-600 underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Logs → {err.requestId}
                            </a>
                          </p>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
