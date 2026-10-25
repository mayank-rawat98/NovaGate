import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { PortalProvider } from '../../../components/portal-provider';
import { PortalShell } from '../../../components/portal-shell';

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenant: string }>;
}) {
  const { tenant } = await params;
  if (!UUID.test(tenant)) notFound();
  // Custom domains serve the workspace at their root; the proxy sets this.
  const base =
    (await headers()).get('x-novagate-portal-mode') === 'domain'
      ? ''
      : `/w/${tenant}`;
  return (
    <PortalProvider tenant={tenant.toLowerCase()} base={base}>
      <PortalShell>{children}</PortalShell>
    </PortalProvider>
  );
}
