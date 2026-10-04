'use client';

import { useEffect, useState, useId } from 'react';
import useSWR from 'swr';
import { Download, Archive, RefreshCw } from 'lucide-react';
import {
  getLogExports,
  createLogExport,
  downloadLogExport,
} from '../lib/api-client';
import { DataLoadNotice } from './data-load-notice';

export function LogExportPanel({ tenantId }: { tenantId: string }) {
  const id = useId();
  const { data, error, mutate } = useSWR(
    tenantId ? `log-exports-${tenantId}` : null,
    () => getLogExports(tenantId),
    { refreshInterval: 30000 },
  );
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [prefix, setPrefix] = useState('');
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  useEffect(() => {
    const now = new Date();
    setTo(now.toISOString().slice(0, 16));
    setFrom(new Date(now.getTime() - 86400000).toISOString().slice(0, 16));
  }, []);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setFailure('');
    setNotice('');
    const start = new Date(`${from}:00Z`);
    const end = new Date(`${to}:00Z`);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      end <= start ||
      end.getTime() - start.getTime() > 31 * 86400000 ||
      end.getTime() > Date.now() + 60000
    ) {
      setFailure('Choose a past date range of up to 31 days.');
      return;
    }
    setSaving(true);
    try {
      await createLogExport(tenantId, {
        from: start.toISOString(),
        to: end.toISOString(),
        ...(status ? { minStatusCode: Number(status) } : {}),
        ...(prefix ? { pathPrefix: prefix } : {}),
      });
      setNotice('Archive queued. You can keep working while it is prepared.');
      await mutate().catch(() => undefined);
    } catch {
      setFailure(
        'Archive could not be queued. Please try again, or wait for pending archives to finish.',
      );
    } finally {
      setSaving(false);
    }
  }
  async function download(jobId: string) {
    setFailure('');
    setDownloading(jobId);
    try {
      await downloadLogExport(tenantId, jobId);
    } catch {
      setFailure(
        'Download is temporarily unavailable or has expired. Please refresh and try again.',
      );
    } finally {
      setDownloading(null);
    }
  }
  return (
    <section
      className="mb-6 rounded-xl border border-gray-200 bg-white shadow-sm"
      aria-labelledby={`${id}-title`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-6 py-4">
        <div>
          <h2
            id={`${id}-title`}
            className="flex items-center gap-2 text-sm font-semibold text-gray-900"
          >
            <Archive size={17} aria-hidden="true" />
            Log archives
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Download private request logs for reporting and incident review.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void mutate().catch(() => undefined)}
          className="flex items-center gap-1 rounded-md border border-gray-300 px-3 py-2 text-xs text-gray-700"
        >
          <RefreshCw size={14} aria-hidden="true" />
          Refresh archives
        </button>
      </div>
      <div className="p-6">
        {error && (
          <DataLoadNotice label="Log archives" onRetry={() => mutate()} />
        )}
        {!data && !error && (
          <p className="text-sm text-gray-500">Loading archives…</p>
        )}
        {data && !data.enabled && (
          <p className="text-sm text-gray-600">
            Log archives are not enabled for this installation. Your
            administrator can enable private object storage.
          </p>
        )}
        {data?.enabled && (
          <>
            <p className="mb-4 text-xs text-gray-500">
              Dates use UTC. Each archive covers up to 31 days and is kept for{' '}
              {data.retentionDays} days. Downloads contain one JSON record per
              line (NDJSON).
            </p>
            <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1">
                <label
                  htmlFor={`${id}-from`}
                  className="text-xs font-medium text-gray-700"
                >
                  From (UTC)
                </label>
                <input
                  id={`${id}-from`}
                  type="datetime-local"
                  required
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="min-w-0 rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <label
                  htmlFor={`${id}-to`}
                  className="text-xs font-medium text-gray-700"
                >
                  To (UTC, exclusive)
                </label>
                <input
                  id={`${id}-to`}
                  type="datetime-local"
                  required
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="min-w-0 rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <label
                  htmlFor={`${id}-status`}
                  className="text-xs font-medium text-gray-700"
                >
                  Minimum status code
                </label>
                <select
                  id={`${id}-status`}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">All responses</option>
                  <option value="400">Client and server errors (400+)</option>
                  <option value="500">Server errors (500+)</option>
                </select>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <label
                  htmlFor={`${id}-path`}
                  className="text-xs font-medium text-gray-700"
                >
                  Path prefix (optional)
                </label>
                <input
                  id={`${id}-path`}
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="/v1/"
                  maxLength={512}
                  pattern="/.*"
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <button
                type="submit"
                disabled={saving || !tenantId}
                className="justify-self-start rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? 'Queuing…' : 'Create archive'}
              </button>
            </form>
          </>
        )}
        {notice && (
          <p role="status" className="mt-4 text-sm text-green-800">
            {notice}
          </p>
        )}
        {failure && (
          <p role="alert" className="mt-4 text-sm text-red-800">
            {failure}
          </p>
        )}
        {data && (
          <div
            role="region"
            aria-label="Log archives table"
            tabIndex={0}
            className="mt-5 overflow-x-auto rounded-lg border border-gray-200"
          >
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-3 font-medium">Created</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Records / size</th>
                  <th className="px-3 py-3 font-medium">Expires</th>
                  <th className="px-3 py-3 font-medium">Download</th>
                </tr>
              </thead>
              <tbody>
                {!data.jobs.length ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-gray-500">
                      No archives yet. Create one to save a copy of your logs.
                    </td>
                  </tr>
                ) : (
                  data.jobs.map((job) => (
                    <tr key={job.id} className="border-t border-gray-100">
                      <td className="px-3 py-3 text-xs text-gray-600">
                        {new Date(job.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-3">
                        <span className="rounded bg-slate-100 px-2 py-1 text-xs capitalize text-slate-800">
                          {job.status}
                        </span>
                        {job.error && (
                          <p className="mt-2 max-w-xs text-xs text-red-800">
                            {job.error}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-600">
                        {job.rowCount.toLocaleString()} /{' '}
                        {(job.bytes / 1024).toFixed(1)} KB
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-600">
                        {new Date(job.expiresAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-3">
                        {job.status === 'completed' &&
                        Date.parse(job.expiresAt) > Date.now() ? (
                          <button
                            type="button"
                            aria-label={`Download archive ${job.id}`}
                            disabled={!!downloading}
                            onClick={() => void download(job.id)}
                            className="flex items-center gap-1 rounded-md border border-gray-300 px-3 py-2 text-xs text-gray-700 disabled:opacity-50"
                          >
                            <Download size={14} aria-hidden="true" />
                            {downloading === job.id
                              ? 'Downloading…'
                              : 'Download'}
                          </button>
                        ) : (
                          <span className="text-xs text-gray-500">
                            {job.status === 'expired'
                              ? 'Expired'
                              : 'Unavailable'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
