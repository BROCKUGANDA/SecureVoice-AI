import { cn } from "@/lib/utils";

/**
 * The one loading indicator this app uses.
 *
 * This replaces the Lottie layer (`lottie-react` + hand-authored JSON in
 * `public/lottie/`), which was removed for three reasons, all of them measured
 * rather than aesthetic:
 *
 *  1. **It was a second loading system for a spinner.** `lottie-react` is ~60 kB
 *     of animation runtime plus a JSON fetch, to draw expanding rings. The CSS
 *     fallback was already sitting underneath it and was already the thing users
 *     saw whenever the dynamic import or the asset fetch lost the race — so on a
 *     cold load the honest answer was usually the CSS ring anyway.
 *  2. **It could not be made to fail closed.** Every failure path had to resolve
 *     to a fallback, which meant four separate ways for the designed animation to
 *     silently not appear. That is a lot of machinery whose only job is to be
 *     invisible.
 *  3. **It competed with first paint.** `LoadingScreen` covers the whole viewport
 *     on boot, so anything it fetches delays the one moment the page is trying to
 *     paint.
 *
 * What replaces it is deliberately boring: three absolutely-stacked rings on one
 * element, animated by CSS. Zero JavaScript, zero network, and — unlike the Lottie
 * component — no `"use client"` boundary, so it can be dropped into a server
 * component without pulling a client chunk along.
 *
 * `role="status"` + `aria-label` is preserved so screen readers still announce the
 * wait; an unlabelled spinner is a real accessibility regression, not a cosmetic
 * one. The ring inherits `currentColor`, so it picks up whatever text colour the
 * surrounding view uses (including `text-white` on the dark splash).
 */
export function LoadingIndicator({
  size = 40,
  className,
  label = "Loading",
}: {
  /** Outer ring diameter in px. */
  size?: number;
  className?: string;
  /** Announced to assistive tech; pass `""` for a purely decorative indicator. */
  label?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      {/* Three rings on one box rather than three stacked boxes: same visual
          result, and the stagger is the only thing that differs. */}
      <span
        className="sv-loading-rings absolute inset-0"
        style={{ "--sv-ring-delay": "0s" } as React.CSSProperties}
      />
      <span
        className="sv-loading-rings absolute inset-0"
        style={{ "--sv-ring-delay": "0.8s" } as React.CSSProperties}
      />
      <span
        className="sv-loading-rings absolute inset-0"
        style={{ "--sv-ring-delay": "1.6s" } as React.CSSProperties}
      />
    </span>
  );
}
