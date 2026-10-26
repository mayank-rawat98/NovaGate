'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Blocks, ShieldCheck, Trash2, Upload } from 'lucide-react';
import {
  MAX_WASM_MODULE_BYTES,
  type WasmPluginState,
  type WasmPluginStatus,
} from '@api-gateway/shared-types';
import {
  getWasmPlugins,
  installWasmPlugin,
  removeWasmPlugin,
  uploadWasmPlugin,
} from '../../../lib/api-client';
import { useTenantId } from '../../../lib/auth';
import { DataLoadNotice } from '../../../components/data-load-notice';

export default function PluginsPage() {
  const tenantId = useTenantId() ?? '';
  return <PluginsWorkspace key={tenantId} tenantId={tenantId} />;
}

function microseconds(value: number | null) {
  if (value === null) return '—';
  return value < 1000 ? `${value} µs` : `${(value / 1000).toFixed(1)} ms`;
}

const STATE_LABEL: Record<WasmPluginStatus['state'], string> = {
  active: 'Running',
  quarantined: 'Paused after failures',
  loading: 'Loading on gateway',
  failed: 'Refused by gateway',
};

function PluginsWorkspace({ tenantId }: { tenantId: string }) {
  const { data, error, mutate } = useSWR(
    tenantId ? ['wasm-plugins', tenantId] : null,
    () => getWasmPlugins(tenantId),
    { refreshInterval: 30000 },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [confirm, setConfirm] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function act(
    key: string,
    action: (signal: AbortSignal) => Promise<WasmPluginState>,
    success: string,
  ) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(key);
    setMessage(null);
    try {
      const next = await action(controller.signal);
      if (controller.signal.aborted) return;
      await mutate(next, { revalidate: false });
      setMessage({ ok: true, text: success });
      return true;
    } catch (cause) {
      if (!controller.signal.aborted)
        setMessage({
          ok: false,
          text: cause instanceof Error ? cause.message : 'The change failed.',
        });
      return false;
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(null);
      }
    }
  }

  const statuses = new Map(
    (data?.statuses ?? []).map((status) => [status.name, status]),
  );
  return (
    <div className="p-4 sm:p-8">
      <div className="mb-2 flex items-center gap-2">
        <Blocks aria-hidden="true" className="h-6 w-6 text-indigo-700" />
        <h1 className="text-2xl font-semibold text-gray-900">
          Plugin marketplace
        </h1>
      </div>
      <p className="mb-6 max-w-3xl text-sm text-gray-600">
        WebAssembly plugins run on your gateway in a sandbox: each request gets
        at most 50 ms, plugins have at most 10 MiB of memory, and they cannot
        reach the filesystem or the network except HTTPS calls to hosts you
        allow. Attach an installed plugin to a route in its Plugins tab as{' '}
        <code className="rounded bg-gray-100 px-1">wasm:&lt;name&gt;</code>.
      </p>
      {error && !data && (
        <DataLoadNotice label="Plugins" onRetry={() => mutate()} />
      )}
      {message && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={`mb-4 rounded-xl border p-3 text-sm ${message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-800'}`}
        >
          {message.text}
        </p>
      )}
      {!data ? (
        !error && (
          <p role="status" className="text-sm text-gray-600">
            Loading plugins…
          </p>
        )
      ) : (
        <div className="flex flex-col gap-8">
          <section aria-labelledby="catalog-title">
            <h2
              id="catalog-title"
              className="mb-3 text-lg font-semibold text-gray-900"
            >
              Catalog
            </h2>
            <ul className="grid gap-3 md:grid-cols-3">
              {data.catalog.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-col rounded-2xl border border-gray-200 bg-white p-4"
                >
                  <h3 className="font-semibold text-gray-900">{entry.name}</h3>
                  <p className="text-xs text-gray-600">
                    Version {entry.version} ·{' '}
                    {entry.hooks
                      .map((hook) =>
                        hook === 'on_request' ? 'requests' : 'responses',
                      )
                      .join(' and ')}
                  </p>
                  <p className="mt-2 text-sm text-gray-700">
                    {entry.description}
                  </p>
                  <dl className="mt-2 flex-1 text-xs text-gray-600">
                    {entry.configKeys.map((item) => (
                      <div key={item.key}>
                        <dt className="inline font-mono">{item.key}</dt>
                        <dd className="inline"> — {item.description}</dd>
                      </div>
                    ))}
                  </dl>
                  <button
                    type="button"
                    disabled={entry.installed || busy !== null}
                    onClick={() =>
                      act(
                        `install:${entry.id}`,
                        (signal) =>
                          installWasmPlugin(tenantId, entry.id, signal),
                        `${entry.name} is installed. Add wasm:${entry.name} to a route to use it.`,
                      )
                    }
                    className="mt-3 rounded-xl bg-indigo-700 px-3 py-2 text-sm font-medium text-white disabled:bg-gray-200 disabled:text-gray-700"
                  >
                    {entry.installed
                      ? 'Installed'
                      : busy === `install:${entry.id}`
                        ? 'Installing…'
                        : 'Install'}
                    <span className="sr-only"> {entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="installed-title">
            <h2
              id="installed-title"
              className="mb-3 text-lg font-semibold text-gray-900"
            >
              Installed in this workspace
            </h2>
            {data.plugins.length === 0 ? (
              <p className="text-sm text-gray-600">
                No WebAssembly plugins yet.
              </p>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-label="Installed plugins table"
                className="relative overflow-x-auto rounded-xl border border-gray-200 bg-white"
              >
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-600">
                    <tr>
                      <th className="px-3 py-2">Route name</th>
                      <th className="px-3 py-2">Version</th>
                      <th className="px-3 py-2">Gateway</th>
                      <th className="px-3 py-2">Time per call (p99)</th>
                      <th className="px-3 py-2">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.plugins.map((plugin) => {
                      const status = statuses.get(plugin.name);
                      return (
                        <tr
                          key={plugin.name}
                          className="border-t border-gray-100 align-top"
                        >
                          <td className="px-3 py-2">
                            <code className="font-medium text-gray-900">
                              wasm:{plugin.name}
                            </code>
                            <span className="block text-xs text-gray-600">
                              {plugin.source === 'catalog'
                                ? 'From the catalog'
                                : 'Uploaded'}
                              {plugin.allowedHosts.length
                                ? ` · may call ${plugin.allowedHosts.join(', ')}`
                                : ' · no network'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-gray-700">
                            {plugin.version}
                          </td>
                          <td className="px-3 py-2 text-gray-700">
                            {status ? STATE_LABEL[status.state] : 'No report'}
                            {status?.lastError && (
                              <span className="block max-w-xs break-words text-xs text-red-800">
                                {status.lastError}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-gray-700">
                            {microseconds(status?.p99Us ?? null)}
                            {status && (
                              <span className="block text-xs text-gray-600">
                                {status.calls.toLocaleString()} calls ·{' '}
                                {status.failures} failed
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {confirm === plugin.name ? (
                              <span className="flex items-center justify-end gap-2">
                                <span className="text-xs text-gray-700">
                                  Remove?
                                </span>
                                <button
                                  type="button"
                                  disabled={busy !== null}
                                  onClick={async () => {
                                    await act(
                                      `remove:${plugin.name}`,
                                      (signal) =>
                                        removeWasmPlugin(
                                          tenantId,
                                          plugin.name,
                                          signal,
                                        ),
                                      `${plugin.name} was removed.`,
                                    );
                                    setConfirm(null);
                                  }}
                                  className="rounded bg-red-700 px-2 py-1 text-xs font-medium text-white"
                                >
                                  Remove {plugin.name}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirm(null)}
                                  className="rounded px-2 py-1 text-xs text-gray-700"
                                >
                                  Keep
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirm(plugin.name)}
                                aria-label={`Remove ${plugin.name}`}
                                className="rounded p-1.5 text-gray-600 hover:bg-gray-100 hover:text-red-700"
                              >
                                <Trash2 aria-hidden="true" size={16} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <UploadForm
            busy={busy !== null}
            onUpload={(input) =>
              act(
                'upload',
                (signal) => uploadWasmPlugin(tenantId, input, signal),
                `${input.name} is installed. Add wasm:${input.name} to a route to use it.`,
              )
            }
          />
        </div>
      )}
    </div>
  );
}

function UploadForm({
  busy,
  onUpload,
}: {
  busy: boolean;
  onUpload: (input: {
    name: string;
    version: string;
    description: string;
    module: string;
    allowedHosts: string[];
  }) => Promise<boolean | undefined>;
}) {
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [description, setDescription] = useState('');
  const [hosts, setHosts] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [failure, setFailure] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFailure('');
    if (!file) return setFailure('Choose a .wasm file.');
    if (file.size > MAX_WASM_MODULE_BYTES)
      return setFailure(
        `Modules are limited to ${MAX_WASM_MODULE_BYTES / 1048576} MiB.`,
      );
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const done = await onUpload({
      name: name.trim(),
      version: version.trim(),
      description: description.trim(),
      module: btoa(binary),
      allowedHosts: hosts
        .split(/[\s,]+/)
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    });
    if (done) {
      setName('');
      setDescription('');
      setHosts('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <section
      aria-labelledby="upload-title"
      className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5"
    >
      <h2
        id="upload-title"
        className="flex items-center gap-2 text-lg font-semibold text-gray-900"
      >
        <Upload aria-hidden="true" size={18} /> Upload your own
      </h2>
      <p className="mt-1 flex gap-2 text-sm text-gray-600">
        <ShieldCheck aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
        Modules are checked before they are stored: they must import their
        memory and only the NovaGate host functions (no WASI). See the plugin
        SDK guide for the C header and build command.
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label
            htmlFor="wasm-name"
            className="text-sm font-medium text-gray-800"
          >
            Name
          </label>
          <input
            id="wasm-name"
            required
            pattern="[a-z0-9][a-z0-9\-]{0,63}"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-auth-check"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="wasm-version"
            className="text-sm font-medium text-gray-800"
          >
            Version
          </label>
          <input
            id="wasm-version"
            required
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label
            htmlFor="wasm-description"
            className="text-sm font-medium text-gray-800"
          >
            Description{' '}
            <span className="font-normal text-gray-600">(optional)</span>
          </label>
          <input
            id="wasm-description"
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="wasm-hosts"
            className="text-sm font-medium text-gray-800"
          >
            Allowed hosts{' '}
            <span className="font-normal text-gray-600">(optional)</span>
          </label>
          <textarea
            id="wasm-hosts"
            rows={2}
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            placeholder="api.partner.example"
            aria-describedby="wasm-hosts-help"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <span id="wasm-hosts-help" className="text-xs text-gray-600">
            Hosts the plugin may call over HTTPS, one per line. Leave empty for
            no network access.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="wasm-file"
            className="text-sm font-medium text-gray-800"
          >
            Module (.wasm)
          </label>
          <input
            id="wasm-file"
            ref={fileInput}
            type="file"
            accept=".wasm,application/wasm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
        </div>
        {failure && (
          <p role="alert" className="text-sm text-red-800 sm:col-span-2">
            {failure}
          </p>
        )}
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Upload plugin
          </button>
        </div>
      </form>
    </section>
  );
}
