'use client';

import { useState, FormEvent, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { resetPassword } from '../../lib/api-client';
import { AuthCard } from '../../components/auth-card';
import { PasswordInput } from '../../components/password-input';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await resetPassword(token, password);
      setDone(true);
      setTimeout(() => router.replace('/login'), 2500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Reset failed. The link may have expired.');
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <p className="text-sm text-red-600">Invalid reset link. Please request a new one.</p>
        <Link href="/forgot-password" className="text-sm font-medium text-blue-600 hover:text-blue-500">
          Request new link
        </Link>
      </div>
    );
  }

  return done ? (
    <div className="flex flex-col items-center gap-4 py-2">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
        <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <p className="text-center text-sm text-gray-600">
        Password updated. Redirecting to sign in…
      </p>
    </div>
  ) : (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <PasswordInput
        id="password"
        label="New password"
        autoComplete="new-password"
        required
        minLength={8}
        value={password}
        onChange={setPassword}
        placeholder="At least 8 characters"
      />
      <PasswordInput
        id="confirm"
        label="Confirm password"
        autoComplete="new-password"
        required
        minLength={8}
        value={confirm}
        onChange={setConfirm}
        placeholder="Repeat your new password"
      />
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</p>
      )}
      <button
        type="submit"
        disabled={loading}
        className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
      >
        {loading ? (
          <>
            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Saving…
          </>
        ) : 'Set new password'}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthCard title="Set new password" subtitle="Choose a strong password for your account">
      <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
        <ResetPasswordForm />
      </Suspense>
    </AuthCard>
  );
}
