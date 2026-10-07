"use client";

import { useApp, type View } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { LogoMark } from "@/components/shell/Logo";
import { Mail } from "lucide-react";

const PRODUCT: { id: View; en: string; ar: string }[] = [
  { id: "demo", en: "Live Demo", ar: "عرض حي" },
  { id: "dashboard", en: "Dashboard", ar: "اللوحة" },
  { id: "product", en: "Deep Dive", ar: "التفاصيل" },
  { id: "usecases", en: "Use Cases", ar: "حالات الاستخدام" },
];

const RESOURCES: { id: View; en: string; ar: string }[] = [
  { id: "docs", en: "Documentation", ar: "التوثيق" },
  { id: "security", en: "Security", ar: "الأمن" },
  { id: "privacy", en: "Privacy", ar: "الخصوصية" },
  { id: "terms", en: "Terms", ar: "الشروط" },
];

export function Footer() {
  const { setView, lang } = useApp();
  const ar = lang === "ar";

  const group = (links: { id: View; en: string; ar: string }[]) =>
    links.map((l) => (
      <button
        key={l.id}
        onClick={() => setView(l.id)}
        className="block text-[12px] font-medium text-ink-2 transition hover:text-primary"
      >
        {ar ? l.ar : l.en}
      </button>
    ));

  return (
    <footer className="mt-auto border-t border-line bg-white">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.2fr]">
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

          {/* product */}
          <nav aria-label="Product">
            <p className="micro text-[9px] text-ink-3">PRODUCT</p>
            <div className="mt-3 space-y-2">{group(PRODUCT)}</div>
          </nav>

          {/* resources */}
          <nav aria-label="Resources">
            <p className="micro text-[9px] text-ink-3">RESOURCES</p>
            <div className="mt-3 space-y-2">{group(RESOURCES)}</div>
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
