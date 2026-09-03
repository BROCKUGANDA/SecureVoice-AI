"use client";

import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useApp, type View } from "@/lib/store";
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
};

export default function Page() {
  const { view, booted, setBooted } = useApp();

  /* keep scroll sane between views */
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [view]);

  const Current = VIEWS[view];
  const fullBleed = view === "deck";

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <LoadingScreen onDone={() => setBooted(true)} />

      {!fullBleed && <Navbar />}

      <main className="flex-1">
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
      </main>

      {!fullBleed && <Footer />}
    </div>
  );
}
