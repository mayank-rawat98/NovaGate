'use client';

import { useState } from 'react';
import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

const FEATURES = [
  {
    title: 'Unlimited Scale',
    desc: 'No caps on microservices, routes, consumers, or requests. We grow with your infrastructure.',
  },
  {
    title: 'SLA Guarantee',
    desc: '99.9% control plane uptime SLA with credits for downtime. Your gateway continues running even during outages.',
  },
  {
    title: 'Dedicated Support',
    desc: 'A named solutions engineer on Slack or Teams. Sub-4-hour response time on critical issues.',
  },
  {
    title: 'On-Premises Control Plane',
    desc: 'Deploy the control plane and dashboard inside your own VPC for compliance-sensitive environments.',
  },
  {
    title: 'SSO / SAML',
    desc: 'Log into the NovaGate dashboard with your existing identity provider: Okta, Azure AD, Google Workspace.',
  },
  {
    title: '90-Day Log Retention',
    desc: 'Extended log and error retention for audit and compliance requirements.',
  },
  {
    title: 'Multi-Region Gateways',
    desc: 'Coordinate multiple gateway nodes across regions from a single dashboard with unified observability.',
  },
  {
    title: 'Custom Billing',
    desc: 'Annual contracts, purchase orders, and invoiced billing — no credit card required.',
  },
];

export default function EnterprisePage() {
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({
    name: '',
    email: '',
    company: '',
    message: '',
  });

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-5xl mx-auto px-6 py-20">
        <div className="mb-16 text-center">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">
            ENTERPRISE
          </p>
          <h1 className="text-4xl md:text-5xl font-black tracking-tight mb-4">
            Built for teams at
            <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent">
              {' '}
              scale.
            </span>
          </h1>
          <p className="text-white/40 text-base max-w-xl mx-auto leading-relaxed">
            NovaGate Enterprise removes every limit and adds the compliance,
            support, and deployment flexibility that large engineering teams
            need.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 mb-20">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5 hover:border-violet-500/25 transition-colors"
            >
              <h3 className="font-semibold text-white text-sm mb-2">
                {f.title}
              </h3>
              <p className="text-xs text-white/38 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>

        <div className="grid md:grid-cols-2 gap-12 items-start">
          <div>
            <h2 className="text-2xl font-bold mb-4">Talk to us</h2>
            <p className="text-sm text-white/45 leading-relaxed mb-6">
              Enterprise plans are scoped to your needs. Tell us about your team
              size, traffic volume, and compliance requirements and we will put
              together a proposal.
            </p>
            <div className="space-y-4 text-sm text-white/45">
              <div className="flex items-center gap-3">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
                Response within 1 business day
              </div>
              <div className="flex items-center gap-3">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
                No lock-in — month-to-month or annual
              </div>
              <div className="flex items-center gap-3">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
                Free proof-of-concept migration support
              </div>
            </div>
            <p className="mt-8 text-sm text-white/30">
              Or email us directly:{' '}
              <a
                href="mailto:enterprise@novagate.dev"
                className="text-violet-400 hover:text-violet-300 transition-colors"
              >
                enterprise@novagate.dev
              </a>
            </p>
          </div>

          {submitted ? (
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-8 text-center">
              <svg
                className="h-10 w-10 text-emerald-400 mx-auto mb-4"
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
              <h3 className="text-lg font-bold text-white mb-2">
                Message received
              </h3>
              <p className="text-sm text-white/45">
                We will get back to you within 1 business day.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {[
                {
                  name: 'name',
                  label: 'Full name',
                  type: 'text',
                  placeholder: 'Jane Smith',
                },
                {
                  name: 'email',
                  label: 'Work email',
                  type: 'email',
                  placeholder: 'jane@company.com',
                },
                {
                  name: 'company',
                  label: 'Company',
                  type: 'text',
                  placeholder: 'Acme Corp',
                },
              ].map((field) => (
                <div key={field.name}>
                  <label className="block text-xs font-medium text-white/50 mb-1.5">
                    {field.label}
                  </label>
                  <input
                    type={field.type}
                    name={field.name}
                    required
                    value={form[field.name as keyof typeof form]}
                    onChange={handleChange}
                    placeholder={field.placeholder}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition"
                  />
                </div>
              ))}
              <div>
                <label className="block text-xs font-medium text-white/50 mb-1.5">
                  Tell us about your use case
                </label>
                <textarea
                  name="message"
                  rows={3}
                  value={form.message}
                  onChange={handleChange}
                  placeholder="Team size, monthly request volume, compliance requirements..."
                  className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition resize-none"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-lg bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 transition-colors"
              >
                Contact Sales
              </button>
            </form>
          )}
        </div>
      </div>

      <MarketingFooter />
    </div>
  );
}
