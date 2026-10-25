'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Check, Copy } from 'lucide-react';
import type { CreatedPortalKey, PortalKey } from '@api-gateway/shared-types';
import { createKey, getKeys, revokeKey } from '../../../../lib/portal-api';
import { usePortal } from '../../../../components/portal-provider';
import { RequireSession } from '../../../../components/require-session';
import { PortalDialog } from '../../../../components/portal-dialog';
import { Field, FormError } from '../../../../components/field';
import { LoadNotice } from '../../../../components/load-notice';

export default function KeysPage() {
  return (
    <RequireSession>
      <Keys />
    </RequireSession>
  );
}

function Keys() {
  const { tenant } = usePortal();
  const { data, error, mutate } = useSWR(['portal-keys', tenant], () =>
    getKeys(tenant),
  );
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedPortalKey | null>(null);
  const [revoking, setRevoking] = useState<PortalKey | null>(null);
  const [notice, setNotice] = useState('');
  const active = data?.filter((key) => !key.revokedAt) ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold text-slate-900">API keys</h1>
          <p className="mt-2 text-slate-700">
            Send a key as{' '}
            <code className="font-mono">Authorization: Bearer</code> on each
            request. Use a separate key per application.
          </p>
        </div>
        <button
          type="button"
          disabled={!data}
          onClick={() => {
            setNotice('');
            setCreating(true);
          }}
          className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          Create key
        </button>
      </div>
      {error && (
        <LoadNotice
          message="Your keys could not be loaded."
          onRetry={() => mutate()}
        />
      )}
      {!data && !error && (
        <p role="status" className="mt-6 text-slate-700">
          Loading keys…
        </p>
      )}
      {data && data.length === 0 && (
        <p className="mt-6 text-slate-700">You have no keys yet.</p>
      )}
      {data && data.length > 0 && (
        <ul className="mt-6 grid gap-3" aria-label="Your keys">
          {data.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-100 bg-white p-4"
            >
              <div>
                <p className="font-medium text-slate-900">{key.name}</p>
                <p className="text-sm text-slate-600">
                  Created {new Date(key.createdAt).toLocaleString()}
                  {key.revokedAt
                    ? ` · Revoked ${new Date(key.revokedAt).toLocaleString()}`
                    : ''}
                </p>
              </div>
              {key.revokedAt ? (
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  Revoked
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setNotice('');
                    setRevoking(key);
                  }}
                  className="rounded-xl px-3 py-2 text-sm font-medium text-red-800 underline"
                >
                  Revoke<span className="sr-only"> {key.name}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && (
        <p className="mt-4 text-sm text-slate-600">
          {active.length} active {active.length === 1 ? 'key' : 'keys'}. The
          provider sets how many you can hold at once.
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-indigo-900">
          {notice}
        </p>
      )}
      {creating && (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setCreated(key);
            void mutate();
          }}
        />
      )}
      {created && (
        <CreatedKeyDialog
          created={created}
          onClose={() => {
            setCreated(null);
            setNotice(`Key ${created.name} created.`);
          }}
        />
      )}
      {revoking && (
        <RevokeKeyDialog
          target={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(key) => {
            setRevoking(null);
            void mutate();
            setNotice(`Key ${key.name} revoked. Requests using it now fail.`);
          }}
        />
      )}
    </>
  );
}

function useAbort() {
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  return pending;
}

function CreateKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (key: CreatedPortalKey) => void;
}) {
  const { tenant } = usePortal();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const pending = useAbort();
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
      const key = await createKey(tenant, name.trim(), controller.signal);
      if (!controller.signal.aborted) onCreated(key);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : 'The key could not be created.',
        );
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <PortalDialog label="Create API key" onClose={close}>
      <form onSubmit={submit} className="space-y-4 p-6">
        <h2 className="text-xl font-semibold text-slate-900">Create API key</h2>
        <Field
          label="Key name"
          required
          maxLength={64}
          placeholder="Mobile app"
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <FormError message={failure} />
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={close}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </form>
    </PortalDialog>
  );
}

function CreatedKeyDialog({
  created,
  onClose,
}: {
  created: CreatedPortalKey;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <PortalDialog label="Save your API key" onClose={onClose}>
      <div className="space-y-4 p-6 text-sm text-slate-800">
        <h2 className="text-xl font-semibold text-slate-900">
          Save your API key
        </h2>
        <p>
          This is the only time <strong>{created.name}</strong> is shown. Store
          it somewhere safe.
        </p>
        <p
          aria-label="API key value"
          className="break-all rounded-xl border border-slate-300 bg-white p-3 font-mono"
        >
          {created.apiKey}
        </p>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(created.apiKey);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
          className="inline-flex items-center gap-2 rounded-xl border border-indigo-300 bg-white px-4 py-2 font-medium text-indigo-900"
        >
          {copied ? (
            <Check aria-hidden="true" size={16} />
          ) : (
            <Copy aria-hidden="true" size={16} />
          )}
          {copied ? 'Copied' : 'Copy key'}
        </button>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-indigo-700 px-4 py-2 font-medium text-white"
          >
            I saved the key
          </button>
        </div>
      </div>
    </PortalDialog>
  );
}

function RevokeKeyDialog({
  target,
  onClose,
  onRevoked,
}: {
  target: PortalKey;
  onClose: () => void;
  onRevoked: (key: PortalKey) => void;
}) {
  const { tenant } = usePortal();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const pending = useAbort();
  function close() {
    pending.current?.abort();
    onClose();
  }
  async function revoke() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure('');
    try {
      const key = await revokeKey(tenant, target.id, controller.signal);
      if (!controller.signal.aborted) onRevoked(key);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error ? error.message : 'Revocation failed.',
        );
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <PortalDialog label="Revoke API key" onClose={close}>
      <div className="space-y-4 p-6 text-sm text-slate-800">
        <h2 className="text-xl font-semibold text-slate-900">
          Revoke {target.name}?
        </h2>
        <p>
          Applications using this key stop working once the gateway receives the
          change. This cannot be undone.
        </p>
        <FormError message={failure} />
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={close}
            className="rounded-xl border border-slate-300 px-4 py-2 text-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={revoke}
            className="rounded-xl bg-red-700 px-4 py-2 font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Revoking…' : 'Revoke key'}
          </button>
        </div>
      </div>
    </PortalDialog>
  );
}
