'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { login } from '../../lib/api-client';
import { setToken, setTenantId } from '../../lib/auth';
import { AuthCard } from '../../components/auth-card';
import { PasswordInput } from '../../components/password-input';

const inputClass =
  'rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2.5 text-sm text-white placeholder-white/25 outline-none transition focus:border-violet-500/60 focus:ring-2 focus:ring-violet-500/20 w-full';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    try {
      const { token, tenantId } = await login(email, password);
      setToken(token);
      setTenantId(tenantId);
      toast.success('Signed in successfully');
      router.replace('/dashboard');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard title="Sign in" subtitle="Welcome back to your gateway dashboard">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="text-sm font-medium text-white/70">
              Password
            </label>
            <Link href="/forgot-password" className="text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors">
              Forgot password?
            </Link>
          </div>
          <PasswordInput
            id="password"
            label=""
            autoComplete="current-password"
            required
            value={password}
            onChange={setPassword}
          />
        </div>
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
              Signing in…
            </>
          ) : 'Sign in'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-white/35">
        No account?{' '}
        <Link href="/register" className="font-medium text-violet-400 hover:text-violet-300 transition-colors">
          Create one
        </Link>
      </p>
    </AuthCard>
  );
}
