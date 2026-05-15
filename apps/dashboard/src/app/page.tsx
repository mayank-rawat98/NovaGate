'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { isAuthenticated } from '../lib/auth';
import { MarketingNav } from '../components/marketing-nav';
import { MarketingFooter } from '../components/marketing-footer';

function useScrollReveal() {
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) e.target.classList.add('revealed');
        }),
      { threshold: 0.1 },
    );
    document.querySelectorAll('[data-reveal]').forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);
}

const LOGOS = [
  { name: 'mailtr.co', href: 'https://mailtr.co' },
  { name: 'squadup.in', href: 'https://squadup.in' },
  { name: 'coderegiment.com', href: 'https://coderegiment.com' },
];

const STEPS = [
  {
    n: '01',
    title: 'Register Account',
    desc: 'Sign up and get your unique gateway API key in under 60 seconds.',
  },
  {
    n: '02',
    title: 'Deploy Gateway',
    desc: 'Pull the Docker image and spin it up on your VPS with one command.',
  },
  {
    n: '03',
    title: 'Connect Routes',
    desc: 'Register your backend services and define routing rules from the dashboard.',
  },
  {
    n: '04',
    title: 'Observe & Scale',
    desc: 'Monitor live logs, metrics, and errors. Add instances without config changes.',
  },
];

const FEATURES = [
  {
    title: 'Live Traffic Observability',
    desc: 'Every request is parsed and indexed in real-time. Trace 4xx spikes back to specific API keys instantly.',
    tags: ['HTTP_TRACING', 'METRICS_EXPORTER', 'JSON_LOGGING'],
    wide: true,
    icon: (
      <svg
        className="h-4 w-4 text-violet-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
        />
      </svg>
    ),
  },
  {
    title: 'Zero-Trust Auth',
    desc: 'JWT validation at the edge. Per-consumer API keys with rate-limit tiers and instant revocation.',
    wide: false,
    icon: (
      <svg
        className="h-4 w-4 text-violet-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
        />
      </svg>
    ),
  },
  {
    title: 'Dynamic Routing',
    desc: 'Map routes across VPS instances with prefix path matching. Config updates push live without restarts.',
    routes: ['ANY /api/v1/*', 'GET /auth/callback', 'POST /webhooks'],
    wide: false,
    icon: (
      <svg
        className="h-4 w-4 text-violet-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
        />
      </svg>
    ),
  },
  {
    title: 'Docker Native',
    desc: 'Single container deployment. The gateway runs entirely on your VPS — your traffic never leaves.',
    wide: false,
    icon: (
      <svg
        className="h-4 w-4 text-violet-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 10V7"
        />
      </svg>
    ),
  },
  {
    title: 'Offline Resilience',
    desc: 'If the control plane is unreachable, the gateway continues serving from in-memory config. No single point of failure.',
    wide: false,
    icon: (
      <svg
        className="h-4 w-4 text-violet-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
        />
      </svg>
    ),
  },
];

const TESTIMONIALS = [
  {
    quote:
      '"NovaGate let us replace our hand-rolled nginx config and a pile of Lua scripts with a single Docker container. Setup took 20 minutes. The live log view alone saved us hours of debugging on our first incident."',
    name: 'Chetan Chauhan',
    role: 'Software Developer at Spectacom Global',
    initials: 'CC',
    reveal: 'left',
  },
  {
    quote:
      '"We run a lean team, so we need infrastructure that just works. NovaGate handles auth, rate limiting, and observability for all our microservices. The fact that traffic never leaves our server was the deciding factor."',
    name: 'Bhanu Pratap',
    role: 'Founder, The Regiment',
    initials: 'BP',
    reveal: 'right',
  },
];

const FREE_FEATURES = [
  'Up to 5 microservices',
  '5M requests per month',
  '7-day log retention',
  'Per-consumer API keys',
  'Prometheus metrics export',
  'Community support',
];

export default function LandingPage() {
  const router = useRouter();
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isAuthenticated()) router.replace('/dashboard');
  }, [router]);

  useEffect(() => {
    let raf: number;
    const pos = { x: -999, y: -999 };
    const cur = { x: -999, y: -999 };
    const onMove = (e: MouseEvent) => {
      pos.x = e.clientX;
      pos.y = e.clientY;
    };
    const tick = () => {
      cur.x += (pos.x - cur.x) * 0.07;
      cur.y += (pos.y - cur.y) * 0.07;
      if (glowRef.current) {
        glowRef.current.style.transform = `translate(${cur.x - 320}px, ${cur.y - 320}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener('mousemove', onMove);
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  useScrollReveal();

  return (
    <div className="min-h-screen bg-[#08080f] text-white overflow-x-hidden selection:bg-violet-500/30">
      {/* Cursor glow */}
      <div
        ref={glowRef}
        aria-hidden
        className="pointer-events-none fixed top-0 left-0 z-50 h-[640px] w-[640px] rounded-full"
        style={{
          background:
            'radial-gradient(circle, rgba(109,40,217,0.12) 0%, transparent 65%)',
          willChange: 'transform',
        }}
      />

      {/* Ambient blobs */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 overflow-hidden -z-0"
      >
        <div className="absolute -top-48 -left-48 h-[500px] w-[500px] rounded-full bg-violet-950/40 blur-[130px]" />
        <div className="absolute top-1/2 -right-32 h-[380px] w-[380px] rounded-full bg-indigo-950/30 blur-[120px]" />
        <div className="absolute bottom-24 left-1/3 h-[350px] w-[350px] rounded-full bg-purple-950/25 blur-[120px]" />
      </div>

      <MarketingNav />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative z-10 flex flex-col items-center text-center px-6 pt-28 pb-24">
        <div
          data-reveal="up"
          className="reveal-item mb-8 inline-flex items-center gap-2 rounded-full border border-violet-500/25 bg-violet-500/8 px-4 py-1.5 text-xs font-medium text-violet-300"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
          Now in public beta — free while we build
        </div>

        <h1
          data-reveal="up"
          className="reveal-item reveal-d1 max-w-[900px] text-[clamp(3rem,8vw,6.5rem)] font-black uppercase leading-[0.93] tracking-tighter"
        >
          SECURE EVERY{' '}
          <span className="bg-gradient-to-r from-violet-400 via-purple-400 to-indigo-400 bg-clip-text text-transparent">
            REQUEST.
          </span>
          <br />
          SCALE WITHOUT LIMITS.
        </h1>

        <p
          data-reveal="up"
          className="reveal-item reveal-d2 mt-7 max-w-lg text-base leading-relaxed text-white/45"
        >
          NovaGate is a hybrid API gateway. The data plane runs on your VPS. The
          control plane, dashboard, and observability live in our cloud —
          managed for you.
        </p>

        <div
          data-reveal="up"
          className="reveal-item reveal-d3 mt-9 flex items-center gap-4"
        >
          <Link
            href="/register"
            className="rounded-xl bg-violet-600 px-7 py-3 text-sm font-bold text-white shadow-lg shadow-violet-900/40 hover:bg-violet-500 hover:-translate-y-0.5 transition-all duration-200"
          >
            Start Free — No Card Needed
          </Link>
          <Link
            href="/docs"
            className="flex items-center gap-2.5 text-sm font-medium text-white/50 hover:text-white transition-colors duration-200"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04]">
              <svg
                className="h-3.5 w-3.5 translate-x-px"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
            Read the Docs
          </Link>
        </div>

        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:28px_28px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,#000_50%,transparent_100%)]"
        />
      </section>

      {/* ── Logo strip ───────────────────────────────────────────────────── */}
      <section className="relative z-10 border-y border-white/[0.05] py-12 px-6">
        <p
          data-reveal="up"
          className="reveal-item text-center text-[10px] font-semibold uppercase tracking-[0.22em] text-white/20 mb-9"
        >
          Trusted by innovative engineering teams
        </p>
        <div className="flex flex-wrap items-center justify-center gap-10 md:gap-20">
          {LOGOS.map((logo, i) => (
            <a
              key={logo.name}
              href={logo.href}
              target="_blank"
              rel="noreferrer"
              data-reveal="up"
              className="reveal-item text-base font-bold text-white/20 hover:text-white/50 transition-colors duration-300 tracking-tight"
              style={{ '--reveal-delay': `${i * 80}ms` } as React.CSSProperties}
            >
              {logo.name}
            </a>
          ))}
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="relative z-10 px-6 py-24 max-w-6xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {STEPS.map((step, i) => (
            <div
              key={step.n}
              data-reveal="up"
              className="reveal-item group relative rounded-2xl border border-white/[0.07] bg-white/[0.025] p-6 hover:border-violet-500/35 hover:bg-violet-500/[0.04] transition-all duration-300"
              style={{ '--reveal-delay': `${i * 75}ms` } as React.CSSProperties}
            >
              <span className="text-[10px] font-bold tracking-widest text-violet-500/50 mb-4 block">
                {step.n}
              </span>
              <h3 className="font-semibold text-white mb-2 text-sm">
                {step.title}
              </h3>
              <p className="text-xs text-white/35 leading-relaxed">
                {step.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Architecture ─────────────────────────────────────────────────── */}
      <section
        id="architecture"
        className="relative z-10 border-y border-white/[0.05] bg-white/[0.015] px-6 py-24"
      >
        <div className="max-w-4xl mx-auto text-center">
          <h2 data-reveal="up" className="reveal-item text-3xl font-bold mb-3">
            Unified Gateway Architecture
          </h2>
          <p
            data-reveal="up"
            className="reveal-item reveal-d1 text-sm text-white/38 mb-16"
          >
            Connect your microservices to our centralized control plane with a
            single Docker command. Traffic never leaves your infrastructure.
          </p>
          <div className="flex flex-col md:flex-row items-center justify-center gap-3">
            {[
              {
                title: 'NovaGate Cloud',
                desc: 'Admin Dashboard, Config Push, Observability',
                reveal: 'left',
              },
              {
                title: 'NovaGate Node',
                desc: 'Docker container on your VPS — handles all live traffic',
                reveal: 'up',
                highlight: true,
              },
              {
                title: 'Your Microservices',
                desc: 'REST, GraphQL, gRPC internal endpoints',
                reveal: 'right',
              },
            ].map((item, i) => (
              <div
                key={item.title}
                className="flex items-center gap-3 flex-col md:flex-row w-full md:w-auto"
              >
                <div
                  data-reveal={item.reveal}
                  className={`reveal-item w-full md:w-52 rounded-2xl border p-6 text-center transition-all duration-300 ${
                    item.highlight
                      ? 'border-violet-500/40 bg-violet-500/10 shadow-lg shadow-violet-900/20'
                      : 'border-white/[0.08] bg-white/[0.03]'
                  }`}
                >
                  <h3 className="font-semibold text-white text-sm mb-1.5">
                    {item.title}
                  </h3>
                  <p className="text-xs text-white/35 leading-relaxed">
                    {item.desc}
                  </p>
                </div>
                {i < 2 && (
                  <span className="text-white/15 text-2xl hidden md:block">
                    →
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section
        id="features"
        className="relative z-10 px-6 py-24 max-w-6xl mx-auto"
      >
        <div className="text-center mb-16">
          <span
            data-reveal="up"
            className="reveal-item inline-block text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3"
          >
            ENGINE_CAPABILITIES
          </span>
          <h2
            data-reveal="up"
            className="reveal-item reveal-d1 text-3xl font-bold"
          >
            Engineered for{' '}
            <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent">
              Mission Critical
            </span>{' '}
            scale.
          </h2>
          <p
            data-reveal="up"
            className="reveal-item reveal-d2 mt-3 text-sm text-white/38 max-w-md mx-auto"
          >
            Deep-packet inspection, dynamic policy enforcement, and
            sub-millisecond overhead at the edge.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {FEATURES.map((feat, i) => (
            <div
              key={feat.title}
              data-reveal={i % 3 === 0 ? 'left' : i % 3 === 2 ? 'right' : 'up'}
              className={`reveal-item rounded-2xl border border-white/[0.07] bg-white/[0.025] p-7 hover:border-violet-500/30 hover:bg-violet-500/[0.03] transition-all duration-300 ${feat.wide ? 'md:col-span-2' : ''}`}
              style={
                { '--reveal-delay': `${(i % 3) * 80}ms` } as React.CSSProperties
              }
            >
              <div className="mb-4 flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600/15">
                {feat.icon}
              </div>
              <h3 className="font-semibold text-white text-sm mb-2">
                {feat.title}
              </h3>
              <p className="text-xs text-white/38 leading-relaxed">
                {feat.desc}
              </p>
              {feat.tags && (
                <div className="mt-5 flex gap-2 flex-wrap">
                  {feat.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md border border-white/[0.08] px-2.5 py-1 text-[10px] font-mono text-white/35"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {feat.routes && (
                <div className="mt-5 space-y-1.5">
                  {feat.routes.map((r) => (
                    <div
                      key={r}
                      className="rounded-md bg-white/[0.04] px-3 py-1.5 font-mono text-[11px] text-violet-300/80"
                    >
                      {r}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Observability ────────────────────────────────────────────────── */}
      <section className="relative z-10 border-y border-white/[0.05] bg-white/[0.015] px-6 py-24">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center gap-16">
          <div className="flex-1">
            <h2
              data-reveal="left"
              className="reveal-item text-4xl md:text-5xl font-bold leading-tight mb-5"
            >
              Observability at
              <br />
              <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent">
                10,000 req/sec
              </span>
            </h2>
            <p
              data-reveal="left"
              className="reveal-item reveal-d1 text-sm text-white/40 leading-relaxed mb-8"
            >
              The NovaGate cloud portal syncs with your local Docker instance in
              real time. Monitor throughput, latency, and errors without
              deploying a separate monitoring stack.
            </p>
            <ul className="space-y-3.5">
              {[
                'Real-time RPS tracking per API key',
                'P50 / P95 / P99 latency distribution',
                'Per-route error event log with request IDs',
              ].map((item, i) => (
                <li
                  key={item}
                  data-reveal="left"
                  className="reveal-item flex items-center gap-3 text-sm text-white/55"
                  style={
                    {
                      '--reveal-delay': `${(i + 2) * 80}ms`,
                    } as React.CSSProperties
                  }
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div
            data-reveal="right"
            className="reveal-item flex-1 w-full rounded-2xl border border-white/[0.09] bg-white/[0.03] p-6 backdrop-blur-sm shadow-2xl shadow-black/40"
          >
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="font-semibold text-white text-sm">
                  Traffic Monitor
                </p>
                <p className="text-xs text-white/28 mt-0.5">
                  Live Gateway Node
                </p>
              </div>
              <span className="rounded-full bg-emerald-500/12 border border-emerald-500/20 px-2.5 py-1 text-xs font-medium text-emerald-400">
                Operational
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-6">
              {[
                { label: 'REQUESTS', value: '1.2M', delta: '+12%' },
                { label: 'AVG LATENCY', value: '42ms', delta: '−5ms' },
                { label: 'ERROR RATE', value: '0.04%', delta: 'Stable' },
              ].map((s) => (
                <div
                  key={s.label}
                  className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3"
                >
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-white/25 mb-1.5">
                    {s.label}
                  </p>
                  <p className="font-bold text-white text-sm">{s.value}</p>
                  <p className="text-xs text-white/25 mt-0.5">{s.delta}</p>
                </div>
              ))}
            </div>
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-wider text-white/25 mb-3">
                Recent Logs
              </p>
              <div className="space-y-2">
                {[
                  {
                    method: 'GET',
                    path: '/api/v1/users',
                    status: 200,
                    ms: '4ms',
                  },
                  {
                    method: 'POST',
                    path: '/api/v1/auth',
                    status: 201,
                    ms: '128ms',
                  },
                  {
                    method: 'GET',
                    path: '/api/v1/orders',
                    status: 200,
                    ms: '18ms',
                  },
                ].map((log, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-lg bg-white/[0.025] px-3 py-2 text-xs font-mono"
                  >
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${log.method === 'GET' ? 'bg-blue-500/15 text-blue-400' : 'bg-green-500/15 text-green-400'}`}
                    >
                      {log.method}
                    </span>
                    <span className="flex-1 text-white/45">{log.path}</span>
                    <span className="text-white/25">{log.status}</span>
                    <span className="text-white/25">{log.ms}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Testimonials ─────────────────────────────────────────────────── */}
      <section className="relative z-10 px-6 py-24 max-w-6xl mx-auto">
        <div className="grid md:grid-cols-2 gap-5">
          {TESTIMONIALS.map((t) => (
            <div
              key={t.name}
              data-reveal={t.reveal}
              className="reveal-item rounded-2xl border border-white/[0.07] bg-white/[0.025] p-8 hover:border-violet-500/25 transition-all duration-300"
            >
              <p className="text-sm text-white/60 italic leading-relaxed mb-7">
                {t.quote}
              </p>
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-xs font-bold text-white">
                  {t.initials}
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{t.name}</p>
                  <p className="text-xs text-white/35">{t.role}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section
        id="pricing"
        className="relative z-10 border-y border-white/[0.05] bg-white/[0.015] px-6 py-24"
      >
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-16">
            <h2
              data-reveal="up"
              className="reveal-item text-3xl font-bold mb-3"
            >
              Simple Pricing
            </h2>
            <p
              data-reveal="up"
              className="reveal-item reveal-d1 text-sm text-white/38"
            >
              We are in public beta. Everything is free while we build. Paid
              plans are coming.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-5 max-w-2xl mx-auto">
            {/* Free plan */}
            <div
              data-reveal="left"
              className="reveal-item relative flex flex-col rounded-2xl border border-violet-500/45 bg-violet-500/[0.08] shadow-lg shadow-violet-900/20 p-8"
            >
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet-600 px-3 py-0.5 text-[10px] font-bold text-white whitespace-nowrap">
                AVAILABLE NOW
              </div>
              <div className="mb-7">
                <p className="text-xs font-semibold text-white/45 uppercase tracking-wider mb-2">
                  Developer
                </p>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-black text-white">Free</span>
                </div>
                <p className="text-xs text-white/35 mt-2 leading-relaxed">
                  Everything you need to get started. No credit card required.
                </p>
              </div>
              <ul className="space-y-3 flex-1 mb-8">
                {FREE_FEATURES.map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2.5 text-xs text-white/55"
                  >
                    <svg
                      className="h-3.5 w-3.5 shrink-0 text-emerald-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2.5}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/register"
                className="block text-center rounded-xl py-2.5 text-sm font-semibold bg-violet-600 text-white hover:bg-violet-500 shadow-md shadow-violet-900/30 transition-all duration-200"
              >
                Start for Free
              </Link>
            </div>

            {/* Coming soon */}
            <div
              data-reveal="right"
              className="reveal-item relative flex flex-col rounded-2xl border border-white/[0.07] bg-white/[0.025] p-8"
            >
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-0.5 text-[10px] font-bold text-white/50 whitespace-nowrap">
                COMING SOON
              </div>
              <div className="mb-7">
                <p className="text-xs font-semibold text-white/45 uppercase tracking-wider mb-2">
                  Growth & Enterprise
                </p>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-black text-white/30">—</span>
                </div>
                <p className="text-xs text-white/28 mt-2 leading-relaxed">
                  Unlimited microservices, 30-day retention, priority support,
                  custom domains, and SLA.
                </p>
              </div>
              <ul className="space-y-3 flex-1 mb-8">
                {[
                  'Unlimited microservices',
                  'Unlimited requests',
                  '30-day log retention',
                  'Priority support',
                  'Custom domains + TLS',
                  'SLA guarantee',
                ].map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2.5 text-xs text-white/28"
                  >
                    <svg
                      className="h-3.5 w-3.5 shrink-0 text-white/20"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2.5}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/contact"
                className="block text-center rounded-xl py-2.5 text-sm font-semibold border border-white/10 text-white/40 hover:bg-white/5 hover:text-white/60 transition-all duration-200"
              >
                Get Notified
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="relative z-10 px-6 py-24">
        <div
          data-reveal="up"
          className="reveal-item max-w-4xl mx-auto rounded-3xl border border-white/[0.07] bg-white/[0.025] px-10 py-20 text-center backdrop-blur-sm"
        >
          <h2 className="text-4xl md:text-5xl font-bold mb-4 leading-tight">
            Your gateway.
            <br />
            Our cloud.
          </h2>
          <p className="text-white/38 text-sm mb-10">
            Deploy in minutes. Scale without configuration. Traffic always stays
            on your server.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Link
              href="/register"
              className="rounded-xl bg-white px-8 py-3 text-sm font-bold text-gray-900 hover:bg-white/90 hover:-translate-y-0.5 transition-all duration-200 shadow-lg"
            >
              Get Started Free
            </Link>
            <Link
              href="/contact"
              className="rounded-xl border border-white/10 px-8 py-3 text-sm font-semibold text-white/60 hover:bg-white/5 hover:text-white transition-all duration-200"
            >
              Talk to Us
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
