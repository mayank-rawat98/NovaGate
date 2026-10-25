'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Activity } from 'lucide-react';
import {
  ANOMALY_LIMITS,
  MAX_ANOMALY_CHANNELS,
  type AlertChannel,
  type AnomalySettings,
} from '@api-gateway/shared-types';
import { getAnomalySettings, saveAnomalySettings } from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';
import { DataLoadNotice } from './data-load-notice';

export function AnomalySettingsPanel({
  tenantId,
  channels,
}: {
  tenantId: string;
  channels: AlertChannel[];
}) {
  const { data, error, mutate } = useSWR(
    ['anomaly-settings', tenantId],
    () => getAnomalySettings(tenantId),
    { refreshInterval: 30000 },
  );
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const names = (data?.channelIds ?? []).map(
    (id) =>
      channels.find((channel) => channel.id === id)?.name ?? 'Removed channel',
  );
  return (
    <section
      aria-labelledby="anomaly-settings-title"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="anomaly-settings-title"
            className="flex items-center gap-2 text-lg font-semibold text-slate-900"
          >
            <Activity size={18} aria-hidden="true" />
            Anomaly detection
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Every minute, each route&apos;s last 5 minutes are compared with its
            own 15-minute windows from the past 7 days: 5xx rate, p95 latency
            and traffic. No rule to write; new routes need about an hour of
            traffic first.
          </p>
        </div>
        <button
          ref={opener}
          type="button"
          disabled={!data}
          onClick={() => {
            setNotice('');
            setEditing(true);
          }}
          className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 disabled:opacity-60"
        >
          Edit anomaly detection
        </button>
      </div>
      {error && !data && (
        <div className="mt-4">
          <DataLoadNotice label="Anomaly settings" onRetry={() => mutate()} />
        </div>
      )}
      {data && (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-xl bg-slate-50 p-3">
            <dt className="text-slate-600">Status</dt>
            <dd className="mt-1 font-medium text-slate-900">
              {data.enabled ? 'On' : 'Off'}
            </dd>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <dt className="text-slate-600">Sensitivity</dt>
            <dd className="mt-1 font-medium text-slate-900">
              z-score {data.zThreshold} · at least {data.minRequests} requests
            </dd>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <dt className="text-slate-600">Notifications</dt>
            <dd className="mt-1 break-words font-medium text-slate-900">
              {names.length ? names.join(', ') : 'Dashboard only'}
            </dd>
          </div>
        </dl>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-slate-700">
          {notice}
        </p>
      )}
      {editing && data && (
        <AnomalyEditor
          tenantId={tenantId}
          initial={data}
          channels={channels}
          onClose={() => {
            setEditing(false);
            requestAnimationFrame(() => opener.current?.focus());
          }}
          onSaved={(saved) => {
            void mutate(saved, { revalidate: false });
            setEditing(false);
            setNotice('Anomaly detection saved.');
            requestAnimationFrame(() => opener.current?.focus());
          }}
          onReload={() => mutate()}
        />
      )}
    </section>
  );
}

function AnomalyEditor({
  tenantId,
  initial,
  channels,
  onClose,
  onSaved,
  onReload,
}: {
  tenantId: string;
  initial: AnomalySettings;
  channels: AlertChannel[];
  onClose: () => void;
  onSaved: (settings: AnomalySettings) => void;
  onReload: () => Promise<AnomalySettings | undefined>;
}) {
  const [revision, setRevision] = useState(initial.revision);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [zThreshold, setZThreshold] = useState(String(initial.zThreshold));
  const [minRequests, setMinRequests] = useState(String(initial.minRequests));
  const [channelIds, setChannelIds] = useState(initial.channelIds);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const [zMin, zMax] = ANOMALY_LIMITS.zThreshold;
  const [rMin, rMax] = ANOMALY_LIMITS.minRequests;
  function close() {
    pending.current?.abort();
    onClose();
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const z = Number(zThreshold);
    const requests = Number(minRequests);
    if (
      !Number.isFinite(z) ||
      z < zMin ||
      z > zMax ||
      Math.round(z * 10) !== z * 10 ||
      !Number.isSafeInteger(requests) ||
      requests < rMin ||
      requests > rMax
    ) {
      setFailure(
        `Use a z-score from ${zMin} to ${zMax} (one decimal place) and ${rMin} to ${rMax} requests.`,
      );
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure('');
    try {
      const saved = await saveAnomalySettings(
        tenantId,
        {
          enabled,
          zThreshold: z,
          minRequests: requests,
          channelIds,
          expectedRevision: revision,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) onSaved(saved);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : 'Anomaly settings could not be saved.',
        );
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <WorkspaceDialog label="Edit anomaly detection" onClose={close} centered>
      <form
        onSubmit={save}
        className="space-y-4 bg-white p-5 text-sm text-slate-700"
      >
        <h2 className="text-xl font-semibold text-slate-900">
          Anomaly detection
        </h2>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>
            Detect unusual route behaviour
            <span className="block text-xs text-slate-600">
              Turning it off closes open anomalies without notifications and
              pauses baseline collection.
            </span>
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="anomaly-z" className="font-medium text-slate-800">
              Sensitivity (z-score)
            </label>
            <input
              id="anomaly-z"
              type="number"
              step="0.1"
              min={zMin}
              max={zMax}
              required
              value={zThreshold}
              onChange={(e) => setZThreshold(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-2"
            />
            <span className="text-xs text-slate-600">
              Lower is more sensitive. 3 flags values about three standard
              deviations from the route&apos;s normal.
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="anomaly-min-requests"
              className="font-medium text-slate-800"
            >
              Minimum requests in 5 minutes
            </label>
            <input
              id="anomaly-min-requests"
              type="number"
              min={rMin}
              max={rMax}
              required
              value={minRequests}
              onChange={(e) => setMinRequests(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-2"
            />
          </div>
        </div>
        <fieldset className="rounded-xl border border-slate-200 p-3">
          <legend className="px-1 font-medium text-slate-800">
            Notify channels (up to {MAX_ANOMALY_CHANNELS})
          </legend>
          {!channels.length && (
            <p className="text-xs text-slate-600">
              No channels yet: anomalies appear in the dashboard only.
            </p>
          )}
          {channels.map((channel) => (
            <label key={channel.id} className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={channelIds.includes(channel.id)}
                disabled={
                  !channelIds.includes(channel.id) &&
                  channelIds.length >= MAX_ANOMALY_CHANNELS
                }
                onChange={(e) =>
                  setChannelIds((ids) =>
                    e.target.checked
                      ? [...ids, channel.id]
                      : ids.filter((id) => id !== channel.id),
                  )
                }
              />
              <span className="break-words">
                {channel.name} · {channel.type}
              </span>
            </label>
          ))}
        </fieldset>
        {failure && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-800"
          >
            {failure}
            {/changed/i.test(failure) && (
              <button
                type="button"
                onClick={async () => {
                  const latest = await onReload();
                  if (latest) {
                    setRevision(latest.revision);
                    setFailure('Reloaded. Your edits are kept; save again.');
                  }
                }}
                className="ml-2 font-medium underline"
              >
                Reload revision
              </button>
            )}
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={close}
            className="rounded-xl border border-slate-300 px-4 py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-indigo-700 px-4 py-2 font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save anomaly detection'}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}
