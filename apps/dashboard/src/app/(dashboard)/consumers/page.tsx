'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Plus, X, Copy, Check } from 'lucide-react';
import { getConsumers, createConsumer, deleteConsumer } from '../../../lib/api-client';
import { getTenantId } from '../../../lib/auth';
import type { Consumer } from '../../../lib/api-client';

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function ConsumersPage() {
  const tenantId = getTenantId() ?? '';

  const { data: consumers, mutate } = useSWR(
    tenantId ? `consumers-${tenantId}` : null,
    () => getConsumers(tenantId),
    { refreshInterval: 30000 },
  );

  const [panelOpen, setPanelOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId || !name.trim()) return;
    setSaving(true);
    try {
      const result = await createConsumer(tenantId, { name: name.trim() });
      setNewKey(result.apiKey);
      setPanelOpen(false);
      setName('');
      await mutate();
    } finally {
      setSaving(false);
    }
  }

  function copyKey() {
    if (!newKey) return;
    navigator.clipboard.writeText(newKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleRevoke() {
    if (!revokeTarget || !tenantId) return;
    setRevoking(true);
    try {
      await deleteConsumer(tenantId, revokeTarget);
      setRevokeTarget(null);
      await mutate();
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Consumers</h1>
        <button
          onClick={() => { setName(''); setPanelOpen(true); }}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          Add Consumer
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Name
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
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-400">
                  Loading…
                </td>
              </tr>
            ) : consumers.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-400">
                  No consumers configured
                </td>
              </tr>
            ) : (
              consumers.map((consumer: Consumer) => {
                const revoked = consumer.revokedAt != null;
                return (
                  <tr key={consumer.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-gray-900">{consumer.name}</td>
                    <td className="px-4 py-3 text-gray-500">{formatDate(consumer.createdAt)}</td>
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
                        <div className="flex items-center justify-end">
                          {revokeTarget === consumer.id ? (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-600">Revoke access?</span>
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

      {/* Add Consumer slide-over */}
      {panelOpen && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="fixed inset-0 bg-black/20" onClick={() => setPanelOpen(false)} />
          <div className="relative z-50 flex h-full w-80 flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">Add Consumer</h2>
              <button
                onClick={() => setPanelOpen(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="flex flex-1 flex-col gap-4 p-6">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">Name</label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="my-service"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="mt-auto flex justify-end gap-2 pt-4">
                <button
                  type="button"
                  onClick={() => setPanelOpen(false)}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !name.trim()}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* One-time API key modal */}
      {newKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/30" />
          <div className="relative z-50 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Consumer API Key</h2>
              <button
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
              <code className="flex-1 break-all font-mono text-xs text-gray-800">{newKey}</code>
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
        </div>
      )}
    </div>
  );
}
