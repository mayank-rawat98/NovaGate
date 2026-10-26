interface GatewayStatusPillProps {
  online: boolean;
  degraded: boolean;
  state?: 'loading' | 'unknown';
}

export function GatewayStatusPill({
  online,
  degraded,
  state,
}: GatewayStatusPillProps) {
  if (state)
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-slate-400"
        />
        {state === 'loading' ? 'Checking status' : 'Status unavailable'}
      </span>
    );
  if (online && !degraded) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-800">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        Online
      </span>
    );
  }
  if (online && degraded) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-100 px-2.5 py-1 text-xs font-medium text-yellow-800">
        <span className="h-1.5 w-1.5 rounded-full bg-yellow-500" />
        Degraded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-800">
      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      Offline
    </span>
  );
}
