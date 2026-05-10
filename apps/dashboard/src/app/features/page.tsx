import Link from 'next/link';
import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

const CATEGORIES = [
  {
    title: 'Routing & Proxying',
    items: [
      { name: 'Prefix path matching', desc: 'Route /api/v1/* to specific downstream services with exact-prefix matching to prevent path collisions.' },
      { name: 'Per-service timeout', desc: 'Configure request timeout per service (default 10s). Gateway returns 504 on breach without hanging connections.' },
      { name: 'X-Request-ID propagation', desc: 'Auto-generates a UUID per request if absent. Forwarded to downstream and included in all logs and error responses.' },
      { name: 'X-Forwarded-For forwarding', desc: 'Client IP chain is forwarded to downstream services for accurate IP attribution.' },
      { name: '502 / 504 normalization', desc: 'All downstream connection errors and timeouts are normalized to consistent JSON error bodies with error codes.' },
    ],
  },
  {
    title: 'Authentication',
    items: [
      { name: 'JWT Bearer validation', desc: 'Validates RS256 / HS256 tokens on every request. Extracts sub, userId, or id claims into req.user.' },
      { name: 'TOKEN_EXPIRED vs TOKEN_INVALID', desc: 'Distinct error codes so your frontend refresh interceptor can react correctly without false logouts.' },
      { name: 'Per-consumer API keys', desc: 'Issue named API keys to each consumer. Keys are SHA-256 hashed at rest. Revocation takes effect instantly.' },
      { name: 'Auth-required per route', desc: 'Mark individual routes as auth-required. Unauthenticated requests get 401 before reaching downstream.' },
      { name: 'Fail-open middleware', desc: 'Missing Authorization header is allowed through. The route\'s authRequired flag decides whether to block.' },
    ],
  },
  {
    title: 'Rate Limiting',
    items: [
      { name: 'Redis sliding window', desc: 'ZSET-based sliding window — no thundering-herd at window boundaries unlike fixed-window implementations.' },
      { name: 'Two-tier limits', desc: 'Separate limits for authenticated (500 req/min default) and unauthenticated (100 req/min default) clients.' },
      { name: 'Retry-After header', desc: 'On 429, the gateway returns Retry-After with the exact number of seconds until the window resets.' },
      { name: 'Redis fail-open', desc: 'If Redis is unreachable, the rate limiter allows the request and increments a Prometheus error counter — never blocks traffic.' },
      { name: 'Per-route override', desc: 'Individual routes can override the global rate limit (e.g., tighter limits on /auth/login).' },
    ],
  },
  {
    title: 'Observability',
    items: [
      { name: 'Prometheus metrics', desc: 'http_requests_total, http_request_duration_ms (histogram), rate_limit_hits_total, downstream_timeout_total — all labeled by method, path, and status.' },
      { name: 'Buffered request logs', desc: 'Every request generates a RequestLog entry. Flushed in batches of 100 or every 500ms to the control plane.' },
      { name: 'Error events', desc: 'Gateway errors (5xx, timeouts) create ErrorEvent records with request ID, error code, and service ID for structured debugging.' },
      { name: 'Health snapshots', desc: 'Gateway sends upstream service health data to the control plane on each health check cycle.' },
      { name: 'Dashboard log viewer', desc: 'Filter logs by time range, path, status group, or consumer. Expandable rows show full request context.' },
    ],
  },
  {
    title: 'Config & Resilience',
    items: [
      { name: 'Real-time WebSocket config push', desc: 'Config changes from the dashboard propagate to your gateway over an authenticated WebSocket within milliseconds.' },
      { name: 'Offline resilience', desc: 'If the control plane is unreachable, the gateway continues serving from in-memory config. Zero requests dropped on SaaS outages.' },
      { name: 'Redis warm-start cache', desc: 'On gateway restart, config is loaded from local Redis (key: cfg:default) before the WebSocket connection is established.' },
      { name: 'Exponential reconnect backoff', desc: 'WebSocket reconnects use 1s → 2s → 4s → 8s → 16s → 30s backoff. Permanent failures (4001, 4003, 4004) stop retrying.' },
      { name: 'Pending config queue', desc: 'Config changes made while the gateway is offline are queued server-side and delivered on reconnect.' },
    ],
  },
  {
    title: 'Multi-Tenancy',
    items: [
      { name: 'Schema-per-tenant isolation', desc: 'Each tenant gets a dedicated PostgreSQL schema (tenant_<uuid>). No shared tables, no cross-tenant data leakage.' },
      { name: 'Instant tenant provisioning', desc: 'New tenants are provisioned with a full schema, default tables, and an API key in one registration call.' },
      { name: 'Per-tenant config versioning', desc: 'Every config change increments gatewayConfigVersion. The gateway acknowledges each version, ensuring no silent update loss.' },
      { name: 'Per-tenant observability', desc: 'Logs, errors, metrics, and health data are scoped to the tenant. Tenants can only see their own traffic.' },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-5xl mx-auto px-6 py-20">
        <div className="mb-16">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">CAPABILITIES</p>
          <h1 className="text-4xl md:text-5xl font-black tracking-tight mb-4">
            Everything NovaGate
            <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent"> can do today.</span>
          </h1>
          <p className="text-white/40 text-base max-w-xl leading-relaxed">
            A complete feature reference for what is currently implemented and production-ready. No vaporware.
          </p>
          <div className="mt-6 flex gap-4">
            <Link href="/register" className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 transition-colors">
              Get Started Free
            </Link>
            <Link href="/docs" className="rounded-lg border border-white/10 px-5 py-2.5 text-sm font-semibold text-white/60 hover:text-white hover:bg-white/5 transition-colors">
              Read the Docs
            </Link>
          </div>
        </div>

        <div className="space-y-14">
          {CATEGORIES.map((cat) => (
            <div key={cat.title}>
              <h2 className="text-lg font-bold text-white mb-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-white/[0.06]" />
                {cat.title}
                <span className="h-px flex-1 bg-white/[0.06]" />
              </h2>
              <div className="grid md:grid-cols-2 gap-3">
                {cat.items.map((item) => (
                  <div key={item.name} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-5 hover:border-violet-500/25 transition-colors">
                    <div className="flex items-center gap-2 mb-2">
                      <svg className="h-3.5 w-3.5 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                      <p className="text-sm font-semibold text-white">{item.name}</p>
                    </div>
                    <p className="text-xs text-white/38 leading-relaxed pl-5">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <MarketingFooter />
    </div>
  );
}
