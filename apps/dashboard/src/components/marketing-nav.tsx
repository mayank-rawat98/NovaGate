import Link from 'next/link';

export function MarketingNav() {
  return (
    <nav className="relative z-10 flex items-center justify-between px-6 md:px-10 py-5 border-b border-white/[0.06] bg-[#08080f]/80 backdrop-blur-md sticky top-0">
      <Link href="/" className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600 shadow-lg shadow-violet-900/50">
          <svg
            className="h-4 w-4 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
            />
          </svg>
        </div>
        <span className="font-bold text-white tracking-tight">NovaGate</span>
      </Link>
      <div className="hidden md:flex items-center gap-8 text-sm text-white/50">
        <Link
          href="/#architecture"
          className="hover:text-white transition-colors duration-200"
        >
          Architecture
        </Link>
        <Link
          href="/#features"
          className="hover:text-white transition-colors duration-200"
        >
          Features
        </Link>
        <Link
          href="/#pricing"
          className="hover:text-white transition-colors duration-200"
        >
          Pricing
        </Link>
        <Link
          href="/docs"
          className="hover:text-white transition-colors duration-200"
        >
          Docs
        </Link>
      </div>
      <div className="flex items-center gap-2">
        <Link
          href="/login"
          className="rounded-lg px-4 py-2 text-sm text-white/60 hover:text-white hover:bg-white/5 transition-all duration-200"
        >
          Sign In
        </Link>
        <Link
          href="/register"
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-violet-900/40 hover:bg-violet-500 transition-all duration-200 hover:-translate-y-px"
        >
          Get Started
        </Link>
      </div>
    </nav>
  );
}
