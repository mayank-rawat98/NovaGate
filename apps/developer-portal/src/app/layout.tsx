import type { Metadata } from 'next';
import './global.css';

export const metadata: Metadata = {
  title: { template: '%s | Developer portal', default: 'Developer portal' },
  description: 'API catalog, self-service keys and usage.',
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
