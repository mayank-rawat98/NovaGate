import type {
  TenantEntity,
  RouteEntity,
  ServiceEntity,
  ConsumerEntity,
  RequestLog,
  ErrorEvent,
  HealthSnapshot,
  LogExportFilter,
  LogExportJob,
  LogExportList,
} from '@api-gateway/shared-types';
import { getToken, clearToken } from './auth';

export type {
  TenantEntity as Tenant,
  RouteEntity as Route,
  ServiceEntity as Service,
  ConsumerEntity as Consumer,
  RequestLog,
  ErrorEvent,
  HealthSnapshot,
};

export interface GatewayStatus {
  tenantId: string;
  online: boolean;
}

export interface MetricsSnapshot {
  rps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorRate: number;
  timestamp: string;
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
}

export type LogParams = {
  from?: string;
  to?: string;
  path?: string;
  statusCode?: number;
  consumerId?: string;
  page?: number;
};

export type ErrorParams = {
  resolved?: boolean;
  page?: number;
};

export type Period = '1h' | '24h' | '7d';

export type CreateRouteDto = Pick<
  RouteEntity,
  'method' | 'pathPattern' | 'serviceId' | 'authRequired'
> & {
  rateLimitOverride?: number;
  enabled?: boolean;
  retry?: RouteEntity['retry'];
  plugins?: RouteEntity['plugins'];
};
export type UpdateRouteDto = Partial<CreateRouteDto>;
export type CreateServiceDto = Pick<ServiceEntity, 'name' | 'targets'> & {
  healthCheckPath?: string;
  healthCheckIntervalMs?: number;
  healthCheckProtocol?: 'http' | 'grpc';
  healthCheckService?: string;
  h2?: boolean;
  supportsWebSocket?: boolean;
  unhealthyFallback?: boolean;
  timeoutMs?: number;
};
export type UpdateServiceDto = Partial<CreateServiceDto>;

export type CreateConsumerDto = {
  name: string;
  rateLimitTier?: string;
  groups?: string[];
};
export type UpdateConsumerDto = { groups?: string[] };
export type CreateConsumerResult = ConsumerEntity & { apiKey: string };

// Same-origin requests use the Next.js admin API rewrite in each deployment.
// An explicit public origin remains available for installations that need it.
const BASE = (process.env.NEXT_PUBLIC_ADMIN_API_URL ?? '').replace(/\/$/, '');
function toQuery(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (!entries.length) return '';
  return (
    '?' +
    entries
      .map(
        ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      )
      .join('&')
  );
}

async function authorizedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers ?? {}),
  };

  const res = await fetch(`${BASE}/api${path}`, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let message = text;
    try {
      const error = JSON.parse(text) as { message?: unknown };
      if (typeof error.message === 'string') message = error.message;
      else if (
        Array.isArray(error.message) &&
        error.message.every((item) => typeof item === 'string')
      )
        message = error.message.join('. ');
      else message = `Request failed (HTTP ${res.status}). Please try again.`;
    } catch {
      /* Plain-text API errors remain readable. */
    }
    throw new Error(
      message || `Request failed (HTTP ${res.status}). Please try again.`,
    );
  }

  return res;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authorizedFetch(path, init);
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ─── Auth ───────────────────────────────────────────────────────────────────

export function login(
  email: string,
  password: string,
): Promise<{ token: string; tenantId: string }> {
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function register(
  name: string,
  email: string,
  password: string,
): Promise<{ message: string }> {
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password }),
  });
}

export function verifyEmail(
  token: string,
): Promise<{ token: string; tenantId: string; gatewayApiKey: string }> {
  return request('/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export function forgotPassword(email: string): Promise<{ message: string }> {
  return request('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(
  token: string,
  password: string,
): Promise<{ message: string }> {
  return request('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });
}

// ─── Tenant ─────────────────────────────────────────────────────────────────

export function getTenant(id: string): Promise<TenantEntity> {
  return request(`/tenants/${id}`);
}

export function rotateGatewayKey(
  tenantId: string,
): Promise<{ apiKey: string }> {
  return request(`/tenants/${tenantId}/rotate-key`, { method: 'POST' });
}

export function getGatewayStatus(tenantId: string): Promise<GatewayStatus> {
  return request(`/tenants/${tenantId}/gateway-status`);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export function getRoutes(tenantId: string): Promise<RouteEntity[]> {
  return request(`/tenants/${tenantId}/routes`);
}

export function createRoute(
  tenantId: string,
  dto: CreateRouteDto,
): Promise<RouteEntity> {
  return request(`/tenants/${tenantId}/routes`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export function updateRoute(
  tenantId: string,
  id: string,
  dto: UpdateRouteDto,
): Promise<RouteEntity> {
  return request(`/tenants/${tenantId}/routes/${id}`, {
    method: 'PUT',
    body: JSON.stringify(dto),
  });
}

export function deleteRoute(tenantId: string, id: string): Promise<void> {
  return request(`/tenants/${tenantId}/routes/${id}`, { method: 'DELETE' });
}

// ─── Services ────────────────────────────────────────────────────────────────

export function getServices(tenantId: string): Promise<ServiceEntity[]> {
  return request(`/tenants/${tenantId}/services`);
}

export function createService(
  tenantId: string,
  dto: CreateServiceDto,
): Promise<ServiceEntity> {
  return request(`/tenants/${tenantId}/services`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export function updateService(
  tenantId: string,
  id: string,
  dto: UpdateServiceDto,
): Promise<ServiceEntity> {
  return request(`/tenants/${tenantId}/services/${id}`, {
    method: 'PUT',
    body: JSON.stringify(dto),
  });
}

export function deleteService(tenantId: string, id: string): Promise<void> {
  return request(`/tenants/${tenantId}/services/${id}`, { method: 'DELETE' });
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export function getLogs(
  tenantId: string,
  params: LogParams = {},
): Promise<PaginatedResult<RequestLog>> {
  const q = toQuery(
    params as Record<string, string | number | boolean | undefined>,
  );
  return request<RequestLog[]>(`/tenants/${tenantId}/logs${q}`).then(
    (items) => ({
      items,
      page: params.page ?? 1,
    }),
  );
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export function getErrors(
  tenantId: string,
  params: ErrorParams = {},
): Promise<PaginatedResult<ErrorEvent>> {
  const q = toQuery(
    params as Record<string, string | number | boolean | undefined>,
  );
  return request<ErrorEvent[]>(`/tenants/${tenantId}/errors${q}`).then(
    (items) => ({
      items,
      page: params.page ?? 1,
    }),
  );
}

export function resolveError(tenantId: string, errorId: string): Promise<void> {
  return request(`/tenants/${tenantId}/errors/${errorId}`, {
    method: 'PATCH',
    body: JSON.stringify({ resolved: true }),
  });
}

// ─── Consumers ───────────────────────────────────────────────────────────────

export function getConsumers(tenantId: string): Promise<ConsumerEntity[]> {
  return request(`/tenants/${tenantId}/consumers`);
}

export function createConsumer(
  tenantId: string,
  dto: CreateConsumerDto,
): Promise<CreateConsumerResult> {
  return request(`/tenants/${tenantId}/consumers`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export function updateConsumer(
  tenantId: string,
  id: string,
  dto: UpdateConsumerDto,
): Promise<ConsumerEntity> {
  return request(`/tenants/${tenantId}/consumers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(dto),
  });
}

export function deleteConsumer(tenantId: string, id: string): Promise<void> {
  return request(`/tenants/${tenantId}/consumers/${id}`, { method: 'DELETE' });
}

export function setCaCert(
  tenantId: string,
  caCertPem: string | null,
): Promise<{ success: boolean }> {
  return request(`/tenants/${tenantId}/ca-cert`, {
    method: 'PUT',
    body: JSON.stringify({ caCertPem }),
  });
}

// ─── Health ──────────────────────────────────────────────────────────────────

export function getHealth(tenantId: string): Promise<HealthSnapshot[]> {
  return request(`/tenants/${tenantId}/health`);
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export function getMetrics(
  tenantId: string,
  period: Period = '24h',
): Promise<MetricsSnapshot[]> {
  return request(`/tenants/${tenantId}/metrics?period=${period}`);
}

export function getLogExports(tenantId: string): Promise<LogExportList> {
  return request(`/tenants/${tenantId}/log-exports`);
}
export function createLogExport(
  tenantId: string,
  filter: LogExportFilter,
): Promise<LogExportJob> {
  return request(`/tenants/${tenantId}/log-exports`, {
    method: 'POST',
    body: JSON.stringify(filter),
  });
}
export async function downloadLogExport(
  tenantId: string,
  id: string,
): Promise<void> {
  const response = await authorizedFetch(
    `/tenants/${tenantId}/log-exports/${id}/download`,
  );
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `novagate-logs-${id}.ndjson`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Allow the browser to begin the download before releasing the blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type {
  OidcPluginConfig,
  OAuth2PluginConfig,
} from '@api-gateway/shared-types';

export type { MtlsPluginConfig } from '@api-gateway/shared-types';

export type { HmacPluginConfig } from '@api-gateway/shared-types';
