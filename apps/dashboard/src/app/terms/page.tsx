import { MarketingNav } from '../../components/marketing-nav';
import { MarketingFooter } from '../../components/marketing-footer';

const SECTIONS = [
  {
    title: '1. Acceptance of Terms',
    content: [
      'By creating a NovaGate account or using the NovaGate service, you agree to these Terms of Service.',
      'If you are using the service on behalf of an organisation, you represent that you have authority to bind that organisation to these terms.',
    ],
  },
  {
    title: '2. Description of Service',
    content: [
      'NovaGate provides an API gateway platform consisting of: a cloud-hosted control plane and admin dashboard, and a self-hosted gateway node you deploy on your own infrastructure.',
      'The service is provided during a public beta period, during which all features are free of charge.',
    ],
  },
  {
    title: '3. Acceptable Use',
    content: [
      'You may use the service to proxy HTTP traffic to your own backend services.',
      'You may not use the service to proxy traffic for illegal purposes, to circumvent rate limits of third-party APIs, or to conduct denial-of-service attacks.',
      'You may not attempt to access, modify, or interfere with other tenants\' data or infrastructure.',
      'You are responsible for all activity that occurs under your account.',
    ],
  },
  {
    title: '4. Your Data',
    content: [
      'You retain ownership of all data that passes through your gateway node. NovaGate does not receive your API request or response payloads.',
      'You grant NovaGate a limited licence to store and process the telemetry data your gateway sends (request metadata) solely to provide the service.',
      'You are responsible for ensuring that your use of the service complies with applicable data protection laws regarding the telemetry data you transmit.',
    ],
  },
  {
    title: '5. Account Security',
    content: [
      'You are responsible for maintaining the confidentiality of your account credentials and gateway API keys.',
      'You must notify us immediately at security@novagate.dev if you suspect unauthorised access to your account.',
      'NovaGate is not liable for losses arising from compromised credentials due to your failure to maintain their confidentiality.',
    ],
  },
  {
    title: '6. Availability',
    content: [
      'NovaGate aims to maintain high availability of the control plane and admin dashboard. However, no uptime guarantee is provided during the beta period.',
      'The self-hosted gateway node is designed to continue operating if the control plane is temporarily unavailable. NovaGate is not responsible for impacts to your service that result from control plane downtime.',
    ],
  },
  {
    title: '7. Intellectual Property',
    content: [
      'The NovaGate software, documentation, and brand are owned by NovaGate. Nothing in these terms transfers intellectual property rights to you.',
      'You retain all intellectual property rights in the configuration, routes, and data you create within the service.',
    ],
  },
  {
    title: '8. Limitation of Liability',
    content: [
      'The service is provided "as is" during the beta period. To the fullest extent permitted by law, NovaGate disclaims all warranties.',
      'NovaGate\'s total liability to you for any claim arising from use of the service shall not exceed the amount you paid to NovaGate in the 12 months preceding the claim.',
    ],
  },
  {
    title: '9. Termination',
    content: [
      'You may close your account at any time by contacting support@novagate.dev.',
      'We may suspend or terminate accounts that violate these terms after providing reasonable notice, except in cases of severe violations where immediate action is required.',
      'On termination, your data will be deleted within 30 days.',
    ],
  },
  {
    title: '10. Changes to Terms',
    content: [
      'We may update these terms. We will notify registered users by email at least 14 days before changes take effect.',
      'Continued use of the service constitutes acceptance of updated terms.',
    ],
  },
  {
    title: '11. Governing Law',
    content: [
      'These terms are governed by the laws of India. Disputes shall be subject to the exclusive jurisdiction of courts in India.',
    ],
  },
  {
    title: '12. Contact',
    content: [
      'For questions about these terms: legal@novagate.dev',
    ],
  },
];

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <MarketingNav />

      <div className="max-w-3xl mx-auto px-6 py-20">
        <div className="mb-12">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-500/50 mb-3">LEGAL</p>
          <h1 className="text-4xl font-black tracking-tight mb-3">Terms of Service</h1>
          <p className="text-white/35 text-sm">Last updated: {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>

        <div className="space-y-10">
          {SECTIONS.map((sec) => (
            <section key={sec.title}>
              <h2 className="text-lg font-bold text-white mb-4">{sec.title}</h2>
              <ul className="space-y-3">
                {sec.content.map((item, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-white/45 leading-relaxed">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400/50" />
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>

      <MarketingFooter />
    </div>
  );
}
