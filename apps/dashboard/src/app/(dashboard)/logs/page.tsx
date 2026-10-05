'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { getLogs } from '../../../lib/api-client';
import { DataLoadNotice } from '../../../components/data-load-notice';
import { useTenantId } from '../../../lib/auth';
import type { RequestLog } from '../../../lib/api-client';

const PAGE_SIZE = 50;

function statusBadgeClass(code: number): string {
  if (code < 300) return 'bg-green-100 text-green-700';
  if (code < 400) return 'bg-blue-100 text-blue-700';
  if (code < 500) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-blue-100 text-blue-700',
  POST: 'bg-green-100 text-green-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-purple-100 text-purple-700',
  DELETE: 'bg-red-100 text-red-700',
};

interface Filters {
  from: string;
  to: string;
  path: string;
  statusGroup: string;
  consumerId: string;
}

const EMPTY_FILTERS: Filters = {
  from: '',
  to: '',
  path: '',
  statusGroup: '',
  consumerId: '',
};

export default function LogsPage() {
  const tenantId = useTenantId() ?? '';

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchLogs = useCallback(
    async (p: number, f: Filters) => {
      if (!tenantId) return;
      setLoading(true);
      setLoadError(false);
      try {
        const statusCode = f.statusGroup
          ? parseInt(f.statusGroup.replace('xx', '00'), 10)
          : undefined;
        const result = await getLogs(tenantId, {
          page: p,
          ...(f.from ? { from: f.from } : {}),
          ...(f.to ? { to: f.to } : {}),
          ...(f.path ? { path: f.path } : {}),
          ...(statusCode ? { statusCode } : {}),
          ...(f.consumerId ? { consumerId: f.consumerId } : {}),
        });
        setLogs(result.items);
        setFetched(true);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    },
    [tenantId],
  );

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchLogs(1, filters);
  }

  async function goToPage(p: number) {
    setPage(p);
    await fetchLogs(p, filters);
    window.scrollTo({ top: 0 });
  }

  const isLastPage = logs.length < PAGE_SIZE;

  function formatTs(ts: string): string {
    return new Date(ts).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  return (
    <div className="p-4 sm:p-8">
      {loadError && (
        <DataLoadNotice
          label="Request logs"
          onRetry={() => fetchLogs(page, filters)}
        />
      )}
      <h1 className="mb-6 text-2xl font-semibold text-gray-900">Logs</h1>

      {/* Filter bar */}
      <form
        onSubmit={handleSearch}
        className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
      >
        <div className="flex flex-col gap-1">
          <label
            htmlFor="logs-field-1"
            className="text-xs font-medium text-gray-500"
          >
            From
          </label>
          <input
            id="logs-field-1"
            type="datetime-local"
            value={filters.from}
            onChange={(e) =>
              setFilters((f) => ({ ...f, from: e.target.value }))
            }
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="logs-field-2"
            className="text-xs font-medium text-gray-500"
          >
            To
          </label>
          <input
            id="logs-field-2"
            type="datetime-local"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="logs-field-3"
            className="text-xs font-medium text-gray-500"
          >
            Path
          </label>
          <input
            id="logs-field-3"
            type="text"
            placeholder="/users/…"
            value={filters.path}
            onChange={(e) =>
              setFilters((f) => ({ ...f, path: e.target.value }))
            }
            className="w-44 rounded-md border border-gray-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="logs-field-4"
            className="text-xs font-medium text-gray-500"
          >
            Status
          </label>
          <select
            id="logs-field-4"
            value={filters.statusGroup}
            onChange={(e) =>
              setFilters((f) => ({ ...f, statusGroup: e.target.value }))
            }
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All</option>
            <option value="2xx">2xx</option>
            <option value="3xx">3xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="logs-field-5"
            className="text-xs font-medium text-gray-500"
          >
            Consumer
          </label>
          <input
            id="logs-field-5"
            type="text"
            placeholder="consumer ID"
            value={filters.consumerId}
            onChange={(e) =>
              setFilters((f) => ({ ...f, consumerId: e.target.value }))
            }
            className="w-36 rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Search className="h-4 w-4" />
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {/* Table */}
      <div
        tabIndex={0}
        role="region"
        aria-label="Logs table"
        className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="w-6 px-2 py-3" />
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Timestamp
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Method
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Path
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Status
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">
                Response Time
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Service
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Consumer
              </th>
            </tr>
          </thead>
          <tbody>
            {!fetched ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-12 text-center text-sm text-gray-400"
                >
                  Use the filters above and click Search to load logs
                </td>
              </tr>
            ) : loading ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-gray-400"
                >
                  Loading…
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-gray-400"
                >
                  No logs found
                </td>
              </tr>
            ) : (
              logs.map((log) => {
                const expanded = expandedId === log.id;
                return (
                  <>
                    <tr
                      key={log.id}
                      onClick={() => setExpandedId(expanded ? null : log.id)}
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
                        {formatTs(log.timestamp)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded px-2 py-0.5 font-mono text-xs font-semibold ${
                            METHOD_COLORS[log.method] ??
                            'bg-gray-100 text-gray-700'
                          }`}
                        >
                          {log.method}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">
                        {log.path}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-xs font-medium tabular-nums ${statusBadgeClass(log.statusCode)}`}
                        >
                          {log.statusCode}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                        {log.responseTimeMs}ms
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {log.downstreamService ?? (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {log.consumerId ? (
                          <span className="font-mono text-xs">
                            {log.consumerId.slice(0, 8)}…
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr
                        key={`${log.id}-detail`}
                        className="border-b border-gray-100 bg-gray-50"
                      >
                        <td colSpan={8} className="px-6 py-4">
                          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                Request ID
                              </dt>
                              <dd className="mt-0.5 font-mono text-xs text-gray-700 break-all">
                                {log.requestId}
                                {log.traceId && (
                                  <Link
                                    href={`/traces?traceId=${encodeURIComponent(log.traceId)}`}
                                    className="mt-2 block text-indigo-700 underline"
                                  >
                                    View trace
                                  </Link>
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                Client IP
                              </dt>
                              <dd className="mt-0.5 font-mono text-xs text-gray-700">
                                {log.clientIp}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                User Agent
                              </dt>
                              <dd className="mt-0.5 truncate text-xs text-gray-700">
                                {log.userAgent ?? '—'}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                Downstream Latency
                              </dt>
                              <dd className="mt-0.5 text-xs text-gray-700">
                                {log.downstreamLatencyMs != null
                                  ? `${log.downstreamLatencyMs}ms`
                                  : '—'}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-medium text-gray-500">
                                Error Code
                              </dt>
                              <dd className="mt-0.5 text-xs text-gray-700">
                                {log.errorCode ?? '—'}
                              </dd>
                            </div>
                          </dl>
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

      {/* Pagination */}
      {fetched && !loading && logs.length > 0 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-gray-500">Page {page}</p>
          <div className="flex gap-2">
            <button
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1 || loading}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              onClick={() => goToPage(page + 1)}
              disabled={isLastPage || loading}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
