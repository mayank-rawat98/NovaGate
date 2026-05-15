import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Enterprise',
  description:
    'NovaGate Enterprise: SLA guarantees, unlimited scale, private Slack support, and dedicated onboarding for teams running critical API infrastructure.',
  keywords: [
    'api gateway enterprise',
    'api gateway sla',
    'enterprise api management',
    'dedicated api support',
  ],
  openGraph: {
    title: 'NovaGate Enterprise — SLA, Private Support, Unlimited Scale',
    description:
      'SLA guarantees, unlimited routes and consumers, private Slack channel, and dedicated engineer support for your API infrastructure.',
    url: 'https://novagate.dev/enterprise',
  },
  alternates: { canonical: 'https://novagate.dev/enterprise' },
};

export default function EnterpriseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
