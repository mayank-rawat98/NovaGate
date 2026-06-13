'use client';

import { useState, FormEvent } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { MailCheck } from 'lucide-react';
import { register } from '../../lib/api-client';
import { AuthCard } from '../../components/auth-card';
import { PasswordInput } from '../../components/password-input';

const inputClass =
  'rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2.5 text-sm text-white placeholder-white/25 outline-none transition focus:border-violet-500/60 focus:ring-2 focus:ring-violet-500/20 w-full';

export default function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    try {
      await register(name, email, password);
      // Always the same generic outcome — we never learn (or reveal) whether
      // the email was already registered.
      setSubmitted(true);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <AuthCard
        title="Check your email"
        subtitle="One more step to set up your gateway"
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-600/15 text-violet-400">
            <MailCheck className="h-6 w-6" />
          </div>
          <p className="text-sm text-white/60">
            If{' '}
            <span className="font-medium text-white/80">
              {email || 'that address'}
            </span>{' '}
            is available, we&apos;ve sent a verification link. Click it to
            finish creating your account. The link expires in 1 hour.
          </p>
          <p className="text-xs text-white/35">
            Didn&apos;t get it? Check your spam folder, or{' '}
            <button
              type="button"
              onClick={() => setSubmitted(false)}
              className="font-medium text-violet-400 transition-colors hover:text-violet-300"
            >
              try again
            </button>
            .
          </p>
        </div>
        <p className="mt-6 text-center text-sm text-white/35">
          Already have an account?{' '}
          <Link
            href="/login"
            className="font-medium text-violet-400 transition-colors hover:text-violet-300"
          >
            Sign in
          </Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create account"
      subtitle="Set up your API Gateway in minutes"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="name" className="text-sm font-medium text-white/70">
            Full name
          </label>
          <input
            id="name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Smith"
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium text-white/70">
            Email address
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={inputClass}
          />
        </div>
        <PasswordInput
          id="password"
          label="Password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={setPassword}
          placeholder="At least 8 characters"
        />
        <button
          type="submit"
          disabled={loading}
          className="flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-violet-900/40 transition hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2 focus:ring-offset-transparent disabled:opacity-50"
        >
          {loading ? (
            <>
              <svg
                className="h-4 w-4 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Creating account…
            </>
          ) : (
            'Create account'
          )}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-white/35">
        Already have an account?{' '}
        <Link
          href="/login"
          className="font-medium text-violet-400 hover:text-violet-300 transition-colors"
        >
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
