import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

const SECTIONS = [
  {
    title: 'Tenant Data Isolation',
    icon: '🔒',
    items: [
      'Every tenant gets a dedicated PostgreSQL schema (tenant_<uuid>). There are no shared tables between tenants — a query bug in one tenant\'s context cannot expose another tenant\'s data.',
      'The public schema stores only global metadata: tenants, api_keys, plans, and pending_config_updates. All request logs, routes, services, and consumers live in per-tenant schemas.',
      'Tenant schemas are provisioned at registration time with fixed table structures. No schema mixing is possible at the ORM level.',
    ],
  },
  {
    title: 'Credential Handling',
    icon: '🔑',
    items: [
      'Platform passwords are hashed with bcrypt (cost factor 10) before storage. Plaintext passwords are never written to disk, logs, or the database.',
      'Gateway API keys are generated as gw_<tenantId>_<random32hex>. Only the SHA-256 hash is stored. The plaintext key is shown exactly once at registration and is not recoverable.',
      'Platform JWTs are signed with PLATFORM_JWT_SECRET (HS256, 7-day expiry). Gateway-facing JWTs use a separate JWT_SECRET (minimum 32 characters enforced at startup).',
      'Password reset tokens are 32 random bytes (hex), stored hashed, and expire after 1 hour. Expired tokens are cleared on use.',
    ],
  },
  {
    title: 'Traffic Security',
    icon: '🛡️',
    items: [
      'Live traffic never reaches NovaGate servers. The gateway node runs entirely on your infrastructure. We process zero bytes of your upstream or downstream payloads.',
      'The WebSocket connection from your gateway to our control plane is TLS-encrypted. The gateway authenticates using its API key on every connection.',
      'JWT validation at the gateway uses the secret you configure. We never have access to your JWT signing secret — it lives only in your gateway\'s environment.',
      'The X-Request-ID header is generated or forwarded for every request, enabling full end-to-end tracing without any PII exposure.',
    ],
  },
  {
    title: 'No-PII Guarantee',
    icon: '🚫',
    items: [
      'Request logs store method, path, status code, latency, and request ID — never query parameters, request bodies, or response bodies.',
      'Prometheus metrics use normalized path labels (e.g. /users/:id from req.route.path) — never raw URLs that may contain user IDs or tokens.',
      'JWT strings, passwords, email addresses, and full IP addresses are never written to metric label values or log fields.',
      'Error events capture error codes and service IDs, not request payloads.',
    ],
  },
  {
    title: 'Infrastructure Security',
    icon: '⚙️',
    items: [
      'All Docker images run as a non-root user (node) with read-only filesystems where possible.',
      'The gateway performs Joi schema validation on all environment variables at startup. Missing required config causes a clean crash rather than a degraded running state.',
      'Redis keys use namespaced prefixes (cfg:default, rl:<clientKey>, gw:online:<tenantId>) to prevent key collisions and simplify access auditing.',
      'The admin API validates tenantId ownership on every request — a valid JWT cannot access another tenant\'s resources.',
    ],
  },
  {
    title: 'Responsible Disclosure',
    icon: '📬',
    items: [
      'If you discover a security vulnerability, please report it to security@novagate.dev.',
      'We aim to acknowledge reports within 48 hours and provide a resolution timeline within 7 days.',
      'Please do not publicly disclose vulnerabilities until we have had the opportunity to investigate and patch.',
      'We do not operate a formal bug bounty program at this time, but we appreciate and credit responsible disclosures.',
    ],
  },
];

export default function SecurityPage() {
  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-4xl mx-auto px-6 py-20">
        <div className="mb-16">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">SECURITY</p>
          <h1 className="text-4xl md:text-5xl font-black tracking-tight mb-4">
            Security is not
            <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent"> an afterthought.</span>
          </h1>
          <p className="text-white/40 text-base max-w-xl leading-relaxed">
            A detailed account of how NovaGate handles credentials, tenant isolation, traffic privacy, and data handling.
          </p>
        </div>

        <div className="space-y-10">
          {SECTIONS.map((sec) => (
            <div key={sec.title} className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-8">
              <h2 className="text-lg font-bold text-white mb-5 flex items-center gap-2.5">
                <span>{sec.icon}</span>
                {sec.title}
              </h2>
              <ul className="space-y-3">
                {sec.items.map((item, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-white/50 leading-relaxed">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400/60" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 rounded-2xl border border-violet-500/25 bg-violet-500/[0.06] p-8 text-center">
          <p className="text-sm text-white/60 mb-4">
            Have a security concern? Reach out directly.
          </p>
          <a
            href="mailto:security@novagate.dev"
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 transition-colors"
          >
            security@novagate.dev
          </a>
        </div>
      </div>

      <MarketingFooter />
    </div>
  );
}
