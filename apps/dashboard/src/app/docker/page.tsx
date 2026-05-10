import Link from 'next/link';
import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

const ENV_VARS = [
  { name: 'PORT', required: false, default: '3000', desc: 'Port the gateway listens on.' },
  { name: 'REDIS_URL', required: true, default: '—', desc: 'Redis connection URL. Used for rate limiting and config cache.' },
  { name: 'JWT_SECRET', required: true, default: '—', desc: 'Secret for validating JWTs from your end users. Minimum 32 characters.' },
  { name: 'CONTROL_PLANE_URL', required: true, default: '—', desc: 'WebSocket URL of the NovaGate control plane. Format: wss://ws.novagate.dev/gateway-ws' },
  { name: 'GATEWAY_API_KEY', required: true, default: '—', desc: 'Your gateway API key from the NovaGate dashboard. Used to authenticate the WebSocket connection.' },
  { name: 'PROXY_TIMEOUT_MS', required: false, default: '10000', desc: 'Default upstream request timeout in milliseconds.' },
  { name: 'RATE_LIMIT_WINDOW_MS', required: false, default: '60000', desc: 'Rate limit sliding window duration in milliseconds.' },
  { name: 'RATE_LIMIT_UNAUTH_MAX', required: false, default: '100', desc: 'Max requests per window for unauthenticated clients.' },
  { name: 'RATE_LIMIT_AUTH_MAX', required: false, default: '500', desc: 'Max requests per window for authenticated clients.' },
];

export default function DockerPage() {
  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-4xl mx-auto px-6 py-20">
        <div className="mb-14">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">DEPLOY</p>
          <h1 className="text-4xl md:text-5xl font-black tracking-tight mb-4">
            Deploy in
            <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent"> under 5 minutes.</span>
          </h1>
          <p className="text-white/40 text-base max-w-xl leading-relaxed">
            The NovaGate gateway is a single Docker container. Run it on any VPS, Kubernetes pod, or bare-metal server that can reach the internet.
          </p>
        </div>

        {/* Step 1 */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-4">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-600 text-xs font-bold">1</span>
            <h2 className="text-lg font-bold">Register and get your API key</h2>
          </div>
          <p className="text-sm text-white/45 mb-4 pl-10">
            Create an account at novagate.dev. After registration, your gateway API key is shown once and saved to your dashboard under Settings.
          </p>
          <div className="pl-10">
            <Link href="/register" className="inline-flex rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 transition-colors">
              Create Account →
            </Link>
          </div>
        </div>

        {/* Step 2 */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-4">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-600 text-xs font-bold">2</span>
            <h2 className="text-lg font-bold">Pull the Docker image</h2>
          </div>
          <div className="pl-10 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 font-mono text-sm text-violet-300/80">
            docker pull ghcr.io/rawatshahab/novagate/api:latest
          </div>
        </div>

        {/* Step 3 */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-4">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-600 text-xs font-bold">3</span>
            <h2 className="text-lg font-bold">Run the container</h2>
          </div>
          <div className="pl-10 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 font-mono text-sm text-violet-300/80 leading-7">
            <span className="text-white/30">docker run -d \</span><br />
            {'  '}<span className="text-white/30">--name novagate \</span><br />
            {'  '}<span className="text-white/30">--restart unless-stopped \</span><br />
            {'  '}-p 3000:3000 \<br />
            {'  '}-e REDIS_URL=redis://your-redis:6379 \<br />
            {'  '}-e JWT_SECRET=your-32-char-secret-here \<br />
            {'  '}-e CONTROL_PLANE_URL=wss://ws.novagate.dev/gateway-ws \<br />
            {'  '}-e GATEWAY_API_KEY=gw_xxxxxxxxxxxxx \<br />
            {'  '}ghcr.io/rawatshahab/novagate/api:latest
          </div>
        </div>

        {/* Step 4 */}
        <div className="mb-14">
          <div className="flex items-center gap-3 mb-4">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-600 text-xs font-bold">4</span>
            <h2 className="text-lg font-bold">Verify the gateway is online</h2>
          </div>
          <div className="pl-10 space-y-3">
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 font-mono text-sm text-violet-300/80">
              curl http://your-vps:3000/health
            </div>
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4 font-mono text-sm text-emerald-300/70">
              {'{"status":"ok","configSource":"live","configVersion":1}'}
            </div>
            <p className="text-xs text-white/35">
              <code className="text-white/50">configSource: live</code> means the gateway is connected to the control plane. <code className="text-white/50">cache</code> means it is using the local Redis fallback.
            </p>
          </div>
        </div>

        {/* Environment Variables */}
        <div>
          <h2 className="text-lg font-bold mb-5">Environment Variables</h2>
          <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] bg-white/[0.025]">
                  <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-white/35">Variable</th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-white/35">Required</th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-white/35">Default</th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-white/35">Description</th>
                </tr>
              </thead>
              <tbody>
                {ENV_VARS.map((v, i) => (
                  <tr key={v.name} className={`border-b border-white/[0.04] ${i % 2 === 0 ? '' : 'bg-white/[0.015]'}`}>
                    <td className="px-4 py-3 font-mono text-xs text-violet-300/80">{v.name}</td>
                    <td className="px-4 py-3">
                      {v.required
                        ? <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">Required</span>
                        : <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold text-white/30">Optional</span>
                      }
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-white/30">{v.default}</td>
                    <td className="px-4 py-3 text-xs text-white/45">{v.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-12 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-6 text-center">
          <p className="text-sm text-white/50 mb-4">Need help? Check the full getting-started guide.</p>
          <Link href="/docs" className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 transition-colors">
            Read the Documentation →
          </Link>
        </div>
      </div>

      <MarketingFooter />
    </div>
  );
}
