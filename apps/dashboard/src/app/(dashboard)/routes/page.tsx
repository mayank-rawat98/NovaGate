'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Pencil, Trash2, Plus, X } from 'lucide-react';
import {
  getRoutes,
  getServices,
  createRoute,
  updateRoute,
  deleteRoute,
} from '../../../lib/api-client';
import { getTenantId } from '../../../lib/auth';
import type { Route, Service, CreateRouteDto } from '../../../lib/api-client';

const METHOD_COLORS: Record<string, string> = {
  ANY: 'bg-gray-800 text-white',
  GET: 'bg-blue-100 text-blue-700',
  POST: 'bg-green-100 text-green-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-purple-100 text-purple-700',
  DELETE: 'bg-red-100 text-red-700',
};

const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface FormState {
  method: string;
  pathPattern: string;
  serviceId: string;
  authRequired: boolean;
  rateLimitOverride: string;
}

const EMPTY_FORM: FormState = {
  method: 'ANY',
  pathPattern: '',
  serviceId: '',
  authRequired: false,
  rateLimitOverride: '',
};

export default function RoutesPage() {
  const tenantId = getTenantId() ?? '';

  const { data: routes, mutate } = useSWR(
    tenantId ? `routes-${tenantId}` : null,
    () => getRoutes(tenantId),
    { refreshInterval: 30000 },
  );
  const { data: services } = useSWR(
    tenantId ? `services-${tenantId}` : null,
    () => getServices(tenantId),
  );

  const [panelOpen, setPanelOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setPanelOpen(true);
  }

  function openEdit(route: Route) {
    setEditId(route.id);
    setForm({
      method: route.method,
      pathPattern: route.pathPattern,
      serviceId: route.serviceId,
      authRequired: route.authRequired,
      rateLimitOverride: route.rateLimitOverride?.toString() ?? '',
    });
    setPanelOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId) return;
    setSaving(true);
    try {
      const dto: CreateRouteDto = {
        method: form.method,
        pathPattern: form.pathPattern,
        serviceId: form.serviceId,
        authRequired: form.authRequired,
        ...(form.rateLimitOverride ? { rateLimitOverride: Number(form.rateLimitOverride) } : {}),
      };
      if (editId) {
        await updateRoute(tenantId, editId, dto);
        toast.success('Route updated');
      } else {
        await createRoute(tenantId, dto);
        toast.success('Route created');
      }
      setPanelOpen(false);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save route');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget || !tenantId) return;
    setDeleting(true);
    try {
      await deleteRoute(tenantId, deleteTarget);
      setDeleteTarget(null);
      await mutate();
      toast.success('Route deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete route');
    } finally {
      setDeleting(false);
    }
  }

  const serviceMap = Object.fromEntries((services ?? []).map((s: Service) => [s.id, s.name]));

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Routes</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          Add Route
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Method
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Path Pattern
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Service
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Auth Required
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Rate Limit Override
              </th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {!routes ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">
                  Loading…
                </td>
              </tr>
            ) : routes.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">
                  No routes configured
                </td>
              </tr>
            ) : (
              routes.map((route) => (
                <tr key={route.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded px-2 py-0.5 font-mono text-xs font-semibold ${
                        METHOD_COLORS[route.method] ?? 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {route.method}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{route.pathPattern}</td>
                  <td className="px-4 py-3 text-gray-700">
                    {serviceMap[route.serviceId] ?? (
                      <span className="text-gray-400">{route.serviceId}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {route.authRequired ? (
                      <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                        Yes
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                        No
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {route.rateLimitOverride != null ? (
                      `${route.rateLimitOverride}/min`
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {deleteTarget === route.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-600">Delete this route?</span>
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
                        <>
                          <button
                            onClick={() => openEdit(route)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(route.id)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
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
              <h2 className="text-base font-semibold text-gray-900">
                {editId ? 'Edit Route' : 'Add Route'}
              </h2>
              <button
                onClick={() => setPanelOpen(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">Method</label>
                <select
                  value={form.method}
                  onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">Path Pattern</label>
                <input
                  type="text"
                  required
                  placeholder="/users/:id"
                  value={form.pathPattern}
                  onChange={(e) => setForm((f) => ({ ...f, pathPattern: e.target.value }))}
                  className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">Service</label>
                <select
                  required
                  value={form.serviceId}
                  onChange={(e) => setForm((f) => ({ ...f, serviceId: e.target.value }))}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Select a service…</option>
                  {(services ?? []).map((s: Service) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Auth Required</span>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, authRequired: !f.authRequired }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    form.authRequired ? 'bg-blue-600' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      form.authRequired ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">
                  Rate Limit Override{' '}
                  <span className="font-normal text-gray-400">(req/min, optional)</span>
                </label>
                <input
                  type="number"
                  min={1}
                  placeholder="Leave blank to use global"
                  value={form.rateLimitOverride}
                  onChange={(e) => setForm((f) => ({ ...f, rateLimitOverride: e.target.value }))}
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
                  {saving ? 'Saving…' : editId ? 'Save Changes' : 'Add Route'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
