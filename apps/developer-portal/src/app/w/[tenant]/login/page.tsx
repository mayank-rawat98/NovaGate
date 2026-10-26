'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { login } from '../../../../lib/portal-api';
import { saveSession } from '../../../../lib/session';
import { usePortal } from '../../../../components/portal-provider';
import { Field, FormError } from '../../../../components/field';

export default function LoginPage() {
  const { tenant, href } = usePortal();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure('');
    try {
      saveSession(tenant, await login(tenant, { email, password }));
      router.push(href('/keys'));
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : 'Sign-in failed. Try again.',
      );
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto max-w-md rounded-3xl border border-indigo-100 bg-white p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Sign in</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          disabled={busy}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        <FormError message={failure} />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-indigo-700 px-4 py-3 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-700">
        New here?{' '}
        <Link href={href('/register')} className="font-medium underline">
          Create a developer account
        </Link>
      </p>
    </section>
  );
}
