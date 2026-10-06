'use client';
import { useEffect, useId, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { ShieldCheck, X } from 'lucide-react';
import type {
  LogPrivacyPolicy,
  LogPrivacyState,
} from '@api-gateway/shared-types';
import { getLogPrivacy, saveLogPrivacy } from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';
import { DataLoadNotice } from './data-load-notice';
export function LogPrivacyPanel({ tenantId }: { tenantId: string }) {
  return tenantId ? (
    <PrivacyWorkspace key={tenantId} tenantId={tenantId} />
  ) : null;
}
function PrivacyWorkspace({ tenantId }: { tenantId: string }) {
  const { data, error, mutate } = useSWR(
    ['log-privacy', tenantId],
    () => getLogPrivacy(tenantId),
    { refreshInterval: 30000 },
  );
  const [editing, setEditing] = useState<LogPrivacyState | null>(null);
  const [notice, setNotice] = useState('');
  const { mutate: refresh } = useSWRConfig();
  return (
    <section
      className="rounded-3xl border border-emerald-100 bg-[#f7fbf8] p-5 shadow-[0_8px_28px_rgba(49,87,70,0.07)] sm:p-6"
      aria-label="Log privacy"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-2xl bg-emerald-100 p-3 text-emerald-800">
            <ShieldCheck aria-hidden="true" size={22} />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Log privacy
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Choose which client details your request logs retain.
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={!data || !!error}
          className="rounded-xl border border-emerald-300 bg-white px-4 py-2 text-sm font-medium text-emerald-900 disabled:opacity-60"
          onClick={() => {
            setNotice('');
            setEditing(data ?? null);
          }}
        >
          Edit log privacy
        </button>
      </div>
      {error && (
        <div className="mt-4">
          <DataLoadNotice
            label="Log privacy settings"
            onRetry={() => mutate()}
          />
        </div>
      )}
      {!data && !error && (
        <p role="status" className="mt-4 text-sm text-slate-600">
          Loading privacy settings…
        </p>
      )}
      {data && (
        <>
          <dl className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-white p-4">
              <dt className="text-sm text-slate-600">Client IP addresses</dt>
              <dd className="mt-1 font-medium text-slate-900">
                {data.policy.clientIp === 'omit' ? 'Omitted' : 'Retained'}
              </dd>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <dt className="text-sm text-slate-600">User agents</dt>
              <dd className="mt-1 font-medium text-slate-900">
                {data.policy.userAgent === 'omit' ? 'Omitted' : 'Retained'}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-slate-600">
            {data.historicalCleanup === 'retrying'
              ? 'Historical cleanup encountered a temporary failure and will retry. Omitted fields remain hidden from log views.'
              : data.historicalCleanup === 'pending'
                ? 'Historical cleanup is in progress. Omitted fields are already hidden from log views.'
                : 'Historical cleanup is complete. Removed values cannot be restored.'}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            {data.gatewayUpdatePending
              ? 'The gateway update is waiting for confirmation. Stored logs already follow these settings.'
              : 'The latest saved configuration has no pending gateway update.'}{' '}
            Updated gateway software is required to apply privacy settings to
            its local output.
          </p>
        </>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {editing && (
        <PrivacyEditor
          tenantId={tenantId}
          initial={editing}
          onClose={() => setEditing(null)}
          onReload={() => mutate()}
          onSaved={(state) => {
            void mutate(state, { revalidate: false });
            void refresh(
              (key) =>
                (Array.isArray(key) && key.includes(tenantId)) ||
                key === `log-exports-${tenantId}`,
            );
            setEditing(null);
            setNotice(
              'Privacy settings saved. Existing archives have expired; create new archives when needed.',
            );
          }}
        />
      )}
    </section>
  );
}
function PrivacyEditor({
  tenantId,
  initial,
  onClose,
  onSaved,
  onReload,
}: {
  tenantId: string;
  initial: LogPrivacyState;
  onClose: () => void;
  onSaved: (state: LogPrivacyState) => void;
  onReload: () => Promise<LogPrivacyState | undefined>;
}) {
  const id = useId();
  const [base, setBase] = useState(initial);
  const [policy, setPolicy] = useState<LogPrivacyPolicy>({ ...initial.policy });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [reloading, setReloading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function close() {
    pending.current?.abort();
    onClose();
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure('');
    try {
      const state = await saveLogPrivacy(
        tenantId,
        { policy, expectedRevision: base.revision },
        controller.signal,
      );
      if (!controller.signal.aborted) onSaved(state);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : 'Privacy settings could not be saved. Try again.',
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
      if (state) setBase(state);
      else setFailure('Current settings could not be loaded. Try again.');
    } catch {
      setFailure('Current settings could not be loaded. Try again.');
    } finally {
      setReloading(false);
    }
  }
  return (
    <WorkspaceDialog label="Edit log privacy" onClose={close}>
      <form onSubmit={submit} className="flex h-full flex-col bg-[#fffdf8]">
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <h2 className="text-xl font-semibold text-slate-900">
            Edit log privacy
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close log privacy editor"
            className="rounded-xl p-2 text-slate-600"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <p className="text-sm text-slate-600">
            These settings affect request logs and new archives. Request
            routing, authentication and IP access rules continue to use the
            original request.
          </p>
          {(['clientIp', 'userAgent'] as const).map((field) => (
            <div key={field}>
              <label
                htmlFor={`${id}-${field}`}
                className="block text-sm font-medium text-slate-800"
              >
                {field === 'clientIp' ? 'Client IP addresses' : 'User agents'}
              </label>
              <select
                id={`${id}-${field}`}
                value={policy[field]}
                disabled={busy}
                onChange={(event) =>
                  setPolicy((current) => ({
                    ...current,
                    [field]: event.target.value as 'omit' | 'retain',
                  }))
                }
                className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900"
              >
                <option value="omit">Omit from logs</option>
                <option value="retain">Retain in logs</option>
              </select>
            </div>
          ))}
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <p>
              Saving a changed policy expires all existing archives, cancels
              their workers and stops active downloads. Create new archives to
              use the new settings.
            </p>
            <p className="mt-2">
              Omitted fields are removed from historical logs in the background.
              Removal is irreversible; retaining a field later applies to future
              logs. Wait for cleanup to finish before retaining previously
              omitted fields. Downloaded copies and older gateway output cannot
              be recalled.
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
                Reloading keeps your selections so you can review and retry.
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
            disabled={
              busy ||
              reloading ||
              JSON.stringify(policy) === JSON.stringify(base.policy)
            }
            className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save privacy settings'}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}
