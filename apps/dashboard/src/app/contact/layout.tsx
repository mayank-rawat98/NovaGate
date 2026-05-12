import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Get in touch with the NovaGate team. General enquiries, technical support, security disclosures, and enterprise plans — we respond personally within one business day.',
  openGraph: {
    title: 'Contact NovaGate',
    description: 'Reach us for support, security disclosures, enterprise enquiries, or general questions. We respond personally within one business day.',
    url: 'https://novagate.dev/contact',
  },
  alternates: { canonical: 'https://novagate.dev/contact' },
};

export default function ContactLayout({ children }: { children: React.ReactNode }) {
  return children;
}
