'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { WorkspaceDialog } from '../../../components/workspace-dialog';
import { DataLoadNotice } from '../../../components/data-load-notice';
import { Plus, X, Copy, Check, Pencil } from 'lucide-react';
import {
  getConsumers,
  createConsumer,
  updateConsumer,
  deleteConsumer,
} from '../../../lib/api-client';
import { useTenantId } from '../../../lib/auth';
import type { Consumer } from '../../../lib/api-client';

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function GroupBadges({ groups }: { groups?: string[] }) {
  if (!groups?.length) return <span className="text-xs text-gray-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {groups.map((g) => (
        <span
          key={g}
          className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700"
        >
          {g}
        </span>
      ))}
    </div>
  );
}

export default function ConsumersPage() {
  const tenantId = useTenantId() ?? '';

  const {
    data: consumers,
    error: loadError,
    mutate,
  } = useSWR(
    tenantId ? `consumers-${tenantId}` : null,
    () => getConsumers(tenantId),
    { refreshInterval: 30000 },
  );

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<'create' | 'edit'>('create');
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [groupsInput, setGroupsInput] = useState('');
  const [saving, setSaving] = useState(false);

  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  function openCreate() {
    setPanelMode('create');
    setEditId(null);
    setName('');
    setGroupsInput('');
    setPanelOpen(true);
  }

  function openEdit(consumer: Consumer) {
    setPanelMode('edit');
    setEditId(consumer.id);
    setName(consumer.name);
    setGroupsInput((consumer.groups ?? []).join(', '));
    setPanelOpen(true);
  }

  function parseGroups(input: string): string[] {
    return input
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId || !name.trim()) return;
    setSaving(true);
    try {
      const result = await createConsumer(tenantId, {
        name: name.trim(),
        groups: parseGroups(groupsInput),
      });
      setNewKey(result.apiKey);
      setPanelOpen(false);
      setName('');
      setGroupsInput('');
      await mutate();
    } catch {
      toast.error('Consumer could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId || !editId) return;
    setSaving(true);
    try {
      await updateConsumer(tenantId, editId, {
        groups: parseGroups(groupsInput),
      });
      setPanelOpen(false);
      await mutate();
    } catch {
      toast.error('Consumer could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function copyKey() {
    if (!newKey) return;
    navigator.clipboard
      .writeText(newKey)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() =>
        toast.error('Copy failed. Select and copy the key manually.'),
      );
  }

  async function handleRevoke() {
    if (!revokeTarget || !tenantId) return;
    setRevoking(true);
    try {
      await deleteConsumer(tenantId, revokeTarget);
      setRevokeTarget(null);
      await mutate();
    } catch {
      toast.error('Consumer key could not be revoked. Please try again.');
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="p-4 sm:p-8">
      {loadError && (
        <DataLoadNotice label="Consumers" onRetry={() => mutate()} />
      )}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">Consumers</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          Add Consumer
        </button>
      </div>

      <div
        tabIndex={0}
        role="region"
        aria-label="Consumers table"
        className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Name
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Groups
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Created
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Status
              </th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {!consumers ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-gray-400"
                >
                  {loadError ? 'Data unavailable' : 'Loading…'}
                </td>
              </tr>
            ) : consumers.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-gray-400"
                >
                  No consumers configured
                </td>
              </tr>
            ) : (
              consumers.map((consumer: Consumer) => {
                const revoked = consumer.revokedAt != null;
                return (
                  <tr
                    key={consumer.id}
                    className="border-b border-gray-100 last:border-0"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {consumer.name}
                    </td>
                    <td className="px-4 py-3">
                      <GroupBadges groups={consumer.groups} />
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatDate(consumer.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      {revoked ? (
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                          Revoked
                        </span>
                      ) : (
                        <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {!revoked && (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => openEdit(consumer)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                            title="Edit groups"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          {revokeTarget === consumer.id ? (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-600">
                                Revoke access?
                              </span>
                              <button
                                onClick={handleRevoke}
                                disabled={revoking}
                                className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                              >
                                {revoking ? '…' : 'Revoke'}
                              </button>
                              <button
                                onClick={() => setRevokeTarget(null)}
                                className="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setRevokeTarget(consumer.id)}
                              className="rounded px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                              Revoke
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Add / Edit Consumer slide-over */}
      {panelOpen && (
        <WorkspaceDialog
          label="Consumer form"
          onClose={() => setPanelOpen(false)}
        >
          <div className="relative z-50 flex h-full w-full max-w-[480px] flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">
                {panelMode === 'create' ? 'Add Consumer' : 'Edit Consumer'}
              </h2>
              <button
                aria-label="Close form"
                onClick={() => setPanelOpen(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form
              onSubmit={panelMode === 'create' ? handleCreate : handleUpdate}
              className="flex flex-1 flex-col gap-4 p-6"
            >
              {panelMode === 'create' && (
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="consumers-field-1"
                    className="text-sm font-medium text-gray-700"
                  >
                    Name
                  </label>
                  <input
                    id="consumers-field-1"
                    type="text"
                    required
                    autoFocus
                    placeholder="my-service"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="consumers-field-2"
                  className="text-sm font-medium text-gray-700"
                >
                  Groups{' '}
                  <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <input
                  id="consumers-field-2"
                  type="text"
                  placeholder="admin, read-only"
                  value={groupsInput}
                  onChange={(e) => setGroupsInput(e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-400">
                  Comma-separated group names — used by ACL plugin
                </p>
              </div>
              <div className="mt-auto flex justify-end gap-2 pt-4">
                <button
                  type="button"
                  aria-label="Close form"
                  onClick={() => setPanelOpen(false)}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || (panelMode === 'create' && !name.trim())}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving
                    ? panelMode === 'create'
                      ? 'Creating…'
                      : 'Saving…'
                    : panelMode === 'create'
                      ? 'Create'
                      : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </WorkspaceDialog>
      )}

      {/* One-time API key modal */}
      {newKey && (
        <WorkspaceDialog
          label="Consumer API key"
          centered
          onClose={() => setNewKey(null)}
        >
          <div className="relative z-50 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">
                Consumer API Key
              </h2>
              <button
                aria-label="Close API key"
                onClick={() => setNewKey(null)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
              Save this key — it won&apos;t be shown again.
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <code className="flex-1 break-all font-mono text-xs text-gray-800">
                {newKey}
              </code>
              <button
                onClick={copyKey}
                className="shrink-0 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                {copied ? (
                  <span className="flex items-center gap-1">
                    <Check className="h-3.5 w-3.5" />
                    Copied
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </span>
                )}
              </button>
            </div>
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setNewKey(null)}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Done
              </button>
            </div>
          </div>
        </WorkspaceDialog>
      )}
    </div>
  );
}
