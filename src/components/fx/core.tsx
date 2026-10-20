"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/* ————— Scroll reveal wrapper ————— */
export function Reveal({
  children,
  delay = 0,
  y = 22,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      data-reveal
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.65, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/* ————— Animated counter ————— */

/**
 * Counts a figure up when it scrolls into view.
 *
 * `MotionConfig reducedMotion="user"` (`src/app/page.tsx:297`) is already applied
 * to the whole tree, and it is why `Reveal` needs no preference check here — that
 * config neutralises framer-motion transforms. It does not reach this component,
 * because the count-up is a `requestAnimationFrame` loop, not a framer-motion
 * animation. So until this branch existed, a visitor who had told the browser to
 * reduce motion still watched the hero number tick from 0 to 38, while every CSS
 * effect in `globals.css` had correctly frozen.
 *
 * The rule applied is the one the rest of the fx layer already states: the
 * affordance survives, only the motion goes. Under the preference the loop is
 * never started and the figure is the target value.
 *
 * Two rejected shapes, recorded because both look right. Writing the value from
 * the effect (`if (reduce) setVal(to); return;`) is the obvious one, and eslint's
 * React Compiler rule refuses it: a synchronous `setState` in an effect body is a
 * cascading render, not a synchronisation with an external system. The other is
 * the plain render-time derivation below, which is correct for the client and
 * different from the server — SSR can only ever paint `0` here, because the
 * observer that starts a count-up cannot fire during server render. That is the
 * narrow case `suppressHydrationWarning` exists for, so it is applied to this one
 * element and no wider: the same device the root layout already uses for `<html>`.
 */
export function Counter({
  to,
  decimals = 0,
  duration = 1400,
  className,
}: {
  to: number;
  decimals?: number;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const reduce = useReducedMotion();
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (reduce || !inView) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 4);
      setVal(to * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, to, duration, reduce]);

  return (
    <span ref={ref} suppressHydrationWarning className={cn("num", className)}>
      {(reduce ? to : val).toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
    </span>
  );
}

/* ————— Shimmer skeleton ————— */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("sv-shimmer rounded-md", className)} />;
}

/* ————— Status pill ————— */
export function StatusPill({
  tone,
  children,
}: {
  tone: "green" | "red" | "amber" | "gray";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    green: "bg-green-tint text-green-deep border-[#c4e5d6]",
    red: "bg-red-tint text-red-soft border-[#f2cdcf]",
    amber: "bg-amber-tint text-amber-soft border-[#ecdcb8]",
    gray: "bg-secondary text-ink-2 border-line",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/* ————— Live dot ————— */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex h-2 w-2 text-primary", className)}>
      <span className="sv-pulse-ring absolute inset-0" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
    </span>
  );
}

/* ————— Mono chip ————— */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-line bg-white px-2 py-0.5 num text-[10.5px] text-ink-2",
        className,
      )}
    >
      {children}
    </span>
  );
}
