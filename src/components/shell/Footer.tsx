"use client";

import { useApp, type View } from "@/lib/store";
import { useViewerSeat } from "@/lib/auth/use-viewer-seat";
import { atLeast } from "@/lib/auth/seat";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { APP_VERSION, versionLabel } from "@/lib/version";
import { LogoMark } from "@/components/shell/Logo";
import { Mail } from "lucide-react";

type Link = { id?: View; href?: string; en: string; ar: string };

const PRODUCT: Link[] = [
  { id: "demo", en: "Live Demo", ar: "عرض حي" },
  { id: "dashboard", en: "Dashboard", ar: "اللوحة" },
  { id: "product", en: "Deep Dive", ar: "التفاصيل" },
];

/**
 * Every public page that is a REAL ROUTE, as real anchors.
 *
 * `/` is the only indexable document a crawler used to see, so anything linked
 * only with a `setView` button was unreachable to it: the Terms of Service was
 * not linked anywhere on the site at all, and Docs and Security — the two pages
 * a bank integrator and a procurement reviewer look for by name — needed someone
 * who already knew to click. A crawler reads links. It does not click buttons.
 *
 * `rel="nofollow"` is deliberately absent. These are the pages we want followed.
 *
 * Use Cases is here too because it is a route now; the authenticated views are
 * not, deliberately, and stay as buttons.
 */
const ROUTES: Link[] = [
  { href: "/pricing", en: "Pricing", ar: "الأسعار" },
  { href: "/docs", en: "Documentation", ar: "التوثيق" },
  { href: "/security", en: "Security", ar: "الأمن" },
  { href: "/usecases", en: "Use Cases", ar: "حالات الاستخدام" },
  // Public and indexable, like every other link in this column. A reader who
  // cannot find "who built this" from the footer concludes there is nobody to
  // find, which is the opposite of what a one-person team wants a procurement
  // thread to conclude.
  { href: "/team", en: "Team", ar: "الفريق" },
  { href: "/faq", en: "FAQ", ar: "الأسئلة الشائعة" },
  { href: "/terms", en: "Terms of Service", ar: "الشروط والأحكام" },
  { href: "/privacy", en: "Privacy Policy", ar: "سياسة الخصوصية" },
  { href: "/refund", en: "Refund Policy", ar: "سياسة الاسترداد" },
];

/** The console screens, grouped for the signed-in footer. */
const CONSOLE_LINKS: Link[] = [
  { id: "dashboard", en: "Dashboard", ar: "اللوحة" },
  { id: "console", en: "Command Center", ar: "مركز التشغيل" },
  { id: "demo", en: "Live Demo", ar: "عرض حي" },
  { id: "settings", en: "Settings", ar: "الإعدادات" },
];

export function Footer() {
  const { setView, lang } = useApp();
  const { seat, isSignedIn, user } = useViewerSeat();
  const ar = lang === "ar";

  const label = (l: Link) => (ar ? l.ar : l.en);

  /**
   * A signed-out visitor gets the marketing footer. A signed-in one gets an app
   * footer: their own console screens, in one column, plus the legal and
   * security pages they still need to be able to reach.
   *
   * The reason the old layout read as unorganised for a signed-in operator is
   * that it was a fixed four-column marketing grid describing a product page
   * they are not looking at — a "Live Demo" link beside "Refund Policy" beside
   * their own name is not a hierarchy, it is a list. An operator's footer is a
   * different document and now reads as one: WHO you are, WHERE you can go, and
   * the legal pages that apply either way.
   */
  const group = (links: Link[]) =>
    links.map((l) => (
      <button
        key={l.id ?? l.href}
        onClick={() => l.id && setView(l.id)}
        className="block text-start text-[12px] font-medium text-ink-2 transition hover:text-primary"
      >
        {label(l)}
      </button>
    ));

  return (
    <footer className="mt-auto border-t border-line bg-white">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {isSignedIn ? (
          /* ── Signed in: an app footer, not a marketing grid ─────────────────── */
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.2fr]">
            {/* who you are signed in as */}
            <div>
              <div className="flex items-center gap-2.5">
                <LogoMark size={30} />
                <div className="leading-tight">
                  <p className="text-[13px] font-semibold">SecureVoice AI</p>
                  <p className="micro text-[8.5px] text-ink-3">CONSOLE · v1.0</p>
                </div>
              </div>
              <p className="mt-3 max-w-xs text-[11.5px] leading-relaxed text-ink-3">
                {user?.name || user?.email}
              </p>
            </div>

            {/* the screens this seat may open */}
            <nav aria-label="Console">
              <p className="micro text-[9px] text-ink-3">CONSOLE</p>
              <div className="mt-3 space-y-2">
                {group(
                  CONSOLE_LINKS.filter((l) => {
                    const required =
                      l.id === "settings" ? "operator" : l.id === "console" ? "vendor" : null;
                    return required === null || (seat !== null && atLeast(seat, required));
                  }),
                )}
              </div>
            </nav>

            {/* platform — the public pages, as real routes */}
            <nav aria-label="Platform">
              <p className="micro text-[9px] text-ink-3">PLATFORM</p>
              <div className="mt-3 space-y-2">
                {ROUTES.filter(
                  (l) => l.href === "/docs" || l.href === "/security" || l.href === "/usecases" || l.href === "/team",
                ).map((l) => (
                  <a
                    key={l.href}
                    href={l.href}
                    className="block text-[12px] font-medium text-ink-2 transition hover:text-primary"
                  >
                    {label(l)}
                  </a>
                ))}
              </div>
            </nav>

            {/* legal */}
            <nav aria-label="Legal">
              <p className="micro text-[9px] text-ink-3">LEGAL</p>
              <div className="mt-3 space-y-2">
                {ROUTES.filter(
                  (l) => l.href === "/terms" || l.href === "/privacy" || l.href === "/refund",
                ).map((l) => (
                  <a
                    key={l.href}
                    href={l.href}
                    className="block text-[12px] font-medium text-ink-2 transition hover:text-primary"
                  >
                    {label(l)}
                  </a>
                ))}
              </div>
            </nav>
          </div>
        ) : (
          /* ── Signed out: the public marketing footer ────────────────────────── */
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_3fr]">
            {/* brand */}
            <div>
              <div className="flex items-center gap-2.5">
                <LogoMark size={30} />
                <div className="leading-tight">
                  <p className="text-[13px] font-semibold">SecureVoice AI</p>
                  <p className="micro text-[8.5px] text-ink-3">FRAUD INTERVENTION · v1.0</p>
                </div>
              </div>
              <p className="mt-3 max-w-xs text-[11.5px] leading-relaxed text-ink-3">
                Real-time fraud intervention for banks & insurers · CBUAE-aligned · Dubai, UAE
              </p>
              <p dir="rtl" className="font-arabic mt-2 text-[11.5px] text-ink-3">
                صوت آمن · حماية خلال ٦٠ ثانية
              </p>
            </div>

            {/* product — the authenticated views, which have no URL */}
            <nav aria-label="Product">
              <p className="micro text-[9px] text-ink-3">PRODUCT</p>
              <div className="mt-3 space-y-2">{group(PRODUCT)}</div>
            </nav>

            {/* every real public route. Anchors, not buttons — see ROUTES above. */}
            <nav aria-label="Public pages" className="sm:col-span-2 lg:col-span-3">
              <p className="micro text-[9px] text-ink-3">SITE</p>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
                {ROUTES.map((l) => (
                  <a
                    key={l.href}
                    href={l.href}
                    className="block text-[12px] font-medium text-ink-2 transition hover:text-primary"
                  >
                    {label(l)}
                  </a>
                ))}
              </div>
            </nav>
          </div>
        )}

        {/* contact — shared. A signed-in operator needs the support address just
            as much as a visitor, and in the app-footer branch there is no brand
            column to carry it. */}
        <div className="mt-8 border-t border-line pt-6">
          <p className="micro text-[9px] text-ink-3">CONTACT</p>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="mt-2 inline-flex items-center gap-2 rounded-full border border-line bg-paper px-3.5 py-2 text-[12px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
          >
            <Mail className="h-3.5 w-3.5 text-primary" />
            {SUPPORT_EMAIL}
          </a>
          <p className="mt-2.5 text-[11px] leading-snug text-ink-3">
            {ar
              ? "للبنوك وشركات التأمين — تجارب ميدانية متاحة"
              : "For banks & insurers — pilot programs open"}
          </p>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <p className="text-[10.5px] text-ink-3">
            © 2026 SecureVoice AI · Built for UAE banks & insurers
          </p>
          {/* Release version, read from package.json at build time (src/lib/version.ts)
              — not typed here, so it cannot drift from the build actually serving. */}
          <p
            className="num text-[10.5px] text-ink-3"
            title={`SecureVoice AI release ${APP_VERSION}`}
          >
            {versionLabel()}
          </p>
        </div>
      </div>
    </footer>
  );
}
