'use client';

import { useEffect, useId, useRef, useState } from 'react';
import useSWR from 'swr';
import { Network, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  DEFAULT_SUBGRAPH_PATH,
  MAX_SUBGRAPHS,
  MAX_SUBGRAPH_SDL_BYTES,
  isFederatedGraphName,
  type FederationCompositionResult,
} from '@api-gateway/shared-types';
import {
  composeFederatedGraph,
  deleteFederatedGraph,
  getFederatedGraph,
  getFederatedGraphs,
  getServices,
  saveFederatedGraph,
  type FederatedSubgraphInput,
} from '../../../lib/api-client';
import { useTenantId } from '../../../lib/auth';
import { DataLoadNotice } from '../../../components/data-load-notice';

export default function GraphqlFederationPage() {
  const tenantId = useTenantId() ?? '';
  return <FederationWorkspace key={tenantId} tenantId={tenantId} />;
}

interface SubgraphRow {
  key: number;
  name: string;
  serviceId: string;
  path: string;
  sdl: string;
}
interface Draft {
  /** Set when editing a saved graph; its name cannot change. */
  existing: string | null;
  name: string;
  subgraphs: SubgraphRow[];
}

const emptyRow = (key: number): SubgraphRow => ({
  key,
  name: '',
  serviceId: '',
  path: DEFAULT_SUBGRAPH_PATH,
  sdl: '',
});

function kib(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function FederationWorkspace({ tenantId }: { tenantId: string }) {
  const { data, error, mutate } = useSWR(
    tenantId ? ['federated-graphs', tenantId] : null,
    () => getFederatedGraphs(tenantId),
    { refreshInterval: 30000 },
  );
  const { data: services } = useSWR(
    tenantId ? `services-${tenantId}` : null,
    () => getServices(tenantId),
    { refreshInterval: 30000 },
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [composition, setComposition] =
    useState<FederationCompositionResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [confirm, setConfirm] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function run<T>(
    key: string,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(key);
    setMessage(null);
    try {
      const result = await action(controller.signal);
      return controller.signal.aborted ? undefined : result;
    } catch (cause) {
      if (!controller.signal.aborted)
        setMessage({
          ok: false,
          text: cause instanceof Error ? cause.message : 'The change failed.',
        });
      return undefined;
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(null);
      }
    }
  }

  function open(next: Draft) {
    setDraft(next);
    setComposition(null);
    setMessage(null);
    requestAnimationFrame(() => editorHeading.current?.focus());
  }

  async function edit(name: string) {
    const graph = await run(`edit:${name}`, (signal) =>
      getFederatedGraph(tenantId, name, signal),
    );
    if (graph)
      open({
        existing: graph.name,
        name: graph.name,
        subgraphs: graph.subgraphs.map((subgraph, key) => ({
          key,
          ...subgraph,
        })),
      });
  }

  function inputs(current: Draft): FederatedSubgraphInput[] {
    return current.subgraphs.map((row) => ({
      name: row.name.trim(),
      serviceId: row.serviceId,
      path: row.path.trim() || DEFAULT_SUBGRAPH_PATH,
      sdl: row.sdl,
    }));
  }

  function problem(current: Draft): string | null {
    if (!isFederatedGraphName(current.name.trim()))
      return 'Graph names are lowercase letters and digits joined by single hyphens, such as storefront.';
    for (const row of current.subgraphs) {
      if (!isFederatedGraphName(row.name.trim()))
        return 'Each subgraph needs a name of lowercase letters and digits joined by single hyphens.';
      if (!row.serviceId) return `Choose the service for ${row.name}.`;
      if (!row.sdl.trim()) return `Paste or load the schema for ${row.name}.`;
      if (new TextEncoder().encode(row.sdl).length > MAX_SUBGRAPH_SDL_BYTES)
        return `The ${row.name} schema exceeds ${MAX_SUBGRAPH_SDL_BYTES / 1024} KiB.`;
    }
    return null;
  }

  async function check() {
    if (!draft) return;
    const invalid = problem(draft);
    if (invalid) return setMessage({ ok: false, text: invalid });
    const result = await run('compose', (signal) =>
      composeFederatedGraph(tenantId, inputs(draft), signal),
    );
    if (result) setComposition(result);
  }

  async function save() {
    if (!draft) return;
    const invalid = problem(draft);
    if (invalid) return setMessage({ ok: false, text: invalid });
    const name = draft.name.trim();
    // Compose first so the editor can list every composition error.
    const result = await run('save', async (signal) => {
      const composed = await composeFederatedGraph(
        tenantId,
        inputs(draft),
        signal,
      );
      if (!composed.ok) return { composed };
      await saveFederatedGraph(tenantId, name, inputs(draft), signal);
      return { composed };
    });
    if (!result) return;
    setComposition(result.composed);
    if (!result.composed.ok) return;
    await mutate();
    setDraft(null);
    setMessage({
      ok: true,
      text: `${name} is saved and on its way to your gateways. Add the GraphQL federation plugin to a route to serve it.`,
    });
  }

  async function remove(name: string) {
    const done = await run(`remove:${name}`, (signal) =>
      deleteFederatedGraph(tenantId, name, signal),
    );
    setConfirm(null);
    if (!done) return;
    await mutate();
    setMessage({ ok: true, text: `${name} was removed.` });
  }

  const serviceName = (id: string) =>
    services?.find((service) => service.id === id)?.name ?? 'Missing service';
  return (
    <div className="p-4 sm:p-8">
      <div className="mb-2 flex items-center gap-2">
        <Network aria-hidden="true" className="h-6 w-6 text-indigo-700" />
        <h1 className="text-2xl font-semibold text-gray-900">
          GraphQL federation
        </h1>
      </div>
      <p className="mb-6 max-w-3xl text-sm text-gray-600">
        Combine the GraphQL schemas of several services into one graph. Upload
        each subgraph&apos;s schema (Apollo Federation directives such as{' '}
        <code className="rounded bg-gray-100 px-1">@key</code>); NovaGate
        composes them when you save and refuses graphs that do not compose. Your
        gateway then answers queries on any route with the GraphQL federation
        plugin, calling each subgraph&apos;s service and merging the results.
      </p>
      {error && !data && (
        <DataLoadNotice label="Federated graphs" onRetry={() => mutate()} />
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
            Loading graphs…
          </p>
        )
      ) : (
        <div className="flex flex-col gap-8">
          <section aria-labelledby="graphs-title">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2
                id="graphs-title"
                className="text-lg font-semibold text-gray-900"
              >
                Graphs
              </h2>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  open({ existing: null, name: '', subgraphs: [emptyRow(0)] })
                }
                className="flex items-center gap-1 rounded-xl bg-indigo-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                <Plus aria-hidden="true" size={16} /> New graph
              </button>
            </div>
            {data.graphs.length === 0 ? (
              <p className="text-sm text-gray-600">No federated graphs yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.graphs.map((graph) => (
                  <li
                    key={graph.name}
                    className="rounded-2xl border border-gray-200 bg-white p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 className="font-semibold text-gray-900">
                          {graph.name}
                        </h3>
                        <p className="text-xs text-gray-600">
                          {graph.routes.length
                            ? `Served on ${graph.routes.join(', ')}`
                            : 'Not served on any route yet'}{' '}
                          · updated {new Date(graph.updatedAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => edit(graph.name)}
                          aria-label={`Edit ${graph.name}`}
                          className="rounded p-1.5 text-gray-600 hover:bg-gray-100"
                        >
                          <Pencil aria-hidden="true" size={16} />
                        </button>
                        {confirm === graph.name ? (
                          <span className="flex items-center gap-2">
                            <span className="text-xs text-gray-700">
                              Remove?
                            </span>
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => remove(graph.name)}
                              className="rounded bg-red-700 px-2 py-1 text-xs font-medium text-white"
                            >
                              Remove {graph.name}
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
                            onClick={() => setConfirm(graph.name)}
                            aria-label={`Remove ${graph.name}`}
                            className="rounded p-1.5 text-gray-600 hover:bg-gray-100 hover:text-red-700"
                          >
                            <Trash2 aria-hidden="true" size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div
                      tabIndex={0}
                      role="region"
                      aria-label={`${graph.name} subgraphs`}
                      className="relative mt-3 overflow-x-auto rounded-xl border border-gray-100"
                    >
                      <table className="w-full text-left text-sm">
                        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-600">
                          <tr>
                            <th className="px-3 py-2">Subgraph</th>
                            <th className="px-3 py-2">Service</th>
                            <th className="px-3 py-2">Path</th>
                            <th className="px-3 py-2">Schema</th>
                          </tr>
                        </thead>
                        <tbody>
                          {graph.subgraphs.map((subgraph) => (
                            <tr
                              key={subgraph.name}
                              className="border-t border-gray-100"
                            >
                              <td className="px-3 py-2 font-medium text-gray-900">
                                {subgraph.name}
                              </td>
                              <td className="px-3 py-2 text-gray-700">
                                {subgraph.serviceName ?? 'Missing service'}
                              </td>
                              <td className="px-3 py-2 font-mono text-xs text-gray-700">
                                {subgraph.path}
                              </td>
                              <td className="px-3 py-2 text-gray-700">
                                {kib(subgraph.sdlBytes)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm text-indigo-800">
                        Composed schema
                      </summary>
                      <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-gray-50 p-3 text-xs text-gray-800">
                        {graph.publicSdl}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {draft && (
            <section
              aria-labelledby="editor-title"
              className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5"
            >
              <div className="flex items-center justify-between gap-2">
                <h2
                  id="editor-title"
                  ref={editorHeading}
                  tabIndex={-1}
                  className="text-lg font-semibold text-gray-900"
                >
                  {draft.existing ? `Edit ${draft.existing}` : 'New graph'}
                </h2>
                <button
                  type="button"
                  aria-label="Close editor"
                  onClick={() => setDraft(null)}
                  className="rounded p-1.5 text-gray-600 hover:bg-gray-100"
                >
                  <X aria-hidden="true" size={16} />
                </button>
              </div>
              <GraphEditor
                draft={draft}
                services={services ?? []}
                serviceName={serviceName}
                onChange={(next) => {
                  setDraft(next);
                  setComposition(null);
                }}
              />
              {composition && (
                <div
                  role={composition.ok ? 'status' : 'alert'}
                  className={`mt-4 rounded-xl border p-3 text-sm ${composition.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-800'}`}
                >
                  {composition.ok ? (
                    'The subgraphs compose into one graph.'
                  ) : (
                    <>
                      <p className="font-medium">
                        The subgraphs do not compose:
                      </p>
                      <ul className="mt-1 list-disc pl-5">
                        {composition.errors.map((item, index) => (
                          <li key={index} className="break-words">
                            {item.message}
                            {item.code && (
                              <span className="ml-1 font-mono text-xs">
                                ({item.code})
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={check}
                  className="rounded-xl border border-indigo-700 px-4 py-2 text-sm font-medium text-indigo-800 disabled:opacity-60"
                >
                  {busy === 'compose' ? 'Checking…' : 'Check composition'}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={save}
                  className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                >
                  {busy === 'save' ? 'Saving…' : 'Save graph'}
                </button>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function GraphEditor({
  draft,
  services,
  serviceName,
  onChange,
}: {
  draft: Draft;
  services: Array<{ id: string; name: string }>;
  serviceName: (id: string) => string;
  onChange: (draft: Draft) => void;
}) {
  const nameId = useId();
  const update = (key: number, patch: Partial<SubgraphRow>) =>
    onChange({
      ...draft,
      subgraphs: draft.subgraphs.map((row) =>
        row.key === key ? { ...row, ...patch } : row,
      ),
    });
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex max-w-sm flex-col gap-1">
        <label htmlFor={nameId} className="text-sm font-medium text-gray-800">
          Graph name
        </label>
        <input
          id={nameId}
          value={draft.name}
          disabled={draft.existing !== null}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="storefront"
          className="rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
        />
      </div>
      {draft.subgraphs.map((row, index) => (
        <SubgraphFields
          key={row.key}
          index={index}
          row={row}
          services={services}
          serviceName={serviceName}
          removable={draft.subgraphs.length > 1}
          onChange={(patch) => update(row.key, patch)}
          onRemove={() =>
            onChange({
              ...draft,
              subgraphs: draft.subgraphs.filter((item) => item.key !== row.key),
            })
          }
        />
      ))}
      {draft.subgraphs.length < MAX_SUBGRAPHS && (
        <button
          type="button"
          onClick={() =>
            onChange({
              ...draft,
              subgraphs: [
                ...draft.subgraphs,
                emptyRow(
                  Math.max(-1, ...draft.subgraphs.map((row) => row.key)) + 1,
                ),
              ],
            })
          }
          className="flex w-fit items-center gap-1 rounded-md px-2 py-1 text-sm text-indigo-800 hover:bg-indigo-50"
        >
          <Plus aria-hidden="true" size={16} /> Add subgraph
        </button>
      )}
    </div>
  );
}

function SubgraphFields({
  index,
  row,
  services,
  serviceName,
  removable,
  onChange,
  onRemove,
}: {
  index: number;
  row: SubgraphRow;
  services: Array<{ id: string; name: string }>;
  serviceName: (id: string) => string;
  removable: boolean;
  onChange: (patch: Partial<SubgraphRow>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const label = row.name.trim() || `subgraph ${index + 1}`;
  return (
    <fieldset className="rounded-xl border border-gray-200 p-3">
      <legend className="px-1 text-sm font-medium text-gray-800">
        Subgraph {index + 1}
      </legend>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${id}-name`}
            className="text-xs font-medium text-gray-700"
          >
            Name
          </label>
          <input
            id={`${id}-name`}
            value={row.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="users"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${id}-service`}
            className="text-xs font-medium text-gray-700"
          >
            Service
          </label>
          <select
            id={`${id}-service`}
            value={row.serviceId}
            onChange={(e) => onChange({ serviceId: e.target.value })}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Choose a service</option>
            {row.serviceId &&
              !services.some((service) => service.id === row.serviceId) && (
                <option value={row.serviceId}>
                  {serviceName(row.serviceId)}
                </option>
              )}
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${id}-path`}
            className="text-xs font-medium text-gray-700"
          >
            Path on the service
          </label>
          <input
            id={`${id}-path`}
            value={row.path}
            onChange={(e) => onChange({ path: e.target.value })}
            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-3">
          <label
            htmlFor={`${id}-sdl`}
            className="text-xs font-medium text-gray-700"
          >
            Schema (SDL)
          </label>
          <textarea
            id={`${id}-sdl`}
            rows={8}
            value={row.sdl}
            onChange={(e) => onChange({ sdl: e.target.value })}
            placeholder={
              'type Query { users: [User!]! }\ntype User @key(fields: "id") { id: ID! name: String! }'
            }
            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <label
            htmlFor={`${id}-file`}
            className="text-xs font-medium text-gray-700"
          >
            Or load a .graphql file
          </label>
          <input
            id={`${id}-file`}
            type="file"
            accept=".graphql,.graphqls,.gql,text/plain"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file && file.size <= MAX_SUBGRAPH_SDL_BYTES)
                onChange({ sdl: await file.text() });
            }}
            className="text-xs"
          />
          {removable && (
            <button
              type="button"
              onClick={onRemove}
              className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-red-800 hover:bg-red-50"
            >
              <Trash2 aria-hidden="true" size={14} /> Remove {label}
            </button>
          )}
        </div>
      </div>
    </fieldset>
  );
}
