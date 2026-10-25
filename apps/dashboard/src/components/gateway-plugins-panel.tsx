'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Puzzle } from 'lucide-react';
import type {
  GatewayPluginState,
  ThirdPartyPluginState,
  ThirdPartyPluginStatus,
} from '@api-gateway/shared-types';
import { getGatewayPlugins, saveDisabledPlugins } from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';
import { DataLoadNotice } from './data-load-notice';

const STATE_LABEL: Record<ThirdPartyPluginState, string> = {
  active: 'Active',
  quarantined: 'Paused after failures',
  failed: 'Not loaded',
  disabled: 'Disabled',
};
const STATE_STYLE: Record<ThirdPartyPluginState, string> = {
  active: 'bg-emerald-100 text-emerald-900',
  quarantined: 'bg-amber-100 text-amber-950',
  failed: 'bg-red-100 text-red-900',
  disabled: 'bg-slate-200 text-slate-800',
};

interface Row {
  name: string;
  status: ThirdPartyPluginStatus | null;
  disabled: boolean;
}

export function GatewayPluginsPanel({ tenantId }: { tenantId: string }) {
  return tenantId ? (
    <PluginsWorkspace key={tenantId} tenantId={tenantId} />
  ) : null;
}

function PluginsWorkspace({ tenantId }: { tenantId: string }) {
  const { data, error, mutate } = useSWR(
    ['gateway-plugins', tenantId],
    () => getGatewayPlugins(tenantId),
    { refreshInterval: 30000 },
  );
  const [changing, setChanging] = useState<Row | null>(null);
  const [notice, setNotice] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const rows: Row[] = data
    ? [
        ...data.plugins.map((status) => ({
          name: status.name,
          status,
          disabled: data.disabled.includes(status.name),
        })),
        // Disabled names this gateway did not report stay visible and reversible.
        ...data.disabled
          .filter((name) => !data.plugins.some((p) => p.name === name))
          .map((name) => ({ name, status: null, disabled: true })),
      ]
    : [];
  return (
    <section
      aria-label="Gateway plugins"
      className="min-w-0 rounded-3xl border border-indigo-100 bg-[#f8f7ff] p-5 shadow-[0_8px_28px_rgba(70,60,120,0.07)] sm:p-6"
    >
      <div className="flex items-center gap-3">
        <span className="rounded-2xl bg-indigo-100 p-3 text-indigo-800">
          <Puzzle aria-hidden="true" size={22} />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Gateway plugins
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Third-party plugins installed on your gateway, and a workspace
            switch to turn each one off.
          </p>
        </div>
      </div>
      {error && (
        <div className="mt-4">
          <DataLoadNotice label="Gateway plugins" onRetry={() => mutate()} />
        </div>
      )}
      {!data && !error && (
        <p role="status" className="mt-4 text-sm text-slate-600">
          Loading gateway plugins…
        </p>
      )}
      {data && (
        <>
          <p className="mt-4 text-sm text-slate-600">
            {data.reportedAt
              ? `Last reported by the gateway at ${new Date(data.reportedAt).toLocaleString()}.`
              : 'No gateway has reported third-party plugins in the last 3 minutes.'}{' '}
            Your gateway operator installs packages and pins their versions;
            plugin code runs on the gateway with full trust.
          </p>
          {rows.length > 0 ? (
            <div
              ref={list}
              tabIndex={-1}
              className="relative mt-4 overflow-x-auto rounded-2xl bg-white"
            >
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  Third-party gateway plugins
                </caption>
                <thead className="text-slate-600">
                  <tr>
                    <th scope="col" className="p-3 font-medium">
                      Plugin
                    </th>
                    <th scope="col" className="p-3 font-medium">
                      State
                    </th>
                    <th scope="col" className="p-3 font-medium">
                      Last error
                    </th>
                    <th scope="col" className="p-3 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const state: ThirdPartyPluginState | null =
                      row.status?.state ?? (row.disabled ? 'disabled' : null);
                    return (
                      <tr key={row.name} className="border-t border-slate-100">
                        <th
                          scope="row"
                          className="p-3 font-medium text-slate-900"
                        >
                          <span className="break-all">{row.name}</span>
                          {row.status && (
                            <span className="block text-xs font-normal text-slate-600">
                              {row.status.version} ·{' '}
                              {row.status.protocols.join(', ')}
                            </span>
                          )}
                        </th>
                        <td className="p-3">
                          {state && (
                            <span
                              className={`rounded-full px-2 py-1 text-xs font-medium ${STATE_STYLE[state]}`}
                            >
                              {STATE_LABEL[state]}
                            </span>
                          )}
                          {!row.status && (
                            <span className="mt-1 block text-xs text-slate-600">
                              Not reported
                            </span>
                          )}
                          {row.status?.quarantinedUntil && (
                            <span className="mt-1 block text-xs text-slate-600">
                              Retries at{' '}
                              {new Date(
                                row.status.quarantinedUntil,
                              ).toLocaleTimeString()}
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-slate-700">
                          <span className="break-words">
                            {row.status?.lastError ?? '—'}
                          </span>
                        </td>
                        <td className="p-3 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              setNotice('');
                              setChanging(row);
                            }}
                            className={`rounded-xl border px-3 py-1.5 text-sm font-medium ${
                              row.disabled
                                ? 'border-indigo-300 bg-white text-indigo-900'
                                : 'border-red-300 bg-white text-red-800'
                            }`}
                          >
                            {row.disabled ? 'Enable' : 'Disable'}
                            <span className="sr-only"> {row.name}</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-4 rounded-2xl bg-white p-4 text-sm text-slate-600">
              No third-party plugins. Add a scoped package name such as
              @acme/saml-auth to a route&apos;s plugins after your operator
              installs it.
            </p>
          )}
        </>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-indigo-800">
          {notice}
        </p>
      )}
      {changing && data && (
        <ToggleDialog
          tenantId={tenantId}
          row={changing}
          current={data}
          onClose={() => {
            setChanging(null);
            requestAnimationFrame(() => list.current?.focus());
          }}
          onSaved={(state) => {
            void mutate(state, { revalidate: false });
            setChanging(null);
            setNotice(
              `${changing.name} ${changing.disabled ? 'enabled' : 'disabled'}. The gateway applies it with the next configuration update.`,
            );
            requestAnimationFrame(() => list.current?.focus());
          }}
        />
      )}
    </section>
  );
}

function ToggleDialog({
  tenantId,
  row,
  current,
  onClose,
  onSaved,
}: {
  tenantId: string;
  row: Row;
  current: GatewayPluginState;
  onClose: () => void;
  onSaved: (state: GatewayPluginState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function close() {
    pending.current?.abort();
    onClose();
  }
  async function confirm() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure('');
    const disabled = row.disabled
      ? current.disabled.filter((name) => name !== row.name)
      : [...current.disabled, row.name];
    try {
      const saved = await saveDisabledPlugins(
        tenantId,
        { disabled },
        controller.signal,
      );
      if (!controller.signal.aborted) onSaved(saved);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error ? error.message : 'The change failed.',
        );
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <WorkspaceDialog
      label={row.disabled ? 'Enable plugin' : 'Disable plugin'}
      onClose={close}
      centered
    >
      <div className="space-y-4 bg-[#fffdf8] p-5 text-sm text-slate-700">
        <h2 className="break-all text-xl font-semibold text-slate-900">
          {row.disabled ? 'Enable' : 'Disable'} {row.name}?
        </h2>
        <p>
          {row.disabled
            ? 'Routes using this plugin run it again once the gateway receives the change.'
            : 'Requests on routes that use this plugin are refused with 503 PLUGIN_DISABLED until you enable it again. Routes without it are not affected.'}
        </p>
        {failure && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800"
          >
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={close}
            className="rounded-xl border border-slate-300 px-4 py-2 text-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className={`rounded-xl px-4 py-2 font-medium text-white disabled:opacity-60 ${
              row.disabled ? 'bg-indigo-700' : 'bg-red-700'
            }`}
          >
            {busy
              ? 'Saving…'
              : row.disabled
                ? 'Enable plugin'
                : 'Disable plugin'}
          </button>
        </div>
      </div>
    </WorkspaceDialog>
  );
}
