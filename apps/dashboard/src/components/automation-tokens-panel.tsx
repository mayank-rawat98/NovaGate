'use client';
import { useEffect, useId, useRef, useState } from 'react';
import useSWR from 'swr';
import { Check, Copy, KeyRound, X } from 'lucide-react';
import {
  AUTOMATION_TOKEN_SCOPES,
  DEFAULT_AUTOMATION_TOKEN_DAYS,
  MAX_AUTOMATION_TOKEN_DAYS,
  type AutomationTokenScope,
  type AutomationTokenSummary,
  type CreatedAutomationToken,
} from '@api-gateway/shared-types';
import {
  createAutomationToken,
  getAutomationTokens,
  revokeAutomationToken,
} from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';
import { DataLoadNotice } from './data-load-notice';

const SCOPE_LABELS: Record<AutomationTokenScope, string> = {
  'workspace:read': 'Read workspace profile',
  'routes:read': 'Read routes',
  'routes:write': 'Create, edit and delete routes',
  'services:read': 'Read services',
  'services:write': 'Create, edit and delete services',
  'consumers:read': 'Read consumers',
  'consumers:write': 'Create consumers and their keys, edit and revoke',
  'config:read': 'Export configuration and preview imports',
  'config:write': 'Apply complete configuration imports',
  'logs:read': 'Read request logs and live log streams',
  'analytics:read': 'Read metrics, health, errors and traces',
  'analytics:write': 'Resolve error events',
  'alerts:read': 'Read alert rules and history',
  'alerts:write': 'Create, edit and delete alert rules',
};

function status(token: AutomationTokenSummary, now: number) {
  if (token.revokedAt) return 'Revoked';
  if (Date.parse(token.expiresAt) <= now) return 'Expired';
  return 'Active';
}

export function AutomationTokensPanel({ tenantId }: { tenantId: string }) {
  return tenantId ? (
    <TokensWorkspace key={tenantId} tenantId={tenantId} />
  ) : null;
}

function TokensWorkspace({ tenantId }: { tenantId: string }) {
  const { data, error, mutate } = useSWR(
    ['automation-tokens', tenantId],
    () => getAutomationTokens(tenantId),
    { refreshInterval: 30000 },
  );
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAutomationToken | null>(null);
  const [revoking, setRevoking] = useState<AutomationTokenSummary | null>(null);
  const [notice, setNotice] = useState('');
  const now = Date.now();
  return (
    <section
      aria-label="Automation tokens"
      className="rounded-3xl border border-indigo-100 bg-[#f8f7ff] p-5 shadow-[0_8px_28px_rgba(70,60,120,0.07)] sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-2xl bg-indigo-100 p-3 text-indigo-800">
            <KeyRound aria-hidden="true" size={22} />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Automation tokens
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Scoped, expiring credentials for the CLI, Terraform and CI.
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={!data || !!error}
          onClick={() => {
            setNotice('');
            setCreating(true);
          }}
          className="rounded-xl border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-900 disabled:opacity-60"
        >
          Create token
        </button>
      </div>
      {error && (
        <div className="mt-4">
          <DataLoadNotice label="Automation tokens" onRetry={() => mutate()} />
        </div>
      )}
      {!data && !error && (
        <p role="status" className="mt-4 text-sm text-slate-600">
          Loading automation tokens…
        </p>
      )}
      {data && data.length === 0 && (
        <p className="mt-4 text-sm text-slate-600">
          No tokens yet. Create one per automation so each can be revoked on its
          own.
        </p>
      )}
      {data && data.length > 0 && (
        <div
          className="mt-4 overflow-x-auto rounded-2xl bg-white"
          tabIndex={0}
          role="region"
          aria-label="Automation token list"
        >
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-slate-600">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Scopes</th>
                <th className="px-4 py-3 font-medium">Expires</th>
                <th className="px-4 py-3 font-medium">Last used</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((token) => {
                const state = status(token, now);
                return (
                  <tr key={token.id} className="border-t border-slate-100">
                    <td className="px-4 py-3">
                      <span className="font-medium text-slate-900">
                        {token.name}
                      </span>
                      <span className="block font-mono text-xs text-slate-600">
                        {token.displayPrefix}…
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <ul className="flex flex-wrap gap-1">
                        {token.scopes.map((scope) => (
                          <li
                            key={scope}
                            className="rounded-full bg-indigo-50 px-2 py-0.5 font-mono text-xs text-indigo-900"
                          >
                            {scope}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {new Date(token.expiresAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {token.lastUsedAt
                        ? new Date(token.lastUsedAt).toLocaleString()
                        : 'Never'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          state === 'Active'
                            ? 'bg-emerald-50 text-emerald-900'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {state}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {state === 'Active' && (
                        <button
                          type="button"
                          onClick={() => {
                            setNotice('');
                            setRevoking(token);
                          }}
                          className="rounded-lg px-2 py-1 text-sm font-medium text-red-800 underline"
                        >
                          Revoke<span className="sr-only"> {token.name}</span>
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
      <p className="mt-4 text-sm text-slate-600">
        Write access includes read access for the same area. Tokens cannot
        manage tokens, workspace keys, privacy, retention, export destinations
        or alert channel credentials; sign in for those. Last use is recorded at
        most once a minute.
      </p>
      {notice && (
        <p role="status" className="mt-3 text-sm text-indigo-800">
          {notice}
        </p>
      )}
      {creating && (
        <CreateTokenDialog
          tenantId={tenantId}
          onClose={() => setCreating(false)}
          onCreated={(token) => {
            setCreating(false);
            setCreated(token);
            void mutate();
          }}
        />
      )}
      {created && (
        <CreatedTokenDialog
          token={created}
          onClose={() => {
            setCreated(null);
            setNotice(`Token ${created.name} created.`);
          }}
        />
      )}
      {revoking && (
        <RevokeTokenDialog
          tenantId={tenantId}
          token={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(token) => {
            setRevoking(null);
            void mutate(
              (list) =>
                list?.map((entry) => (entry.id === token.id ? token : entry)),
              { revalidate: true },
            );
            setNotice(
              `Token ${token.name} revoked. Requests using it now fail; open log streams close within a minute.`,
            );
          }}
        />
      )}
    </section>
  );
}

function useAbortOnUnmount() {
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  return pending;
}

function CreateTokenDialog({
  tenantId,
  onClose,
  onCreated,
}: {
  tenantId: string;
  onClose: () => void;
  onCreated: (token: CreatedAutomationToken) => void;
}) {
  const nameId = useId();
  const daysId = useId();
  const [name, setName] = useState('');
  const [days, setDays] = useState(String(DEFAULT_AUTOMATION_TOKEN_DAYS));
  const [scopes, setScopes] = useState<AutomationTokenScope[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const pending = useAbortOnUnmount();
  function close() {
    pending.current?.abort();
    onClose();
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = Number(days);
    if (!name.trim()) return setFailure('Give the token a name.');
    if (!scopes.length) return setFailure('Choose at least one scope.');
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_AUTOMATION_TOKEN_DAYS
    )
      return setFailure(
        `Choose an expiry of 1–${MAX_AUTOMATION_TOKEN_DAYS} whole days.`,
      );
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure('');
    try {
      const token = await createAutomationToken(
        tenantId,
        { name: name.trim(), scopes, expiresInDays: value },
        controller.signal,
      );
      if (!controller.signal.aborted) onCreated(token);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : 'The token could not be created. Try again.',
        );
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <WorkspaceDialog label="Create automation token" onClose={close}>
      <form onSubmit={submit} className="flex h-full flex-col bg-[#fffdf8]">
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <h2 className="text-xl font-semibold text-slate-900">
            Create automation token
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close token editor"
            className="rounded-xl p-2 text-slate-600"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <div>
            <label
              htmlFor={nameId}
              className="block text-sm font-medium text-slate-800"
            >
              Token name
            </label>
            <input
              id={nameId}
              value={name}
              maxLength={64}
              required
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              placeholder="GitHub Actions deploy"
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900"
            />
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-slate-800">
              Scopes
            </legend>
            <p className="mt-1 text-sm text-slate-600">
              Grant only what this automation needs.
            </p>
            <div className="mt-3 space-y-2">
              {AUTOMATION_TOKEN_SCOPES.map((scope) => (
                <label
                  key={scope}
                  className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    disabled={busy}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, scope]
                          : current.filter((entry) => entry !== scope),
                      )
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-mono text-xs text-indigo-900">
                      {scope}
                    </span>
                    <span className="text-slate-700">
                      {SCOPE_LABELS[scope]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label
              htmlFor={daysId}
              className="block text-sm font-medium text-slate-800"
            >
              Expires after (days)
            </label>
            <input
              id={daysId}
              type="number"
              min="1"
              max={MAX_AUTOMATION_TOKEN_DAYS}
              step="1"
              required
              value={days}
              disabled={busy}
              onChange={(event) => setDays(event.target.value)}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900"
            />
          </div>
          {failure && (
            <p
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
            >
              {failure}
            </p>
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
            disabled={busy}
            className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Creating…' : 'Create token'}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}

function CreatedTokenDialog({
  token,
  onClose,
}: {
  token: CreatedAutomationToken;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <WorkspaceDialog label="Save your automation token" onClose={onClose}>
      <div className="flex h-full flex-col bg-[#fffdf8]">
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <h2 className="text-xl font-semibold text-slate-900">
            Save your token
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close saved token"
            className="rounded-xl p-2 text-slate-600"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm text-slate-700">
          <p>
            This is the only time <strong>{token.name}</strong> is shown. Store
            it in your CI secret store, then use it as{' '}
            <code className="font-mono">GW_API_TOKEN</code>.
          </p>
          <p
            aria-label="Automation token value"
            className="break-all rounded-xl border border-slate-300 bg-white p-3 font-mono text-slate-900"
          >
            {token.token}
          </p>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(token.token);
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
            {copied ? 'Copied' : 'Copy token'}
          </button>
          <p role="status">
            Expires {new Date(token.expiresAt).toLocaleString()}. Scopes:{' '}
            {token.scopes.join(', ')}.
          </p>
        </div>
        <div className="flex justify-end border-t border-slate-200 p-5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white"
          >
            I saved the token
          </button>
        </div>
      </div>
    </WorkspaceDialog>
  );
}

function RevokeTokenDialog({
  tenantId,
  token,
  onClose,
  onRevoked,
}: {
  tenantId: string;
  token: AutomationTokenSummary;
  onClose: () => void;
  onRevoked: (token: AutomationTokenSummary) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const pending = useAbortOnUnmount();
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
      const revoked = await revokeAutomationToken(
        tenantId,
        token.id,
        controller.signal,
      );
      if (!controller.signal.aborted) onRevoked(revoked);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : 'The token could not be revoked. Try again.',
        );
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <WorkspaceDialog label="Revoke automation token" onClose={close} centered>
      <div className="space-y-4 bg-[#fffdf8] p-5 text-sm text-slate-700">
        <h2 className="text-xl font-semibold text-slate-900">
          Revoke {token.name}?
        </h2>
        <p>
          Automations using this token stop working immediately. Revocation
          cannot be undone; create a new token to restore access.
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
            onClick={revoke}
            className="rounded-xl bg-red-700 px-4 py-2 font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Revoking…' : 'Revoke token'}
          </button>
        </div>
      </div>
    </WorkspaceDialog>
  );
}
