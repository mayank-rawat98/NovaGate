export function LoadNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
    >
      <p>{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 font-medium underline"
        >
          Try again
        </button>
      )}
    </div>
  );
}
