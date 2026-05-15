'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#08080f] text-white flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">
          Error
        </p>
        <h1 className="text-3xl font-black tracking-tight mb-3">
          Something went wrong
        </h1>
        <p className="text-sm text-white/40 leading-relaxed mb-8">
          {error.message || 'An unexpected error occurred. Please try again.'}
        </p>
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={reset}
            className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-lg border border-white/10 px-5 py-2.5 text-sm font-semibold text-white/60 hover:text-white hover:bg-white/5 transition-colors"
          >
            Go home
          </Link>
        </div>
        {error.digest && (
          <p className="mt-6 text-[10px] text-white/20 font-mono">
            ref: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
