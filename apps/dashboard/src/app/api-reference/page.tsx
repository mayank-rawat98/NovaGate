import type { Metadata } from 'next';
import Link from 'next/link';
import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

export const metadata: Metadata = {
  title: 'API Reference',
  description:
    'NovaGate REST API reference. Authentication, routes, services, consumers, and analytics endpoints with full request and response examples.',
  keywords: [
    'api gateway api reference',
    'rest api docs',
    'novagate api',
    'routes api',
    'services api',
    'gateway management api',
  ],
  openGraph: {
    title: 'NovaGate API Reference',
    description:
      'Full REST API reference for managing routes, services, consumers, and analytics. Includes request/response examples for every endpoint.',
    url: 'https://novagate.dev/api-reference',
  },
  alternates: { canonical: 'https://novagate.dev/api-reference' },
};

const ENDPOINTS = [
  {
    group: 'Authentication',
    base: '/api/auth',
    routes: [
      {
        method: 'POST',
        path: '/register',
        desc: 'Create a new tenant account.',
        body: '{ name, email, password }',
        response: '{ token, tenantId, gatewayApiKey }',
      },
      {
        method: 'POST',
        path: '/login',
        desc: 'Authenticate with email and password.',
        body: '{ email, password }',
        response: '{ token, tenantId }',
      },
      {
        method: 'POST',
        path: '/forgot-password',
        desc: 'Send a password reset email. Always returns 200 to prevent user enumeration.',
        body: '{ email }',
        response: '{ message }',
      },
      {
        method: 'POST',
        path: '/reset-password',
        desc: 'Reset password using the token from the email link.',
        body: '{ token, password }',
        response: '{ message }',
      },
    ],
  },
  {
    group: 'Routes',
    base: '/api/tenants/:tenantId',
    routes: [
      {
        method: 'GET',
        path: '/routes',
        desc: 'List all non-deleted routes for the tenant.',
        body: '—',
        response: 'RouteEntity[]',
      },
      {
        method: 'POST',
        path: '/routes',
        desc: 'Create a new route.',
        body: '{ method, pathPattern, serviceId, authRequired, rateLimitOverride?, enabled? }',
        response: 'RouteEntity',
      },
      {
        method: 'PUT',
        path: '/routes/:id',
        desc: 'Update an existing route. Accepts partial updates.',
        body: 'Partial<RouteEntity>',
        response: 'RouteEntity',
      },
      {
        method: 'DELETE',
        path: '/routes/:id',
        desc: 'Soft-delete a route (sets deletedAt). Config is updated immediately.',
        body: '—',
        response: '204 No Content',
      },
    ],
  },
  {
    group: 'Services',
    base: '/api/tenants/:tenantId',
    routes: [
      {
        method: 'GET',
        path: '/services',
        desc: 'List all non-deleted services.',
        body: '—',
        response: 'ServiceEntity[]',
      },
      {
        method: 'POST',
        path: '/services',
        desc: 'Create a new downstream service.',
        body: '{ name, targetUrl, healthCheckPath?, timeoutMs? }',
        response: 'ServiceEntity',
      },
      {
        method: 'PUT',
        path: '/services/:id',
        desc: 'Update a service. Accepts partial updates.',
        body: 'Partial<ServiceEntity>',
        response: 'ServiceEntity',
      },
      {
        method: 'DELETE',
        path: '/services/:id',
        desc: 'Soft-delete a service. All routes pointing to this service will fail until reassigned.',
        body: '—',
        response: '204 No Content',
      },
    ],
  },
  {
    group: 'Consumers',
    base: '/api/tenants/:tenantId',
    routes: [
      {
        method: 'GET',
        path: '/consumers',
        desc: 'List all active (non-revoked) consumers.',
        body: '—',
        response: 'ConsumerEntity[]',
      },
      {
        method: 'POST',
        path: '/consumers',
        desc: 'Create a consumer and generate an API key. Key is returned in plaintext once.',
        body: '{ name, rateLimitTier? }',
        response: '{ ...ConsumerEntity, apiKey: string }',
      },
      {
        method: 'DELETE',
        path: '/consumers/:id',
        desc: 'Revoke a consumer (sets revokedAt). Their API key stops working immediately.',
        body: '—',
        response: '204 No Content',
      },
    ],
  },
  {
    group: 'Analytics',
    base: '/api/tenants/:tenantId',
    routes: [
      {
        method: 'GET',
        path: '/logs',
        desc: 'Paginated request logs. 50 per page.',
        body: '—',
        response: 'RequestLog[]',
        query: '?from=ISO&to=ISO&path=&statusCode=&consumerId=&page=',
      },
      {
        method: 'GET',
        path: '/errors',
        desc: 'Paginated error events.',
        body: '—',
        response: 'ErrorEvent[]',
        query: '?resolved=false&page=',
      },
      {
        method: 'PATCH',
        path: '/errors/:id',
        desc: 'Mark an error event as resolved.',
        body: '{ resolved: true }',
        response: '204 No Content',
      },
      {
        method: 'GET',
        path: '/health',
        desc: 'Latest health snapshot per service (DISTINCT ON serviceId).',
        body: '—',
        response: 'HealthSnapshot[]',
      },
      {
        method: 'GET',
        path: '/metrics',
        desc: 'Aggregated metrics snapshots for a time period.',
        body: '—',
        response: 'MetricsSnapshot[]',
        query: '?period=1h|24h|7d',
      },
      {
        method: 'GET',
        path: '/gateway-status',
        desc: "Whether the tenant's gateway is currently connected to the control plane.",
        body: '—',
        response: '{ tenantId, online: boolean }',
      },
    ],
  },
];

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-blue-500/15 text-blue-400',
  POST: 'bg-green-500/15 text-green-400',
  PUT: 'bg-amber-500/15 text-amber-400',
  PATCH: 'bg-purple-500/15 text-purple-400',
  DELETE: 'bg-red-500/15 text-red-400',
};

export default function ApiReferencePage() {
  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-5xl mx-auto px-6 py-20">
        <div className="mb-14">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">
            API REFERENCE
          </p>
          <h1 className="text-4xl font-black tracking-tight mb-4">
            Admin API Reference
          </h1>
          <p className="text-white/40 text-base max-w-xl leading-relaxed">
            All endpoints require a valid JWT in the{' '}
            <code className="text-violet-300/70">
              Authorization: Bearer &lt;token&gt;
            </code>{' '}
            header except the auth endpoints.
          </p>
          <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.025] p-4 font-mono text-xs text-white/45">
            Base URL:{' '}
            <span className="text-violet-300/80">
              https://admin.novagate.dev
            </span>
            {'  '}(local dev:{' '}
            <span className="text-violet-300/80">http://localhost:3001</span>)
          </div>
        </div>

        <div className="space-y-14">
          {ENDPOINTS.map((group) => (
            <section key={group.group}>
              <div className="flex items-center gap-3 mb-5">
                <h2 className="text-xl font-bold text-white">{group.group}</h2>
                <code className="rounded-md bg-white/[0.05] px-2 py-0.5 text-xs text-white/35">
                  {group.base}
                </code>
              </div>
              <div className="space-y-4">
                {group.routes.map((route) => (
                  <div
                    key={route.path}
                    className="rounded-xl border border-white/[0.07] bg-white/[0.025] overflow-hidden"
                  >
                    <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.05]">
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-bold font-mono ${METHOD_COLORS[route.method] ?? 'bg-white/10 text-white/50'}`}
                      >
                        {route.method}
                      </span>
                      <code className="text-sm text-white/80">
                        {group.base}
                        {route.path}
                      </code>
                      {'query' in route && (
                        <code className="text-xs text-white/30">
                          {(route as { query?: string }).query}
                        </code>
                      )}
                    </div>
                    <div className="px-5 py-4">
                      <p className="text-sm text-white/50 mb-3">{route.desc}</p>
                      <div className="grid sm:grid-cols-2 gap-3 text-xs">
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-white/25 mb-1.5">
                            Request Body
                          </p>
                          <code className="text-white/40">{route.body}</code>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-white/25 mb-1.5">
                            Response
                          </p>
                          <code className="text-violet-300/60">
                            {route.response}
                          </code>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-14 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-6 text-center">
          <p className="text-sm text-white/45 mb-4">
            Looking for the getting-started guide instead?
          </p>
          <Link
            href="/docs"
            className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 transition-colors"
          >
            Read the Documentation →
          </Link>
        </div>
      </div>

      <MarketingFooter />
    </div>
  );
}
