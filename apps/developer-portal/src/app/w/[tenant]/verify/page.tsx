'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { verifyEmail } from '../../../../lib/portal-api';
import { saveSession } from '../../../../lib/session';
import { usePortal } from '../../../../components/portal-provider';

export default function VerifyPage() {
  const { tenant, href } = usePortal();
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [failure, setFailure] = useState('');
  const started = useRef(false);
  useEffect(() => {
    // Verification tokens are single use; never submit one twice.
    if (started.current) return;
    started.current = true;
    verifyEmail(tenant, token)
      .then((session) => {
        saveSession(tenant, session);
        router.replace(href('/keys'));
      })
      .catch((error: Error) => setFailure(error.message));
  }, [tenant, token, router, href]);
  return (
    <section className="mx-auto max-w-md rounded-3xl border border-indigo-100 bg-white p-6">
      <h1 className="text-2xl font-semibold text-slate-900">
        Confirm your email
      </h1>
      {failure ? (
        <div role="alert" className="mt-4 text-slate-800">
          <p>{failure}</p>
          <p className="mt-2">
            <Link href={href('/register')} className="font-medium underline">
              Register again
            </Link>{' '}
            to receive a new link.
          </p>
        </div>
      ) : (
        <p role="status" className="mt-4 text-slate-700">
          Confirming your account…
        </p>
      )}
    </section>
  );
}
