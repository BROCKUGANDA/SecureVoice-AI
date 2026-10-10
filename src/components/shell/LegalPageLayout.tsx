import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark } from "@/components/shell/Logo";
import { SUPPORT_EMAIL } from "@/lib/public-config";

/**
 * Shell for the standalone public routes (`/pricing`, `/terms`, `/privacy`,
 * `/refund`).
 *
 * WHY THESE PAGES DO NOT REUSE THE APP'S Navbar AND Footer
 * Both of those drive the SPA through `setView()`, and on a standalone route
 * there is no `src/app/page.tsx` mounted to receive that state change. A Footer
 * rendered here would show five links that silently do nothing — which is worse
 * than having fewer links, and it is exactly the "must be clearly accessible via
 * navigation" requirement being satisfied in appearance only.
 *
 * So every link on these pages is a real `<a>` to a real URL. There is nothing
 * here that can be a dead control.
 *
 * The set below is the whole public, crawlable surface. `/` covers the rest of
 * the marketing and docs content, which is panels inside it.
 */
const LINKS: { href: string; label: string }[] = [
  { href: "/", label: "Overview" },
  { href: "/pricing", label: "Pricing" },
  { href: "/", label: "Documentation" },
  { href: "/", label: "Security" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/refund", label: "Refund" },
];

export function LegalPageLayout({
  children,
  current,
}: {
  children: ReactNode;
  /** Path of this page, so the footer can mark it `aria-current`. */
  current: string;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="group flex items-center gap-2.5"
            aria-label="SecureVoice AI home"
          >
            <span className="transition-transform duration-300 group-hover:scale-105">
              <LogoMark size={36} />
            </span>
            <span className="flex flex-col items-start leading-none">
              <span className="font-display text-[15px] font-semibold tracking-tight">
                SecureVoice <span className="text-primary">AI</span>
              </span>
              <span className="micro mt-1 text-[9px] text-ink-3">Fraud Intervention</span>
            </span>
          </Link>
          <a
            href="/"
            className="ml-auto rounded-full border border-line bg-paper px-3.5 py-2 text-[12.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
          >
            Back to site
          </a>
        </div>
      </header>

      <main id="main-content" className="flex-1">
        {children}
      </main>

      <footer className="mt-auto border-t border-line bg-white">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-2">
            {LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                aria-current={l.href === current ? "page" : undefined}
                className="text-[12px] font-medium text-ink-2 underline-offset-4 transition hover:text-primary hover:underline"
              >
                {l.label}
              </a>
            ))}
          </nav>
          <p className="mt-5 text-[10.5px] leading-relaxed text-ink-3">
            © 2026 SecureVoice Technologies FZ-LLC · Dubai, United Arab Emirates ·{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-2">
              {SUPPORT_EMAIL}
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
