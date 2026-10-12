"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { signOut, useSession } from "@/lib/auth-client";
import {
  BookOpenText,
  Home,
  ShieldCheck,
  LayoutDashboard,
  Menu,
  Play,
  Presentation,
  Settings as SettingsIcon,
  Table2,
  UserRound,
  LogOut,
  X,
} from "lucide-react";
import { useApp, t, type View, type Lang } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/shell/Logo";
import { OrgSwitcher } from "@/components/shell/OrgSwitcher";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { CurrentUserAvatar } from "@/components/current-user-avatar";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const isSignedIn = Boolean(session?.user);
  const user = session?.user;
  const role = session?.session?.activeOrganizationId ? "operator" : undefined;
  const showOperatorNav = role === "operator";
  const navItems = isSignedIn
    ? [...PUBLIC_NAV, ...USER_NAV, ...(showOperatorNav ? OPERATOR_NAV : [])]
    : PUBLIC_NAV;

  // `go()` closes the menu on every navigation it performs, so the panel never
  // outlives the page it was opened from. Signing out and launching the demo
  // close it explicitly for the same reason. No effect watches `view` to do this:
  // setting state in an effect is exactly the "close menu on render" bug the
  // rules forbid, and a redundant effect is worse than a missing one.
  const go = (id: View) => {
    setView(id);
    setMenuOpen(false);
  };

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
              clears the client" row.

              DESKTOP ONLY (`hidden md:flex`). Below md this control used to
              render here AND again in the mobile strip, so a phone showed two
              "Sign in" buttons at once. The mobile copy now lives in the menu
              panel, and this one is hidden — one account affordance per
              breakpoint. */}
          <div className="hidden md:flex">
            {isSignedIn ? (
              <div className="flex items-center gap-2">
                {/* The signed-in operator, visually as well as by name. The block
                    reads the account this app actually authenticates — Better
                    Auth's `user.image`, populated by the identity provider or a
                    profile edit — so it falls back to initials and never to a
                    stale picture from a system that is not in use here. */}
                <CurrentUserAvatar />
                <span className="max-w-[10rem] truncate text-[12.5px] font-semibold text-ink-2">
                  {session?.user?.name || session?.user?.email}
                </span>
                <ThemeToggle />
                {/* Only rendered for a session that belongs to more than one
                    organization — see OrgSwitcher for why the tenant is the
                    session and not a request parameter. */}
                <OrgSwitcher />
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
          </div>

          {/* demo CTA — visitors only; signed-in users are already inside the
              platform. Desktop only for the same reason as the account control:
              on mobile it is in the menu panel. */}
          {!isSignedIn && (
            <button
              onClick={launchDemo}
              className="group hidden items-center gap-2 rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-[0_6px_18px_-6px_rgba(11,122,85,0.55)] transition hover:bg-green-deep md:flex"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="sv-pulse-ring absolute inset-0 text-white" />
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
              </span>
              <span className="relative">{t("Launch live demo", "ابدأ العرض الحي", lang)}</span>
            </button>
          )}

          {/* Hamburger — mobile only. Replaces the horizontally-scrolling strip
              that used to sit under the header: a row of pills that scrolled
              sideways gave no affordance that more existed, and duplicated the
              sign-in control. */}
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={
              menuOpen
                ? t("Close menu", "إغلاق القائمة", lang)
                : t("Open menu", "فتح القائمة", lang)
            }
            className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-white text-ink-2 transition hover:border-primary/40 hover:text-primary md:hidden"
          >
            {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Mobile menu panel — `md:hidden` so it can never appear over the desktop
          layout, and rendered only while open so it holds no focus targets when
          collapsed. */}
      {menuOpen && (
        <div
          id="mobile-menu"
          className="border-t border-line/70 bg-paper/95 backdrop-blur-xl md:hidden"
        >
          <nav
            className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-3"
            aria-label={t("Mobile", "الجوال", lang)}
          >
            {navItems.map((n) => {
              const active = view === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => go(n.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[13.5px] font-medium transition",
                    active
                      ? "bg-[#0c110e] text-white"
                      : "text-ink-2 hover:bg-white hover:text-foreground",
                  )}
                >
                  <n.icon className={cn("h-4 w-4", active && "text-green-bright")} />
                  {lang === "ar" ? n.ar : n.en}
                </button>
              );
            })}

            <div className="mt-2 flex flex-col gap-2 border-t border-line pt-3">
              {isSignedIn ? (
                <>
                  <div className="flex items-center gap-2.5 px-1">
                    <CurrentUserAvatar />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-2">
                      {session?.user?.name || session?.user?.email}
                    </span>
                    <ThemeToggle compact />
                    <OrgSwitcher />
                  </div>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      void signOut();
                    }}
                    className="flex items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-3.5 py-2.5 text-[13px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
                  >
                    <LogOut className="h-4 w-4" />
                    {t("Sign out", "خروج", lang)}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => go("auth")}
                    className="flex items-center justify-center gap-1.5 rounded-xl border border-primary/40 bg-green-tint px-3.5 py-2.5 text-[13px] font-semibold text-primary"
                  >
                    <UserRound className="h-4 w-4" />
                    {t("Sign in", "دخول", lang)}
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      launchDemo();
                    }}
                    className="flex items-center justify-center gap-2 rounded-xl bg-primary px-3.5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
                  >
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="sv-pulse-ring absolute inset-0 text-white" />
                      <span className="h-1.5 w-1.5 rounded-full bg-white" />
                    </span>
                    {t("Launch live demo", "ابدأ العرض الحي", lang)}
                  </button>
                </>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
