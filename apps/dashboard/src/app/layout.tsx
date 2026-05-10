import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import './global.css';
import { SidebarShell } from '../components/sidebar-shell';

export const metadata: Metadata = {
  metadataBase: new URL('https://novagate.dev'),
  title: {
    template: '%s | NovaGate',
    default: 'NovaGate — Self-Hosted API Gateway',
  },
  description:
    'NovaGate is a hybrid SaaS API gateway. Deploy the gateway on your own VPS, manage everything from a hosted dashboard. JWT auth, rate limiting, and real-time observability — free during beta.',
  keywords: [
    'api gateway',
    'self-hosted api gateway',
    'kong alternative',
    'api proxy',
    'jwt authentication gateway',
    'rate limiting',
    'docker api gateway',
    'api observability',
    'novagate',
  ],
  openGraph: {
    type: 'website',
    siteName: 'NovaGate',
    title: 'NovaGate — Self-Hosted API Gateway',
    description:
      'Deploy the gateway on your own server. Manage routes, rate limits, and observability from a hosted dashboard. Free during beta.',
    url: 'https://novagate.dev',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'NovaGate API Gateway' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'NovaGate — Self-Hosted API Gateway',
    description:
      'Deploy the gateway on your own server. Manage routes, rate limits, and observability from a hosted dashboard.',
    images: ['/og-image.png'],
  },
  robots: { index: true, follow: true },
  alternates: { canonical: 'https://novagate.dev' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SidebarShell>{children}</SidebarShell>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: { background: '#18181b', border: '1px solid rgba(255,255,255,0.08)', color: '#fff' },
          }}
          richColors
        />
      </body>
    </html>
  );
}
