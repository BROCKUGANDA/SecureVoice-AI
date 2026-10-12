"use client";

import { useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence, MotionConfig } from "framer-motion";
import { useApp, t, VIEW_ACCESS, ACCESS_SEAT, type View } from "@/lib/store";
import { atLeast } from "@/lib/auth/seat";
import { useViewerSeat } from "@/lib/auth/use-viewer-seat";
import { isShellPath, pathForView, viewForPath } from "@/lib/console-routes";
import { cn } from "@/lib/utils";
import { Navbar } from "@/components/shell/Navbar";
import { Footer } from "@/components/shell/Footer";
import { Home } from "@/views/Home";
import { Demo } from "@/views/Demo";
import { Dashboard } from "@/views/Dashboard";
import { Product } from "@/views/Product";
import { UseCases } from "@/views/UseCases";
import { Docs } from "@/views/Docs";
import { Security } from "@/views/Security";
import { Privacy, Terms, Refund } from "@/views/Legal";
import { Pricing } from "@/views/Pricing";
import { Deck } from "@/views/Deck";
import { Auth } from "@/views/Auth";
import { Console } from "@/views/Console";
import { Settings } from "@/views/Settings";
import { SetupWizard } from "@/views/SetupWizard";
import { IdleTimeoutHandler } from "@/components/shell/IdleTimeoutHandler";
import { TwoFactorPrompt } from "@/components/security/TwoFactorPrompt";

const VIEWS: Record<View, React.ComponentType> = {
  home: Home,
  demo: Demo,
  dashboard: Dashboard,
  product: Product,
  usecases: UseCases,
  docs: Docs,
  security: Security,
  pricing: Pricing,
  privacy: Privacy,
  terms: Terms,
  refund: Refund,
  deck: Deck,
  auth: Auth,
  console: Console,
  settings: Settings,
  setup: SetupWizard,
};

export function AppRoot() {
  const { view, lang, setView, setTimedOut, highContrast } = useApp();
  // `seat` comes from the membership row, NOT from `activeOrganizationId ? "operator"`
  // — see the doc comment on useViewerSeat. Both values the gate below needs are
  // read here so there is exactly one subscription and one chance of the header
  // and the gate disagreeing.
  const { seat, isLoading: seatLoading, isSignedIn } = useViewerSeat();

  /* keep scroll sane between views */
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [view]);

  /* Deep links into the SPA, for the standalone routes that cannot use the
   * in-app navigation: `/#docs` opens the docs, and any other public view
   * behaves the same way. This exists because `launchDemo`/`setView` mutate a
   * Zustand store that nothing is subscribed to when the view is rendered as
   * its own route (see src/components/shell/standalone-context.tsx), so a
   * "Read the docs" control on `/usecases` has to be a real anchor.
   *
   * `#demo` is DELIBERATELY NOT HANDLED, and this is the second thing that has
   * to be true for the reason it is not. The `demo` view is `user` access, so
   * for a signed-out visitor the RBAC effect below bounces `demo` to `auth` —
   * meaning a `/#demo` deep link triggers home -> demo -> auth in quick
   * succession during mount, and AnimatePresence is left with two views
   * overlapping and the page rendering blank. It was measured, not predicted.
   *
   * The public answer to "show me the demo" is the browser-mic widget on this
   * page (`#live-demo`), which needs no sign-in at all, and that is what the
   * public CTAs link to.
   *
   * Restricted to `public` views for the same reason: routing a `user` or
   * `operator` view here would reintroduce exactly that bounce.
   */
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    if (hash === "demo") return; // see above — auth-gated, bounces to /auth
    if (hash in VIEWS && VIEW_ACCESS[hash as View] === "public") setView(hash as View);
  }, [setView]);

  /* announce the active language to assistive tech — Arabic copy read with an
     English voice profile is unintelligible, so lang must track the toggle.
     The direction is set from the same effect: Arabic is a right-to-left
     script, and without `dir` on <html> the browser lays every Arabic
     sentence out left-to-right — punctuation lands on the wrong end, mixed
     numbers read backwards, and `ms-*`/`me-*`/`text-start` utilities never
     mirror. One attribute here is what makes the AR toggle a real Arabic mode
     rather than Arabic words in an English layout. */
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  /* high-contrast theme (WCAG 1.4.3/1.4.6): applied as a data attribute so the
     CSS override block in globals.css switches atomically with the toggle */
  useEffect(() => {
    if (highContrast) {
      document.documentElement.dataset.contrast = "high";
    } else {
      delete document.documentElement.dataset.contrast;
    }
  }, [highContrast]);

  const handleIdleTimeout = useCallback(() => {
    setTimedOut(true);
    setView("auth");
  }, [setTimedOut, setView]);

  /* RBAC gate: every view declares who may see it (VIEW_ACCESS).
   *
   * THE `seatLoading` GUARD IS THE ORG-SWITCH FIX, and it is load-bearing.
   *
   * `setActive` (OrgSwitcher) refetches the session and the active membership
   * together. For the duration of that round trip both are briefly unavailable:
   * `useSession()` reports pending, and `activeOrganizationId` is momentarily
   * absent. This gate used to read that absence as "signed out" and redirect the
   * operator to the sign-in screen mid-switch — the bounce that sent a tenant
   * change back to the landing page. Nothing about the switch had failed; the
   * gate had simply been asked a question while the answer was in flight.
   *
   * So: while the seat is unresolved the gate does NOTHING. It is a UI gate, not
   * an authorisation boundary — every route re-checks server-side, so declining
   * to redirect during a 200ms refetch cannot grant access to anything. Deferring
   * the decision is strictly safer than making it on incomplete data.
   */
  useEffect(() => {
    if (seatLoading) return;
    const access = VIEW_ACCESS[view];
    const required = ACCESS_SEAT[access];
    if (required === null) return; // public view — everyone, including signed out
    if (required === "judge" && !isSignedIn) {
      setView("auth");
      return;
    }
    // A signed-in seat below the bar is sent to the DASHBOARD, not to the
    // sign-in screen and not to the console. They ARE signed in, they simply may
    // not open this screen, and bouncing to `/auth` told them to log in again
    // with a perfectly valid session.
    //
    // The dashboard specifically: it is the one view every signed-in seat can
    // reach (`judge` in VIEW_ACCESS), so it is a destination this gate can never
    // itself reject. Sending them to the console instead — which is what an
    // earlier version of this line did — is a redirect loop whenever the console
    // is the very screen that was refused, because the console is `vendor` and a
    // `judge` will be bounced straight back out of it, forever.
    if (seat === null || !atLeast(seat, required)) {
      setView(isSignedIn ? "dashboard" : "auth");
    }
  }, [view, isSignedIn, seat, seatLoading, setView]);

  /* ── The URL is the view, in both directions ────────────────────────────────
   *
   * Reading it on mount is what makes a deep link, a refresh, and a new tab work
   * now that `/console/settings` is a real route rather than a string in a store.
   * The `popstate` listener is what the back button was missing: nothing in this
   * app ever wrote a history entry, so "back" left the console and landed on the
   * same page.
   *
   * Writing it on change uses `replaceState` for the FIRST sync after mount (the
   * view may be corrected by the RBAC gate, and pushing that would put a screen
   * the user never chose into their back stack) and `pushState` afterwards.
   */
  useEffect(() => {
    const apply = () => {
      const next = viewForPath(window.location.pathname);
      if (next) setView(next);
    };
    apply();
    window.addEventListener("popstate", apply);
    return () => window.removeEventListener("popstate", apply);
  }, [setView]);

  const syncedOnce = useRef(false);
  useEffect(() => {
    // The FIRST commit is skipped deliberately. On that commit `view` is still the
    // store's initial value (`home`), because the read effect above can only
    // schedule a state change — so writing the URL here would push `/` over the
    // deep link the user actually asked for, and `/console/settings` would land on
    // the landing page. Measured, not theorised: the first version of this effect
    // did exactly that, and both new routes bounced to `/`.
    if (!syncedOnce.current) {
      syncedOnce.current = true;
      return;
    }
    const target = pathForView(view);
    if (target === null) return;
    const here = window.location.pathname;
    if (here === target) return;
    // A path the shell does not own (a public page, or the initial `/`) is
    // replaced rather than pushed: the user did not navigate here from a screen
    // of the app, so it does not belong in the back stack.
    const replace = !isShellPath(here);
    window.history[replace ? "replaceState" : "pushState"]({ view }, "", target);
  }, [view]);

  const Current = VIEWS[view];
  const fullBleed = view === "deck" || view === "auth";

  return (
    <div className={cn("flex flex-col bg-paper", !fullBleed && "min-h-screen")}>
      <IdleTimeoutHandler onTimeout={handleIdleTimeout} />

      <a
        href="#main-content"
        className="sr-only z-[110] rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        {t("Skip to content", "تخطَّ إلى المحتوى", lang)}
      </a>

      {!fullBleed && <Navbar />}

      <main id="main-content" className="flex-1">
        {/*
          The two-factor nudge. Signed-in only: it reads the SERVER's
          `twoFactorEnabled` flag (never a local one), and renders nothing for
          an operator who already has a second factor or has said "not now".
          Mounted here, outside the AnimatePresence, so switching views does
          not remount it and re-read the dismissal.
        */}
        {isSignedIn && <TwoFactorPrompt />}
        <MotionConfig reducedMotion="user">
          {/* Not mode="wait": it mounts the next view only after the current one's exit animation completes, and a stalled exit (framer-motion under React StrictMode in dev — the same fault that stuck the boot splash) freezes navigation on the current view. Default sync mode swaps immediately and degrades to a harmless overlap. */}
          <AnimatePresence>
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 18, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -14, filter: "blur(4px)" }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            >
              <Current />
            </motion.div>
          </AnimatePresence>
        </MotionConfig>
      </main>

      {!fullBleed && <Footer />}
    </div>
  );
}

/**
 * The default export is the shell itself. `src/app/console/[[...path]]/page.tsx`
 * and `src/app/sign-in/page.tsx` import `AppRoot` directly, so a deep link and a
 * client-side navigation render the same component rather than two copies that can
 * drift.
 */
export default AppRoot;
