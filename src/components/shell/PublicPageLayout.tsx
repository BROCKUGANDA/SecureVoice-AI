import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark } from "@/components/shell/Logo";
import { StandaloneProvider } from "@/components/shell/standalone-context";
import { SUPPORT_EMAIL } from "@/lib/public-config";

/**
 * Shell for the standalone public routes — `/pricing`, `/terms`, `/privacy`,
 * `/refund`, `/docs`, `/security`, `/usecases`.
 *
 * Renamed from `LegalPageLayout` when the legal trio grew into the full public
 * route set. "PublicPageLayout" is what it always was.
 *
 * A Server Component on purpose: pure markup, no state, no handlers. The
 * standalone flag the views need is published by a separate Client Component —
 * see `standalone-context.tsx` for why that is not declared here.
 *
 * WHY THESE PAGES DO NOT REUSE THE APP'S Navbar AND Footer
 * Both drive the SPA through `setView()`, and on a standalone route there is no
 * `src/app/page.tsx` mounted to receive that state change. A Footer rendered here
 * would show links that silently do nothing — which is worse than having fewer
 * links, and it is exactly the "must be clearly accessible via navigation"
 * requirement being satisfied in appearance only.
 *
 * So every link in this shell is a real `<a>` to a real URL.
 */

/**
 * The whole public, crawlable surface. `/` carries the rest of the marketing —
 * it is the single-page app, so anything not listed here is a panel inside it.
 */
const LINKS: { href: string; label: string }[] = [
  { href: "/", label: "Overview" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Documentation" },
  { href: "/security", label: "Security" },
  { href: "/usecases", label: "Use Cases" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/refund", label: "Refund" },
];

export function PublicPageLayout({
  children,
  current,
}: {
  children: ReactNode;
  /** Path of this page, so the footer can mark it `aria-current`. */
  current: string;
}) {
  return (
    <StandaloneProvider>
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
            <nav aria-label="Site" className="flex flex-wrap gap-x-6 gap-y-2">
              {LINKS.map((l) => (
                <a
                  key={l.href}
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
    </StandaloneProvider>
  );
}
