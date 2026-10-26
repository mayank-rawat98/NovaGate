'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';

export function DataLoadNotice({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => unknown | Promise<unknown>;
}) {
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      /* The parent retains its error state. */
    } finally {
      setRetrying(false);
    }
  }
  return (
    <div
      role="alert"
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <p>{label} could not be loaded. Please try again.</p>
      <button
        type="button"
        disabled={retrying}
        onClick={retry}
        className="inline-flex items-center gap-2 rounded-lg border border-amber-400 px-3 py-2 font-medium disabled:opacity-60"
      >
        <RefreshCw size={15} aria-hidden="true" />
        {retrying ? 'Retrying…' : 'Try again'}
      </button>
    </div>
  );
}
