'use client';

import { useEffect, useId, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  Cloud,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import {
  DATADOG_LOG_SITES,
  type DatadogLogSite,
  type LogExportDestination,
  type LogExportDestinationCredentials,
  type LogExportDestinationType,
} from '@api-gateway/shared-types';
import {
  createLogExportDestination,
  getLogExportDestinations,
  reencryptLogExportDestination,
  removeLogExportDestination,
  updateLogExportDestination,
} from '../lib/api-client';
import { DataLoadNotice } from './data-load-notice';
import { WorkspaceDialog } from './workspace-dialog';

const PROVIDERS: Record<LogExportDestinationType, string> = {
  s3: 'S3-compatible storage',
  webhook: 'NDJSON webhook',
  datadog: 'Datadog',
};
const control =
  'mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900 disabled:bg-slate-100 disabled:text-slate-600';
const secondary =
  'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 disabled:opacity-60';
type Action =
  | { kind: 'create' }
  | { kind: 'edit' | 'remove' | 'rotate'; row: LogExportDestination };

export function ExportDestinationsPanel({ tenantId }: { tenantId: string }) {
  return tenantId ? (
    <DestinationWorkspace key={tenantId} tenantId={tenantId} />
  ) : null;
}
function DestinationWorkspace({ tenantId }: { tenantId: string }) {
  const read = useRef<AbortController | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => read.current?.abort(), []);
  const { data, error, mutate, isValidating } = useSWR(
    ['export-destinations', tenantId],
    () => {
      read.current?.abort();
      const controller = new AbortController();
      read.current = controller;
      return getLogExportDestinations(
        tenantId,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      );
    },
    { refreshInterval: 30000 },
  );
  const [action, setAction] = useState<Action | null>(null);
  const [notice, setNotice] = useState('');
  const available = !!data?.configurationAvailable;
  function restoreFocus() {
    requestAnimationFrame(() => {
      const original = opener.current;
      const target =
        original?.isConnected && !original.disabled
          ? original
          : addButton.current && !addButton.current.disabled
            ? addButton.current
            : section.current;
      target?.focus();
    });
  }
  function saved(row?: LogExportDestination) {
    if (!action) return;
    const currentAction = action;
    setAction(null);
    setNotice(
      currentAction.kind === 'remove'
        ? 'Destination removed. Saved credentials have been cleared.'
        : currentAction.kind === 'rotate'
          ? 'Saved credentials re-encrypted. The destination remains a draft.'
          : 'Destination draft saved. It is not sending logs.',
    );
    void mutate(
      (current) =>
        current
          ? {
              ...current,
              destinations:
                currentAction.kind === 'remove'
                  ? current.destinations.filter(
                      (destination) => destination.id !== currentAction.row.id,
                    )
                  : row
                    ? [
                        ...current.destinations.filter(
                          (destination) => destination.id !== row.id,
                        ),
                        row,
                      ]
                    : current.destinations,
            }
          : current,
      { revalidate: false },
    )
      .then(() => {
        restoreFocus();
        return mutate();
      })
      .catch(() => undefined);
  }
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label="External export destinations"
      className="rounded-3xl border border-indigo-100 bg-gradient-to-br from-[#f4f7ff] to-[#f3fbf7] p-5 shadow-[0_8px_28px_rgba(65,70,140,0.08)] sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="rounded-2xl border border-white bg-indigo-100 p-3 text-indigo-800 shadow-sm">
            <Cloud size={22} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              External export destinations
            </h2>
            <p className="mt-1 max-w-xl text-sm text-slate-600">
              Prepare external connections. Drafts do not send logs yet; your
              private archives continue to work.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            ref={addButton}
            type="button"
            onClick={(event) => {
              opener.current = event.currentTarget;
              setNotice('');
              setAction({ kind: 'create' });
            }}
            disabled={
              !available ||
              !!error ||
              (data?.destinations.length ?? 0) >= (data?.limit ?? 0)
            }
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white shadow-sm disabled:opacity-60"
          >
            <Plus size={16} aria-hidden="true" />
            Add destination
          </button>
          <button
            type="button"
            aria-label="Refresh destinations"
            disabled={isValidating}
            onClick={() => void mutate().catch(() => undefined)}
            className={secondary}
          >
            <RefreshCw size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      {error && (
        <div className="mt-4">
          <DataLoadNotice
            label="Export destinations"
            onRetry={() => mutate()}
          />
          {data && (
            <p className="text-sm text-slate-600">
              The saved list may be outdated. Refresh before making changes.
            </p>
          )}
        </div>
      )}
      {!data && !error && (
        <p role="status" className="mt-4 text-sm text-slate-600">
          Loading export destinations…
        </p>
      )}
      {data && (
        <>
          {!available && (
            <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              Secure destination setup is unavailable for this installation.
              Your administrator needs to enable it. You can still rename or
              remove saved drafts.
            </p>
          )}
          <p className="mt-4 text-sm text-slate-600">
            {data.destinations.length} of {data.limit} destinations saved.
            {data.destinations.length >= data.limit
              ? ' Remove a destination to add another.'
              : ''}
          </p>
          {!data.destinations.length && (
            <p className="mt-4 rounded-2xl border border-dashed border-indigo-200 bg-white/80 p-5 text-sm text-slate-600">
              No external destinations yet. Save a draft to prepare your next
              connection.
            </p>
          )}
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {data.destinations.map((row) => (
              <li
                key={row.id}
                className="min-w-0 rounded-2xl border border-white bg-white p-4 shadow-[0_3px_12px_rgba(65,70,140,0.06)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="break-words font-semibold text-slate-900">
                    {row.name}
                  </h3>
                  <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-900">
                    Draft · not sending
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  {PROVIDERS[row.type]}
                </p>
                <p className="mt-1 break-all text-sm text-slate-600">
                  {row.destination}
                </p>
                <p
                  className={`mt-3 text-sm ${row.credentialStatus === 'available' ? 'text-emerald-800' : 'text-amber-900'}`}
                >
                  {row.credentialStatus === 'available'
                    ? 'Credentials stored securely. Provider connection has not been verified.'
                    : 'Saved credentials are unavailable. Replace them or ask your administrator to restore access.'}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-label={`Edit ${row.name}`}
                    disabled={!!error}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setNotice('');
                      setAction({ kind: 'edit', row });
                    }}
                    className={secondary}
                  >
                    <Pencil
                      size={14}
                      className="mr-1 inline"
                      aria-hidden="true"
                    />
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Re-encrypt ${row.name}`}
                    disabled={
                      !!error ||
                      !available ||
                      row.credentialStatus !== 'available'
                    }
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setNotice('');
                      setAction({ kind: 'rotate', row });
                    }}
                    className={secondary}
                  >
                    <KeyRound
                      size={14}
                      className="mr-1 inline"
                      aria-hidden="true"
                    />
                    Re-encrypt
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${row.name}`}
                    disabled={!!error}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setNotice('');
                      setAction({ kind: 'remove', row });
                    }}
                    className={secondary}
                  >
                    <Trash2
                      size={14}
                      className="mr-1 inline"
                      aria-hidden="true"
                    />
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {notice && (
        <p role="status" className="mt-4 text-sm font-medium text-emerald-800">
          {notice}
        </p>
      )}
      {action && (
        <DestinationDialog
          key={`${action.kind}-${action.kind === 'create' ? 'new' : action.row.id}`}
          tenantId={tenantId}
          action={action}
          available={available}
          onClose={() => {
            setAction(null);
            restoreFocus();
          }}
          onSaved={saved}
        />
      )}
    </section>
  );
}

function initialFields(row?: LogExportDestination) {
  return {
    endpoint: row?.type === 's3' ? row.destination : '',
    region: 'us-east-1',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    forcePathStyle: true,
    url: '',
    signingSecret: '',
    site: (row?.type === 'datadog'
      ? row.destination
      : 'datadoghq.com') as DatadogLogSite,
    apiKey: '',
  };
}
type ConnectionFields = ReturnType<typeof initialFields>;
function credentials(
  type: LogExportDestinationType,
  fields: ConnectionFields,
): LogExportDestinationCredentials {
  if (type === 'webhook')
    return { type, url: fields.url, signingSecret: fields.signingSecret };
  if (type === 'datadog')
    return { type, site: fields.site, apiKey: fields.apiKey };
  return {
    type,
    endpoint: fields.endpoint,
    region: fields.region,
    bucket: fields.bucket,
    accessKeyId: fields.accessKeyId,
    secretAccessKey: fields.secretAccessKey,
    forcePathStyle: fields.forcePathStyle,
    ...(fields.sessionToken ? { sessionToken: fields.sessionToken } : {}),
  };
}
function DestinationDialog({
  tenantId,
  action,
  available,
  onClose,
  onSaved,
}: {
  tenantId: string;
  action: Action;
  available: boolean;
  onClose: () => void;
  onSaved: (row?: LogExportDestination) => void;
}) {
  const id = useId();
  const [base, setBase] = useState(
    action.kind === 'create' ? undefined : action.row,
  );
  const [name, setName] = useState(base?.name ?? '');
  const [type, setType] = useState<LogExportDestinationType>(
    base?.type ?? 's3',
  );
  const [fields, setFields] = useState(() => initialFields(base));
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState('');
  const [reloadNotice, setReloadNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const editing = action.kind === 'create' || action.kind === 'edit';
  const writingCredentials =
    action.kind === 'create' || (action.kind === 'edit' && replace);
  const title =
    action.kind === 'create'
      ? 'Add export destination'
      : action.kind === 'edit'
        ? 'Edit export destination'
        : action.kind === 'remove'
          ? 'Remove export destination'
          : 'Re-encrypt saved credentials';
  function close() {
    pending.current?.abort();
    onClose();
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current || missing) return;
    setFailure('');
    if (
      editing &&
      (!name.trim() || new TextEncoder().encode(name).length > 80)
    ) {
      setFailure('Use a destination name of 1–80 bytes.');
      return;
    }
    if (
      writingCredentials &&
      type === 'webhook' &&
      new TextEncoder().encode(fields.signingSecret).length < 32
    ) {
      setFailure('Use a webhook signing secret of at least 32 bytes.');
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    try {
      let row: LogExportDestination | undefined;
      if (action.kind === 'create')
        row = await createLogExportDestination(
          tenantId,
          { name, credentials: credentials(type, fields) },
          signal,
        );
      else if (action.kind === 'edit' && base)
        row = await updateLogExportDestination(
          tenantId,
          base.id,
          {
            name,
            expectedRevision: base.revision,
            ...(replace ? { credentials: credentials(type, fields) } : {}),
          },
          signal,
        );
      else if (action.kind === 'rotate' && base)
        row = await reencryptLogExportDestination(
          tenantId,
          base.id,
          base.revision,
          signal,
        );
      else if (action.kind === 'remove' && base)
        await removeLogExportDestination(
          tenantId,
          base.id,
          base.revision,
          signal,
        );
      if (!controller.signal.aborted) onSaved(row);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error && error.name !== 'TimeoutError'
            ? error.message
            : 'The destination could not be saved. Try again.',
        );
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  async function reload() {
    if (pending.current || !base) return;
    const controller = new AbortController();
    pending.current = controller;
    setReloading(true);
    setFailure('');
    setReloadNotice('');
    try {
      const list = await getLogExportDestinations(
        tenantId,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      );
      if (controller.signal.aborted) return;
      const current = list.destinations.find((row) => row.id === base.id);
      if (!current) {
        setMissing(true);
        setFailure(
          'This destination was removed. Close this editor and refresh the list.',
        );
      } else {
        setBase(current);
        setReloadNotice(
          `Latest revision loaded for ${current.name}. Your unsaved input is kept; review it before confirming.`,
        );
      }
    } catch {
      if (!controller.signal.aborted)
        setFailure('The latest destination could not be loaded. Try again.');
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setReloading(false);
      }
    }
  }
  return (
    <WorkspaceDialog label={title} onClose={close}>
      <form onSubmit={submit} className="flex h-full flex-col bg-[#fffdf8]">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 p-5">
          <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
          <button
            type="button"
            aria-label="Close destination editor"
            onClick={close}
            className="rounded-xl p-2 text-slate-600"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <p className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900">
            This is a draft connection. Saving or re-encrypting it does not
            start log delivery.
          </p>
          {editing ? (
            <>
              <div>
                <label
                  htmlFor={`${id}-name`}
                  className="text-sm font-medium text-slate-800"
                >
                  Destination name
                </label>
                <input
                  id={`${id}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={80}
                  disabled={busy || reloading || missing}
                  className={control}
                />
              </div>
              <div>
                <label
                  htmlFor={`${id}-type`}
                  className="text-sm font-medium text-slate-800"
                >
                  Destination provider
                </label>
                <select
                  id={`${id}-type`}
                  value={type}
                  disabled={!!base || busy || reloading}
                  onChange={(event) => {
                    setType(event.target.value as LogExportDestinationType);
                    setFields(initialFields());
                  }}
                  className={control}
                >
                  {Object.entries(PROVIDERS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {base && (
                <>
                  <p className="break-all text-sm text-slate-600">
                    Saved destination: {base.destination}. Saved secrets are
                    never shown.
                  </p>
                  {base.credentialStatus !== 'available' && (
                    <p className="text-sm text-amber-900">
                      Saved credentials are unavailable. Replace the complete
                      connection details to repair this draft.
                    </p>
                  )}
                  <label className="flex items-center gap-3 rounded-2xl border border-indigo-200 bg-white p-4 text-sm font-medium text-slate-800">
                    <input
                      type="checkbox"
                      checked={replace}
                      disabled={!available || busy || reloading || missing}
                      onChange={(event) => {
                        setReplace(event.target.checked);
                        if (!event.target.checked)
                          setFields(initialFields(base));
                      }}
                      className="h-4 w-4 accent-indigo-700"
                    />
                    Replace saved credentials
                  </label>
                  {!replace && (
                    <p className="text-sm text-slate-600">
                      Only the name will change. The saved connection details
                      stay in place.
                    </p>
                  )}
                </>
              )}
              {writingCredentials && (
                <CredentialInputs
                  id={id}
                  type={type}
                  fields={fields}
                  setFields={setFields}
                  disabled={!available || busy || reloading || missing}
                />
              )}
              {!available && (
                <p className="text-sm text-amber-900">
                  Credential writes are unavailable. Ask your administrator to
                  enable secure destination setup.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="break-words font-semibold text-slate-900">
                {base?.name}
              </p>
              <p className="break-all text-sm text-slate-600">
                {base?.destination}
              </p>
              <p className="text-sm text-slate-700">
                {action.kind === 'remove'
                  ? 'Remove this draft and clear its saved credentials? This does not remove your private archives.'
                  : 'Protect this saved connection with the installation’s current encryption key. Its provider credentials stay the same.'}
              </p>
            </>
          )}
          {reloadNotice && (
            <p role="status" className="text-sm text-emerald-800">
              {reloadNotice}
            </p>
          )}
          {failure && (
            <div
              role="alert"
              className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
            >
              <p>{failure}</p>
              {base && !missing && (
                <button
                  type="button"
                  disabled={busy || reloading}
                  onClick={reload}
                  className={`${secondary} mt-3`}
                >
                  {reloading
                    ? 'Loading latest revision…'
                    : 'Reload latest revision'}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-3 border-t border-slate-200 bg-[#fffdf8] p-5">
          <button type="button" onClick={close} className={secondary}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              busy ||
              reloading ||
              missing ||
              (writingCredentials && !available) ||
              (action.kind === 'rotate' &&
                (!available || base?.credentialStatus !== 'available'))
            }
            className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy
              ? 'Saving…'
              : action.kind === 'remove'
                ? 'Remove destination'
                : action.kind === 'rotate'
                  ? 'Re-encrypt credentials'
                  : 'Save destination draft'}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}

function CredentialInputs({
  id,
  type,
  fields,
  setFields,
  disabled,
}: {
  id: string;
  type: LogExportDestinationType;
  fields: ConnectionFields;
  setFields: React.Dispatch<React.SetStateAction<ConnectionFields>>;
  disabled: boolean;
}) {
  type TextField = Exclude<keyof ConnectionFields, 'forcePathStyle' | 'site'>;
  const inputs: Array<{
    key: TextField;
    label: string;
    secret?: boolean;
    optional?: boolean;
    max: number;
    url?: boolean;
  }> =
    type === 's3'
      ? [
          { key: 'endpoint', label: 'S3 endpoint', max: 2048, url: true },
          { key: 'region', label: 'S3 region', max: 64 },
          { key: 'bucket', label: 'Bucket name', max: 63 },
          {
            key: 'accessKeyId',
            label: 'Access key ID',
            secret: true,
            max: 256,
          },
          {
            key: 'secretAccessKey',
            label: 'Secret access key',
            secret: true,
            max: 1024,
          },
          {
            key: 'sessionToken',
            label: 'Session token (optional)',
            secret: true,
            optional: true,
            max: 1024,
          },
        ]
      : type === 'webhook'
        ? [
            { key: 'url', label: 'Webhook URL', secret: true, max: 2048 },
            {
              key: 'signingSecret',
              label: 'Webhook signing secret',
              secret: true,
              max: 256,
            },
          ]
        : [{ key: 'apiKey', label: 'Datadog API key', secret: true, max: 32 }];
  return (
    <fieldset
      disabled={disabled}
      className="space-y-4 rounded-2xl border border-emerald-200 bg-[#f3faf5] p-4"
    >
      <legend className="px-1 text-sm font-semibold text-emerald-900">
        Connection details
      </legend>
      <p className="text-sm text-slate-600">
        Enter the complete connection. Secrets are encrypted when saved and
        cannot be revealed here.
      </p>
      {type === 'datadog' && (
        <div>
          <label
            htmlFor={`${id}-site`}
            className="text-sm font-medium text-slate-800"
          >
            Datadog site
          </label>
          <select
            id={`${id}-site`}
            value={fields.site}
            onChange={(event) =>
              setFields((current) => ({
                ...current,
                site: event.target.value as DatadogLogSite,
              }))
            }
            className={control}
          >
            {DATADOG_LOG_SITES.map((site) => (
              <option key={site} value={site}>
                {site}
              </option>
            ))}
          </select>
        </div>
      )}
      {inputs.map((input) => (
        <div key={input.key}>
          <label
            htmlFor={`${id}-${input.key}`}
            className="text-sm font-medium text-slate-800"
          >
            {input.label}
          </label>
          <input
            id={`${id}-${input.key}`}
            type={input.secret ? 'password' : input.url ? 'url' : 'text'}
            autoComplete="off"
            spellCheck={false}
            value={fields[input.key]}
            required={!input.optional}
            maxLength={input.max}
            onChange={(event) =>
              setFields((current) => ({
                ...current,
                [input.key]: event.target.value,
              }))
            }
            className={control}
          />
        </div>
      ))}
      {type === 's3' && (
        <label className="flex items-center gap-3 text-sm text-slate-800">
          <input
            type="checkbox"
            checked={fields.forcePathStyle}
            onChange={(event) =>
              setFields((current) => ({
                ...current,
                forcePathStyle: event.target.checked,
              }))
            }
            className="h-4 w-4 accent-indigo-700"
          />
          Use path-style bucket addresses
        </label>
      )}
      <p className="text-sm text-slate-600">
        {type === 's3'
          ? 'Use an HTTPS endpoint without a path or query. Keep the region and bucket exactly as configured by your storage provider.'
          : type === 'webhook'
            ? 'Use a public HTTPS URL and a signing secret of 32–256 bytes. The URL may contain private paths or tokens, so it stays masked.'
            : 'Select your account’s Datadog site and provide its 32-character API key.'}
      </p>
    </fieldset>
  );
}
