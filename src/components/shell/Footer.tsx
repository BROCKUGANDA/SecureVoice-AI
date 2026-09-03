"use client";

import { useApp, type View } from "@/lib/store";
import { LogoMark } from "@/components/shell/Logo";

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

  const group = (links: { id: View; en: string; ar: string }[]) =>
    links.map((l) => (
      <button
        key={l.id}
        onClick={() => setView(l.id)}
        className="text-[12px] font-medium text-ink-2 transition hover:text-primary"
      >
        {lang === "ar" ? l.ar : l.en}
      </button>
    ));

  return (
    <footer className="mt-auto border-t border-line bg-white">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-4 px-4 py-6 sm:px-6 lg:flex-row lg:justify-between lg:px-8">
        <div className="flex items-center gap-2.5">
          <LogoMark size={28} />
          <div className="leading-tight">
            <p className="text-[12.5px] font-semibold">SecureVoice AI · Platform 1.0</p>
            <p className="text-[11px] text-ink-3">
              Real-time fraud intervention for banks · CBUAE-aligned · Dubai, UAE
            </p>
          </div>
        </div>

        <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2" aria-label="Footer">
          {group(PRODUCT)}
          <span className="h-3.5 w-px bg-line" aria-hidden />
          {group(RESOURCES)}
          <span dir="rtl" className="font-arabic text-[11.5px] text-ink-3">
            صوت آمن · حماية خلال ٦٠ ثانية
          </span>
        </nav>

        <button
          onClick={() => setView("deck")}
          title="Team appendix — not part of the product demo"
          className="text-[10.5px] text-ink-3/70 underline-offset-2 transition hover:text-ink-2 hover:underline"
        >
          appendix
        </button>
      </div>
    </footer>
  );
}
