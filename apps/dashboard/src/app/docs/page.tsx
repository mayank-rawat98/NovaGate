import type { Metadata } from 'next';
import Link from 'next/link';
import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

export const metadata: Metadata = {
  title: 'Documentation',
  description:
    'NovaGate getting-started guide. Register, deploy the gateway container, add services and routes, and have live request logs running in under 10 minutes.',
  keywords: [
    'api gateway documentation',
    'novagate docs',
    'api gateway setup',
    'gateway getting started',
    'api routing guide',
  ],
  openGraph: {
    title: 'NovaGate Documentation — Getting Started Guide',
    description:
      'From zero to a live API gateway in under 10 minutes. Register, deploy the container, add a service, add a route, and start routing traffic.',
    url: 'https://novagate.dev/docs',
  },
  alternates: { canonical: 'https://novagate.dev/docs' },
};

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-4xl mx-auto px-6 py-20">
        <div className="mb-14">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">
            DOCUMENTATION
          </p>
          <h1 className="text-4xl font-black tracking-tight mb-4">
            Getting Started with NovaGate
          </h1>
          <p className="text-white/40 text-base max-w-xl leading-relaxed">
            From zero to a live, rate-limited, JWT-authenticated API gateway in
            under 10 minutes.
          </p>
        </div>

        <div className="grid md:grid-cols-4 gap-8">
          {/* Sidebar */}
          <nav className="md:col-span-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-white/25 mb-3">
              On this page
            </p>
            <ul className="space-y-2 text-sm">
              {[
                'Overview',
                'Prerequisites',
                'Step 1: Register',
                'Step 2: Deploy',
                'Step 3: Add a Service',
                'Step 4: Add a Route',
                'Step 5: Test It',
                'Plugins',
                'Next Steps',
              ].map((item) => (
                <li key={item}>
                  <a
                    href={`#${item.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                    className="text-white/35 hover:text-violet-400 transition-colors"
                  >
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {/* Content */}
          <div className="md:col-span-3 space-y-12 text-sm">
            <section id="overview">
              <h2 className="text-xl font-bold mb-3">Overview</h2>
              <p className="text-white/50 leading-relaxed mb-4">
                NovaGate has two components: the{' '}
                <strong className="text-white">gateway node</strong> (a Docker
                container you run on your server) and the{' '}
                <strong className="text-white">control plane</strong> (a cloud
                service we operate). The gateway handles all your live traffic.
                The control plane manages config and collects observability
                data.
              </p>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4 font-mono text-xs text-white/40 leading-6">
                Your Client →{' '}
                <span className="text-violet-300">
                  NovaGate Node (your VPS)
                </span>{' '}
                → Your Microservices
                <br />
                {'                    '}↕ WSS (config + telemetry)
                <br />
                {'            '}
                <span className="text-indigo-300">
                  NovaGate Cloud (control plane)
                </span>
              </div>
            </section>

            <section id="prerequisites">
              <h2 className="text-xl font-bold mb-3">Prerequisites</h2>
              <ul className="space-y-2 text-white/50">
                {[
                  'A server or VPS with Docker installed (1 vCPU, 512 MB RAM minimum)',
                  'A Redis instance reachable from your server (Redis Cloud free tier works)',
                  'A NovaGate account (free)',
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400/60" />
                    {item}
                  </li>
                ))}
              </ul>
            </section>

            <section id="step-1:-register">
              <h2 className="text-xl font-bold mb-3">Step 1: Register</h2>
              <p className="text-white/50 leading-relaxed mb-4">
                Create a free account at{' '}
                <Link
                  href="/register"
                  className="text-violet-400 hover:text-violet-300 transition-colors"
                >
                  novagate.dev/register
                </Link>
                . After registration, you will be redirected to the setup flow
                where your{' '}
                <strong className="text-white">Gateway API Key</strong> is
                shown. Copy it — it is shown only once.
              </p>
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-xs text-amber-300/70">
                Your Gateway API Key looks like:{' '}
                <code className="text-amber-200/80">gw_abc123...xyz</code>.
                Store it in a secrets manager or environment variable
                immediately.
              </div>
            </section>

            <section id="step-2:-deploy">
              <h2 className="text-xl font-bold mb-3">
                Step 2: Deploy the Gateway
              </h2>
              <p className="text-white/50 leading-relaxed mb-4">
                Run the gateway container on your server:
              </p>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 font-mono text-xs text-violet-300/80 leading-7">
                docker run -d --name novagate --restart unless-stopped \<br />
                {'  '}-p 3000:3000 \<br />
                {'  '}-e REDIS_URL=redis://your-redis:6379 \<br />
                {'  '}-e JWT_SECRET=your-32-char-secret \<br />
                {'  '}-e CONTROL_PLANE_URL=wss://ws.novagate.dev/gateway-ws \
                <br />
                {'  '}-e GATEWAY_API_KEY=gw_your_key_here \<br />
                {'  '}ghcr.io/rawatshahab/novagate/api:latest
              </div>
              <p className="mt-3 text-white/40">Verify it started correctly:</p>
              <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 font-mono text-xs text-violet-300/80">
                curl http://localhost:3000/health
                <br />
                <span className="text-emerald-300/70">
                  {'# {"status":"ok","configSource":"live","configVersion":1}'}
                </span>
              </div>
            </section>

            <section id="step-3:-add-a-service">
              <h2 className="text-xl font-bold mb-3">Step 3: Add a Service</h2>
              <p className="text-white/50 leading-relaxed mb-4">
                In the dashboard, go to{' '}
                <strong className="text-white">Services → Add Service</strong>.
                A service represents one of your downstream applications.
              </p>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4 text-xs text-white/50 space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <div className="font-semibold text-white/35">Field</div>
                  <div className="col-span-2 font-semibold text-white/35">
                    Example
                  </div>
                </div>
                {[
                  ['Name', 'users-api'],
                  ['Target URL', 'http://internal-ip:8080'],
                  ['Health Check Path', '/health'],
                  ['Timeout (ms)', '5000'],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    className="grid grid-cols-3 gap-2 border-t border-white/[0.04] pt-2"
                  >
                    <div className="text-white/50">{k}</div>
                    <div className="col-span-2 font-mono text-violet-300/70">
                      {v}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section id="step-4:-add-a-route">
              <h2 className="text-xl font-bold mb-3">Step 4: Add a Route</h2>
              <p className="text-white/50 leading-relaxed mb-4">
                Go to <strong className="text-white">Routes → Add Route</strong>
                . A route maps an incoming path pattern to a service.
              </p>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4 text-xs text-white/50 space-y-2">
                {[
                  ['Method', 'GET'],
                  ['Path Pattern', '/api/users'],
                  ['Service', 'users-api'],
                  ['Auth Required', 'false'],
                  ['Rate Limit Override', '(empty — uses global default)'],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    className="grid grid-cols-3 gap-2 border-t border-white/[0.04] pt-2 first:border-0 first:pt-0"
                  >
                    <div className="text-white/50">{k}</div>
                    <div className="col-span-2 font-mono text-violet-300/70">
                      {v}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-white/40 text-xs">
                The gateway receives this config update over WebSocket within
                milliseconds. No restart required.
              </p>
              <p className="mt-3 text-white/50 text-xs">
                The route panel has three tabs:{' '}
                <strong className="text-white">Basic</strong> (method, path,
                service), <strong className="text-white">Advanced</strong>{' '}
                (retry, body limit, CORS, IP restriction), and{' '}
                <strong className="text-white">Plugins</strong> — see below.
              </p>
            </section>

            <section id="step-5:-test-it">
              <h2 className="text-xl font-bold mb-3">Step 5: Test It</h2>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 font-mono text-xs text-violet-300/80 leading-6">
                curl http://your-vps:3000/api/users
                <br />
                <span className="text-emerald-300/70">
                  {'# Proxied to http://internal-ip:8080/api/users'}
                </span>
              </div>
              <p className="mt-3 text-white/50">
                Check the <strong className="text-white">Logs</strong> page in
                the dashboard. You should see the request appear within a few
                seconds.
              </p>
            </section>

            <section id="plugins">
              <h2 className="text-xl font-bold mb-3">Plugins</h2>
              <p className="text-white/50 leading-relaxed mb-4">
                Routes support an ordered plugin pipeline. Open any route in the
                dashboard and click the{' '}
                <strong className="text-white">Plugins</strong> tab to configure
                them. Each enabled plugin runs in order on every request
                matching that route.
              </p>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4 text-xs text-white/50 space-y-2">
                {[
                  [
                    'CORS',
                    'Allowed origins, methods, headers, credentials, and preflight max-age.',
                  ],
                  [
                    'IP Restriction',
                    'Allow or deny specific CIDR ranges. Deny takes precedence.',
                  ],
                  [
                    'Rate Limit',
                    'Per-route request cap with a Redis sliding window. Independent of the global limit.',
                  ],
                  [
                    'Request Size Limit',
                    'Reject requests larger than N bytes before reading the body.',
                  ],
                  [
                    'Request Transform',
                    'Add, remove, or rename request headers and query parameters before forwarding.',
                  ],
                  [
                    'Response Transform',
                    'Add or remove response headers, or override the response status code.',
                  ],
                  [
                    'Basic Auth',
                    'Password-protect a route with HTTP Basic authentication (SHA-256 hashed credentials).',
                  ],
                ].map(([name, desc]) => (
                  <div
                    key={name}
                    className="grid grid-cols-3 gap-2 border-t border-white/[0.04] pt-2 first:border-0 first:pt-0"
                  >
                    <div className="text-white/70 font-semibold">{name}</div>
                    <div className="col-span-2 text-white/40">{desc}</div>
                  </div>
                ))}
              </div>
            </section>

            <section id="next-steps">
              <h2 className="text-xl font-bold mb-3">Next Steps</h2>
              <div className="grid sm:grid-cols-2 gap-3">
                {[
                  {
                    title: 'API Reference',
                    desc: 'Full REST API documentation for programmatic config management.',
                    href: '/api-reference',
                  },
                  {
                    title: 'Docker Deploy Guide',
                    desc: 'Full environment variable reference and Docker Compose example.',
                    href: '/docker',
                  },
                  {
                    title: 'Security',
                    desc: 'How NovaGate handles credentials, isolation, and no-PII guarantees.',
                    href: '/security',
                  },
                  {
                    title: 'Features',
                    desc: 'Complete list of everything NovaGate can do today.',
                    href: '/features',
                  },
                ].map((item) => (
                  <Link
                    key={item.title}
                    href={item.href}
                    className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4 hover:border-violet-500/25 transition-colors group"
                  >
                    <p className="font-semibold text-white text-sm mb-1 group-hover:text-violet-300 transition-colors">
                      {item.title} →
                    </p>
                    <p className="text-xs text-white/35">{item.desc}</p>
                  </Link>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>

      <MarketingFooter />
    </div>
  );
}
