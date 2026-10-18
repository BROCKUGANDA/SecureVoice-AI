"use client";

import { useCallback, useState } from "react";
import { motion } from "framer-motion";
import { signOut } from "@/lib/auth-client";
import {
  BookOpenText,
  Home,
  ShieldCheck,
  LayoutDashboard,
  Menu,
  NotebookPen,
  Play,
  Presentation,
  Settings as SettingsIcon,
  Table2,
  UserRound,
  LogOut,
  X,
} from "lucide-react";
import { useApp, t, VIEW_ACCESS, ACCESS_SEAT, type View } from "@/lib/store";
import { ARABIC_SCRIPT_LANGS, UI_LANG_SHORT, UI_LANGS } from "@/lib/i18n/registry";
import { atLeast, type Seat } from "@/lib/auth/seat";
import { useViewerSeat } from "@/lib/auth/use-viewer-seat";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/shell/Logo";
import { OrgSwitcher } from "@/components/shell/OrgSwitcher";
import { CurrentUserAvatar, presentIdentity } from "@/components/current-user-avatar";

type NavItem = { id: View; en: string; ar: string; icon: typeof Home };

/**
 * Everything a signed-out visitor may reach. Real anchors in the footer for the
 * routes that have URLs; these are the in-app ones.
 */
const PUBLIC_NAV: NavItem[] = [
  { id: "home", en: "Overview", ar: "الرئيسية", icon: Home },
  { id: "docs", en: "Docs", ar: "التوثيق", icon: BookOpenText },
  { id: "security", en: "Security", ar: "الأمن", icon: ShieldCheck },
];

/**
 * The signed-in navigation, as three audience tiers.
 *
 * Why this is a table and not a filtered list: the nav and the shell's RBAC gate
 * must never disagree about who may see what. Both read `VIEW_ACCESS`, so a view
 * that gains a requirement here automatically tightens the route gate too. An
 * earlier version kept `PUBLIC_NAV` in the bar for signed-in users, which is what
 * made the header overflow — nine items plus the account cluster does not fit
 * 1280px, and the labels wrapped onto two lines each. Public pages are still
 * reachable from the footer, which links them as real routes.
 */
const SEAT_NAV: Record<Seat, NavItem[]> = {
  // Read-only. The tour and the recorded dashboard — the two things a judge or a
  // press reviewer needs to believe the product works. No Command Center: it is a
  // working surface, and a read-only seat must not be able to open a case.
  judge: [
    { id: "dashboard", en: "Dashboard", ar: "اللوحة", icon: Table2 },
    { id: "product", en: "Deep Dive", ar: "التفاصيل", icon: Presentation },
    { id: "demo", en: "Demo", ar: "العرض", icon: Play },
    // The appendix is a read-only deck, so a read-only seat may open it. It is
    // deliberately absent from the vendor nav below: a working seat is not
    // offered the pitch.
    { id: "deck", en: "Appendix", ar: "ملحق", icon: NotebookPen },
  ],
  // A working seat. Same as a judge plus the queue.
  vendor: [
    { id: "dashboard", en: "Dashboard", ar: "اللوحة", icon: Table2 },
    { id: "console", en: "Command Center", ar: "مركز التشغيل", icon: LayoutDashboard },
    { id: "demo", en: "Demo", ar: "العرض", icon: Play },
    { id: "product", en: "Deep Dive", ar: "التفاصيل", icon: Presentation },
  ],
  // Administering the organisation.
  operator: [
    { id: "dashboard", en: "Dashboard", ar: "اللوحة", icon: Table2 },
    { id: "console", en: "Command Center", ar: "مركز التشغيل", icon: LayoutDashboard },
    { id: "audit", en: "Audit explorer", ar: "مستكشف التدقيق", icon: ShieldCheck },
    { id: "demo", en: "Demo", ar: "العرض", icon: Play },
    { id: "product", en: "Deep Dive", ar: "التفاصيل", icon: Presentation },
    { id: "settings", en: "Settings", ar: "الإعدادات", icon: SettingsIcon },
    { id: "audit", en: "Audit explorer", ar: "مستكشف التدقيق", icon: ShieldCheck },
    { id: "deck", en: "Appendix", ar: "ملحق", icon: NotebookPen },
  ],
};

/**
 * The nav for the current seat.
 *
 * The `VIEW_ACCESS` filter is the point of this function: it means the table
 * above can never advertise a screen the gate would refuse, and the gate can
 * never refuse a screen the table promised. Both read the same map, so the only
 * way to drift is to edit one of them — and this filter makes that a no-op for
 * the nav.
 *
 * `seat === null` (the session has not resolved) yields an empty list rather than
 * the full operator list. The alternative — showing the widest nav until the
 * answer arrives — flashes controls at someone who may not hold them, and on a
 * slow connection that flash is long enough to click.
 */
function navForSeat(seat: Seat | null): NavItem[] {
  if (seat === null) return [];
  return SEAT_NAV[seat].filter((item) => {
    const required = ACCESS_SEAT[VIEW_ACCESS[item.id]];
    return required === null || atLeast(seat, required);
  });
}

export function Navbar() {
  const { view, setView, lang, setLang } = useApp();
  const { seat, isSignedIn, user } = useViewerSeat();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const navItems = isSignedIn ? navForSeat(seat) : PUBLIC_NAV;

  /**
   * Sign out, then leave the console.
   *
   * The navigation away is not cosmetic. `signOut()` clears the session, so the
   * shell's RBAC gate observes a signed-out visitor on an operator-only screen
   * and redirects to `/auth` — which is the right destination for a deep link
   * someone bookmarked, and the wrong one for a person who pressed "Sign out"
   * from the header. They asked to leave, not to be re-prompted. So the view is
   * set explicitly once the session is actually gone.
   *
   * `await` before navigating, and the button disabled while it is in flight:
   * `signOut()` revokes the row server-side and clears the cookie, and racing
   * the navigation against it is how you land back on the console with a session
   * that no longer exists.
   *
   * BOTH sign-outs, not one. There are two session systems (see the databaseHooks
   * block in src/lib/better-auth.ts): `signOut()` covers Better Auth's session,
   * `/api/auth/logout` covers the first-party `sv_session` store that
   * `requireAuth` actually reads. Magic link — the primary operator sign-in —
   * mints ONLY `sv_session`, so calling `signOut()` alone left the user
   * authenticated to every guarded route while the UI showed them signed out.
   * `allSettled` so one failing cannot skip the other; the `finally` below still
   * sends them home either way.
   */
  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    setMenuOpen(false);
    try {
      // BOTH session systems, as before — `allSettled` so one failing cannot skip
      // the other (see the long comment above this handler for why magic link
      // mints only the first-party session).
      await Promise.allSettled([
        signOut(),
        fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
        }),
      ]);
    } finally {
      // Whatever the server said, the person is leaving: a failed revocation
      // must not strand them on a screen they asked to leave, and the gate will
      // catch a session that is still live.
      //
      // Drop the one piece of client-side session state that OUTLIVES a navigation:
      // the demo seat id. The realtime socket, the CreditWidget's balance and the
      // RBAC gate all reset because `location.replace` is a real document load,
      // which is also why the explicit teardown for them is unnecessary — but
      // localStorage survives it, and a stale seat id would let the next visitor
      // on this browser try to heartbeat a lease that was already released.
      try {
        window.localStorage.removeItem("sv_demo_seat");
      } catch {
        // storage blocked; the server-side release is the control that matters
      }
      setView("home");
      setSigningOut(false);
      // `replace`, not `assign` or `pushState`. `assign` adds a history entry, so
      // Back lands on the authenticated page — served from bfcache, still
      // rendered, with a dead session behind it. A sign-out that leaves a working
      // Back button into the console is not a sign-out. `replace` leaves no entry
      // to return through, and the server response now sends `Clear-Site-Data`
      // alongside the cookie expiries.
      window.location.replace("/");
    }
  }, [setView, signingOut]);

  // `go()` closes the menu on every navigation it performs, so the panel never
  // outlives the page it was opened from. No effect watches `view` to do this:
  // setting state in an effect is exactly the "close menu on render" bug the
  // rules forbid, and a redundant effect is worse than a missing one.
  const go = (id: View) => {
    setView(id);
    setMenuOpen(false);
  };

  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-paper/85 backdrop-blur-xl">
      {/*
        The squeeze, and why this is a flex row with a scrolling middle.

        The bar holds, at its widest, the brand, six nav pills, a language
        toggle, an avatar, a name, a theme toggle, an org switcher and a sign-out
        button. That does not fit 1280px, and the version that tried to make it
        fit did so by letting the labels wrap — "Deep Dive" and "Command Center"
        each broke onto two lines, which doubled the header height and read as a
        rendering fault.

        So: the right-hand cluster is `shrink-0` and never gives up its width, the
        nav is the only element allowed to shrink, and it scrolls horizontally
        rather than wrapping or overflowing the viewport. `min-w-0` on the middle
        is what makes that work — without it a flex item refuses to shrink below
        its content width, which is the actual cause of the horizontal scrollbar
        across the whole page.
      */}
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* Brand */}
        <button
          onClick={() => setView("home")}
          className="group flex shrink-0 items-center gap-2.5"
          aria-label="SecureVoice AI home"
        >
          <span className="transition-transform duration-300 group-hover:scale-105">
            <LogoMark size={36} />
          </span>
          <span className="hidden flex-col items-start leading-none sm:flex">
            <span className="whitespace-nowrap font-display text-[15px] font-semibold tracking-tight">
              SecureVoice <span className="text-primary">AI</span>
            </span>
            <span className="micro mt-1 whitespace-nowrap text-[9px] text-ink-3">
              Fraud Intervention
            </span>
          </span>
        </button>

        {/* Nav — the only shrinkable element in the bar. */}
        <nav className="min-w-0 flex-1 overflow-x-auto md:overflow-visible" aria-label="Primary">
          <div className="mx-auto flex w-max items-center gap-1 rounded-full border border-line bg-white p-1 md:mx-auto md:w-auto md:justify-center">
            {navItems.map((n) => {
              const active = view === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setView(n.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
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
          </div>
        </nav>

        {/* Right: lang toggle + account + demo CTA. `shrink-0` so it keeps its
            size and the nav absorbs the pressure instead. */}
        <div className="flex shrink-0 items-center gap-2">
          <div
            className="hidden items-center rounded-full border border-line bg-white p-0.5 sm:flex"
            role="group"
            aria-label="Language"
          >
            {UI_LANGS.map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                aria-pressed={lang === l}
                className={cn(
                  "relative rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors",
                  // `ar` needs the Arabic webfont, and so does Urdu — that set
                  // lives in ARABIC_SCRIPT_LANGS, which already contains `ar`.
                  // The separate `l === "ar"` test this replaced was subsumed by
                  // it, so one condition said the same thing twice.
                  ARABIC_SCRIPT_LANGS.includes(l) && "font-arabic",
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
                <span className="relative">{UI_LANG_SHORT[l]}</span>
              </button>
            ))}
          </div>

          {/* Session: name + sign out when signed in, sign in when out.
              Better Auth ships no prebuilt account UI, so this is an explicit
              control. Signing out calls `authClient.signOut()`, which revokes the
              session SERVER-side before clearing the cookie — the requirement
              behind X-3's "logout that only clears the client" row. See
              `handleSignOut` for why the navigation away is part of the handler
              rather than left to the RBAC gate.

              DESKTOP ONLY (`hidden md:flex`). Below md this control used to
              render here AND again in the mobile strip, so a phone showed two
              "Sign in" buttons at once. One account affordance per breakpoint. */}
          <div className="hidden md:flex">
            {isSignedIn ? (
              <div className="flex items-center gap-2">
                {/* The signed-in person, visually as well as by name. Reads the
                    account this app actually authenticates — Better Auth's
                    `user.image` — so it falls back to initials and never to a
                    stale picture from a system that is not in use here.

                    The demo seat is presented as a LABEL rather than a name. Its
                    stored name is the literal "demo user", which put those two
                    words and a "DU" badge in the header of every page a judge
                    visits — a placeholder that reads as somebody's personal
                    login on a fraud platform's own header. `presentIdentity`
                    gives it one "D" and "Demo session", and tints both, so it
                    looks deliberate. */}
                <CurrentUserAvatar />
                {(() => {
                  const presented = presentIdentity(user?.email, user?.name, lang);
                  return presented.isDemo ? (
                    <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-2.5 py-1 text-[11px] font-semibold tracking-wide text-white">
                      {presented.label}
                    </span>
                  ) : (
                    <span className="max-w-[10rem] truncate text-[12.5px] font-semibold text-ink-2">
                      {presented.label}
                    </span>
                  );
                })()}
                {/* The rule for WHO may see the tenant switcher lives inside
                    OrgSwitcher, not here — this component renders it twice
                    (desktop cluster and mobile panel) and a rule written at both
                    call sites is one that gets edited at only one of them. */}
                <OrgSwitcher />
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  disabled={signingOut}
                  className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-white px-3.5 py-2 text-[12.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary disabled:opacity-60"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  {signingOut
                    ? t("Signing out…", "جارٍ الخروج…", lang)
                    : t("Sign out", "خروج", lang)}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setView("auth")}
                className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-white px-3.5 py-2 text-[12.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
              >
                <UserRound className="h-3.5 w-3.5" />
                {t("Sign in", "دخول", lang)}
              </button>
            )}
          </div>

          {/* THE DEMO CTA, AND WHY IT NOW SAYS "SIGN IN".
              The demo view lives at /console/demo and is `judge`-level, so a
              signed-out visitor cannot be handed it: this button used to call
              `launchDemo()` and the shell's RBAC gate immediately sent them to
              /sign-in. The most prominent control on the landing page was
              therefore a dead end that silently changed destination.
              Making `demo` public is not the fix — it breaks four asserted
              invariants, including "no console view is public". So the button
              now names what it actually does. */}
          {!isSignedIn && (
            <button
              onClick={() => setView("auth")}
              className="group hidden items-center gap-2 whitespace-nowrap rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-[0_6px_18px_-6px_rgba(11,122,85,0.55)] transition hover:bg-green-deep md:flex"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="sv-pulse-ring absolute inset-0 text-white" />
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
              </span>
              <span className="relative">
                {t("Sign in to run the demo", "سجّل الدخول لتشغيل العرض", lang)}
              </span>
            </button>
          )}

          {/* Hamburger — mobile only. */}
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
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-white text-ink-2 transition hover:border-primary/40 hover:text-primary md:hidden"
          >
            {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Mobile menu panel — `md:hidden` so it can never appear over the desktop
          layout, and rendered only while open so it holds no focus targets when
          collapsed. Carries the same `navItems`, so a seat that cannot see a
          screen on desktop cannot reach it from the phone either. */}
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

            {/* Language — below the `sm` breakpoint the cluster in the bar above
                is `hidden`, so on a phone this panel was the only place a
                language could be chosen, and it carried no control at all. The
                interface ships in two languages, which made Arabic unreachable
                on a handset for anyone not already in it.
                `sm:hidden` rather than a conditional render: at 640–767px both
                the bar cluster and this panel are on screen, and two identical
                controls is one too many.
                No `layoutId="lang-pill"` here, deliberately. Framer's shared
                layout id is global, and a `display:none` element still registers
                it — a second holder would let the pill teleport from the visible
                cluster into the hidden row. The pressed state is a plain
                background instead, in the same `bg-primary` the cluster uses, so
                the control still reads as one control at every width. */}
            <div className="mt-2 flex flex-wrap items-center gap-2 pb-1 sm:hidden">
              <span className="micro text-ink-3">{t("Language", "اللغة", lang)}</span>
              <div
                className="flex items-center rounded-full border border-line bg-white p-0.5"
                role="group"
                aria-label={t("Language", "اللغة", lang)}
              >
                {UI_LANGS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLang(l)}
                    aria-pressed={lang === l}
                    className={cn(
                      "rounded-full px-3 py-1 text-[11.5px] font-semibold transition-colors",
                      ARABIC_SCRIPT_LANGS.includes(l) && "font-arabic",
                      lang === l ? "bg-primary text-white" : "text-ink-3 hover:text-foreground",
                    )}
                  >
                    {UI_LANG_SHORT[l]}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-2 flex flex-col gap-2 border-t border-line pt-3">
              {isSignedIn ? (
                <>
                  <div className="flex items-center gap-2.5 px-1">
                    <CurrentUserAvatar />
                    {(() => {
                      const presented = presentIdentity(user?.email, user?.name, lang);
                      return presented.isDemo ? (
                        <span className="min-w-0 flex-1 truncate rounded-full bg-ink px-2.5 py-1 text-center text-[11px] font-semibold tracking-wide text-white">
                          {presented.label}
                        </span>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-2">
                          {presented.label}
                        </span>
                      );
                    })()}
                    <OrgSwitcher />
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSignOut()}
                    disabled={signingOut}
                    className="flex items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-3.5 py-2.5 text-[13px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary disabled:opacity-60"
                  >
                    <LogOut className="h-4 w-4" />
                    {signingOut
                      ? t("Signing out…", "جارٍ الخروج…", lang)
                      : t("Sign out", "خروج", lang)}
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
                  {/* Same reasoning as the desktop CTA above: the demo needs a
                      session, so this names the sign-in rather than promising a
                      demo it cannot deliver. */}
                  <button
                    onClick={() => go("auth")}
                    className="flex items-center justify-center gap-2 rounded-xl bg-primary px-3.5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
                  >
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="sv-pulse-ring absolute inset-0 text-white" />
                      <span className="h-1.5 w-1.5 rounded-full bg-white" />
                    </span>
                    {t("Sign in to run the demo", "سجّل الدخول لتشغيل العرض", lang)}
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
