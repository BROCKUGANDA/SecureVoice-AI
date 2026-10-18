/**
 * The fonts are self-hosted, everything references a file that exists, and
 * nothing reaches for Google at build time.
 *
 * The failure this prevents is a CI run that is red for a reason that is not in
 * the diff. `src/app/layout.tsx` used four `next/font/google` loaders, which
 * makes `next build` fetch from fonts.gstatic.com. When that fetch fails the
 * build dies inside `[next]/internal/font/google/…module.css` with
 * `module-not-found`, and because the only variable is the network, the SAME
 * commit passes on one runner and fails on the next: dev run 39117764846 red,
 * PR run 39117766899 green, both on `7367617`. A production build cannot be
 * allowed to depend on somebody else's CDN being up.
 *
 * So the invariant is "the build needs no network for fonts", and it has three
 * parts, all of which are cheap to break by accident later:
 *
 *  1. no `next/font` import in the root layout,
 *  2. every `url()` in the generated sheet resolves to a committed file, and no
 *     committed file is unreferenced (orphan binaries ship forever),
 *  3. the preload list in the layout is EXACTLY the primary subset of every
 *     family in the sheet — because the filenames carry a content hash, so a
 *     refreshed font silently stops being preloaded, and a page that stops
 *     preloading its own fonts looks fine and paints later.
 *
 * Note the comment-stripping below. The layout's own explanation of this history
 * contains the literal string `next/font/google`, so an unstripped assertion
 * would fail on the file that documents the fix. The positive control at the end
 * proves the stripper ran.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const layoutRaw = read("src/app/layout.tsx");
// `{/* … */}` for JSX, and `/** … */` / `// …` for TypeScript.
const layout = layoutRaw
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

const sheet = read("src/app/fonts.css");
const fontDir = "public/fonts";
const onDisk = readdirSync(join(ROOT, fontDir)).filter((f) => f.endsWith(".woff2"));

/** Every `/fonts/<file>` a sheet or a link points at. */
function referenced(text: string): string[] {
  return [...text.matchAll(/\/fonts\/([A-Za-z0-9._-]+\.woff2)/g)].map((m) => m[1] as string);
}

/**
 * The `PRELOAD_FONTS` entries, read from the array literal.
 *
 * Deliberately NOT `referenced(layout)`: the layout builds its hrefs from a
 * template (`/fonts/${f}`), so the prefix is not adjacent to any filename in the
 * source and a path-shaped regex finds nothing there. That is what made the first
 * version of this test report "the layout preloads nothing" against a layout that
 * preloads eight files — the assertion was measuring the wrong shape, so it is
 * now explicit about which shape it reads.
 */
function preloadList(src: string): string[] {
  const start = src.indexOf("const PRELOAD_FONTS");
  expect(start, "the layout no longer declares PRELOAD_FONTS").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("];", start));
  return [...body.matchAll(/"([A-Za-z0-9._-]+\.woff2)"/g)].map((m) => m[1] as string);
}

const VARS = ["--font-display", "--font-sans", "--font-mono", "--font-arabic"] as const;

/** `var(--font-*)` consumers anywhere under src/, with the files that use them. */
function fontVarConsumers(): { used: Set<string>; where: string[] } {
  const used = new Set<string>();
  const where: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "fonts.css") continue;
        walk(join(dir, e.name), rel);
      } else if (/\.(tsx?|css)$/.test(e.name)) {
        const body = readFileSync(join(ROOT, dir, e.name), "utf8");
        for (const m of body.matchAll(/var\((--font-[a-z-]+)\)/g)) {
          used.add(m[1] as string);
          where.push(rel);
        }
      }
    }
  };
  walk("src", "src");
  return { used, where };
}

describe("self-hosted fonts", () => {
  test("the layout is comment-stripped before any assertion runs", () => {
    // Positive control. The raw file must still contain the phrase this gate
    // forbids — inside the prose that explains why — and the stripped file must
    // not. If the stripper breaks, this is the assertion that goes red first,
    // not the ban silently passing on the strength of a comment.
    expect(layoutRaw).toContain("next/font/google");
    expect(layout).not.toContain("next/font");
  });

  test("no font loader is imported at build time", () => {
    expect(layout).not.toMatch(/from\s+"next\/font\/(google|local)"/);
    // The generated sheet must actually be loaded, or the four custom properties
    // vanish and every `var(--font-*)` consumer falls back to the system stack.
    expect(layout).toContain('import "./fonts.css"');
  });

  test("every referenced font file exists, and none is orphaned", () => {
    const refs = referenced(sheet);
    expect(refs.length, "the sheet references no font files at all").toBeGreaterThan(0);
    for (const f of refs) {
      expect(
        existsSync(join(ROOT, fontDir, f)),
        `fonts.css points at ${f}, which is not committed`,
      ).toBe(true);
    }
    for (const f of onDisk) {
      expect(refs, `${f} is committed but no rule references it`).toContain(f);
    }
  });

  test("the preload list is exactly the primary subset of each family", () => {
    // The href is assembled from a template, so assert the template too — a list
    // that exists but is never turned into a link preloads nothing.
    expect(layout).toContain("`/fonts/${f}`");
    const preloaded = preloadList(layout);
    expect(preloaded.length, "the layout preloads nothing").toBeGreaterThan(0);
    for (const f of preloaded) {
      expect(existsSync(join(ROOT, fontDir, f)), `preloading ${f}, which does not exist`).toBe(
        true,
      );
      expect(sheet, `preloading ${f}, which no @font-face declares`).toContain(f);
      // `-s.p.` is Next's marker for the subsetted PRIMARY file, the one it puts
      // in next-font-manifest. Preloading an extreme slice instead buys nothing.
      expect(f, `${f} is not a primary subset`).toContain("-s.p.");
    }
    // And the converse: every primary in the sheet must be preloaded, or a
    // regenerated sheet quietly drops a family's preload.
    const primaries = [...new Set(onDisk.filter((f) => f.includes("-s.p.")))].sort();
    expect([...new Set(preloaded)].sort(), "the preload list and the sheet disagree").toEqual(
      primaries,
    );
  });

  test("the four variables the app consumes are defined by the sheet", () => {
    const { used, where } = fontVarConsumers();
    expect(
      used.size,
      "no var(--font-*) consumer found under src/ — did the walk break?",
    ).toBeGreaterThan(0);
    for (const name of used) {
      expect(where.join(), `${name} is consumed`).toBeTruthy();
      expect(
        sheet,
        `${name} is used in src/ but fonts.css never defines it, so it renders the system font`,
      ).toContain(`${name}:`);
    }
    for (const v of VARS) {
      expect(sheet, `${v} disappeared from the sheet`).toContain(`${v}:`);
    }
  });

  test("metric fallbacks survived generation", () => {
    // Next computes size-adjust/ascent-override so the first paint with the
    // system font occupies the same space as the reflow with the webfont. Losing
    // these silently reintroduces layout shift, which no screenshot catches.
    expect((sheet.match(/Fallback/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(sheet).toContain("size-adjust");
    expect(sheet).toContain("ascent-override");
  });
});
