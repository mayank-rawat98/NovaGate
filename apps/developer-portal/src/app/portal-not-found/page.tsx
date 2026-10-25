export const metadata = { title: 'Portal not found' };

export default function PortalNotFound() {
  return (
    <main className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold text-slate-900">
        Portal not available
      </h1>
      <p className="mt-3 text-slate-700">
        No published developer portal uses this address, or it is temporarily
        unreachable. Check the link with your API provider.
      </p>
    </main>
  );
}
