import { validateMetricPayload } from '@api-gateway/shared-types';
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
  TraceListResponse,
  TraceDetailResponse,
  MetricsSnapshot,
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
  MetricsSnapshot,
};

export interface GatewayStatus {
  tenantId: string;
  online: boolean;
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
  graphql?: RouteEntity['graphql'];
};
export type UpdateRouteDto = Partial<CreateRouteDto>;
export type CreateServiceDto = Pick<ServiceEntity, 'name' | 'targets'> & {
  loadBalancing?: ServiceEntity['loadBalancing'];
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
  signal?: AbortSignal,
): Promise<MetricsSnapshot[]> {
  return request(`/tenants/${tenantId}/metrics?period=${period}`, { signal });
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

export type { GraphqlPolicy } from '@api-gateway/shared-types';

export type TraceParams = {
  from?: string;
  to?: string;
  traceId?: string;
  requestId?: string;
  route?: string;
  errorsOnly?: boolean;
  cursor?: string;
};
export function getTraces(tenantId: string, params: TraceParams = {}) {
  return request<TraceListResponse>(
    `/tenants/${tenantId}/traces${toQuery(params)}`,
  );
}
export function getTrace(tenantId: string, traceId: string) {
  return request<TraceDetailResponse>(
    `/tenants/${tenantId}/traces/${encodeURIComponent(traceId)}`,
  );
}

export function validateMetricSnapshot(value: unknown): MetricsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid live metric sample');
  const snapshot = value as MetricsSnapshot;
  if (
    Object.keys(snapshot).some(
      (key) =>
        !['rps', 'p50Ms', 'p95Ms', 'p99Ms', 'errorRate', 'timestamp'].includes(
          key,
        ),
    ) ||
    typeof snapshot.timestamp !== 'string' ||
    snapshot.timestamp.length > 32 ||
    !Number.isFinite(Date.parse(snapshot.timestamp))
  )
    throw new Error('Invalid live metric sample');
  validateMetricPayload({
    rps: snapshot.rps,
    p50: snapshot.p50Ms,
    p95: snapshot.p95Ms,
    p99: snapshot.p99Ms,
    errorRate: snapshot.errorRate,
  });
  return snapshot;
}
export async function streamMetrics(
  tenantId: string,
  signal: AbortSignal,
  onSnapshot: (snapshot: MetricsSnapshot) => void,
  onReady: () => void,
): Promise<void> {
  const response = await authorizedFetch(
    `/tenants/${encodeURIComponent(tenantId)}/metrics/stream`,
    { signal, headers: { Accept: 'text/event-stream' }, cache: 'no-store' },
  );
  if (
    !response.headers.get('content-type')?.includes('text/event-stream') ||
    !response.body
  )
    throw new Error('Live metrics unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let activity = Date.now();
  // Cancel an abandoned transport even if its TCP connection never closes.
  const watchdog = setInterval(() => {
    if (Date.now() - activity > 45000)
      void reader.cancel().catch(() => undefined);
  }, 5000);
  try {
    onReady();
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Live metrics connection ended');
      activity = Date.now();
      if (value.byteLength > 65536)
        throw new Error('Live metrics frame too large');
      pending = (pending + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        '\n',
      );
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (frame.length > 4096)
          throw new Error('Live metrics frame too large');
        const lines = frame.split('\n');
        const event = lines
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (event === 'metrics')
          onSnapshot(validateMetricSnapshot(JSON.parse(data)));
      }
      if (pending.length > 4096)
        throw new Error('Live metrics frame too large');
    }
  } finally {
    clearInterval(watchdog);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
