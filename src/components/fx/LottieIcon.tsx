"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Loading indicator backed by a Lottie animation, with a CSS fallback that is
 * ALWAYS available.
 *
 * Two constraints shaped this component:
 *
 *  1. **`lottie-react` is dynamically imported.** It is ~60 kB of animation
 *     runtime and a loading state is the last thing worth spending it on up
 *     front — the initial bundle must not carry a spinner engine. The import
 *     happens after mount, so the first paint is the fallback.
 *
 *  2. **A missing or broken asset can never blank a screen.** Every failure path
 *     — import rejection, 404 on the JSON, malformed JSON, an unknown `name` —
 *     resolves to the same CSS spinner. A decorative loading animation is not
 *     allowed to become a hard dependency of the console rendering.
 *
 * The animations are hand-authored in `public/lottie/` rather than downloaded,
 * so they carry no third-party attribution requirement and stay ~2–4 KB each.
 */

export type LottieName = "sonar" | "bars";

const SOURCES: Record<LottieName, string> = {
  sonar: "/lottie/sonar.json",
  bars: "/lottie/bars.json",
};

/** Minimal shape of the parts of lottie-react this component uses. */
type LottieComponent = (props: Record<string, unknown>) => React.ReactElement | null;

export function LottieIcon({
  name = "sonar",
  size = 40,
  className,
  label = "Loading",
}: {
  name?: LottieName;
  size?: number;
  className?: string;
  label?: string;
}) {
  const [Comp, setComp] = useState<LottieComponent | null>(null);
  const [data, setData] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    // Two independent failures, two independent guards. `setComp`/`setData` are
    // only called when the effect is still current, so a fast unmount cannot
    // set state on a dead component.
    void import("lottie-react")
      .then((mod) => {
        if (!alive) return;
        const component = (mod as { default?: LottieComponent }).default;
        if (component) setComp(() => component);
      })
      .catch(() => {
        /* keep the CSS fallback */
      });
    fetch(SOURCES[name])
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("animation asset unavailable"))))
      .then((json) => {
        if (alive) setData(json);
      })
      .catch(() => {
        /* keep the CSS fallback */
      });
    return () => {
      alive = false;
    };
  }, [name]);

  if (Comp && data) {
    return (
      <span role="status" aria-label={label} className={cn("inline-flex", className)}>
        <Comp animationData={data} loop autoplay width={size} height={size} />
      </span>
    );
  }

  return (
    <span role="status" aria-label={label} className={cn("inline-flex", className)}>
      <Loader2
        style={{ width: size / 2, height: size / 2 }}
        className="animate-spin text-ink-3"
        aria-hidden="true"
      />
    </span>
  );
}
