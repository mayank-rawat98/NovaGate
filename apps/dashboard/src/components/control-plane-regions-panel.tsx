'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Globe2 } from 'lucide-react';
import type { ControlPlaneRegionsState } from '@api-gateway/shared-types';
import { getControlPlaneRegions, savePreferredRegion } from '../lib/api-client';
import { DataLoadNotice } from './data-load-notice';

export function ControlPlaneRegionsPanel({ tenantId }: { tenantId: string }) {
  return tenantId ? (
    <RegionsWorkspace key={tenantId} tenantId={tenantId} />
  ) : null;
}

function relative(value: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return new Date(value).toLocaleString();
}

function RegionsWorkspace({ tenantId }: { tenantId: string }) {
  const { data, error, mutate } = useSWR(
    ['control-plane-regions', tenantId],
    () => getControlPlaneRegions(tenantId),
    { refreshInterval: 30000 },
  );
  return (
    <section
      aria-label="Control plane regions"
      className="min-w-0 rounded-3xl border border-indigo-100 bg-[#f8f7ff] p-5 shadow-[0_8px_28px_rgba(70,60,120,0.07)] sm:p-6"
    >
      <div className="flex items-center gap-3">
        <span className="rounded-2xl bg-indigo-100 p-3 text-indigo-800">
          <Globe2 aria-hidden="true" size={22} />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Control plane regions
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Your gateways keep serving traffic from their last configuration if
            a control plane region is unreachable, and reconnect to the next
            region they are configured with.
          </p>
        </div>
      </div>
      {error && !data && (
        <div className="mt-4">
          <DataLoadNotice
            label="Control plane regions"
            onRetry={() => mutate()}
          />
        </div>
      )}
      {!data ? (
        !error && (
          <p role="status" className="mt-4 text-sm text-slate-600">
            Loading regions…
          </p>
        )
      ) : (
        <>
          <PreferredRegion
            tenantId={tenantId}
            data={data}
            onSaved={(next) => mutate(next, { revalidate: false })}
          />
          <Gateways data={data} />
        </>
      )}
    </section>
  );
}

function PreferredRegion({
  tenantId,
  data,
  onSaved,
}: {
  tenantId: string;
  data: ControlPlaneRegionsState;
  onSaved: (state: ControlPlaneRegionsState) => void;
}) {
  const [value, setValue] = useState(data.preferredRegion ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  if (data.regions.length < 2)
    return (
      <p className="mt-4 text-sm text-slate-700">
        This installation runs a single control plane region
        {data.regions[0] ? ` (${data.regions[0]})` : ''}.
      </p>
    );
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await savePreferredRegion(
        tenantId,
        { preferredRegion: value || null },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      onSaved(saved);
      setMessage({
        ok: true,
        text: saved.preferredRegion
          ? `Gateways that know a ${saved.preferredRegion} endpoint will move there.`
          : 'Gateways use their configured endpoint order.',
      });
    } catch (cause) {
      if (!controller.signal.aborted)
        setMessage({
          ok: false,
          text:
            cause instanceof Error
              ? cause.message
              : 'The preferred region could not be saved.',
        });
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <form onSubmit={save} className="mt-4 flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label
          htmlFor="preferred-region"
          className="text-sm font-medium text-slate-800"
        >
          Preferred region
        </label>
        <select
          id="preferred-region"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">No preference</option>
          {data.regions.map((region) => (
            <option key={region} value={region}>
              {region}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={busy || value === (data.preferredRegion ?? '')}
        className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {busy ? 'Saving…' : 'Save preferred region'}
      </button>
      {message && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={`basis-full text-sm ${message.ok ? 'text-slate-700' : 'text-red-800'}`}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}

function Gateways({ data }: { data: ControlPlaneRegionsState }) {
  if (!data.gateways.length)
    return (
      <p className="mt-4 text-sm text-slate-600">
        No gateway has connected yet.
      </p>
    );
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Connected gateways table"
      className="relative mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white"
    >
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th className="px-3 py-2">Gateway</th>
            <th className="px-3 py-2">Region</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Configuration</th>
            <th className="px-3 py-2">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {data.gateways.map((gateway) => {
            const behind =
              gateway.configVersion !== null &&
              gateway.configVersion < data.configVersion;
            return (
              <tr
                key={gateway.instanceId}
                className="border-t border-slate-100"
              >
                <td className="break-all px-3 py-2 font-medium text-slate-900">
                  {gateway.name}
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {gateway.region ?? 'Default'}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${gateway.online ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-200 text-slate-800'}`}
                  >
                    {gateway.online ? 'Connected' : 'Offline'}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {gateway.configVersion === null
                    ? 'Unknown'
                    : `Version ${gateway.configVersion}`}
                  {behind && (
                    <span className="block text-xs text-amber-900">
                      Behind version {data.configVersion}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {relative(gateway.lastSeenAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
