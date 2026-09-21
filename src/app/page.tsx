"use client";

import { useCallback, useEffect } from "react";
import { motion, AnimatePresence, MotionConfig } from "framer-motion";
import { useAuth, useUser } from "@clerk/nextjs";
import { useApp, VIEW_ACCESS, type View } from "@/lib/store";
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
};

export default function Page() {
  const { view, lang, booted, setBooted, setView, setTimedOut } = useApp();
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const role = (user?.publicMetadata as { role?: string } | undefined)?.role;

  /* keep scroll sane between views */
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [view]);

  /* announce the active language to assistive tech — Arabic copy read with an
     English voice profile is unintelligible, so lang must track the toggle */
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

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
      <LoadingScreen onDone={() => setBooted(true)} />

      <IdleTimeoutHandler onTimeout={handleIdleTimeout} />

      <a
        href="#main-content"
        className="sr-only z-[110] rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>



      {!fullBleed && <Navbar />}

      <main id="main-content" className="flex-1">
        <MotionConfig reducedMotion="user">
          <AnimatePresence mode="wait">
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
