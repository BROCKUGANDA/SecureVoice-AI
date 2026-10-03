"use client";

import { motion } from "framer-motion";
import { signOut, useSession } from "@/lib/auth-client";
import {
  BookOpenText,
  Home,
  ShieldCheck,
  LayoutDashboard,
  Play,
  Presentation,
  Settings as SettingsIcon,
  Table2,
  UserRound,
  LogOut,
} from "lucide-react";
import { useApp, t, type View, type Lang } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/shell/Logo";

const PUBLIC_NAV: { id: View; en: string; ar: string; icon: typeof Home }[] = [
  { id: "home", en: "Overview", ar: "الرئيسية", icon: Home },
  { id: "docs", en: "Docs", ar: "التوثيق", icon: BookOpenText },
  { id: "security", en: "Security", ar: "الأمن", icon: ShieldCheck },
];

// visible to any signed-in session (demo or operator) — single-app strategy:
// demo seats share the Command Center under a Demo Mode badge
const USER_NAV: { id: View; en: string; ar: string; icon: typeof Home }[] = [
  { id: "demo", en: "Demo", ar: "العرض", icon: Play },
  { id: "dashboard", en: "Dashboard", ar: "اللوحة", icon: Table2 },
  { id: "product", en: "Deep Dive", ar: "التفاصيل", icon: Presentation },
  { id: "console", en: "Command Center", ar: "مركز التشغيل", icon: LayoutDashboard },
];

// operator (admin) only
const OPERATOR_NAV: { id: View; en: string; ar: string; icon: typeof Home }[] = [
  { id: "settings", en: "Settings", ar: "الإعدادات", icon: SettingsIcon },
  { id: "deck", en: "Appendix", ar: "ملحق", icon: Presentation },
];

export function Navbar() {
  const { view, setView, lang, setLang, launchDemo } = useApp();
  const { data: session } = useSession();
  const isSignedIn = Boolean(session?.user);
  const user = session?.user;
  const role = session?.session?.activeOrganizationId ? "operator" : undefined;
  const showOperatorNav = role === "operator";
  const navItems = isSignedIn
    ? [...PUBLIC_NAV, ...USER_NAV, ...(showOperatorNav ? OPERATOR_NAV : [])]
    : PUBLIC_NAV;

  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-paper/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* Brand */}
        <button
          onClick={() => setView("home")}
          className="group flex items-center gap-2.5"
          aria-label="SecureVoice AI home"
        >
          <span className="transition-transform duration-300 group-hover:scale-105">
            <LogoMark size={36} />
          </span>
          <span className="hidden flex-col items-start leading-none sm:flex">
            <span className="font-display text-[15px] font-semibold tracking-tight">
              SecureVoice <span className="text-primary">AI</span>
            </span>
            <span className="micro mt-1 text-[9px] text-ink-3">Fraud Intervention</span>
          </span>
        </button>

        {/* Nav */}
        <nav
          className="mx-auto hidden items-center rounded-full border border-line bg-white p-1 md:flex"
          aria-label="Primary"
        >
          {navItems.map((n) => {
            const active = view === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setView(n.id)}
                className={cn(
                  "relative flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                  active ? "text-white" : "text-ink-2 hover:text-foreground",
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

        {/* Right: lang toggle + account + demo CTA */}
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
                  lang === l ? "text-white" : "text-ink-3 hover:text-foreground",
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

          {/* Session: name + sign out when signed in, sign in when out.
              The previous <UserButton> was a provider-hosted account menu with no
              Better Auth equivalent, so it is replaced by an explicit control:
              Better Auth ships no prebuilt account UI, and a menu that silently
              did nothing would be worse than no menu. Signing out calls
              authClient.signOut(), which revokes the session SERVER-side before
              clearing the cookie — the requirement behind X-3's "logout that only
              clears the client" row. */}
          {isSignedIn ? (
            <div className="flex items-center gap-2">
              <span className="max-w-[10rem] truncate text-[12.5px] font-semibold text-ink-2">
                {session?.user?.name || session?.user?.email}
              </span>
              <button
                onClick={() => void signOut()}
                className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3.5 py-2 text-[12.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
              >
                <LogOut className="h-3.5 w-3.5" />
                {t("Sign out", "خروج", lang)}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setView("auth")}
              className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3.5 py-2 text-[12.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
            >
              <UserRound className="h-3.5 w-3.5" />
              {t("Sign in", "دخول", lang)}
            </button>
          )}

          {/* demo CTA — visitors only; signed-in users are already inside the platform */}
          {!isSignedIn && (
            <button
              onClick={launchDemo}
              className="group hidden items-center gap-2 rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-[0_6px_18px_-6px_rgba(11,122,85,0.55)] transition hover:bg-green-deep sm:flex"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="sv-pulse-ring absolute inset-0 text-white" />
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
              </span>
              <span className="relative">{t("Launch live demo", "ابدأ العرض الحي", lang)}</span>
            </button>
          )}
        </div>
      </div>

      {/* Mobile nav strip */}
      <nav
        className="flex gap-1 overflow-x-auto border-t border-line/70 px-3 py-1.5 md:hidden sv-scroll"
        aria-label="Mobile"
      >
        {navItems.map((n) => (
          <button
            key={n.id}
            onClick={() => setView(n.id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition",
              view === n.id ? "bg-[#0c110e] text-white" : "bg-white text-ink-2 border border-line",
            )}
          >
            <n.icon className={cn("h-3 w-3", view === n.id && "text-green-bright")} />
            {lang === "ar" ? n.ar : n.en}
          </button>
        ))}
        {!isSignedIn && (
          <button
            onClick={() => setView("auth")}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/40 bg-green-tint px-3 py-1.5 text-[12px] font-semibold text-primary"
          >
            <UserRound className="h-3 w-3" />
            {t("Sign in", "دخول", lang)}
          </button>
        )}
      </nav>
    </header>
  );
}
