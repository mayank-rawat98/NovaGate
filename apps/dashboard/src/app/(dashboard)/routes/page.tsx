'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Pencil, Trash2, Plus, X, ChevronDown, ChevronRight } from 'lucide-react';
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
  GET: 'bg-blue-100 text-blue-700',
  POST: 'bg-green-100 text-green-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-purple-100 text-purple-700',
  DELETE: 'bg-red-100 text-red-700',
  ANY: 'bg-gray-100 text-gray-700',
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'] as const;
const RETRY_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE'] as const;
const DEFAULT_RETRY_CODES = '502,503,504';
const DEFAULT_RETRY_METHODS = ['GET', 'HEAD', 'OPTIONS'];

interface FormState {
  // Basic
  method: string;
  pathPattern: string;
  serviceId: string;
  authRequired: boolean;
  enabled: boolean;
  rateLimitOverride: string;
  // Advanced toggle
  showAdvanced: boolean;
  // Size limit
  maxBodyBytes: string;
  // Retry
  retryEnabled: boolean;
  retryAttempts: string;
  retryOn: string;
  retryMethods: string[];
  // CORS
  corsEnabled: boolean;
  corsOrigins: string;
  corsMethods: string;
  corsHeaders: string;
  corsCredentials: boolean;
  corsMaxAge: string;
  // IP restriction
  ipEnabled: boolean;
  ipAllow: string;
  ipDeny: string;
}

const EMPTY_FORM: FormState = {
  method: 'GET',
  pathPattern: '',
  serviceId: '',
  authRequired: false,
  enabled: true,
  rateLimitOverride: '',
  showAdvanced: false,
  maxBodyBytes: '',
  retryEnabled: false,
  retryAttempts: '3',
  retryOn: DEFAULT_RETRY_CODES,
  retryMethods: DEFAULT_RETRY_METHODS,
  corsEnabled: false,
  corsOrigins: '',
  corsMethods: '',
  corsHeaders: '',
  corsCredentials: false,
  corsMaxAge: '',
  ipEnabled: false,
  ipAllow: '',
  ipDeny: '',
};

function routeToForm(route: Route): FormState {
  return {
    method: route.method,
    pathPattern: route.pathPattern,
    serviceId: route.serviceId,
    authRequired: route.authRequired,
    enabled: route.enabled,
    rateLimitOverride: route.rateLimitOverride?.toString() ?? '',
    showAdvanced: !!(route.retry || route.cors || route.ipRestriction || route.maxBodyBytes),
    maxBodyBytes: route.maxBodyBytes?.toString() ?? '',
    retryEnabled: !!route.retry,
    retryAttempts: route.retry?.attempts?.toString() ?? '3',
    retryOn: route.retry?.on?.join(',') ?? DEFAULT_RETRY_CODES,
    retryMethods: route.retry?.methods ?? DEFAULT_RETRY_METHODS,
    corsEnabled: !!route.cors,
    corsOrigins: route.cors?.origins?.join('\n') ?? '',
    corsMethods: route.cors?.methods?.join(',') ?? '',
    corsHeaders: route.cors?.headers?.join(',') ?? '',
    corsCredentials: route.cors?.credentials ?? false,
    corsMaxAge: route.cors?.maxAge?.toString() ?? '',
    ipEnabled: !!route.ipRestriction,
    ipAllow: route.ipRestriction?.allow?.join('\n') ?? '',
    ipDeny: route.ipRestriction?.deny?.join('\n') ?? '',
  };
}

function formToDto(form: FormState): CreateRouteDto {
  const dto: CreateRouteDto = {
    method: form.method,
    pathPattern: form.pathPattern,
    serviceId: form.serviceId,
    authRequired: form.authRequired,
    enabled: form.enabled,
  };
  if (form.rateLimitOverride) dto.rateLimitOverride = Number(form.rateLimitOverride);
  if (form.maxBodyBytes) dto.maxBodyBytes = Number(form.maxBodyBytes);
  if (form.retryEnabled) {
    dto.retry = {
      attempts: Math.max(1, parseInt(form.retryAttempts, 10) || 3),
      on: form.retryOn.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n)),
      methods: form.retryMethods,
    };
  }
  if (form.corsEnabled) {
    dto.cors = {
      origins: form.corsOrigins.split('\n').map((s) => s.trim()).filter(Boolean),
      ...(form.corsMethods ? { methods: form.corsMethods.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(form.corsHeaders ? { headers: form.corsHeaders.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      credentials: form.corsCredentials,
      ...(form.corsMaxAge ? { maxAge: Number(form.corsMaxAge) } : {}),
    };
  }
  if (form.ipEnabled) {
    dto.ipRestriction = {
      ...(form.ipAllow ? { allow: form.ipAllow.split('\n').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(form.ipDeny ? { deny: form.ipDeny.split('\n').map((s) => s.trim()).filter(Boolean) } : {}),
    };
  }
  return dto;
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${value ? 'bg-blue-600' : 'bg-gray-200'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${value ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

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
    setForm(routeToForm(route));
    setPanelOpen(true);
  }

  function setF(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function toggleRetryMethod(method: string) {
    setForm((f) => ({
      ...f,
      retryMethods: f.retryMethods.includes(method)
        ? f.retryMethods.filter((m) => m !== method)
        : [...f.retryMethods, method],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId) return;
    setSaving(true);
    try {
      const dto = formToDto(form);
      if (editId) {
        await updateRoute(tenantId, editId, dto);
      } else {
        await createRoute(tenantId, dto);
      }
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
      await deleteRoute(tenantId, deleteTarget);
      setDeleteTarget(null);
      await mutate();
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
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Method</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Path Pattern</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Service</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Auth</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Features</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {!routes ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">Loading…</td>
              </tr>
            ) : routes.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">No routes configured</td>
              </tr>
            ) : (
              routes.map((route) => (
                <tr key={route.id} className={`border-b border-gray-100 last:border-0 ${!route.enabled ? 'opacity-50' : ''}`}>
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
                    {serviceMap[route.serviceId] ?? <span className="text-gray-400">{route.serviceId}</span>}
                  </td>
                  <td className="px-4 py-3">
                    {route.authRequired ? (
                      <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">Yes</span>
                    ) : (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">No</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {route.enabled ? (
                      <span className="rounded bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">Active</span>
                    ) : (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-400">Disabled</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {route.cors && (
                        <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-600">CORS</span>
                      )}
                      {route.ipRestriction && (
                        <span className="rounded bg-orange-50 px-1.5 py-0.5 text-xs font-medium text-orange-600">IP</span>
                      )}
                      {route.retry && (
                        <span className="rounded bg-purple-50 px-1.5 py-0.5 text-xs font-medium text-purple-600">Retry</span>
                      )}
                      {route.maxBodyBytes && (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-500">
                          {route.maxBodyBytes >= 1048576
                            ? `${(route.maxBodyBytes / 1048576).toFixed(0)}MB`
                            : `${(route.maxBodyBytes / 1024).toFixed(0)}KB`} limit
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {deleteTarget === route.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-600">Delete?</span>
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
          <div className="relative z-50 flex h-full w-[560px] flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">
                {editId ? 'Edit Route' : 'Add Route'}
              </h2>
              <button onClick={() => setPanelOpen(false)} className="rounded p-1 text-gray-400 hover:bg-gray-100">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-5 overflow-y-auto p-6">
              {/* Method */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">Method</label>
                <select
                  value={form.method}
                  onChange={(e) => setF({ method: e.target.value })}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>

              {/* Path Pattern */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">Path Pattern</label>
                <input
                  type="text"
                  required
                  placeholder="/api/users"
                  value={form.pathPattern}
                  onChange={(e) => setF({ pathPattern: e.target.value })}
                  className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-400">Prefix match — /api/users matches /api/users/123</p>
              </div>

              {/* Service */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">Service</label>
                <select
                  required
                  value={form.serviceId}
                  onChange={(e) => setF({ serviceId: e.target.value })}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Select a service…</option>
                  {(services ?? []).map((s: Service) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>

              {/* Auth Required + Enabled */}
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2.5">
                  <span className="text-sm font-medium text-gray-700">Auth Required</span>
                  <Toggle value={form.authRequired} onChange={(v) => setF({ authRequired: v })} />
                </div>
                <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2.5">
                  <span className="text-sm font-medium text-gray-700">Enabled</span>
                  <Toggle value={form.enabled} onChange={(v) => setF({ enabled: v })} />
                </div>
              </div>

              {/* Rate Limit Override */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">
                  Rate Limit Override <span className="font-normal text-gray-400">(req/min, optional)</span>
                </label>
                <input
                  type="number"
                  min={1}
                  placeholder="Leave blank to use global limit"
                  value={form.rateLimitOverride}
                  onChange={(e) => setF({ rateLimitOverride: e.target.value })}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {/* Advanced section toggle */}
              <button
                type="button"
                onClick={() => setF({ showAdvanced: !form.showAdvanced })}
                className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                {form.showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Advanced options
                {(form.retryEnabled || form.corsEnabled || form.ipEnabled || form.maxBodyBytes) && (
                  <span className="ml-auto flex gap-1">
                    {form.retryEnabled && <span className="rounded bg-purple-50 px-1.5 py-0.5 text-xs text-purple-600">Retry</span>}
                    {form.corsEnabled && <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-600">CORS</span>}
                    {form.ipEnabled && <span className="rounded bg-orange-50 px-1.5 py-0.5 text-xs text-orange-600">IP</span>}
                    {form.maxBodyBytes && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">Size</span>}
                  </span>
                )}
              </button>

              {form.showAdvanced && (
                <div className="flex flex-col gap-5 rounded-md border border-gray-200 p-4">
                  {/* Max Body Size */}
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-gray-700">
                      Max Body Size <span className="font-normal text-gray-400">(bytes, optional)</span>
                    </label>
                    <input
                      type="number"
                      min={1}
                      placeholder="e.g. 1048576 = 1 MB"
                      value={form.maxBodyBytes}
                      onChange={(e) => setF({ maxBodyBytes: e.target.value })}
                      className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                  </div>

                  <hr className="border-gray-100" />

                  {/* Retry Policy */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-700">Retry Policy</span>
                        <p className="text-xs text-gray-400">Automatically retry on transient upstream errors</p>
                      </div>
                      <Toggle value={form.retryEnabled} onChange={(v) => setF({ retryEnabled: v })} />
                    </div>

                    {form.retryEnabled && (
                      <div className="flex flex-col gap-3 pl-1">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="flex flex-col gap-1">
                            <label className="text-xs font-medium text-gray-600">Max Attempts</label>
                            <input
                              type="number"
                              min={1}
                              max={10}
                              value={form.retryAttempts}
                              onChange={(e) => setF({ retryAttempts: e.target.value })}
                              className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-xs font-medium text-gray-600">Retry on Status Codes</label>
                            <input
                              type="text"
                              placeholder="502,503,504"
                              value={form.retryOn}
                              onChange={(e) => setF({ retryOn: e.target.value })}
                              className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs font-medium text-gray-600">
                            Retry Methods{' '}
                            <span className="font-normal text-gray-400">(POST/PUT/DELETE require idempotent downstream)</span>
                          </label>
                          <div className="flex flex-wrap gap-2">
                            {RETRY_METHODS.map((m) => (
                              <label key={m} className="flex cursor-pointer items-center gap-1.5">
                                <input
                                  type="checkbox"
                                  checked={form.retryMethods.includes(m)}
                                  onChange={() => toggleRetryMethod(m)}
                                  className="rounded border-gray-300 text-blue-600"
                                />
                                <span className="text-xs text-gray-700">{m}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <hr className="border-gray-100" />

                  {/* CORS */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-700">CORS</span>
                        <p className="text-xs text-gray-400">Allow cross-origin requests from browsers</p>
                      </div>
                      <Toggle value={form.corsEnabled} onChange={(v) => setF({ corsEnabled: v })} />
                    </div>

                    {form.corsEnabled && (
                      <div className="flex flex-col gap-3 pl-1">
                        <div className="flex flex-col gap-1">
                          <label className="text-xs font-medium text-gray-600">
                            Allowed Origins <span className="font-normal text-gray-400">(one per line, or * for all)</span>
                          </label>
                          <textarea
                            rows={3}
                            required={form.corsEnabled}
                            placeholder={'https://app.example.com\nhttps://admin.example.com'}
                            value={form.corsOrigins}
                            onChange={(e) => setF({ corsOrigins: e.target.value })}
                            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="flex flex-col gap-1">
                            <label className="text-xs font-medium text-gray-600">
                              Allowed Methods <span className="font-normal text-gray-400">(comma-sep, optional)</span>
                            </label>
                            <input
                              type="text"
                              placeholder="GET,POST,PUT"
                              value={form.corsMethods}
                              onChange={(e) => setF({ corsMethods: e.target.value })}
                              className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-xs font-medium text-gray-600">
                              Allowed Headers <span className="font-normal text-gray-400">(optional)</span>
                            </label>
                            <input
                              type="text"
                              placeholder="Authorization,X-Api-Key"
                              value={form.corsHeaders}
                              onChange={(e) => setF({ corsHeaders: e.target.value })}
                              className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2">
                            <span className="text-xs font-medium text-gray-600">Allow Credentials</span>
                            <Toggle value={form.corsCredentials} onChange={(v) => setF({ corsCredentials: v })} />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-xs font-medium text-gray-600">
                              Preflight Cache <span className="font-normal text-gray-400">(seconds)</span>
                            </label>
                            <input
                              type="number"
                              min={0}
                              placeholder="86400"
                              value={form.corsMaxAge}
                              onChange={(e) => setF({ corsMaxAge: e.target.value })}
                              className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <hr className="border-gray-100" />

                  {/* IP Restriction */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-700">IP Restriction</span>
                        <p className="text-xs text-gray-400">Allow or deny IPs by CIDR range</p>
                      </div>
                      <Toggle value={form.ipEnabled} onChange={(v) => setF({ ipEnabled: v })} />
                    </div>

                    {form.ipEnabled && (
                      <div className="grid grid-cols-2 gap-3 pl-1">
                        <div className="flex flex-col gap-1">
                          <label className="text-xs font-medium text-gray-600">
                            Allow List <span className="font-normal text-gray-400">(one CIDR per line)</span>
                          </label>
                          <textarea
                            rows={3}
                            placeholder={'10.0.0.0/8\n192.168.1.0/24'}
                            value={form.ipAllow}
                            onChange={(e) => setF({ ipAllow: e.target.value })}
                            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-xs font-medium text-gray-600">
                            Deny List <span className="font-normal text-gray-400">(takes precedence)</span>
                          </label>
                          <textarea
                            rows={3}
                            placeholder={'203.0.113.0/24'}
                            value={form.ipDeny}
                            onChange={(e) => setF({ ipDeny: e.target.value })}
                            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

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
