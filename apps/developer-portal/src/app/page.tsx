export default function SharedHostHome() {
  return (
    <main className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold text-slate-900">
        Developer portal
      </h1>
      <p className="mt-3 text-slate-700">
        Open the portal link your API provider shared with you. It looks like
        this address followed by <code className="font-mono">/w/</code> and a
        workspace identifier, or uses the provider&apos;s own domain.
      </p>
    </main>
  );
}
