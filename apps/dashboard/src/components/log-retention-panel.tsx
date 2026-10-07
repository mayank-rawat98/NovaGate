'use client';
import { useEffect, useId, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Clock3, X } from 'lucide-react';
import type { LogRetentionState } from '@api-gateway/shared-types';
import { getLogRetention, saveLogRetention } from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';
import { DataLoadNotice } from './data-load-notice';
export function LogRetentionPanel({ tenantId }: { tenantId: string }) {
  return tenantId ? (
    <RetentionWorkspace key={tenantId} tenantId={tenantId} />
  ) : null;
}
function RetentionWorkspace({ tenantId }: { tenantId: string }) {
  const { data, error, mutate } = useSWR(
    ['log-retention', tenantId],
    () => getLogRetention(tenantId),
    { refreshInterval: 30000 },
  );
  const { mutate: refresh } = useSWRConfig();
  const [editing, setEditing] = useState<LogRetentionState | null>(null);
  const [notice, setNotice] = useState('');
  return (
    <section
      aria-label="Log retention"
      className="rounded-3xl border border-indigo-100 bg-[#f8f7ff] p-5 shadow-[0_8px_28px_rgba(70,60,120,0.07)] sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-2xl bg-indigo-100 p-3 text-indigo-800">
            <Clock3 aria-hidden="true" size={22} />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Log retention
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Give stored request logs a clear lifetime.
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={!data || !!error}
          onClick={() => {
            setNotice('');
            setEditing(data ?? null);
          }}
          className="rounded-xl border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-900 disabled:opacity-60"
        >
          Edit log retention
        </button>
      </div>
      {error && (
        <div className="mt-4">
          <DataLoadNotice
            label="Log retention settings"
            onRetry={() => mutate()}
          />
        </div>
      )}
      {!data && !error && (
        <p role="status" className="mt-4 text-sm text-slate-600">
          Loading retention settings…
        </p>
      )}
      {data && (
        <>
          <dl className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-white p-4">
              <dt className="text-sm text-slate-600">Raw-log lifetime</dt>
              <dd className="mt-1 font-medium text-slate-900">
                {data.days} {data.days === 1 ? 'day' : 'days'}
              </dd>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <dt className="text-sm text-slate-600">
                Earliest retained receipt
              </dt>
              <dd className="mt-1 text-sm font-medium text-slate-900">
                {new Date(data.receivedFrom).toLocaleString()}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-slate-600">
            {data.cleanup === 'retrying'
              ? 'Physical cleanup encountered a temporary failure and will retry. Expired logs remain hidden.'
              : data.cleanup === 'pending'
                ? 'Physical cleanup is in progress. Expired logs are already hidden.'
                : 'Physical cleanup is up to date; the lifetime continues to apply as logs age.'}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            The lifetime starts when the database receives a log. Expired
            records cannot be restored by increasing it. Private archives have
            their own download lifetime.
          </p>
        </>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-indigo-800">
          {notice}
        </p>
      )}
      {editing && (
        <RetentionEditor
          tenantId={tenantId}
          initial={editing}
          onClose={() => setEditing(null)}
          onReload={() => mutate()}
          onSaved={(state) => {
            void mutate(state, { revalidate: false });
            void refresh(
              (key) =>
                (Array.isArray(key) && key.includes(tenantId)) ||
                key === 'log-exports-' + tenantId,
            );
            setEditing(null);
            setNotice(
              'Log retention saved. Existing archives have expired; create new archives when needed.',
            );
          }}
        />
      )}
    </section>
  );
}
function RetentionEditor({
  tenantId,
  initial,
  onClose,
  onReload,
  onSaved,
}: {
  tenantId: string;
  initial: LogRetentionState;
  onClose: () => void;
  onReload: () => Promise<LogRetentionState | undefined>;
  onSaved: (state: LogRetentionState) => void;
}) {
  const id = useId();
  const [base, setBase] = useState(initial);
  const [days, setDays] = useState(String(initial.days));
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [failure, setFailure] = useState('');
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  function close() {
    pending.current?.abort();
    onClose();
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1 || value > 90) {
      setFailure('Choose 1–90 whole days.');
      return;
    }
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure('');
    try {
      const state = await saveLogRetention(
        tenantId,
        { days: value, expectedRevision: base.revision },
        controller.signal,
      );
      if (!controller.signal.aborted) onSaved(state);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : 'Log retention could not be saved. Try again.',
        );
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  async function reload() {
    setReloading(true);
    setFailure('');
    try {
      const state = await onReload();
      if (!mounted.current) return;
      if (state) setBase(state);
      else setFailure('Current settings could not be loaded. Try again.');
    } catch {
      if (mounted.current)
        setFailure('Current settings could not be loaded. Try again.');
    } finally {
      if (mounted.current) setReloading(false);
    }
  }
  return (
    <WorkspaceDialog label="Edit log retention" onClose={close}>
      <form onSubmit={submit} className="flex h-full flex-col bg-[#fffdf8]">
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <h2 className="text-xl font-semibold text-slate-900">
            Edit log retention
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close log retention editor"
            className="rounded-xl p-2 text-slate-600"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <p className="text-sm text-slate-600">
            Keep database request logs for 1–90 days. The default is 30 days.
            Logs and consumer usage show retained records only.
          </p>
          <div>
            <label
              htmlFor={id}
              className="block text-sm font-medium text-slate-800"
            >
              Raw-log lifetime in days
            </label>
            <input
              id={id}
              type="number"
              min="1"
              max="90"
              step="1"
              required
              value={days}
              disabled={busy}
              onChange={(event) => setDays(event.target.value)}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900"
            />
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <p>
              Changing the lifetime immediately hides expired logs and expires
              all existing archives, cancelling their workers and stopping
              active downloads. New archives use the new retained-data cutoff.
            </p>
            <p className="mt-2">
              Removal is irreversible. Increasing the lifetime keeps future logs
              longer and cannot restore expired records. Downloaded copies,
              gateway output and backups have separate operator policies.
            </p>
            <p className="mt-2">
              Private archives have a separate download lifetime. Automatic
              archive windows lost to raw-log retention are reported as skipped.
            </p>
          </div>
          {failure && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
            >
              <p>{failure}</p>
              <button
                type="button"
                disabled={busy || reloading}
                onClick={reload}
                className="mt-2 underline"
              >
                {reloading ? 'Reloading…' : 'Reload current revision'}
              </button>
              <p className="mt-2">
                Reloading keeps your selection so you can review and retry.
              </p>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 border-t border-slate-200 p-5">
          <button
            type="button"
            onClick={close}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || reloading || Number(days) === base.days}
            className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save retention settings'}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}
