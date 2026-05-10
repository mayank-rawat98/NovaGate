'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { register } from '../../lib/api-client';
import { setToken, setTenantId } from '../../lib/auth';
import { AuthCard } from '../../components/auth-card';
import { PasswordInput } from '../../components/password-input';

const inputClass =
  'rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2.5 text-sm text-white placeholder-white/25 outline-none transition focus:border-violet-500/60 focus:ring-2 focus:ring-violet-500/20 w-full';

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { token, tenantId, gatewayApiKey } = await register(name, email, password);
      setToken(token);
      setTenantId(tenantId);
      localStorage.setItem('gw_setup_api_key', gatewayApiKey);
      router.replace('/setup');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard title="Create account" subtitle="Set up your API Gateway in minutes">
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
        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2.5">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}
        <button
          type="submit"
          disabled={loading}
          className="flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-violet-900/40 transition hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2 focus:ring-offset-transparent disabled:opacity-50"
        >
          {loading ? (
            <>
              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Creating account…
            </>
          ) : 'Create account'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-white/35">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-violet-400 hover:text-violet-300 transition-colors">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
