'use client';

import { useEffect, useId, useRef, useState } from 'react';
import useSWR from 'swr';
import { Archive, Clock3, Pause, Play, RefreshCw, X } from 'lucide-react';
import type {
  LogExportCadence,
  LogExportSchedule,
  LogExportScheduleState,
} from '@api-gateway/shared-types';
import {
  getConsumers,
  getLogExportSchedule,
  removeLogExportSchedule,
  saveLogExportSchedule,
} from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';
import { DataLoadNotice } from './data-load-notice';
const button =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60';
const input =
  'mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900';
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'The schedule could not be saved. Refresh it and try again.';
}
export function LogExportSchedulePanel({ tenantId }: { tenantId: string }) {
  return tenantId ? (
    <ScheduleWorkspace key={tenantId} tenantId={tenantId} />
  ) : null;
}
function ScheduleWorkspace({ tenantId }: { tenantId: string }) {
  const id = useId();
  const { data, error, mutate } = useSWR(
    ['log-export-schedule', tenantId],
    () => getLogExportSchedule(tenantId),
    { refreshInterval: 30000 },
  );
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<LogExportSchedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const schedule = data?.schedule;
  const behind = !!(
    schedule?.enabled &&
    Date.parse(schedule.nextWindowAt) + (data?.settlementSeconds ?? 15) * 1000 <
      Date.now() - 45000
  );
  function saved(state: LogExportScheduleState) {
    void mutate(state, { revalidate: false });
    setEditing(false);
    setNotice('Archive schedule saved. Existing windows are retained.');
  }
  function closeRemoval() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setRemoving(null);
    setFailure('');
  }
  async function change(remove = false) {
    const target = remove ? removing : schedule;
    if (!target || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      const state = remove
        ? await removeLogExportSchedule(
            tenantId,
            target.revision,
            controller.signal,
          )
        : await saveLogExportSchedule(
            tenantId,
            {
              enabled: !target.enabled,
              cadence: target.cadence,
              filter: target.filter,
              expectedRevision: target.revision,
            },
            controller.signal,
          );
      if (!controller.signal.aborted) {
        await mutate(state, { revalidate: false });
        setRemoving(null);
        setNotice(
          remove
            ? 'Automatic archives removed. Your archive history is retained.'
            : target.enabled
              ? 'Automatic archives paused. Queued archives will finish.'
              : 'Automatic archives resumed. Waiting windows will catch up.',
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) setFailure(message(error));
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mb-6 overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 bg-emerald-50 px-6 py-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
            Private RustFS archives
          </p>
          <h2
            id={`${id}-title`}
            className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-900"
          >
            <Archive size={21} aria-hidden="true" />
            Automatic log archives
          </h2>
          <p className="mt-1 max-w-xl text-sm text-slate-600">
            Keep a private copy of incoming logs without repeatedly choosing a
            date range.
          </p>
        </div>
        <button
          type="button"
          className={button}
          onClick={() => void mutate().catch(() => undefined)}
        >
          <RefreshCw size={15} aria-hidden="true" />
          Refresh schedule
        </button>
      </div>
      <div className="space-y-4 p-6">
        {error && (
          <DataLoadNotice label="Archive schedule" onRetry={() => mutate()} />
        )}
        {!data && !error && (
          <p className="text-sm text-slate-600">Loading archive schedule…</p>
        )}
        {data && !data.available && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            Automatic archives are unavailable. Ask your installation
            administrator to enable private object storage.
          </p>
        )}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-800">
                {!schedule
                  ? 'Not configured'
                  : !schedule.enabled
                    ? 'Paused'
                    : behind
                      ? 'Catching up'
                      : 'Active'}
              </span>
              {schedule && (
                <span className="inline-flex items-center gap-1 text-sm text-slate-600">
                  <Clock3 size={15} aria-hidden="true" />
                  {schedule.cadence === 'hourly'
                    ? 'Hourly · UTC hour boundaries'
                    : 'Every minute · near real time'}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-600">
              {schedule
                ? 'Windows use the time NovaGate receives each log, so late gateway logs can still be included.'
                : 'Your first window starts when you save. Earlier logs remain available through manual archives.'}{' '}
              Windows wait {data.settlementSeconds} seconds after closing;
              downloads appear once preparation finishes.
            </p>
            {schedule && (
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div className="rounded-xl bg-slate-50 p-3">
                  <dt className="text-slate-600">Waiting archives</dt>
                  <dd className="mt-1 font-semibold text-slate-900">
                    {data.pendingJobs} / {data.queueLimit}
                  </dd>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <dt className="text-slate-600">Waiting receipt windows</dt>
                  <dd className="mt-1 font-semibold text-slate-900">
                    {data.backlogSeconds
                      ? `${Math.ceil(data.backlogSeconds / 60)} min`
                      : 'Up to date'}
                  </dd>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <dt className="text-slate-600">Failed automatic archives</dt>
                  <dd className="mt-1 font-semibold text-slate-900">
                    {data.failedJobs}
                  </dd>
                </div>
              </dl>
            )}
            {!!schedule?.retentionSkippedWindows && (
              <p
                role="status"
                className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950"
              >
                {schedule.retentionSkippedWindows.toLocaleString()} receipt
                window(s) fell partly or wholly outside retained coverage before
                selection. Expired records cannot be restored.
              </p>
            )}
            {schedule?.error && (
              <p
                role="status"
                className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
              >
                {schedule.error}
              </p>
            )}
            {behind && (
              <p className="text-sm text-amber-900">
                Receipt windows are waiting. They stay queued for catch-up;
                refresh to check progress. If progress stops, contact your
                installation administrator.
              </p>
            )}
            {!!data.failedJobs && (
              <p className="text-sm text-rose-800">
                Review failed jobs below. Retry an unexpired archive after the
                storage problem is resolved.
              </p>
            )}
            {schedule && (
              <p className="text-xs text-slate-600">
                Next receipt window closes{' '}
                {new Date(schedule.nextWindowAt).toLocaleString()} (your time).
                Filter:{' '}
                {schedule.filter.minStatusCode
                  ? `status ${schedule.filter.minStatusCode}+`
                  : 'all responses'}
                {schedule.filter.pathPrefix
                  ? ` · ${schedule.filter.pathPrefix}`
                  : ''}
                {schedule.filter.consumerId ? ' · one consumer' : ''}.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!data.available || busy}
                className={button}
                onClick={() => {
                  setFailure('');
                  setNotice('');
                  setEditing(true);
                }}
              >
                {schedule
                  ? 'Edit archive schedule'
                  : 'Set up automatic archives'}
              </button>
              {schedule && (
                <>
                  <button
                    type="button"
                    disabled={!data.available || busy}
                    className={button}
                    onClick={() => void change()}
                  >
                    {schedule.enabled ? (
                      <Pause size={15} aria-hidden="true" />
                    ) : (
                      <Play size={15} aria-hidden="true" />
                    )}
                    {schedule.enabled
                      ? 'Pause automatic archives'
                      : 'Resume automatic archives'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={button}
                    onClick={() => {
                      setFailure('');
                      setRemoving(schedule);
                    }}
                  >
                    Remove archive schedule
                  </button>
                </>
              )}
            </div>
            <p className="text-xs text-slate-600">
              Pausing stops new windows; queued archives finish. Resuming keeps
              the receipt cursor and catches up. Empty windows create no files.
            </p>
          </>
        )}
        {notice && (
          <p role="status" className="text-sm text-emerald-800">
            {notice}
          </p>
        )}
        {failure && !removing && (
          <p role="alert" className="text-sm text-rose-800">
            {failure}
          </p>
        )}
      </div>
      {editing && data && (
        <ScheduleForm
          tenantId={tenantId}
          schedule={schedule ?? null}
          onClose={() => setEditing(false)}
          onSaved={saved}
        />
      )}
      {removing && (
        <WorkspaceDialog
          label="Remove archive schedule"
          onClose={closeRemoval}
          centered
        >
          <div className="space-y-4 p-6">
            <h3 className="text-lg font-semibold text-slate-900">
              Remove automatic archives?
            </h3>
            <p className="text-sm text-slate-600">
              Queued archives and downloads remain available until they expire.
              Unprocessed windows stop here. A new schedule will start from its
              new save time.
            </p>
            {failure && (
              <p role="alert" className="text-sm text-rose-800">
                {failure}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={button} onClick={closeRemoval}>
                Keep schedule
              </button>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void change(true)}
              >
                {busy ? 'Removing…' : 'Confirm removal'}
              </button>
            </div>
          </div>
        </WorkspaceDialog>
      )}
    </section>
  );
}
function ScheduleForm({
  tenantId,
  schedule,
  onSaved,
  onClose,
}: {
  tenantId: string;
  schedule: LogExportSchedule | null;
  onSaved: (state: LogExportScheduleState) => void;
  onClose: () => void;
}) {
  const id = useId();
  const consumers = useSWR(
    ['archive-consumers', tenantId],
    () => getConsumers(tenantId),
    { refreshInterval: 30000 },
  );
  const [cadence, setCadence] = useState<LogExportCadence>(
    schedule?.cadence ?? 'hourly',
  );
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [status, setStatus] = useState(
    schedule?.filter.minStatusCode === undefined
      ? ''
      : String(schedule.filter.minStatusCode),
  );
  const [prefix, setPrefix] = useState(schedule?.filter.pathPrefix ?? '');
  const [consumerId, setConsumer] = useState(schedule?.filter.consumerId ?? '');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    setFailure('');
    if (
      (status &&
        (!Number.isInteger(Number(status)) ||
          Number(status) < 100 ||
          Number(status) > 599)) ||
      (prefix &&
        (!prefix.startsWith('/') ||
          prefix.length > 512 ||
          Array.from(prefix).some(
            (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
          )))
    ) {
      setFailure(
        'Use a status from 100 to 599 and a path prefix beginning with /.',
      );
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setSaving(true);
    try {
      const state = await saveLogExportSchedule(
        tenantId,
        {
          enabled,
          cadence,
          filter: {
            ...(status ? { minStatusCode: Number(status) } : {}),
            ...(prefix ? { pathPrefix: prefix } : {}),
            ...(consumerId ? { consumerId } : {}),
          },
          expectedRevision: schedule?.revision ?? null,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) onSaved(state);
    } catch (error) {
      if (!controller.signal.aborted) setFailure(message(error));
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setSaving(false);
      }
    }
  }
  return (
    <WorkspaceDialog
      label={schedule ? 'Edit archive schedule' : 'Set up automatic archives'}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold text-slate-900">
            {schedule ? 'Edit archive schedule' : 'Set up automatic archives'}
          </h3>
          <button
            type="button"
            className={button}
            aria-label="Close archive schedule form"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="text-sm text-slate-600">
          Private NDJSON files appear in Log archives below.{' '}
          {schedule
            ? 'Changes apply to waiting receipt windows; jobs already queued keep their original filters.'
            : 'Only logs received after this save are included automatically.'}
        </p>
        <div>
          <label
            htmlFor={`${id}-cadence`}
            className="text-sm font-medium text-slate-700"
          >
            Archive frequency
          </label>
          <select
            id={`${id}-cadence`}
            className={input}
            value={cadence}
            onChange={(event) =>
              setCadence(event.target.value as LogExportCadence)
            }
          >
            <option value="hourly">Hourly (UTC hour boundaries)</option>
            <option value="near_real_time">
              Every minute (near real time)
            </option>
          </select>
        </div>
        <div>
          <label
            htmlFor={`${id}-status`}
            className="text-sm font-medium text-slate-700"
          >
            Minimum response status (optional)
          </label>
          <input
            id={`${id}-status`}
            type="number"
            min={100}
            max={599}
            step={1}
            className={input}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            placeholder="All responses"
          />
        </div>
        <div>
          <label
            htmlFor={`${id}-prefix`}
            className="text-sm font-medium text-slate-700"
          >
            Scheduled path prefix (optional)
          </label>
          <input
            id={`${id}-prefix`}
            className={input}
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            pattern="/.*"
            maxLength={512}
            placeholder="/v1/"
          />
        </div>
        <div>
          <label
            htmlFor={`${id}-consumer`}
            className="text-sm font-medium text-slate-700"
          >
            Scheduled consumer
          </label>
          <select
            id={`${id}-consumer`}
            className={input}
            value={consumerId}
            onChange={(event) => setConsumer(event.target.value)}
          >
            <option value="">All consumers</option>
            {consumerId &&
              !consumers.data?.some(
                (consumer) => consumer.id === consumerId,
              ) && <option value={consumerId}>Saved consumer</option>}
            {consumers.data?.map((consumer) => (
              <option key={consumer.id} value={consumer.id}>
                {consumer.name}
              </option>
            ))}
          </select>
          {consumers.error && (
            <DataLoadNotice
              label="Consumers"
              onRetry={() => consumers.mutate()}
            />
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Run automatic archives
        </label>
        {failure && (
          <p role="alert" className="text-sm text-rose-800">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={button} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className={`${button} border-emerald-300 bg-emerald-50 text-emerald-900`}
          >
            {saving ? 'Saving…' : 'Save archive schedule'}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}
