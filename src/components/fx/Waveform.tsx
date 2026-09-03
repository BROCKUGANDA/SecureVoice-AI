"use client";

import { useEffect, useRef } from "react";

/**
 * Canvas voice waveform — symmetric bars driven by layered sine noise.
 * `active` → energetic speaking bars; idle → calm low ripple.
 */
export function Waveform({
  active,
  intensity = 1,
  color = "#0b7a55",
  barColor2,
  className,
  bars = 48,
}: {
  active: boolean;
  intensity?: number;
  color?: string;
  barColor2?: string;
  className?: string;
  bars?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const start = performance.now();
    const draw = (now: number) => {
      const t = (now - start) / 1000;
      ctx.clearRect(0, 0, w, h);
      const gap = 3;
      const bw = Math.max(2, (w - gap * (bars - 1)) / bars);
      const mid = h / 2;

      for (let i = 0; i < bars; i++) {
        const x = i * (bw + gap);
        const centered = Math.abs(i - bars / 2) / (bars / 2); // 0 center → 1 edge
        const envelope = 0.35 + 0.65 * (1 - centered * centered);
        const noise =
          Math.sin(t * 7.3 + i * 0.9) * 0.5 +
          Math.sin(t * 11.7 + i * 1.7) * 0.3 +
          Math.sin(t * 3.1 + i * 0.5) * 0.2;
        const level = activeRef.current
          ? envelope * (0.42 + 0.58 * Math.abs(noise)) * intensity
          : 0.06 + 0.05 * Math.abs(Math.sin(t * 1.4 + i * 0.35));
        const barH = Math.max(2, level * (h * 0.92));
        const grad = ctx.createLinearGradient(0, mid - barH / 2, 0, mid + barH / 2);
        const c1 = color;
        const c2 = barColor2 ?? color;
        grad.addColorStop(0, c2);
        grad.addColorStop(0.5, c1);
        grad.addColorStop(1, c2);
        ctx.fillStyle = activeRef.current ? grad : "#c9d2ca";
        ctx.beginPath();
        const r = Math.min(bw / 2, 2);
        const y0 = mid - barH / 2;
        ctx.roundRect(x, y0, bw, barH, r);
        ctx.fill();
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [active, intensity, color, barColor2, bars]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

/** Small inline equalizer (CSS-only, for chips/rows) */
export function Equalizer({ active, className }: { active: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-end gap-[2px] h-3 ${className ?? ""}`} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[2.5px] rounded-full bg-current origin-bottom"
          style={{
            height: "100%",
            transform: active ? undefined : "scaleY(0.25)",
            animation: active ? `sv-eq 0.9s ease-in-out ${i * 0.13}s infinite` : undefined,
          }}
        />
      ))}
    </span>
  );
}
