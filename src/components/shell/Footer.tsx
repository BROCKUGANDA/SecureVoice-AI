"use client";

import { useApp, type View } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { LogoMark } from "@/components/shell/Logo";
import { Mail } from "lucide-react";

const PRODUCT: { id: View; en: string; ar: string }[] = [
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
 * Use Cases is here too (it moved out of PRODUCT above) because it is a route
 * now; the authenticated views above are not, deliberately, and stay as buttons.
 */
const ROUTES: { href: string; en: string; ar: string }[] = [
  { href: "/pricing", en: "Pricing", ar: "الأسعار" },
  { href: "/docs", en: "Documentation", ar: "التوثيق" },
  { href: "/security", en: "Security", ar: "الأمن" },
  { href: "/usecases", en: "Use Cases", ar: "حالات الاستخدام" },
  { href: "/terms", en: "Terms of Service", ar: "الشروط والأحكام" },
  { href: "/privacy", en: "Privacy Policy", ar: "سياسة الخصوصية" },
  { href: "/refund", en: "Refund Policy", ar: "سياسة الاسترداد" },
];

export function Footer() {
  const { setView, lang } = useApp();
  const ar = lang === "ar";

  const group = (links: { id: View; en: string; ar: string }[]) =>
    links.map((l) => (
      <button
        key={l.id}
        onClick={() => setView(l.id)}
        className="block text-left text-[12px] font-medium text-ink-2 transition hover:text-primary"
      >
        {ar ? l.ar : l.en}
      </button>
    ));

  return (
    <footer className="mt-auto border-t border-line bg-white">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
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
              Real-time fraud intervention for banks · CBUAE-aligned · Dubai, UAE
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
                  {ar ? l.ar : l.en}
                </a>
              ))}
            </div>
          </nav>

          {/* contact */}
          <div>
            <p className="micro text-[9px] text-ink-3">CONTACT</p>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="mt-3 inline-flex items-center gap-2 rounded-full border border-line bg-paper px-3.5 py-2 text-[12px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
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
        </div>

        <div className="mt-8 border-t border-line pt-4">
          <p className="text-[10.5px] text-ink-3">© 2026 SecureVoice AI · Built for UAE banking</p>
        </div>
      </div>
    </footer>
  );
}
