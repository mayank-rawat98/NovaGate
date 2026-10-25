'use client';
import { useEffect, useId, useRef, useState } from 'react';
import useSWR from 'swr';
import { Store, X } from 'lucide-react';
import {
  MAX_PORTAL_KEYS_PER_DEVELOPER,
  PORTAL_TITLE_MAX,
  type PortalDeveloper,
  type PortalSettings,
} from '@api-gateway/shared-types';
import {
  PORTAL_URL,
  getPortalDevelopers,
  getPortalSettings,
  savePortalSettings,
  setPortalDeveloperStatus,
} from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';
import { DataLoadNotice } from './data-load-notice';

export function portalAddress(tenantId: string, settings: PortalSettings) {
  return settings.customDomain
    ? `https://${settings.customDomain}`
    : `${PORTAL_URL}/w/${tenantId}`;
}

export function DeveloperPortalPanel({ tenantId }: { tenantId: string }) {
  return tenantId ? (
    <PortalWorkspace key={tenantId} tenantId={tenantId} />
  ) : null;
}

function PortalWorkspace({ tenantId }: { tenantId: string }) {
  const settings = useSWR(
    ['portal-settings', tenantId],
    () => getPortalSettings(tenantId),
    { refreshInterval: 30000 },
  );
  const developers = useSWR(
    ['portal-developers', tenantId],
    () => getPortalDevelopers(tenantId),
    { refreshInterval: 30000 },
  );
  const [editing, setEditing] = useState<PortalSettings | null>(null);
  const [changing, setChanging] = useState<PortalDeveloper | null>(null);
  const [notice, setNotice] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const developerList = useRef<HTMLDivElement>(null);
  // Removing an open dialog does not restore focus; return it explicitly.
  const restore = (target: { current: HTMLElement | null }) =>
    requestAnimationFrame(() => target.current?.focus());
  const data = settings.data;
  return (
    <section
      aria-label="Developer portal"
      className="min-w-0 rounded-3xl border border-indigo-100 bg-[#f8f7ff] p-5 shadow-[0_8px_28px_rgba(70,60,120,0.07)] sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-2xl bg-indigo-100 p-3 text-indigo-800">
            <Store aria-hidden="true" size={22} />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Developer portal
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Let your API consumers browse routes, create keys and see usage.
            </p>
          </div>
        </div>
        <button
          ref={opener}
          type="button"
          disabled={!data || !!settings.error}
          onClick={() => {
            setNotice('');
            setEditing(data ?? null);
          }}
          className="rounded-xl border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-900 disabled:opacity-60"
        >
          Edit portal settings
        </button>
      </div>
      {settings.error && (
        <div className="mt-4">
          <DataLoadNotice
            label="Developer portal settings"
            onRetry={() => settings.mutate()}
          />
        </div>
      )}
      {!data && !settings.error && (
        <p role="status" className="mt-4 text-sm text-slate-600">
          Loading portal settings…
        </p>
      )}
      {data && (
        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-white p-4">
            <dt className="text-sm text-slate-600">Status</dt>
            <dd className="mt-1 font-medium text-slate-900">
              {data.enabled ? 'Published' : 'Not published'}
            </dd>
          </div>
          <div className="rounded-2xl bg-white p-4">
            <dt className="text-sm text-slate-600">Address</dt>
            <dd className="mt-1 break-all text-sm font-medium text-slate-900">
              {data.enabled ? (
                <a
                  href={portalAddress(tenantId, data)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {portalAddress(tenantId, data)}
                </a>
              ) : (
                portalAddress(tenantId, data)
              )}
            </dd>
          </div>
          <div className="rounded-2xl bg-white p-4">
            <dt className="text-sm text-slate-600">Sign-up</dt>
            <dd className="mt-1 font-medium text-slate-900">
              {data.signup === 'open' ? 'Open' : 'Closed'} · up to{' '}
              {data.maxKeysPerDeveloper} keys each
            </dd>
          </div>
        </dl>
      )}
      {data?.customDomain && (
        <p className="mt-3 text-sm text-slate-600">
          Point a DNS record for {data.customDomain} at your portal host and
          serve it over HTTPS. Routes are published from each route&apos;s
          Advanced tab.
        </p>
      )}
      <h3 className="mt-6 text-base font-semibold text-slate-900">
        Developers
      </h3>
      {developers.error && (
        <div className="mt-3">
          <DataLoadNotice
            label="Portal developers"
            onRetry={() => developers.mutate()}
          />
        </div>
      )}
      {developers.data && developers.data.length === 0 && (
        <p className="mt-2 text-sm text-slate-600">
          No developers have registered yet.
        </p>
      )}
      {developers.data && developers.data.length > 0 && (
        <div
          ref={developerList}
          className="relative mt-3 overflow-x-auto rounded-2xl bg-white"
          tabIndex={0}
          role="region"
          aria-label="Portal developer list"
        >
          <table className="w-full text-left text-sm">
            <thead className="text-slate-600">
              <tr>
                <th className="px-4 py-3 font-medium">Developer</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Active keys</th>
                <th className="px-4 py-3 font-medium">Last sign-in</th>
                <th className="px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {developers.data.map((developer) => (
                <tr key={developer.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">
                    <span className="block font-medium text-slate-900">
                      {developer.name}
                    </span>
                    <span className="text-xs text-slate-600">
                      {developer.email}
                    </span>
                  </td>
                  <td className="px-4 py-3 capitalize text-slate-800">
                    {developer.status}
                  </td>
                  <td className="px-4 py-3 text-slate-800">
                    {developer.activeKeys}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {developer.lastLoginAt
                      ? new Date(developer.lastLoginAt).toLocaleString()
                      : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        setNotice('');
                        setChanging(developer);
                      }}
                      className={`rounded-lg px-2 py-1 text-sm font-medium underline ${
                        developer.status === 'suspended' ||
                        developer.status === 'pending'
                          ? 'text-indigo-900'
                          : 'text-red-800'
                      }`}
                    >
                      {developer.status === 'active' ? 'Suspend' : 'Activate'}
                      <span className="sr-only"> {developer.email}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-indigo-800">
          {notice}
        </p>
      )}
      {editing && (
        <PortalSettingsEditor
          tenantId={tenantId}
          initial={editing}
          onClose={() => setEditing(null)}
          onReload={() => settings.mutate()}
          onSaved={(saved) => {
            void settings.mutate(saved, { revalidate: false });
            setEditing(null);
            restore(opener);
            setNotice(
              saved.enabled
                ? 'Portal settings saved. The portal is published.'
                : 'Portal settings saved. The portal is not published.',
            );
          }}
        />
      )}
      {changing && (
        <DeveloperStatusDialog
          tenantId={tenantId}
          developer={changing}
          onClose={() => setChanging(null)}
          onChanged={(result) => {
            setChanging(null);
            void developers.mutate();
            restore(developerList);
            setNotice(
              result.status === 'suspended'
                ? `${changing.email} suspended; ${result.revokedKeys} ${result.revokedKeys === 1 ? 'key' : 'keys'} revoked.`
                : `${changing.email} can sign in again. Earlier keys stay revoked.`,
            );
          }}
        />
      )}
    </section>
  );
}

function useAbortOnUnmount() {
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  return { pending, mounted };
}

function PortalSettingsEditor({
  tenantId,
  initial,
  onClose,
  onReload,
  onSaved,
}: {
  tenantId: string;
  initial: PortalSettings;
  onClose: () => void;
  onReload: () => Promise<PortalSettings | undefined>;
  onSaved: (settings: PortalSettings) => void;
}) {
  const ids = {
    title: useId(),
    domain: useId(),
    api: useId(),
    signup: useId(),
    groups: useId(),
    keys: useId(),
  };
  const [base, setBase] = useState(initial);
  const [form, setForm] = useState({
    enabled: initial.enabled,
    title: initial.title,
    customDomain: initial.customDomain ?? '',
    apiBaseUrl: initial.apiBaseUrl ?? '',
    signup: initial.signup,
    defaultGroups: initial.defaultGroups.join(', '),
    maxKeysPerDeveloper: String(initial.maxKeysPerDeveloper),
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [reloading, setReloading] = useState(false);
  const { pending, mounted } = useAbortOnUnmount();
  function close() {
    pending.current?.abort();
    onClose();
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const keys = Number(form.maxKeysPerDeveloper);
    if (
      !Number.isInteger(keys) ||
      keys < 1 ||
      keys > MAX_PORTAL_KEYS_PER_DEVELOPER
    ) {
      setFailure(
        `Allow 1–${MAX_PORTAL_KEYS_PER_DEVELOPER} active keys per developer.`,
      );
      return;
    }
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure('');
    try {
      const saved = await savePortalSettings(
        tenantId,
        {
          enabled: form.enabled,
          title: form.title.trim(),
          customDomain: form.customDomain.trim() || null,
          apiBaseUrl: form.apiBaseUrl.trim() || null,
          signup: form.signup,
          defaultGroups: form.defaultGroups
            .split(',')
            .map((group) => group.trim())
            .filter(Boolean),
          maxKeysPerDeveloper: keys,
          expectedRevision: base.revision,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) onSaved(saved);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : 'Portal settings could not be saved. Try again.',
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
      const current = await onReload();
      if (!mounted.current) return;
      if (current) setBase(current);
      else setFailure('Current settings could not be loaded. Try again.');
    } catch {
      if (mounted.current)
        setFailure('Current settings could not be loaded. Try again.');
    } finally {
      if (mounted.current) setReloading(false);
    }
  }
  const input =
    'mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900';
  return (
    <WorkspaceDialog label="Edit developer portal settings" onClose={close}>
      <form onSubmit={submit} className="flex h-full flex-col bg-[#fffdf8]">
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <h2 className="text-xl font-semibold text-slate-900">
            Developer portal settings
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close portal settings"
            className="rounded-xl p-2 text-slate-600"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <label className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={busy}
              onChange={(event) =>
                setForm({ ...form, enabled: event.target.checked })
              }
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium text-slate-900">
                Publish the portal
              </span>
              <span className="text-slate-700">
                Unpublishing hides the catalog and ends developer sessions.
                Existing developer keys keep working until revoked.
              </span>
            </span>
          </label>
          <div>
            <label
              htmlFor={ids.title}
              className="block text-sm font-medium text-slate-800"
            >
              Portal title
            </label>
            <input
              id={ids.title}
              required
              maxLength={PORTAL_TITLE_MAX}
              value={form.title}
              disabled={busy}
              onChange={(event) =>
                setForm({ ...form, title: event.target.value })
              }
              className={input}
            />
          </div>
          <div>
            <label
              htmlFor={ids.domain}
              className="block text-sm font-medium text-slate-800"
            >
              Custom domain (optional)
            </label>
            <input
              id={ids.domain}
              value={form.customDomain}
              disabled={busy}
              placeholder="portal.example.com"
              onChange={(event) =>
                setForm({ ...form, customDomain: event.target.value })
              }
              className={input}
            />
            <p className="mt-1 text-sm text-slate-600">
              Without one, the portal is served at {PORTAL_URL}/w/{tenantId}.
            </p>
          </div>
          <div>
            <label
              htmlFor={ids.api}
              className="block text-sm font-medium text-slate-800"
            >
              Gateway address for examples (optional)
            </label>
            <input
              id={ids.api}
              value={form.apiBaseUrl}
              disabled={busy}
              placeholder="https://api.example.com"
              onChange={(event) =>
                setForm({ ...form, apiBaseUrl: event.target.value })
              }
              className={input}
            />
          </div>
          <div>
            <label
              htmlFor={ids.signup}
              className="block text-sm font-medium text-slate-800"
            >
              Developer sign-up
            </label>
            <select
              id={ids.signup}
              value={form.signup}
              disabled={busy}
              onChange={(event) =>
                setForm({
                  ...form,
                  signup: event.target.value as PortalSettings['signup'],
                })
              }
              className={input}
            >
              <option value="open">Open: anyone with a verified email</option>
              <option value="closed">Closed: no new registrations</option>
            </select>
          </div>
          <div>
            <label
              htmlFor={ids.groups}
              className="block text-sm font-medium text-slate-800"
            >
              Groups for new developer keys (comma-separated)
            </label>
            <input
              id={ids.groups}
              value={form.defaultGroups}
              disabled={busy}
              placeholder="partners"
              onChange={(event) =>
                setForm({ ...form, defaultGroups: event.target.value })
              }
              className={input}
            />
            <p className="mt-1 text-sm text-slate-600">
              Groups feed the acl plugin. Changes apply to keys created later.
            </p>
          </div>
          <div>
            <label
              htmlFor={ids.keys}
              className="block text-sm font-medium text-slate-800"
            >
              Active keys per developer
            </label>
            <input
              id={ids.keys}
              type="number"
              min="1"
              max={MAX_PORTAL_KEYS_PER_DEVELOPER}
              step="1"
              required
              value={form.maxKeysPerDeveloper}
              disabled={busy}
              onChange={(event) =>
                setForm({ ...form, maxKeysPerDeveloper: event.target.value })
              }
              className={input}
            />
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
              <p className="mt-2">Reloading keeps what you typed.</p>
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
            disabled={busy || reloading}
            className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save portal settings'}
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}

function DeveloperStatusDialog({
  tenantId,
  developer,
  onClose,
  onChanged,
}: {
  tenantId: string;
  developer: PortalDeveloper;
  onClose: () => void;
  onChanged: (result: {
    status: 'active' | 'suspended';
    revokedKeys: number;
  }) => void;
}) {
  const next = developer.status === 'active' ? 'suspended' : 'active';
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const { pending } = useAbortOnUnmount();
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
    try {
      const result = await setPortalDeveloperStatus(
        tenantId,
        developer.id,
        next,
        controller.signal,
      );
      if (!controller.signal.aborted) onChanged(result);
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
      label={next === 'suspended' ? 'Suspend developer' : 'Activate developer'}
      onClose={close}
      centered
    >
      <div className="space-y-4 bg-[#fffdf8] p-5 text-sm text-slate-700">
        <h2 className="text-xl font-semibold text-slate-900">
          {next === 'suspended' ? 'Suspend' : 'Activate'} {developer.email}?
        </h2>
        <p>
          {next === 'suspended'
            ? `This ends their portal sessions and revokes all ${developer.activeKeys} active ${developer.activeKeys === 1 ? 'key' : 'keys'} immediately.`
            : developer.status === 'pending'
              ? 'This confirms the account without email verification. They can sign in and create keys.'
              : 'They can sign in again and create new keys. Revoked keys stay revoked.'}
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
              next === 'suspended' ? 'bg-red-700' : 'bg-indigo-700'
            }`}
          >
            {busy
              ? 'Saving…'
              : next === 'suspended'
                ? 'Suspend developer'
                : 'Activate developer'}
          </button>
        </div>
      </div>
    </WorkspaceDialog>
  );
}
