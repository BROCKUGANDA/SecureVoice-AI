"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck } from "lucide-react";

const STEPS = [
  "Loading design system",
  "Connecting fraud engine",
  "Warming telephony channels",
  "Arming guardrails",
];

/** First-boot splash — brand moment with progress */
export function LoadingScreen({ onDone }: { onDone: () => void }) {
  const [progress, setProgress] = useState(0);
  const [gone, setGone] = useState(false);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    let v = 0;
    const iv = setInterval(() => {
      v = Math.min(100, v + 9 + Math.random() * 16);
      setProgress(v);
      if (v >= 100) {
        clearInterval(iv);
        setTimeout(() => {
          setGone(true);
          setTimeout(() => doneRef.current(), 480);
        }, 220);
      }
    }, 110);
    return () => clearInterval(iv);
  }, []);

  const step = Math.min(STEPS.length - 1, Math.floor((progress / 100) * STEPS.length));

  return (
    <AnimatePresence>
      {!gone && (
        <motion.div
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#0c110e]"
          exit={{ opacity: 0, transition: { duration: 0.45, ease: "easeInOut" } }}
        >
          <div className="sv-grid-bg absolute inset-0 opacity-[0.35]" />
          <div className="relative flex flex-col items-center">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
              className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-green-tint/10 ring-1 ring-green-bright/30"
            >
              <ShieldCheck className="h-8 w-8 text-green-bright" strokeWidth={1.6} />
              <span className="sv-pulse-ring absolute inset-0 rounded-2xl text-green-bright/60" />
            </motion.div>
            <motion.h1
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.5 }}
              className="font-display mt-6 text-2xl font-semibold tracking-tight text-white"
            >
              SecureVoice <span className="text-green-bright">AI</span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              dir="rtl"
              className="font-arabic mt-1.5 text-[13px] text-white/45"
            >
              حماية لحظية بأصوات تُطمئن
            </motion.p>

            <div className="mt-9 w-56">
              <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-[#0b7a55] to-[#17a673]"
                  style={{ width: `${progress}%` }}
                  transition={{ ease: "easeOut" }}
                />
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="micro text-white/40">{STEPS[step]}</span>
                <span className="num text-[11px] text-green-bright/90">
                  {Math.round(progress)}%
                </span>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
