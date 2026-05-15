import type { Metadata } from 'next';
import Link from 'next/link';
import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

export const metadata: Metadata = {
  title: 'About',
  description:
    'The story behind NovaGate — built because running Kong is a full-time job. Self-hosted gateway, hosted control plane. Your traffic never touches our servers.',
  keywords: [
    'about novagate',
    'api gateway company',
    'kong alternative',
    'self-hosted gateway story',
  ],
  openGraph: {
    title: 'About NovaGate — Built Because Running Kong Is a Full-Time Job',
    description:
      'Self-hosted gateway, hosted control plane. The best of both models — without the infrastructure burden.',
    url: 'https://novagate.dev/about',
  },
  alternates: { canonical: 'https://novagate.dev/about' },
};

const VALUES = [
  {
    title: 'Traffic stays on your server',
    desc: 'This is a non-negotiable design constraint. Every architectural decision is evaluated against it. If traffic ever touched our infrastructure, we would be a different product.',
  },
  {
    title: 'Simple beats clever',
    desc: 'A config change that takes 30 seconds in the dashboard is worth more than a powerful CLI you have to learn. We optimise for the path from idea to running.',
  },
  {
    title: 'Honest about what we have',
    desc: 'We document exactly what is implemented, not what is on the roadmap. Every feature page on this site describes code that exists today.',
  },
  {
    title: 'Defaults that are safe',
    desc: 'Rate limiting fails open. Missing config crashes the gateway at startup. JWTs distinguish expired from invalid. Good defaults prevent production incidents.',
  },
];

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-4xl mx-auto px-6 py-20">
        <div className="mb-16">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">
            ABOUT
          </p>
          <h1 className="text-4xl md:text-5xl font-black tracking-tight mb-5">
            Built because running Kong is
            <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent">
              {' '}
              a full-time job.
            </span>
          </h1>
          <p className="text-white/45 text-base leading-relaxed max-w-2xl">
            NovaGate started when we got tired of maintaining Nginx configs, Lua
            plugins, and a Postgres cluster just to add rate limiting and
            per-key observability to a handful of microservices.
          </p>
        </div>

        <div className="space-y-8 mb-16 text-white/50 text-sm leading-relaxed max-w-2xl">
          <p>
            The pattern we kept running into: teams with 5–15 microservices that
            need JWT validation, rate limiting, and basic observability. Simple
            requirements — but every existing gateway either required you to
            operate significant infrastructure (Kong, Traefik) or was a black
            box that routed your traffic through someone else's servers (most
            SaaS API gateways).
          </p>
          <p>
            We wanted something different: the control plane and dashboard
            hosted and managed for you (zero infrastructure to operate), but the
            gateway — the thing handling your actual traffic — running on your
            own server. The best of both models.
          </p>
          <p>
            NovaGate is that product. The gateway is a single Docker container.
            It boots in seconds, connects to our control plane over WebSocket,
            and starts routing immediately. Config changes from the dashboard
            propagate in under a second. If our cloud ever has an outage, your
            gateway keeps working from its local cache.
          </p>
          <p>
            We are in public beta. Everything is free while we build. The
            feedback from teams currently running NovaGate is directly shaping
            what we build next.
          </p>
        </div>

        {/* Values */}
        <div className="mb-16">
          <h2 className="text-2xl font-bold mb-6">How we build</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {VALUES.map((v) => (
              <div
                key={v.title}
                className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-6"
              >
                <h3 className="font-semibold text-white text-sm mb-2">
                  {v.title}
                </h3>
                <p className="text-xs text-white/40 leading-relaxed">
                  {v.desc}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="rounded-2xl border border-violet-500/20 bg-violet-500/[0.05] p-8">
          <h2 className="text-xl font-bold mb-3">Try it while it is free</h2>
          <p className="text-sm text-white/45 mb-6 max-w-xl">
            Create an account, deploy the gateway container, and have live
            request logs and rate limiting within 10 minutes.
          </p>
          <div className="flex gap-4">
            <Link
              href="/register"
              className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 transition-colors"
            >
              Get Started Free
            </Link>
            <Link
              href="/contact"
              className="rounded-lg border border-white/10 px-5 py-2.5 text-sm font-semibold text-white/60 hover:text-white hover:bg-white/5 transition-colors"
            >
              Talk to Us
            </Link>
          </div>
        </div>
      </div>

      <MarketingFooter />
    </div>
  );
}
