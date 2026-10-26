'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { getCatalog, register } from '../../../../lib/portal-api';
import { usePortal } from '../../../../components/portal-provider';
import { Field, FormError } from '../../../../components/field';

export default function RegisterPage() {
  const { tenant, href } = usePortal();
  const { data } = useSWR(['portal-catalog', tenant], () => getCatalog(tenant));
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [done, setDone] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (form.password.length < 10)
      return setFailure('Use a password of at least 10 characters.');
    setBusy(true);
    setFailure('');
    try {
      setDone((await register(tenant, form)).message);
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : 'Registration failed. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (data?.signup === 'closed')
    return (
      <section className="mx-auto max-w-md rounded-3xl border border-indigo-100 bg-white p-6">
        <h1 className="text-2xl font-semibold text-slate-900">
          Registration is closed
        </h1>
        <p className="mt-3 text-slate-700">
          This provider is not accepting new developer accounts. Contact them
          for access, or{' '}
          <Link href={href('/login')} className="font-medium underline">
            sign in
          </Link>{' '}
          with an existing account.
        </p>
      </section>
    );
  return (
    <section className="mx-auto max-w-md rounded-3xl border border-indigo-100 bg-white p-6">
      <h1 className="text-2xl font-semibold text-slate-900">
        Create a developer account
      </h1>
      {done ? (
        <p role="status" className="mt-4 text-slate-800">
          {done}
        </p>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field
            label="Name"
            autoComplete="name"
            required
            maxLength={128}
            value={form.name}
            disabled={busy}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            disabled={busy}
            onChange={(event) =>
              setForm({ ...form, email: event.target.value })
            }
          />
          <Field
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            hint="At least 10 characters."
            value={form.password}
            disabled={busy}
            onChange={(event) =>
              setForm({ ...form, password: event.target.value })
            }
          />
          <FormError message={failure} />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-indigo-700 px-4 py-3 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>
      )}
    </section>
  );
}
