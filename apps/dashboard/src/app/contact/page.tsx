'use client';

import { useState } from 'react';
import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

const SUBJECTS = [
  'General Enquiry',
  'Technical Support',
  'Enterprise Plan',
  'Security Disclosure',
  'Partnership',
  'Press / Media',
];

export default function ContactPage() {
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', subject: SUBJECTS[0], message: '' });

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-4xl mx-auto px-6 py-20">
        <div className="mb-14">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">CONTACT</p>
          <h1 className="text-4xl font-black tracking-tight mb-4">Get in Touch</h1>
          <p className="text-white/40 text-base max-w-xl leading-relaxed">
            We are a small team and we respond personally. Expect a reply within one business day.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-10">
          {/* Contact details */}
          <div className="space-y-6">
            {[
              {
                label: 'General',
                email: 'hello@novagate.dev',
                desc: 'Product questions, feedback, anything else.',
              },
              {
                label: 'Support',
                email: 'support@novagate.dev',
                desc: 'Account issues, gateway errors, setup help.',
              },
              {
                label: 'Security',
                email: 'security@novagate.dev',
                desc: 'Responsible disclosure. We acknowledge within 24 hours.',
              },
              {
                label: 'Enterprise',
                email: 'enterprise@novagate.dev',
                desc: 'SLAs, private Slack, dedicated support.',
              },
            ].map((c) => (
              <div key={c.label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-violet-400/60 mb-1">{c.label}</p>
                <a
                  href={`mailto:${c.email}`}
                  className="text-sm font-medium text-white hover:text-violet-300 transition-colors"
                >
                  {c.email}
                </a>
                <p className="mt-1 text-xs text-white/35 leading-relaxed">{c.desc}</p>
              </div>
            ))}
          </div>

          {/* Form */}
          <div className="md:col-span-2">
            {submitted ? (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-10 text-center">
                <svg className="h-10 w-10 text-emerald-400 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <h2 className="text-xl font-bold mb-2">Message sent</h2>
                <p className="text-sm text-white/45">
                  Thanks, {form.name.split(' ')[0]}. We will reply to {form.email} within one business day.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-8 space-y-5">
                <div className="grid sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-xs font-medium text-white/50 mb-1.5">Name</label>
                    <input
                      name="name"
                      required
                      value={form.name}
                      onChange={handleChange}
                      placeholder="Your name"
                      className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-white/50 mb-1.5">Email</label>
                    <input
                      name="email"
                      type="email"
                      required
                      value={form.email}
                      onChange={handleChange}
                      placeholder="you@company.com"
                      className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-white/50 mb-1.5">Subject</label>
                  <select
                    name="subject"
                    value={form.subject}
                    onChange={handleChange}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-colors appearance-none"
                  >
                    {SUBJECTS.map((s) => (
                      <option key={s} value={s} className="bg-[#12121e]">{s}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-white/50 mb-1.5">Message</label>
                  <textarea
                    name="message"
                    required
                    rows={6}
                    value={form.message}
                    onChange={handleChange}
                    placeholder="Tell us what you need…"
                    className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-colors resize-none"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full rounded-lg bg-violet-600 py-3 text-sm font-semibold text-white hover:bg-violet-500 transition-colors"
                >
                  Send Message
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      <MarketingFooter />
    </div>
  );
}
