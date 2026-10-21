/**
 * Loading-surface gate: every screen the user can reach must show its own shape
 * while it arrives.
 *
 * Two defects this pins, both of which shipped:
 *
 *   1. The code-split view loader rendered `<div className="min-h-[60vh]"
 *      aria-hidden />`. It reserved the height and showed nothing, so on a slow
 *      connection an in-app navigation was a blank rectangle — indistinguishable
 *      from a broken page, which is the one thing a loading state must never be.
 *   2. Routes whose page component `await`s server data had no `loading.tsx`, so
 *      the browser held the previous screen with no indication anything was
 *      coming. Four routes suspended and zero had a fallback.
 *
 * The second is the load-bearing assertion: it is derived from the filesystem, so
 * adding a data-fetching page without a fallback fails here rather than in
 * someone's demo. No network, no database.
 *
 *   bun run test unit/loading-surface
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ViewLoading } from "@/components/ui/ViewLoading";

const repo = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const appDir = new URL("../../src/app", import.meta.url);

const VARIANTS = ["page", "table", "panel", "chat"] as const;

function render(variant: (typeof VARIANTS)[number]): string {
  return renderToStaticMarkup(createElement(ViewLoading, { variant }));
}

describe("the view loading fallback is a real indicator, not a blank frame", () => {
  test.each(VARIANTS.slice())("%s renders a live region that says what is happening", (variant) => {
    const html = render(variant);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    // Announced in both shipped languages, because this markup is server-rendered
    // and the language lives in client state, so it cannot pick one.
    expect(html).toContain("Loading this screen");
    expect(html).toContain("جارٍ تحميل هذه الشاشة");
    // The shimmer bars are the indicator. A status region with no visible shape is
    // the empty box this replaced, wearing a label.
    const bars = (html.match(/sv-shimmer/g) ?? []).length;
    expect(bars).toBeGreaterThanOrEqual(4);
  });

  test("no variant invents content a reader could mistake for data", () => {
    for (const variant of VARIANTS) {
      const text = render(variant)
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      // The only words allowed in a loading frame are the announcement itself.
      expect(text, `${variant} skeleton carries copy`).toBe(
        "Loading this screen. جارٍ تحميل هذه الشاشة.",
      );
    }
  });

  test("the shell's chunk loader uses it, and the empty frame is gone", () => {
    const page = repo("src/app/page.tsx");
    expect(page).toContain("loading: () => <ViewLoading variant={variant} />");
    expect(page).not.toContain('className="min-h-[60vh]" aria-hidden');
  });

  test("the sweep is disabled for people who asked for no motion", () => {
    // The static block still reads as a placeholder, but the gate exists because
    // deleting the media rule would silently make every skeleton an animation.
    const css = repo("src/app/globals.css");
    expect(css).toMatch(/@keyframes sv-shimmer/);
    expect(css).toMatch(/\.sv-shimmer\s*\{\s*animation:\s*none\s*!important/);
  });
});

describe("every route that awaits data has a loading boundary", () => {
  /** All page segments under src/app, with the fallback that sits beside them. */
  function routes(): { dir: string; suspends: boolean; hasFallback: boolean }[] {
    const out: { dir: string; suspends: boolean; hasFallback: boolean }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === "page.tsx") {
          const src = readFileSync(full, "utf8");
          // What makes a segment need a fallback is an ASYNC default export: that
          // is the component the router suspends on. Matching any `await` in the
          // file would flag pages whose only async work is `generateMetadata`,
          // which never blocks the render — and a rule that cries wolf here is how
          // the real gap gets lost in the noise.
          const asyncDefault =
            /export\s+default\s+async\s+function/.test(src) ||
            /export\s+async\s+function\s+\w*[Pp]age/.test(src) ||
            /export\s+default\s+async\s+\(/.test(src);
          out.push({
            dir,
            suspends: asyncDefault,
            hasFallback: readdirSync(dir).includes("loading.tsx"),
          });
        } else if (entry.endsWith(".tsx")) {
          // covered by the walk
        }
      }
    };
    walk(fileURLToPath(appDir));
    return out;
  }

  /** Route name for the failure message, with either path separator. */
  const routeName = (dir: string): string => dir.replace(/^.*[\\/]src[\\/]app[\\/]?/, "") || dir;

  test("the scan found the route set at all", () => {
    const r = routes();
    expect(r.length).toBeGreaterThanOrEqual(10);
    expect(r.filter((x) => x.suspends).length).toBeGreaterThanOrEqual(1);
  });

  test("no data-fetching page segment is missing its fallback", () => {
    const offenders = routes()
      .filter((r) => r.suspends && !r.hasFallback)
      .map((r) => routeName(r.dir));
    expect(
      offenders,
      `these routes await server data with no loading.tsx, so the old screen just hangs: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  test("each fallback renders the shared skeleton rather than a bespoke spinner", () => {
    for (const r of routes()) {
      if (!r.hasFallback) continue;
      const src = readFileSync(join(r.dir, "loading.tsx"), "utf8");
      expect(src, `${r.dir} does not use the shared fallback`).toContain("ViewLoading");
      // A `role="status"` region comes from the component; re-implementing it per
      // route is how one of them ends up announcing nothing.
      expect(src).not.toMatch(/animate-spin|LoadingDots|Spinner/);
    }
  });
});
