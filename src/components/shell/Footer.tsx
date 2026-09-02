"use client";

import { ShieldCheck } from "lucide-react";
import { useApp, type View } from "@/lib/store";

const LINKS: { id: View; en: string; ar: string }[] = [
  { id: "demo", en: "Live Demo", ar: "عرض حي" },
  { id: "dashboard", en: "Dashboard", ar: "اللوحة" },
  { id: "product", en: "Deep Dive", ar: "التفاصيل" },
  { id: "deck", en: "Pitch Deck", ar: "العرض" },
];

export function Footer() {
  const { setView, lang } = useApp();
  return (
    <footer className="mt-auto border-t border-line bg-white">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 py-6 sm:flex-row sm:px-6 lg:px-8">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#0c110e]">
            <ShieldCheck className="h-3.5 w-3.5 text-green-bright" strokeWidth={1.8} />
          </span>
          <div className="leading-tight">
            <p className="text-[12.5px] font-semibold">SecureVoice AI · Team SecureVoice</p>
            <p className="text-[11px] text-ink-3">
              Real-Time Fraud Intervention · ElevenLabs Hackathon — Banking &amp; Insurance
            </p>
          </div>
        </div>
        <nav className="flex items-center gap-4" aria-label="Footer">
          {LINKS.map((l) => (
            <button
              key={l.id}
              onClick={() => setView(l.id)}
              className="text-[12px] font-medium text-ink-2 transition hover:text-primary"
            >
              {lang === "ar" ? l.ar : l.en}
            </button>
          ))}
          <span dir="rtl" className="font-arabic text-[11.5px] text-ink-3">
            صوت آمن · حماية خلال ٦٠ ثانية
          </span>
        </nav>
      </div>
    </footer>
  );
}
