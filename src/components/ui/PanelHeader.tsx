import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The black top band of a card — one component for every "box header" in the
 * demo surfaces (call stage, live-voice panel, hero call card, ops panel,
 * deck chrome, rail cards).
 *
 * WHY bg-black and not a palette token: the darkest value in the design
 * system (--foreground, #101812) is the *text* token, not a surface, and the
 * ink/foreground tokens are actively retuned by the [data-contrast="high"]
 * theme in src/app/globals.css. Pinning the band to bg-black (and white text
 * inside it) keeps the banner — and its readability contract — stable no
 * matter how the token set is retuned later.
 *
 * The five card headers this replaces were copy-pasted
 * `border-b border-line bg-card px-5 py-4` variants that drifted apart
 * (padding, wrap, decorations); they now share one implementation. Text and
 * icons that sit directly on the band must be white/near-white — the old
 * `text-foreground`/`text-ink-2` pairs are invisible on black and were moved
 * to `text-white` / `text-white/70` at every call site. Content on its own
 * light chip (timer pill, REC badge) keeps its original colors.
 */
export function PanelHeader({
  icon,
  title,
  right,
  decoration,
  className,
}: {
  /** Chip / glyph rendered left of the title — pass the whole chip element. */
  icon?: ReactNode;
  /** Title block; may be a multi-line fragment. Inherits white from the band. */
  title: ReactNode;
  /** Right-aligned content (timers, badges, toggles). */
  right?: ReactNode;
  /** Absolute-positioned layer painted behind the content row (radial glows). */
  decoration?: ReactNode;
  /** Extra classes on the band itself, e.g. a tighter padding override. */
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden border-b border-line bg-black px-5 py-4 text-white",
        className,
      )}
    >
      {decoration}
      {/* flex-1 on the title column lets a full-width child (the deck's URL
          pill) stretch, while justify-between still pins `right` to the edge. */}
      <div className="relative flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {icon}
          <div className="min-w-0 flex-1 leading-tight">{title}</div>
        </div>
        {right ? <div className="flex flex-wrap items-center gap-2.5">{right}</div> : null}
      </div>
    </div>
  );
}
