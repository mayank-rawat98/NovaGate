import Link from 'next/link';

const COLS = [
  {
    title: 'Product',
    items: [
      { label: 'Features', href: '/features' },
      { label: 'Security', href: '/security' },
      { label: 'Docker Deploy', href: '/docker' },
      { label: 'Enterprise', href: '/enterprise' },
    ],
  },
  {
    title: 'Resources',
    items: [
      { label: 'Documentation', href: '/docs' },
      { label: 'API Reference', href: '/api-reference' },
      { label: 'Support', href: '/support' },
      { label: 'Status', href: '/status' },
    ],
  },
  {
    title: 'Company',
    items: [
      { label: 'About Us', href: '/about' },
      { label: 'Privacy Policy', href: '/privacy' },
      { label: 'Terms of Service', href: '/terms' },
      { label: 'Contact', href: '/contact' },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="relative z-10 border-t border-white/[0.05] px-6 py-14 bg-[#08080f]">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-10 mb-12">
          <div className="col-span-2">
            <Link href="/" className="flex items-center gap-2 mb-4">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-600">
                <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
              </div>
              <span className="font-bold text-white tracking-tight">NovaGate</span>
            </Link>
            <p className="text-xs text-white/25 leading-relaxed max-w-[220px]">
              High-performance, hybrid API gateway infrastructure for modern engineering teams.
            </p>
            <p className="mt-3 text-xs text-white/18">novagate.dev</p>
          </div>
          {COLS.map((col) => (
            <div key={col.title}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-white/35 mb-4">{col.title}</p>
              <ul className="space-y-2.5">
                {col.items.map((item) => (
                  <li key={item.label}>
                    <Link href={item.href} className="text-xs text-white/25 hover:text-white/55 transition-colors duration-200">
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-white/[0.05] pt-6 flex flex-col md:flex-row items-center justify-between gap-3">
          <p className="text-[11px] text-white/18">© {new Date().getFullYear()} NovaGate. All rights reserved.</p>
          <p className="text-[11px] text-white/18">Built by engineers for engineers</p>
        </div>
      </div>
    </footer>
  );
}
