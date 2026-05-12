import type { Metadata } from 'next';
import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

export const metadata: Metadata = {
  title: 'Support',
  description: 'NovaGate support: email, GitHub issues, and enterprise plans. FAQ covering traffic routing, Redis setup, config propagation speed, gateway key rotation, and offline resilience.',
  keywords: ['api gateway support', 'novagate help', 'api gateway faq', 'gateway troubleshooting'],
  openGraph: {
    title: 'NovaGate Support & FAQ',
    description: 'Get help with NovaGate. Email support, GitHub issues, and a detailed FAQ covering the most common setup and operations questions.',
    url: 'https://novagate.dev/support',
  },
  alternates: { canonical: 'https://novagate.dev/support' },
};

const FAQ = [
  {
    q: 'Does NovaGate see my API traffic?',
    a: 'No. The gateway node runs on your server. Your request and response payloads never leave your infrastructure. Only telemetry (request metadata: method, path, status code, latency) is sent to the control plane.',
  },
  {
    q: 'What happens if the NovaGate control plane goes down?',
    a: 'Nothing — your gateway continues routing requests using its in-memory config and local Redis cache. The control plane being unreachable only prevents config changes and new log collection. Live traffic is unaffected.',
  },
  {
    q: 'Can I run multiple gateway instances?',
    a: 'Yes. All instances connect to the same control plane using the same API key and receive the same config. They operate independently — there is no shared state between gateway nodes beyond what is in Redis.',
  },
  {
    q: 'How do I rotate my Gateway API key?',
    a: 'Go to Dashboard → Settings → Gateway Key → Rotate Key. Your old key is revoked immediately. The new key is shown once. Update your gateway container\'s GATEWAY_API_KEY environment variable and restart it.',
  },
  {
    q: 'How quickly do config changes reach the gateway?',
    a: 'Config changes are pushed over an authenticated WebSocket. In most cases your gateway receives the update within 100–300ms of the dashboard save. If the gateway is offline, the update is queued and delivered on reconnect.',
  },
  {
    q: 'Is there a free plan?',
    a: 'Yes. NovaGate is currently in public beta and completely free. We will introduce paid plans for higher limits and enterprise features — free users will be given advance notice before any changes.',
  },
  {
    q: 'What Redis version do I need?',
    a: 'Redis 6.0 or higher. The rate limiter uses ZRANGEBYSCORE and ZADD which are available in all modern Redis versions. Redis Cluster is not yet supported — use a single-node or Sentinel setup.',
  },
  {
    q: 'Can I use NovaGate without Redis?',
    a: 'No. Redis is required. It serves as the rate-limit store, warm-start config cache, and the pub/sub channel between the control plane and your gateway. A minimal Redis Cloud free tier instance is sufficient.',
  },
];

export default function SupportPage() {
  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-4xl mx-auto px-6 py-20">
        <div className="mb-14">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">SUPPORT</p>
          <h1 className="text-4xl font-black tracking-tight mb-4">How can we help?</h1>
          <p className="text-white/40 text-base max-w-xl leading-relaxed">
            Find answers below, or reach out directly. We are a small team and we respond personally.
          </p>
        </div>

        {/* Channels */}
        <div className="grid sm:grid-cols-3 gap-4 mb-16">
          {[
            {
              icon: '✉️',
              title: 'Email',
              desc: 'For account issues, billing questions, and anything that doesn\'t fit in a GitHub issue.',
              action: 'support@novagate.dev',
              href: 'mailto:support@novagate.dev',
            },
            {
              icon: '🐛',
              title: 'GitHub Issues',
              desc: 'For bug reports and feature requests. Open a public issue so the community can follow along.',
              action: 'Open an issue',
              href: '#',
            },
            {
              icon: '🏢',
              title: 'Enterprise',
              desc: 'Need an SLA, private Slack, or a dedicated engineer? Talk to us about an enterprise plan.',
              action: 'Enterprise contact',
              href: '/enterprise',
            },
          ].map((c) => (
            <div key={c.title} className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-6">
              <span className="text-2xl mb-3 block">{c.icon}</span>
              <h3 className="font-semibold text-white text-sm mb-2">{c.title}</h3>
              <p className="text-xs text-white/38 leading-relaxed mb-4">{c.desc}</p>
              <a href={c.href} className="text-xs text-violet-400 hover:text-violet-300 transition-colors font-medium">
                {c.action} →
              </a>
            </div>
          ))}
        </div>

        {/* FAQ */}
        <div>
          <h2 className="text-2xl font-bold mb-6">Frequently Asked Questions</h2>
          <div className="space-y-4">
            {FAQ.map((item) => (
              <div key={item.q} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-6">
                <h3 className="font-semibold text-white text-sm mb-2">{item.q}</h3>
                <p className="text-sm text-white/45 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-6 text-center">
          <p className="text-sm text-white/45 mb-3">Didn&apos;t find what you were looking for?</p>
          <p className="text-sm text-white/30">
            Email us at{' '}
            <a href="mailto:support@novagate.dev" className="text-violet-400 hover:text-violet-300 transition-colors">
              support@novagate.dev
            </a>{' '}
            and we will get back to you within 24 hours.
          </p>
        </div>
      </div>

      <MarketingFooter />
    </div>
  );
}
