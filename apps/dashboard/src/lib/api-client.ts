import type {
  TenantEntity,
  RouteEntity,
  ServiceEntity,
  ConsumerEntity,
  RequestLog,
  ErrorEvent,
  HealthSnapshot,
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

export type CreateRouteDto = Pick<RouteEntity, 'method' | 'pathPattern' | 'serviceId' | 'authRequired'> & {
  rateLimitOverride?: number;
  enabled?: boolean;
};
export type UpdateRouteDto = Partial<CreateRouteDto>;
export type CreateServiceDto = Pick<ServiceEntity, 'name' | 'targetUrl'> & {
  healthCheckPath?: string;
  timeoutMs?: number;
};

export type CreateConsumerDto = { name: string; rateLimitTier?: string };
export type CreateConsumerResult = ConsumerEntity & { apiKey: string };

const BASE = process.env.NEXT_PUBLIC_ADMIN_API_URL || '';

function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    throw new Error(text || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ─── Auth ───────────────────────────────────────────────────────────────────

export function login(email: string, password: string): Promise<{ token: string; tenantId: string }> {
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function register(name: string, email: string, password: string): Promise<{ token: string; tenantId: string; gatewayApiKey: string }> {
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password }),
  });
}

export function forgotPassword(email: string): Promise<{ message: string }> {
  return request('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(token: string, password: string): Promise<{ message: string }> {
  return request('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });
}

// ─── Tenant ─────────────────────────────────────────────────────────────────

export function getTenant(id: string): Promise<TenantEntity> {
  return request(`/tenants/${id}`);
}

export function getGatewayStatus(tenantId: string): Promise<GatewayStatus> {
  return request(`/tenants/${tenantId}/gateway-status`);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export function getRoutes(tenantId: string): Promise<RouteEntity[]> {
  return request(`/tenants/${tenantId}/routes`);
}

export function createRoute(tenantId: string, dto: CreateRouteDto): Promise<RouteEntity> {
  return request(`/tenants/${tenantId}/routes`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export function updateRoute(tenantId: string, id: string, dto: UpdateRouteDto): Promise<RouteEntity> {
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

export function createService(tenantId: string, dto: CreateServiceDto): Promise<ServiceEntity> {
  return request(`/tenants/${tenantId}/services`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export function deleteService(tenantId: string, id: string): Promise<void> {
  return request(`/tenants/${tenantId}/services/${id}`, { method: 'DELETE' });
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export function getLogs(tenantId: string, params: LogParams = {}): Promise<PaginatedResult<RequestLog>> {
  const q = toQuery(params as Record<string, string | number | boolean | undefined>);
  return request<RequestLog[]>(`/tenants/${tenantId}/logs${q}`).then((items) => ({
    items,
    page: params.page ?? 1,
  }));
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export function getErrors(tenantId: string, params: ErrorParams = {}): Promise<PaginatedResult<ErrorEvent>> {
  const q = toQuery(params as Record<string, string | number | boolean | undefined>);
  return request<ErrorEvent[]>(`/tenants/${tenantId}/errors${q}`).then((items) => ({
    items,
    page: params.page ?? 1,
  }));
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

export function createConsumer(tenantId: string, dto: CreateConsumerDto): Promise<CreateConsumerResult> {
  return request(`/tenants/${tenantId}/consumers`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

export function deleteConsumer(tenantId: string, id: string): Promise<void> {
  return request(`/tenants/${tenantId}/consumers/${id}`, { method: 'DELETE' });
}

// ─── Health ──────────────────────────────────────────────────────────────────

export function getHealth(tenantId: string): Promise<HealthSnapshot[]> {
  return request(`/tenants/${tenantId}/health`);
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export function getMetrics(tenantId: string, period: Period = '24h'): Promise<MetricsSnapshot[]> {
  return request(`/tenants/${tenantId}/metrics?period=${period}`);
}
