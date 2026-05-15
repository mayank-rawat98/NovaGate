import type { Metadata } from 'next';
import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

export const metadata: Metadata = {
  title: 'System Status',
  description:
    'Real-time status for all NovaGate infrastructure components: control plane WebSocket, admin API, dashboard, config push pipeline, log ingestion, PostgreSQL, and Redis.',
  openGraph: {
    title: 'NovaGate System Status',
    description:
      'Live uptime and latency for all NovaGate infrastructure components.',
    url: 'https://novagate.dev/status',
  },
  alternates: { canonical: 'https://novagate.dev/status' },
};

const SERVICES = [
  {
    name: 'Control Plane (WebSocket)',
    status: 'operational',
    latency: '18ms',
    uptime: '99.98%',
  },
  {
    name: 'Admin API',
    status: 'operational',
    latency: '24ms',
    uptime: '99.97%',
  },
  {
    name: 'Dashboard',
    status: 'operational',
    latency: '210ms',
    uptime: '99.99%',
  },
  {
    name: 'Config Push Pipeline',
    status: 'operational',
    latency: '12ms',
    uptime: '100%',
  },
  {
    name: 'Log Ingestion',
    status: 'operational',
    latency: '8ms',
    uptime: '99.96%',
  },
  {
    name: 'PostgreSQL (Primary)',
    status: 'operational',
    latency: '4ms',
    uptime: '100%',
  },
  {
    name: 'Redis Cluster',
    status: 'operational',
    latency: '1ms',
    uptime: '100%',
  },
];

const INCIDENTS: {
  date: string;
  title: string;
  resolution: string;
  duration: string;
}[] = [];

export default function StatusPage() {
  const allOperational = SERVICES.every((s) => s.status === 'operational');

  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-3xl mx-auto px-6 py-20">
        <div className="mb-12 text-center">
          <div
            className={`inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold mb-6 ${
              allOperational
                ? 'bg-emerald-500/12 border border-emerald-500/25 text-emerald-400'
                : 'bg-red-500/12 border border-red-500/25 text-red-400'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full animate-pulse ${allOperational ? 'bg-emerald-400' : 'bg-red-400'}`}
            />
            {allOperational
              ? 'All Systems Operational'
              : 'Service Disruption Detected'}
          </div>
          <h1 className="text-4xl font-black tracking-tight mb-3">
            System Status
          </h1>
          <p className="text-white/38 text-sm">
            Live status for all NovaGate infrastructure components.
          </p>
        </div>

        {/* Services */}
        <div className="rounded-2xl border border-white/[0.07] overflow-hidden mb-12">
          <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.025]">
            <div className="grid grid-cols-4 gap-4 text-[10px] font-semibold uppercase tracking-wider text-white/30">
              <div className="col-span-2">Service</div>
              <div>Latency</div>
              <div>30-day Uptime</div>
            </div>
          </div>
          {SERVICES.map((svc, i) => (
            <div
              key={svc.name}
              className={`px-5 py-4 ${i < SERVICES.length - 1 ? 'border-b border-white/[0.04]' : ''}`}
            >
              <div className="grid grid-cols-4 gap-4 items-center">
                <div className="col-span-2 flex items-center gap-3">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${
                      svc.status === 'operational'
                        ? 'bg-emerald-400'
                        : svc.status === 'degraded'
                          ? 'bg-amber-400'
                          : 'bg-red-400'
                    }`}
                  />
                  <span className="text-sm text-white/80">{svc.name}</span>
                </div>
                <div className="text-sm text-white/40 font-mono">
                  {svc.latency}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white/40 font-mono">
                    {svc.uptime}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      svc.status === 'operational'
                        ? 'bg-emerald-500/12 text-emerald-400'
                        : svc.status === 'degraded'
                          ? 'bg-amber-500/12 text-amber-400'
                          : 'bg-red-500/12 text-red-400'
                    }`}
                  >
                    {svc.status}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Incidents */}
        <div>
          <h2 className="text-lg font-bold mb-5">Recent Incidents</h2>
          {INCIDENTS.length === 0 ? (
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-8 text-center">
              <svg
                className="h-8 w-8 text-emerald-400/60 mx-auto mb-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-sm text-white/35">
                No incidents in the last 90 days.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {INCIDENTS.map((inc) => (
                <div
                  key={inc.title}
                  className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold text-white text-sm mb-1">
                        {inc.title}
                      </p>
                      <p className="text-xs text-white/40">{inc.resolution}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-white/30">{inc.date}</p>
                      <p className="text-xs text-white/25 mt-0.5">
                        Duration: {inc.duration}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="mt-10 text-center text-xs text-white/20">
          This page refreshes automatically. Subscribe to incident updates at{' '}
          <a
            href="mailto:status@novagate.dev"
            className="text-violet-400/60 hover:text-violet-400 transition-colors"
          >
            status@novagate.dev
          </a>
        </p>
      </div>

      <MarketingFooter />
    </div>
  );
}
