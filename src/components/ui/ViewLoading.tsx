/**
 * The fallback shown while a view's code-split chunk is landing, or while a
 * server route is still fetching.
 *
 * It replaces `<div className="min-h-[60vh]" aria-hidden />`, which reserved the
 * height and rendered nothing — so a slow connection showed a blank screen with
 * no indication the product was arriving rather than broken. Reserving the frame
 * is the right instinct (no layout shift when the view mounts) and the wrong
 * execution: the frame has to say what is happening in the shape of the thing
 * that is coming.
 *
 * The shapes are per view family, not per view. A dashboard that shimmers as a
 * wall of prose reads as the wrong page loading; the six-cell table row does not.
 * Nothing here invents content — no fake numbers, no skeleton text that could be
 * mistaken for a real figure — because on this product a placeholder that looks
 * like data is a measurement someone could quote.
 *
 * `sv-shimmer` is the site's existing sweep and `globals.css` disables its
 * animation under `prefers-reduced-motion`, so the static block remains as the
 * loading indicator for people who asked for no motion.
 */

type Variant = "page" | "table" | "panel" | "chat";

/** Widths are arbitrary but fixed, so a re-render never re-shuffles the shape. */
const PROSE_LINES = ["58%", "94%", "88%", "96%", "46%", "91%", "78%"];
const TABLE_ROWS = ["62%", "48%", "71%", "55%", "66%", "44%"];

function Bar({ w, h = "h-3", className = "" }: { w: string; h?: string; className?: string }) {
  return (
    <div aria-hidden className={`sv-shimmer rounded-md ${h} ${className}`} style={{ width: w }} />
  );
}

export function ViewLoading({ variant = "page" }: { variant?: Variant }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16"
    >
      <span className="sr-only">
        <span lang="en">Loading this screen.</span> <span lang="ar">جارٍ تحميل هذه الشاشة.</span>
      </span>

      {variant === "page" && (
        <div className="space-y-4">
          <Bar w="34%" h="h-8" />
          <Bar w="52%" h="h-4" />
          <div className="space-y-3 pt-4">
            {PROSE_LINES.map((w) => (
              <Bar key={w} w={w} />
            ))}
          </div>
        </div>
      )}

      {variant === "table" && (
        <div className="space-y-5">
          <div className="flex items-end justify-between gap-4">
            <Bar w="26%" h="h-7" />
            <Bar w="14%" h="h-9" />
          </div>
          <div className="space-y-2 rounded-2xl border border-line p-4">
            <Bar w="100%" h="h-8" />
            {TABLE_ROWS.map((w) => (
              <div key={w} className="flex items-center gap-4">
                <Bar w={w} />
                <Bar w="10%" className="ml-auto" />
                <Bar w="12%" />
              </div>
            ))}
          </div>
        </div>
      )}

      {variant === "panel" && (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-3 rounded-2xl border border-line p-5">
              <Bar w="46%" h="h-5" />
              <Bar w="80%" />
              <Bar w="64%" />
              <Bar w="100%" h="h-10" className="mt-4" />
            </div>
          ))}
        </div>
      )}

      {variant === "chat" && (
        <div className="mx-auto max-w-2xl space-y-4">
          {[
            { w: "62%", align: "start" },
            { w: "44%", align: "end" },
            { w: "72%", align: "start" },
            { w: "36%", align: "end" },
          ].map((b) => (
            <div
              key={b.w}
              className={`flex ${b.align === "end" ? "justify-end" : "justify-start"}`}
            >
              <div className="sv-shimmer h-12 rounded-2xl" style={{ width: b.w }} aria-hidden />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
