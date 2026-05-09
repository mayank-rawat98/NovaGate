'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Trash2, Plus, X } from 'lucide-react';
import {
  getServices,
  getHealth,
  createService,
  deleteService,
} from '../../../lib/api-client';
import { getTenantId } from '../../../lib/auth';
import type { Service, CreateServiceDto } from '../../../lib/api-client';
import type { HealthSnapshot } from '../../../lib/api-client';

const HEALTH_STYLES: Record<string, string> = {
  healthy: 'bg-green-100 text-green-700',
  unhealthy: 'bg-red-100 text-red-700',
  unknown: 'bg-gray-100 text-gray-500',
};

interface FormState {
  name: string;
  targetUrl: string;
  healthCheckPath: string;
  timeoutMs: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  targetUrl: '',
  healthCheckPath: '/health',
  timeoutMs: '10000',
};

export default function ServicesPage() {
  const tenantId = getTenantId() ?? '';

  const { data: services, mutate } = useSWR(
    tenantId ? `services-${tenantId}` : null,
    () => getServices(tenantId),
    { refreshInterval: 30000 },
  );
  const { data: healthSnapshots } = useSWR(
    tenantId ? `health-${tenantId}` : null,
    () => getHealth(tenantId),
    { refreshInterval: 30000 },
  );

  const [panelOpen, setPanelOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setForm(EMPTY_FORM);
    setPanelOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId) return;
    setSaving(true);
    try {
      const dto: CreateServiceDto = {
        name: form.name,
        targetUrl: form.targetUrl,
        healthCheckPath: form.healthCheckPath || '/health',
        timeoutMs: form.timeoutMs ? Number(form.timeoutMs) : undefined,
      };
      await createService(tenantId, dto);
      setPanelOpen(false);
      await mutate();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget || !tenantId) return;
    setDeleting(true);
    try {
      await deleteService(tenantId, deleteTarget);
      setDeleteTarget(null);
      await mutate();
    } finally {
      setDeleting(false);
    }
  }

  const healthMap = Object.fromEntries(
    (healthSnapshots ?? []).map((h: HealthSnapshot) => [h.serviceId, h]),
  );

  function formatCheckedAt(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Services</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          Add Service
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
                Target URL
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Health
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Last Checked
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">
                Latency
              </th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {!services ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">
                  Loading…
                </td>
              </tr>
            ) : services.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">
                  No services configured
                </td>
              </tr>
            ) : (
              services.map((service: Service) => {
                const health: HealthSnapshot | undefined = healthMap[service.id];
                const status = health?.status ?? 'unknown';
                return (
                  <tr key={service.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-gray-900">{service.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 break-all">
                      {service.targetUrl}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs font-medium capitalize ${
                          HEALTH_STYLES[status] ?? HEALTH_STYLES.unknown
                        }`}
                      >
                        {status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {health ? formatCheckedAt(health.checkedAt) : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {health?.latencyMs != null ? `${health.latencyMs}ms` : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end">
                        {deleteTarget === service.id ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-600">Delete this service?</span>
                            <button
                              onClick={handleDelete}
                              disabled={deleting}
                              className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                            >
                              {deleting ? '…' : 'Delete'}
                            </button>
                            <button
                              onClick={() => setDeleteTarget(null)}
                              className="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleteTarget(service.id)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Slide-over panel */}
      {panelOpen && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="fixed inset-0 bg-black/20" onClick={() => setPanelOpen(false)} />
          <div className="relative z-50 flex h-full w-96 flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">Add Service</h2>
              <button
                onClick={() => setPanelOpen(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">Name</label>
                <input
                  type="text"
                  required
                  placeholder="user-service"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">Target URL</label>
                <input
                  type="url"
                  required
                  placeholder="http://user-service:4000"
                  value={form.targetUrl}
                  onChange={(e) => setForm((f) => ({ ...f, targetUrl: e.target.value }))}
                  className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">Health Check Path</label>
                <input
                  type="text"
                  placeholder="/health"
                  value={form.healthCheckPath}
                  onChange={(e) => setForm((f) => ({ ...f, healthCheckPath: e.target.value }))}
                  className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">
                  Timeout{' '}
                  <span className="font-normal text-gray-400">(ms)</span>
                </label>
                <input
                  type="number"
                  min={100}
                  placeholder="10000"
                  value={form.timeoutMs}
                  onChange={(e) => setForm((f) => ({ ...f, timeoutMs: e.target.value }))}
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
                  disabled={saving}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Add Service'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
