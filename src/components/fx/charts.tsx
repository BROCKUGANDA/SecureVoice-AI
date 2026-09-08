"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/* ————— Area/line trend chart (SVG, animated draw) ————— */
export function TrendChart({
  data,
  labels,
  className,
}: {
  data: number[];
  labels?: string[];
  className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 220;
  const pad = { l: 8, r: 8, t: 14, b: 22 };
  const max = Math.max(...data) * 1.12;
  const min = Math.min(...data) * 0.85;
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const pts = data.map((v, i) => {
    const x = pad.l + (i / (data.length - 1)) * iw;
    const y = pad.t + ih - ((v - min) / (max - min)) * ih;
    return [x, y] as const;
  });

  const line = pts
    .map(([x, y], i) => {
      if (i === 0) return `M ${x} ${y}`;
      const [px, py] = pts[i - 1];
      const cx = (px + x) / 2;
      return `C ${cx} ${py} ${cx} ${y} ${x} ${y}`;
    })
    .join(" ");
  const area = `${line} L ${pts[pts.length - 1][0]} ${pad.t + ih} L ${pts[0][0]} ${pad.t + ih} Z`;

  return (
    <div className={cn("relative", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Prevented loss trend">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0b7a55" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#0b7a55" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={pad.l}
            x2={W - pad.r}
            y1={pad.t + ih * f}
            y2={pad.t + ih * f}
            stroke="#e7eae3"
            strokeDasharray="3 5"
          />
        ))}
        <motion.path
          d={area}
          fill="url(#trendFill)"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 1.2, delay: 0.6 }}
        />
        <motion.path
          d={line}
          fill="none"
          stroke="#0b7a55"
          strokeWidth={2.4}
          strokeLinecap="round"
          className="sv-draw"
          initial={{ strokeDashoffset: 1200, strokeDasharray: 1200 }}
          whileInView={{ strokeDashoffset: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 1.8, ease: [0.65, 0, 0.35, 1] }}
        />
        {pts.map(([x, y], i) => (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <circle cx={x} cy={y} r={10} fill="transparent" />
            <circle
              cx={x}
              cy={y}
              r={hover === i ? 5 : 3}
              fill="#fff"
              stroke="#0b7a55"
              strokeWidth={2}
              className="transition-all"
            />
          </g>
        ))}
        {hover !== null && (
          <g>
            <rect
              x={Math.min(Math.max(pts[hover][0] - 34, 2), W - 70)}
              y={pts[hover][1] - 34}
              width="68"
              height="24"
              rx="6"
              fill="#101812"
            />
            <text
              x={Math.min(Math.max(pts[hover][0], 36), W - 34)}
              y={pts[hover][1] - 18}
              textAnchor="middle"
              fill="#fff"
              fontSize="11"
              fontFamily="var(--font-mono)"
            >
              AED {data[hover]}K
            </text>
          </g>
        )}
        {labels &&
          pts.map(([x], i) =>
            i % 2 === 0 ? (
              <text key={i} x={x} y={H - 4} textAnchor="middle" fontSize="9.5" fill="#79857c" fontFamily="var(--font-mono)">
                {labels[i]}
              </text>
            ) : null
          )}
      </svg>
    </div>
  );
}

/* ————— Horizontal bars ————— */
export function HBars({
  items,
  className,
}: {
  items: { label: string; sub?: string; pct: number }[];
  className?: string;
}) {
  return (
    <div className={cn("space-y-3.5", className)}>
      {items.map((it, i) => (
        <div key={it.label}>
          <div className="flex items-baseline justify-between mb-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-medium text-foreground">{it.label}</span>
              {it.sub && <span className="font-arabic text-[11px] text-ink-3" dir="rtl">{it.sub}</span>}
            </div>
            <span className="num text-[12px] text-ink-2">{it.pct}%</span>
          </div>
          <div className="h-[7px] rounded-full bg-secondary overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{
                background: `linear-gradient(90deg, #0b7a55, ${`hsl(${158 - i * 4} 62% ${38 + i * 4}%)`})`,
              }}
              initial={{ width: 0 }}
              whileInView={{ width: `${it.pct}%` }}
              viewport={{ once: true }}
              transition={{ duration: 1, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ————— Donut ————— */
export function Donut({
  items,
  size = 180,
  className,
}: {
  items: { label: string; pct: number; color: string }[];
  size?: number;
  className?: string;
}) {
  const r = 60;
  const c = 2 * Math.PI * r;
  const segs = items.map((it, i) => ({
    ...it,
    offset: items.slice(0, i).reduce((s, x) => s + x.pct / 100, 0),
  }));
  return (
    <div className={cn("relative", className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 160 160" className="w-full h-full -rotate-90">
        <circle cx="80" cy="80" r={r} fill="none" stroke="#f1f3ec" strokeWidth="16" />
        {segs.map((it) => (
          <motion.circle
            key={it.label}
            cx="80"
            cy="80"
            r={r}
            fill="none"
            stroke={it.color}
            strokeWidth="16"
            strokeLinecap="butt"
            strokeDasharray={`${(it.pct / 100) * c} ${c}`}
            initial={{ strokeDashoffset: -(it.offset - it.pct / 100) * c + c }}
            whileInView={{ strokeDashoffset: -it.offset * c }}
            viewport={{ once: true }}
            transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-2xl font-semibold text-foreground">58%</span>
        <span className="text-[10.5px] text-ink-3">prevented</span>
      </div>
    </div>
  );
}

/* ————— Gauge (half arc) ————— */
export function Gauge({
  pct,
  size = 170,
  label,
}: {
  pct: number;
  size?: number;
  label?: string;
}) {
  const r = 62;
  const arcLen = Math.PI * r;
  return (
    <div className="relative" style={{ width: size, height: size * 0.64 }}>
      <svg viewBox="0 0 160 96" className="w-full h-full">
        <path
          d={`M 18 84 A ${r} ${r} 0 0 1 142 84`}
          fill="none"
          stroke="#f1f3ec"
          strokeWidth="13"
          strokeLinecap="round"
        />
        <motion.path
          d={`M 18 84 A ${r} ${r} 0 0 1 142 84`}
          fill="none"
          stroke="#0b7a55"
          strokeWidth="13"
          strokeLinecap="round"
          strokeDasharray={arcLen}
          initial={{ strokeDashoffset: arcLen }}
          whileInView={{ strokeDashoffset: arcLen * (1 - pct / 100) }}
          viewport={{ once: true }}
          transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className="num text-2xl font-semibold">{Math.round(pct)}%</div>
        {label && <div className="text-[10.5px] text-ink-3">{label}</div>}
      </div>
    </div>
  );
}

/* ————— Baseline vs current vs target comparison bar ————— */
export function CompareBar({
  baseline,
  current,
  target,
  max,
  good,
  unit,
  delay = 0,
}: {
  baseline: number;
  current: number;
  target: number;
  max: number;
  good: "up" | "down";
  unit: string;
  delay?: number;
}) {
  const fmt = (v: number) =>
    v >= 1000 ? `${Math.round(v).toLocaleString()}` : `${v}`;
  const bw = (baseline / max) * 100;
  const cw = (current / max) * 100;
  const tw = (target / max) * 100;
  const fmtUnit = (v: number) =>
    unit === "s" && v >= 60
      ? `${Math.floor(v / 60)}m ${v % 60}s`
      : `${fmt(v)}${unit === "s" ? "s" : unit}`;
  return (
    <div className="space-y-2">
      <Row label="Baseline" w={bw} cls="bg-[#c9d2ca]" val={fmtUnit(baseline)} delay={delay} />
      <Row label="Now" w={cw} cls={good === "up" ? "bg-primary" : "bg-amber-soft"} val={fmtUnit(current)} delay={delay + 0.12} />
      <Row label="Target" w={tw} cls="bg-green-deep/85" val={fmtUnit(target)} dashed delay={delay + 0.24} />
    </div>
  );
}

function Row({
  label,
  w,
  cls,
  val,
  dashed,
  delay,
}: {
  label: string;
  w: number;
  cls: string;
  val: string;
  dashed?: boolean;
  delay: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-[10.5px] text-ink-3 font-medium">{label}</span>
      <div className="relative h-[18px] flex-1 rounded-[5px] bg-secondary/70 overflow-hidden">
        <motion.div
          className={cn("h-full rounded-[5px]", cls)}
          style={
            dashed
              ? { backgroundImage: "repeating-linear-gradient(135deg, rgba(255,255,255,.28) 0 5px, transparent 5px 10px)" }
              : undefined
          }
          initial={{ width: 0 }}
          whileInView={{ width: `${w}%` }}
          viewport={{ once: true }}
          transition={{ duration: 1.1, delay, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
      <span className="num w-[86px] shrink-0 text-right text-[11.5px] text-ink-2">{val}</span>
    </div>
  );
}

/* ————— Sparkline ————— */
export function Sparkline({
  data,
  up = true,
  className,
}: {
  data: number[];
  up?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const W = 120;
  const H = 36;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * W;
      const y = H - 4 - ((v - min) / (max - min || 1)) * (H - 8);
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <div ref={ref} className={className}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-9">
        <polyline
          points={pts}
          fill="none"
          stroke={up ? "#0b7a55" : "#d64550"}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
