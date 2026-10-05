'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { WorkspaceDialog } from '../../../components/workspace-dialog';
import { DataLoadNotice } from '../../../components/data-load-notice';
import { Trash2, Plus, X, Pencil, GripVertical } from 'lucide-react';
import {
  getServices,
  getHealth,
  createService,
  updateService,
  deleteService,
} from '../../../lib/api-client';
import { useTenantId } from '../../../lib/auth';
import type {
  Service,
  CreateServiceDto,
  UpdateServiceDto,
  HealthSnapshot,
} from '../../../lib/api-client';

const HEALTH_STYLES: Record<string, string> = {
  healthy: 'bg-green-100 text-green-700',
  unhealthy: 'bg-red-100 text-red-700',
  degraded: 'bg-amber-100 text-amber-800',
  unknown: 'bg-gray-100 text-gray-500',
};

interface TargetRow {
  url: string;
  weight: string;
}

interface FormState {
  name: string;
  loadBalancing: 'weighted-round-robin' | 'least-connections';
  targets: TargetRow[];
  healthCheckPath: string;
  timeoutMs: string;
  healthCheckIntervalMs: string;
  healthCheckProtocol: 'http' | 'grpc';
  healthCheckService: string;
  h2: boolean;
  supportsWebSocket: boolean;
  unhealthyFallback: boolean;
}

const EMPTY_TARGET: TargetRow = { url: '', weight: '1' };

const EMPTY_FORM: FormState = {
  name: '',
  loadBalancing: 'weighted-round-robin',
  targets: [{ url: '', weight: '1' }],
  healthCheckPath: '/health',
  timeoutMs: '10000',
  healthCheckIntervalMs: '10000',
  healthCheckProtocol: 'http',
  healthCheckService: '',
  h2: false,
  supportsWebSocket: false,
  unhealthyFallback: false,
};

function formToDto(form: FormState): CreateServiceDto {
  return {
    name: form.name,
    loadBalancing: form.loadBalancing,
    healthCheckIntervalMs: Number(form.healthCheckIntervalMs),
    healthCheckProtocol: form.healthCheckProtocol,
    healthCheckService:
      form.healthCheckProtocol === 'grpc' ? form.healthCheckService.trim() : '',
    h2: form.h2,
    supportsWebSocket: form.supportsWebSocket,
    unhealthyFallback: form.unhealthyFallback,
    targets: form.targets
      .filter((t) => t.url.trim())
      .map((t) => {
        const parsed = parseInt(t.weight, 10);
        const weight = Number.isFinite(parsed) ? parsed : 1;
        const clamped = Math.min(100, Math.max(1, weight));
        return { url: t.url.trim(), weight: clamped };
      }),
    healthCheckPath: form.healthCheckPath || '/health',
    timeoutMs: form.timeoutMs ? Number(form.timeoutMs) : undefined,
  };
}

export default function ServicesPage() {
  const tenantId = useTenantId() ?? '';

  const {
    data: services,
    error: loadError,
    mutate,
  } = useSWR(
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
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setPanelOpen(true);
  }

  function openEdit(service: Service) {
    setEditId(service.id);
    setForm({
      name: service.name,
      targets: service.targets.map((t) => ({
        url: t.url,
        weight: String(t.weight),
      })),
      healthCheckPath: service.healthCheckPath,
      timeoutMs: String(service.timeoutMs),
      healthCheckIntervalMs: String(service.healthCheckIntervalMs ?? 10000),
      loadBalancing: service.loadBalancing ?? 'weighted-round-robin',
      healthCheckProtocol: service.healthCheckProtocol ?? 'http',
      healthCheckService: service.healthCheckService ?? '',
      h2: service.h2 ?? false,
      supportsWebSocket: service.supportsWebSocket ?? false,
      unhealthyFallback: service.unhealthyFallback ?? false,
    });
    setFormError(null);
    setPanelOpen(true);
  }

  function addTarget() {
    setForm((f) => ({ ...f, targets: [...f.targets, { ...EMPTY_TARGET }] }));
    setFormError(null);
  }

  function removeTarget(i: number) {
    setForm((f) => ({
      ...f,
      targets: f.targets.filter((_, idx) => idx !== i),
    }));
    setFormError(null);
  }

  function updateTarget(i: number, field: keyof TargetRow, value: string) {
    setForm((f) => {
      const next = [...f.targets];
      next[i] = { ...next[i], [field]: value };
      return { ...f, targets: next };
    });
    setFormError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId) return;
    setSaving(true);
    try {
      setFormError(null);
      const dto = formToDto(form);
      if (dto.targets.length === 0) {
        setFormError('Add at least one target URL before saving.');
        return;
      }
      if (editId) {
        await updateService(tenantId, editId, dto as UpdateServiceDto);
      } else {
        await createService(tenantId, dto);
      }
      setPanelOpen(false);
      await mutate();
    } catch {
      setFormError('Service could not be saved. Please try again.');
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
    } catch {
      toast.error('Service could not be deleted. Please try again.');
    } finally {
      setDeleting(false);
    }
  }

  const healthMap = Object.fromEntries(
    (healthSnapshots ?? []).map((h: HealthSnapshot) => [h.serviceId, h]),
  );

  function formatCheckedAt(ts: string): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  return (
    <div className="p-4 sm:p-8">
      {loadError && (
        <DataLoadNotice label="Services" onRetry={() => mutate()} />
      )}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">Services</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          Add Service
        </button>
      </div>

      <div
        tabIndex={0}
        role="region"
        aria-label="Services table"
        className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Name
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Targets
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Health Check
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
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-gray-400"
                >
                  {loadError ? 'Data unavailable' : 'Loading…'}
                </td>
              </tr>
            ) : services.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-gray-400"
                >
                  No services configured
                </td>
              </tr>
            ) : (
              services.map((service: Service) => {
                const health: HealthSnapshot | undefined =
                  healthMap[service.id];
                const status = health?.status ?? 'unknown';
                const primaryTarget = service.targets[0];
                const extraCount = service.targets.length - 1;
                return (
                  <tr
                    key={service.id}
                    className="border-b border-gray-100 last:border-0"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {service.name}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono text-xs text-gray-700">
                          {primaryTarget?.url ?? '—'}
                        </span>
                        {extraCount > 0 && (
                          <span className="text-xs text-gray-400">
                            +{extraCount} more target{extraCount > 1 ? 's' : ''}
                          </span>
                        )}
                        {service.targets.length > 1 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {service.targets.map((t, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600"
                              >
                                <span className="text-gray-400">
                                  w{t.weight}
                                </span>
                                {t.url}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                      {service.healthCheckProtocol === 'grpc'
                        ? `gRPC: ${service.healthCheckService || 'overall server'}`
                        : service.healthCheckPath}
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
                      {health ? (
                        formatCheckedAt(health.checkedAt)
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {health?.latencyMs != null ? (
                        `${health.latencyMs}ms`
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {deleteTarget === service.id ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-600">
                              Delete?
                            </span>
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
                              onClick={() => openEdit(service)}
                              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                              title="Edit service"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => setDeleteTarget(service.id)}
                              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                              title="Delete service"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
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
        <WorkspaceDialog
          label="Services form"
          onClose={() => setPanelOpen(false)}
        >
          <div className="relative z-50 flex h-full w-full max-w-[480px] flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">
                {editId ? 'Edit Service' : 'Add Service'}
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
              onSubmit={handleSubmit}
              className="flex flex-1 flex-col gap-5 overflow-y-auto p-6"
            >
              {/* Name */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="services-field-1"
                  className="text-sm font-medium text-gray-700"
                >
                  Name
                </label>
                <input
                  id="services-field-1"
                  type="text"
                  required
                  placeholder="user-service"
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {/* Targets */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="services-target-0"
                    className="text-sm font-medium text-gray-700"
                  >
                    Targets
                    <span className="ml-1 font-normal text-gray-400 text-xs">
                      (URL + weight for load balancing)
                    </span>
                  </label>
                </div>

                <div className="flex flex-col gap-2">
                  {form.targets.map((target, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <GripVertical className="h-4 w-4 flex-shrink-0 text-gray-300" />
                      <input
                        id={`services-target-${i}`}
                        type="url"
                        aria-label={`Target ${i + 1} URL`}
                        required
                        placeholder="http://service:4000"
                        value={target.url}
                        onChange={(e) => updateTarget(i, 'url', e.target.value)}
                        className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-400">w</span>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={target.weight}
                          onChange={(e) =>
                            updateTarget(i, 'weight', e.target.value)
                          }
                          className="w-14 rounded-md border border-gray-300 px-2 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                          aria-label={`Target ${i + 1} weight`}
                          title="Weight (1–100)"
                        />
                      </div>
                      {form.targets.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Remove target ${i + 1}`}
                          onClick={() => removeTarget(i)}
                          className="flex-shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-500"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={addTarget}
                  className="flex items-center gap-1 self-start rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add target
                </button>

                {formError && (
                  <p role="alert" className="text-xs text-red-700">
                    {formError}
                  </p>
                )}

                {form.targets.length > 1 && (
                  <p className="text-xs text-gray-400">
                    Weight is relative — equal weights = even distribution.
                    Higher weight = more traffic.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
                <label
                  htmlFor="service-load-balancing"
                  className="text-sm font-medium text-gray-800"
                >
                  Load balancing
                </label>
                <select
                  id="service-load-balancing"
                  value={form.loadBalancing}
                  onChange={(event) =>
                    setForm((value) => ({
                      ...value,
                      loadBalancing: event.target
                        .value as FormState['loadBalancing'],
                    }))
                  }
                  className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm"
                  aria-describedby="service-load-balancing-help"
                >
                  <option value="weighted-round-robin">
                    Weighted round robin
                  </option>
                  <option value="least-connections">Least connections</option>
                </select>
                <p
                  id="service-load-balancing-help"
                  className="text-xs leading-relaxed text-gray-600"
                >
                  {form.loadBalancing === 'least-connections'
                    ? 'Send new work to the least busy healthy target, adjusted by weight. Useful for slow requests, gRPC streams and WebSocket tunnels. Counts are local to each gateway.'
                    : 'Rotate healthy targets according to their relative weights. A predictable default for requests with similar duration.'}
                </p>
              </div>

              <fieldset className="flex flex-col gap-3 rounded-lg border border-gray-200 p-3">
                <legend className="px-1 text-sm font-medium text-gray-700">
                  Upstream protocols
                </legend>
                <label className="flex items-start gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={form.h2}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, h2: e.target.checked }))
                    }
                  />
                  <span>
                    Use HTTP/2 for upstream connections
                    <span className="block text-xs text-gray-500">
                      Native gRPC calls use HTTP/2 through the gateway’s
                      separate gRPC endpoint. Choose gRPC health checks below
                      for native gRPC servers.
                    </span>
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    aria-describedby="services-websocket-help"
                    checked={form.supportsWebSocket}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        supportsWebSocket: e.target.checked,
                      }))
                    }
                  />
                  Allow WebSocket upgrades
                </label>
                <p
                  id="services-websocket-help"
                  className="text-xs text-gray-500"
                >
                  Add a GET route for your WebSocket endpoint. Authentication
                  and connection limits apply before connecting. Basic Auth,
                  OIDC, OAuth introspection, ACL and IP rules support upgrades;
                  use a separate route for plugins that inspect HTTP bodies.
                  Prefer credentials in headers; query tokens need operator
                  opt-in.
                </p>
              </fieldset>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="services-health-protocol"
                  className="text-sm font-medium text-gray-700"
                >
                  Health check protocol
                </label>
                <select
                  id="services-health-protocol"
                  value={form.healthCheckProtocol}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      healthCheckProtocol: e.target.value as 'http' | 'grpc',
                    }))
                  }
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="http">HTTP endpoint</option>
                  <option value="grpc">Native gRPC health service</option>
                </select>
              </div>
              {form.healthCheckProtocol === 'grpc' && (
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="services-grpc-health-service"
                    className="text-sm font-medium text-gray-700"
                  >
                    gRPC health service name
                  </label>
                  <input
                    id="services-grpc-health-service"
                    value={form.healthCheckService}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        healthCheckService: e.target.value,
                      }))
                    }
                    placeholder="Leave empty for overall server health"
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                  <p className="text-xs text-gray-500">
                    Calls the standard health Check RPC. Only a successful
                    SERVING response counts as healthy. Your upstream must
                    implement grpc.health.v1.Health.
                  </p>
                </div>
              )}

              {/* Health Check Path */}
              {form.healthCheckProtocol === 'http' && (
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="services-health-path"
                    className="text-sm font-medium text-gray-700"
                  >
                    Health Check Path
                  </label>
                  <input
                    type="text"
                    id="services-health-path"
                    placeholder="/health"
                    value={form.healthCheckPath}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        healthCheckPath: e.target.value,
                      }))
                    }
                    className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-400">
                    Only successful (2xx) responses count as healthy. Failure
                    and recovery thresholds are controlled by the gateway
                    operator.
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="services-health-interval"
                  className="text-sm font-medium text-gray-700"
                >
                  Health check interval (ms)
                </label>
                <input
                  id="services-health-interval"
                  type="number"
                  required
                  min={1000}
                  max={60000}
                  value={form.healthCheckIntervalMs}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      healthCheckIntervalMs: e.target.value,
                    }))
                  }
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
                <p className="text-xs text-gray-500">
                  Choose 1–60 seconds. Shorter intervals detect failures sooner
                  and send more probe requests.
                </p>
              </div>
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={form.unhealthyFallback}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      unhealthyFallback: e.target.checked,
                    }))
                  }
                />
                <span>
                  Try failed targets when all targets are unhealthy
                  <span className="mt-1 block text-xs text-gray-500">
                    Disabled by default: requests receive unavailable until a
                    target recovers. Enable only if continuing to attempt failed
                    upstreams is appropriate for your service.
                  </span>
                </span>
              </label>

              {/* Timeout */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="services-field-3"
                  className="text-sm font-medium text-gray-700"
                >
                  Timeout{' '}
                  <span className="font-normal text-gray-400">(ms)</span>
                </label>
                <input
                  id="services-field-3"
                  type="number"
                  min={100}
                  max={3600000}
                  required
                  placeholder="10000"
                  value={form.timeoutMs}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, timeoutMs: e.target.value }))
                  }
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
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
                  disabled={saving}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : editId ? 'Save Changes' : 'Add Service'}
                </button>
              </div>
            </form>
          </div>
        </WorkspaceDialog>
      )}
    </div>
  );
}
