import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Create Account',
  description: 'Create a free NovaGate account. Deploy your self-hosted API gateway in under 5 minutes. No credit card required.',
  keywords: ['novagate signup', 'free api gateway', 'api gateway free trial'],
  openGraph: {
    title: 'Create a Free NovaGate Account',
    description: 'Deploy your self-hosted API gateway in under 5 minutes. Free during public beta — no credit card required.',
    url: 'https://novagate.dev/register',
  },
  alternates: { canonical: 'https://novagate.dev/register' },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
