'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { verifyEmail } from '../../lib/api-client';
import { setToken, setTenantId } from '../../lib/auth';
import { AuthCard } from '../../components/auth-card';

function VerifyForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [status, setStatus] = useState<'verifying' | 'error'>('verifying');
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true; // guard against React strict-mode double-invoke

    verifyEmail(token)
      .then(({ token: authToken, tenantId, gatewayApiKey }) => {
        setToken(authToken);
        setTenantId(tenantId);
        localStorage.setItem('gw_setup_api_key', gatewayApiKey);
        toast.success('Email verified — deploying your gateway…');
        router.replace('/setup');
      })
      .catch((err: unknown) => {
        setStatus('error');
        setError(
          err instanceof Error
            ? err.message
            : 'Verification failed. The link may have expired.',
        );
      });
  }, [token, router]);

  if (!token) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <p className="text-sm text-red-400">
          Invalid verification link. Please sign up again to get a new one.
        </p>
        <Link
          href="/register"
          className="text-sm font-medium text-violet-400 transition-colors hover:text-violet-300"
        >
          Back to sign up
        </Link>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        <p className="rounded-lg bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
          {error}
        </p>
        <Link
          href="/register"
          className="text-sm font-medium text-violet-400 transition-colors hover:text-violet-300"
        >
          Sign up again
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 py-2">
      <svg
        className="h-8 w-8 animate-spin text-violet-400"
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
      <p className="text-center text-sm text-white/60">
        Confirming your email…
      </p>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <AuthCard title="Verifying" subtitle="Finishing your account setup">
      <Suspense fallback={<p className="text-sm text-white/40">Loading…</p>}>
        <VerifyForm />
      </Suspense>
    </AuthCard>
  );
}
