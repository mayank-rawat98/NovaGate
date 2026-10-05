'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Activity, RefreshCw, Search, Copy } from 'lucide-react';
import { getTrace, getTraces, type TraceParams } from '../../../lib/api-client';
import { useTenantId } from '../../../lib/auth';
import { DataLoadNotice } from '../../../components/data-load-notice';
import type { TraceDetailResponse } from '@api-gateway/shared-types';

const OPTIONS = { refreshInterval: 30000, keepPreviousData: false };
const FIELD =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50';
const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
function timing(value: number) {
  return `${value.toFixed(2)} ms`;
}
function Waterfall({ trace }: { trace: TraceDetailResponse }) {
  const [copied, setCopied] = useState('');
  const first = Math.min(
    ...trace.spans.map((span) => Date.parse(span.timestamp)),
  );
  const duration = Math.max(
    1,
    ...trace.spans.map(
      (span) => Date.parse(span.timestamp) - first + span.durationMs,
    ),
  );
  const received = new Set(trace.spans.map((span) => span.spanId));
  const partial =
    !trace.spans.some((span) => span.kind === 'server') ||
    trace.spans.some(
      (span) =>
        span.kind !== 'server' &&
        span.parentSpanId &&
        !received.has(span.parentSpanId),
    );
  async function copy() {
    try {
      await navigator.clipboard.writeText(trace.traceId);
      setCopied('Trace ID copied');
    } catch {
      setCopied('Copy unavailable. Select the trace ID above to copy it.');
    }
  }
  return (
    <section
      aria-label="Trace waterfall"
      className="mt-6 rounded-3xl border border-indigo-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Request timeline
          </h2>
          <p className="mt-1 break-all font-mono text-xs text-slate-600">
            {trace.traceId}
          </p>
        </div>
        <button className={BUTTON} onClick={copy}>
          <Copy size={16} aria-hidden="true" />
          Copy trace ID
        </button>
      </div>
      <p role="status" className="mt-2 text-sm text-slate-700">
        {copied}
      </p>
      <p className="mb-4 text-sm text-slate-600">
        Received spans only. Sampling, active requests and retention can leave
        gaps.
      </p>
      {(trace.truncated || partial) && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {trace.truncated
            ? 'This large trace is truncated. The earliest retained spans are shown.'
            : 'Some parent spans have not been received. This timeline is partial.'}
        </p>
      )}
      {!trace.spans.length && (
        <p className="text-sm text-slate-600">
          No retained spans are available.
        </p>
      )}
      <ol className="space-y-3">
        {trace.spans.map((span) => {
          const offset = Math.max(0, Date.parse(span.timestamp) - first);
          return (
            <li
              key={span.spanId}
              className="rounded-2xl border border-slate-200 p-3"
            >
              <details>
                <summary className="cursor-pointer rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <span className="font-semibold">{span.name}</span>
                  {' · '}
                  {timing(span.durationMs)}
                  {' · '}
                  <span
                    className={
                      span.status === 'error'
                        ? 'font-semibold text-rose-700'
                        : 'text-slate-600'
                    }
                  >
                    {span.status === 'error'
                      ? 'Error'
                      : span.status === 'ok'
                        ? 'OK'
                        : 'Unspecified'}
                  </span>
                </summary>
                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold text-slate-600">Span ID</dt>
                    <dd className="break-all font-mono text-slate-800">
                      {span.spanId}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-slate-600">
                      Parent span ID
                    </dt>
                    <dd className="break-all font-mono text-slate-800">
                      {span.parentSpanId ?? 'Root span'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-slate-600">Started</dt>
                    <dd className="text-slate-800">{span.timestamp}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-slate-600">Kind</dt>
                    <dd className="text-slate-800">{span.kind}</dd>
                  </div>
                  {Object.entries(span.attributes).map(([key, value]) => (
                    <div key={key}>
                      <dt className="break-all font-semibold text-slate-600">
                        {key}
                      </dt>
                      <dd className="break-all text-slate-800">
                        {String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
              <div
                aria-hidden="true"
                className="mt-3 h-3 overflow-hidden rounded-full bg-slate-100"
              >
                <div
                  className={`h-full min-w-1 rounded-full ${span.status === 'error' ? 'bg-rose-500' : span.kind === 'server' ? 'bg-indigo-500' : 'bg-emerald-500'}`}
                  style={{
                    marginLeft: `${(offset / duration) * 100}%`,
                    width: `${Math.min(100, (span.durationMs / duration) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-slate-600">
                Starts +{timing(offset)} · ends +
                {timing(offset + span.durationMs)}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default function TracesPage() {
  const tenantId = useTenantId();
  const [period, setPeriod] = useState('24');
  const [traceId, setTraceId] = useState('');
  const [requestId, setRequestId] = useState('');
  const [route, setRoute] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [params, setParams] = useState<TraceParams>({});
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const [selected, setSelected] = useState<string>();
  const [validation, setValidation] = useState('');
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('traceId');
    if (id && TRACE_ID.test(id)) {
      setTraceId(id);
      setParams({ traceId: id });
      setSelected(id);
    }
  }, []);
  const cursor = cursors.at(-1);
  const list = useSWR(
    tenantId ? ['traces', tenantId, params, cursor] : null,
    () => getTraces(tenantId as string, { ...params, cursor }),
    OPTIONS,
  );
  const detail = useSWR(
    tenantId && selected ? ['trace', tenantId, selected] : null,
    () => getTrace(tenantId as string, selected as string),
    OPTIONS,
  );
  function search(event: React.FormEvent) {
    event.preventDefault();
    const id = traceId.trim();
    const request = requestId.trim();
    const path = route.trim();
    if (
      (id && !TRACE_ID.test(id)) ||
      (request &&
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(request)) ||
      /[?#]/.test(path)
    ) {
      setValidation(
        'Use a 32-character lowercase trace ID, a UUID request ID and a route without query parameters.',
      );
      return;
    }
    const to = new Date();
    setValidation('');
    setSelected(undefined);
    setCursors([undefined]);
    setParams({
      from: new Date(to.getTime() - Number(period) * 3600000).toISOString(),
      to: to.toISOString(),
      traceId: id || undefined,
      requestId: request || undefined,
      route: path || undefined,
      errorsOnly,
    });
  }
  return (
    <div className="p-4 sm:p-8">
      <header className="mb-6 flex items-center gap-4 rounded-3xl border border-indigo-100 bg-gradient-to-br from-indigo-50 to-emerald-50 p-5 shadow-sm">
        <span
          aria-hidden="true"
          className="rounded-2xl border border-white bg-white/80 p-3 text-indigo-700 shadow-[inset_0_2px_3px_white,0_4px_10px_#c7d2fe]"
        >
          <Activity size={28} />
        </span>
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Traces</h1>
          <p className="mt-1 text-sm text-slate-600">
            Follow requests through your gateway and upstream services.
          </p>
        </div>
      </header>
      <form
        onSubmit={search}
        className="mb-5 grid gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-2 xl:grid-cols-3"
      >
        <div>
          <label
            htmlFor="trace-period"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Time range
          </label>
          <select
            id="trace-period"
            className={FIELD}
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
          >
            <option value="1">Last hour</option>
            <option value="24">Last 24 hours</option>
            <option value="168">Last 7 days</option>
          </select>
        </div>
        <div>
          <label
            htmlFor="trace-id"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Trace ID
          </label>
          <input
            id="trace-id"
            className={FIELD}
            value={traceId}
            maxLength={32}
            onChange={(event) => setTraceId(event.target.value)}
            placeholder="Exact trace ID"
          />
        </div>
        <div>
          <label
            htmlFor="trace-request"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Request ID
          </label>
          <input
            id="trace-request"
            className={FIELD}
            value={requestId}
            maxLength={36}
            onChange={(event) => setRequestId(event.target.value)}
            placeholder="Request UUID"
          />
        </div>
        <div>
          <label
            htmlFor="trace-route"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            Route
          </label>
          <input
            id="trace-route"
            className={FIELD}
            value={route}
            maxLength={256}
            onChange={(event) => setRoute(event.target.value)}
            placeholder="/orders/:id"
          />
        </div>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(event) => setErrorsOnly(event.target.checked)}
          />
          Errors only
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-800"
          >
            <Search size={16} aria-hidden="true" />
            Search traces
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => list.mutate()}
            disabled={list.isValidating}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </form>
      {validation && (
        <p role="alert" className="mb-4 text-sm text-rose-700">
          {validation}
        </p>
      )}
      <p className="mb-4 text-sm text-slate-600">
        Showing sampled, retained traces. Not every request is sampled. Results
        refresh every 30 seconds.
      </p>
      {list.error && (
        <DataLoadNotice label="Traces" onRetry={() => list.mutate()} />
      )}
      {list.isLoading && (
        <p role="status" className="text-sm text-slate-600">
          Loading traces…
        </p>
      )}
      {!list.error && list.data && (
        <>
          {!list.data.traces.length ? (
            <p
              role="status"
              className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600"
            >
              No traces match. Try a wider time range or fewer filters. New
              samples can take a moment to appear.
            </p>
          ) : (
            <div
              role="region"
              aria-label="Trace results"
              tabIndex={0}
              className="overflow-x-auto rounded-2xl border border-slate-200 bg-white"
            >
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    {[
                      'Trace',
                      'Route',
                      'Started (UTC)',
                      'Duration',
                      'Spans',
                      'Outcome',
                    ].map((label) => (
                      <th
                        key={label}
                        scope="col"
                        className="whitespace-nowrap p-3 font-medium"
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.data.traces.map((trace) => (
                    <tr
                      key={trace.traceId}
                      className="border-t border-slate-100"
                    >
                      <td className="p-3">
                        <button
                          onClick={() => setSelected(trace.traceId)}
                          aria-pressed={selected === trace.traceId}
                          className="rounded-md font-mono text-xs text-indigo-700 underline underline-offset-4 focus:ring-2 focus:ring-indigo-500"
                        >
                          {trace.traceId}
                        </button>
                      </td>
                      <td className="p-3 text-slate-800">{trace.route}</td>
                      <td className="whitespace-nowrap p-3 text-slate-600">
                        {trace.timestamp}
                      </td>
                      <td className="whitespace-nowrap p-3 text-slate-800">
                        {timing(trace.durationMs)}
                      </td>
                      <td className="p-3 text-slate-800">{trace.spanCount}</td>
                      <td
                        className={`p-3 ${trace.status === 'error' ? 'font-semibold text-rose-700' : 'text-slate-700'}`}
                      >
                        {trace.status === 'error'
                          ? 'Error'
                          : trace.status === 'ok'
                            ? 'OK'
                            : 'Unspecified'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600">Page {cursors.length}</p>
            <div className="flex gap-2">
              <button
                className={BUTTON}
                disabled={cursors.length <= 1 || list.isLoading}
                onClick={() => {
                  setSelected(undefined);
                  setCursors((values) => values.slice(0, -1));
                }}
              >
                Previous
              </button>
              <button
                className={BUTTON}
                disabled={!list.data.nextCursor || list.isLoading}
                onClick={() => {
                  setSelected(undefined);
                  setCursors((values) => [
                    ...values,
                    list.data?.nextCursor ?? undefined,
                  ]);
                }}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
      {selected && detail.error && (
        <div className="mt-6">
          <DataLoadNotice
            label="Trace details (the trace may no longer be retained)"
            onRetry={() => detail.mutate()}
          />
        </div>
      )}
      {selected && detail.isLoading && (
        <p role="status" className="mt-6 text-sm text-slate-600">
          Loading timeline…
        </p>
      )}
      {selected && !detail.error && detail.data && (
        <Waterfall key={selected} trace={detail.data} />
      )}
    </div>
  );
}
