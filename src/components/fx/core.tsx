"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useInView } from "framer-motion";
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
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!inView) return;
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
  }, [inView, to, duration]);

  return (
    <span ref={ref} className={cn("num", className)}>
      {val.toLocaleString("en-US", {
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

/* ————— Section header (editorial numbering) ————— */
export function SectionHead({
  index,
  en,
  ar,
  lang,
  desc,
  light = false,
}: {
  index: string;
  en: string;
  ar: string;
  lang: "en" | "ar";
  desc?: string;
  light?: boolean;
}) {
  return (
    <div className="max-w-3xl">
      <Reveal>
        <div className="flex items-center gap-3">
          <span className={cn("micro", light ? "text-green-bright" : "text-primary")}>{index}</span>
          <span className={cn("h-px w-10", light ? "bg-white/25" : "bg-line")} />
          <span
            dir="rtl"
            className={cn("font-arabic text-[13px]", light ? "text-white/60" : "text-ink-3")}
          >
            {ar}
          </span>
        </div>
      </Reveal>
      <Reveal delay={0.08}>
        <h2
          className={cn(
            "font-display mt-4 text-3xl sm:text-4xl lg:text-[2.75rem] leading-[1.08] font-semibold tracking-tight",
            light ? "text-white" : "text-foreground",
          )}
        >
          {lang === "ar" ? (
            <span dir="rtl" className="font-arabic">
              {ar}
            </span>
          ) : (
            en
          )}
        </h2>
      </Reveal>
      {desc && (
        <Reveal delay={0.16}>
          <p
            className={cn(
              "mt-4 text-base sm:text-lg leading-relaxed",
              light ? "text-white/65" : "text-ink-2",
            )}
          >
            {desc}
          </p>
        </Reveal>
      )}
    </div>
  );
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
