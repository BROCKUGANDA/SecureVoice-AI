"use client";

import { useCallback, useEffect } from "react";
import { motion, AnimatePresence, MotionConfig } from "framer-motion";
import { useSession } from "@/lib/auth-client";
import { useApp, t, VIEW_ACCESS, type View } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Navbar } from "@/components/shell/Navbar";
import { Footer } from "@/components/shell/Footer";
import { LoadingScreen } from "@/components/shell/LoadingScreen";
import { Home } from "@/views/Home";
import { Demo } from "@/views/Demo";
import { Dashboard } from "@/views/Dashboard";
import { Product } from "@/views/Product";
import { UseCases } from "@/views/UseCases";
import { Docs } from "@/views/Docs";
import { Security } from "@/views/Security";
import { Privacy, Terms } from "@/views/Legal";
import { Deck } from "@/views/Deck";
import { Auth } from "@/views/Auth";
import { Console } from "@/views/Console";
import { Settings } from "@/views/Settings";
import { SetupWizard } from "@/views/SetupWizard";
import { IdleTimeoutHandler } from "@/components/shell/IdleTimeoutHandler";

const VIEWS: Record<View, React.ComponentType> = {
  home: Home,
  demo: Demo,
  dashboard: Dashboard,
  product: Product,
  usecases: UseCases,
  docs: Docs,
  security: Security,
  privacy: Privacy,
  terms: Terms,
  deck: Deck,
  auth: Auth,
  console: Console,
  settings: Settings,
  setup: SetupWizard,
};

export default function Page() {
  const { view, lang, booted, setBooted, setView, setTimedOut, highContrast } = useApp();
  const { data: session } = useSession();
  const isSignedIn = Boolean(session?.user);
  // Role for gating the console. Better Auth has no `publicMetadata`: the role
  // lives on the organization membership. This is a UI AFFORDANCE only — every
  // route re-checks the capability server-side, so a wrong value here can hide a
  // nav item but can never grant one.
  const role = session?.session?.activeOrganizationId ? "operator" : undefined;

  /* keep scroll sane between views */
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [view]);

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

  /* RBAC gate: every view declares who may see it (VIEW_ACCESS) */
  useEffect(() => {
    const access = VIEW_ACCESS[view];
    if (access === "public") return;
    if (access === "user" && !isSignedIn) {
      setView("auth");
      return;
    }
    if (access === "operator" && (!isSignedIn || role !== "operator")) {
      setView("auth");
    }
  }, [view, isSignedIn, role, setView]);

  const Current = VIEWS[view];
  const fullBleed = view === "deck" || view === "auth";

  return (
    <div className={cn("flex flex-col bg-paper", !fullBleed && "min-h-screen")}>
      {!booted && <LoadingScreen onDone={() => setBooted(true)} />}

      <IdleTimeoutHandler onTimeout={handleIdleTimeout} />

      <a
        href="#main-content"
        className="sr-only z-[110] rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        {t("Skip to content", "تخطَّ إلى المحتوى", lang)}
      </a>

      {!fullBleed && <Navbar />}

      <main id="main-content" className="flex-1">
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
