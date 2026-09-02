"use client";

import { motion } from "framer-motion";
import { ShieldCheck, PhoneCall, LayoutDashboard, BookOpenText, Home } from "lucide-react";
import { useApp, type View, type Lang } from "@/lib/store";
import { cn } from "@/lib/utils";

const NAV: { id: View; en: string; ar: string; icon: typeof Home }[] = [
  { id: "home", en: "Overview", ar: "الرئيسية", icon: Home },
  { id: "demo", en: "Live Demo", ar: "عرض حي", icon: PhoneCall },
  { id: "dashboard", en: "Dashboard", ar: "اللوحة", icon: LayoutDashboard },
  { id: "product", en: "Deep Dive", ar: "التفاصيل", icon: BookOpenText },
];

export function Navbar() {
  const { view, setView, lang, setLang } = useApp();

  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-paper/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* Brand */}
        <button
          onClick={() => setView("home")}
          className="group flex items-center gap-2.5"
          aria-label="SecureVoice AI home"
        >
          <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-[#0c110e] transition-colors group-hover:bg-green-deep">
            <ShieldCheck className="h-[18px] w-[18px] text-green-bright" strokeWidth={1.8} />
          </span>
          <span className="hidden flex-col items-start leading-none sm:flex">
            <span className="font-display text-[15px] font-semibold tracking-tight">
              SecureVoice <span className="text-primary">AI</span>
            </span>
            <span className="micro mt-1 text-[9px] text-ink-3">Fraud Intervention</span>
          </span>
        </button>

        {/* Nav */}
        <nav className="mx-auto hidden items-center rounded-full border border-line bg-white p-1 md:flex" aria-label="Primary">
          {NAV.map((n) => {
            const active = view === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setView(n.id)}
                className={cn(
                  "relative flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                  active ? "text-white" : "text-ink-2 hover:text-foreground"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="nav-pill"
                    className="absolute inset-0 rounded-full bg-[#0c110e]"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <n.icon className={cn("relative h-3.5 w-3.5", active && "text-green-bright")} />
                <span className="relative">{lang === "ar" ? n.ar : n.en}</span>
              </button>
            );
          })}
        </nav>

        {/* Right: lang toggle + demo CTA */}
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <div
            className="flex items-center rounded-full border border-line bg-white p-0.5"
            role="group"
            aria-label="Language"
          >
            {(["en", "ar"] as Lang[]).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={cn(
                  "relative rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors",
                  l === "ar" && "font-arabic",
                  lang === l ? "text-white" : "text-ink-3 hover:text-foreground"
                )}
              >
                {lang === l && (
                  <motion.span
                    layoutId="lang-pill"
                    className="absolute inset-0 rounded-full bg-primary"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative">{l === "en" ? "EN" : "عربي"}</span>
              </button>
            ))}
          </div>

          <button
            onClick={() => setView("demo")}
            className="group hidden items-center gap-2 rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-[0_6px_18px_-6px_rgba(11,122,85,0.55)] transition hover:bg-green-deep sm:flex"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="sv-pulse-ring absolute inset-0 text-white" />
              <span className="h-1.5 w-1.5 rounded-full bg-white" />
            </span>
            Launch demo
          </button>
        </div>
      </div>

      {/* Mobile nav strip */}
      <nav className="flex gap-1 overflow-x-auto border-t border-line/70 px-3 py-1.5 md:hidden sv-scroll" aria-label="Mobile">
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setView(n.id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition",
              view === n.id
                ? "bg-[#0c110e] text-white"
                : "bg-white text-ink-2 border border-line"
            )}
          >
            <n.icon className={cn("h-3 w-3", view === n.id && "text-green-bright")} />
            {lang === "ar" ? n.ar : n.en}
          </button>
        ))}
      </nav>
    </header>
  );
}
