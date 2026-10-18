/**
 * Vendor the webfonts that `next/font/google` used to fetch at build time.
 *
 * WHY THIS EXISTS. `src/app/layout.tsx` imported four families from
 * `next/font/google`, which makes the BUILD download them from
 * fonts.gstatic.com. When that fetch fails on a runner the build dies with a
 * module-not-found inside `[next]/internal/font/google/…module.css`, and because
 * the only variable is the network the same commit is green on one run and red on
 * the next (dev run 39117764846 failed, PR run 39117766899 passed, both on
 * `7367617`). A production build must not depend on somebody else's CDN.
 *
 * WHY HAND-WRITTEN `@font-face` INSTEAD OF `next/font/local`. The type shipped in
 * this version is `src: Array<{path, weight?, style?}>`
 * (node_modules/next/dist/compiled/@next/font/dist/local/index.d.ts) — there is NO
 * `unicodeRange`, and `declarations` may not set `src`, `font-display`,
 * `font-weight` or `font-style` (validate-local-font-function-call.js:50). So
 * `next/font/local` cannot express Google's per-script slicing, and one file per
 * weight would have to choose between the Arabic glyphs and the ASCII digits the
 * Arabic UI renders on the same line. This script instead copies what a real build
 * emitted: every `@font-face`, every `unicode-range`, every `* Fallback` metric
 * block. Coverage and layout-shift behaviour are unchanged.
 *
 * WHAT THIS SCRIPT IS. A harvest of ONE networked build that still used the Google
 * loader — the migration, run once. It is deliberately not a steady-state refresh:
 * a vendored build no longer emits `/_next/static/media/*.woff2` faces, so running
 * it then would rewrite the sheet onto itself, and it refuses instead. To change a
 * font: restore the loader for one networked build, run this, re-apply the layout
 * change, and let `tests/surface/self-hosted-fonts.test.ts` check that the sheet,
 * the files and the preload list still agree.
 *
 * HOW IT PROTECTS THE EXISTING SET. It plans and validates everything before
 * touching the filesystem, and it prunes stale `.woff2` by name rather than
 * deleting `public/fonts/` — that directory also holds the hand-authored
 * `README.md` and `licenses/*.OFL.txt`, which a font refresh must not destroy. The
 * first version did the opposite: `rmSync` ran before the loop, so a mid-loop
 * failure wiped the working set it was meant to replace.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const chunksDir = join(root, ".next", "static", "chunks");
const mediaDir = join(root, ".next", "static", "media");
const outDir = join(root, "public", "fonts");

/** family -> the CSS variable the app consumes, and the file prefix. */
const FAMILIES = [
  { cssFamily: "Space Grotesk", variable: "--font-display", slug: "space-grotesk" },
  { cssFamily: "Inter", variable: "--font-sans", slug: "inter" },
  { cssFamily: "JetBrains Mono", variable: "--font-mono", slug: "jetbrains-mono" },
  { cssFamily: "IBM Plex Sans Arabic", variable: "--font-arabic", slug: "ibm-plex-sans-arabic" },
];

/** Every early exit says what was NOT written, so a failure is known to be safe. */
function fail(message) {
  console.error(`${message}\nNothing was written.`);
  process.exit(1);
}

let css;
try {
  css = readdirSync(chunksDir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join(chunksDir, f), "utf8"))
    .join("\n");
} catch {
  fail(`no ${chunksDir} — run \`bun run build\` first`);
}

/** The declaration blocks. These CSS files have no strings containing `}`. */
const blocks = css.match(/@font-face\s*{[^}]*}/g) ?? [];
if (blocks.length === 0) fail("the built CSS contains no @font-face");

const familyOf = (block) => {
  const fam = /font-family:\s*([^;]+);/.exec(block)?.[1]?.replace(/["']/g, "").trim();
  return FAMILIES.find((f) => fam === f.cssFamily || fam === `${f.cssFamily} Fallback`) ?? null;
};

// ————— pass 1: plan and validate, touching nothing ————————————————
/** emitted basename -> { name, slug } */
const plan = new Map();
/** the path-substituted blocks, in source order */
const faces = [];

for (const block of blocks) {
  const f = familyOf(block);
  if (!f) continue;
  const url = /url\(([^)]+\.woff2)\)/.exec(block)?.[1];
  if (!url) continue;
  if (url.startsWith("/fonts/")) {
    fail(
      `the build's CSS already references vendored fonts (${url}). This script harvests a\n` +
        "build that still used next/font/google; on a vendored build it would rewrite the\n" +
        "sheet onto itself. See public/fonts/README.md for the refresh procedure.",
    );
  }
  const emitted = url.split("/").pop();
  if (!existsSync(join(mediaDir, emitted))) {
    fail(`MISSING emitted font file: ${emitted} — the build output is incomplete`);
  }
  if (!plan.has(emitted)) {
    // `[hash]-s[.<kind>].<rest>.woff2`: `s` = subsetted, `p` = the primary file
    // Next preloads for that family. The suffix is kept so a reader and the gate
    // can still tell which files are preloaded on first paint.
    const parts = emitted.split("-");
    const hash = parts.shift().replace(/[^a-z0-9]/gi, "");
    const suffix = parts.join("-").replace(/\.[a-z0-9]+$/i, "");
    // One name per distinct SOURCE font, never per weight: three of these four
    // families are variable, and naming by weight stores identical bytes under
    // four names — the trap `demo/walkthrough/source/assets/fonts` is already in
    // (Inter-400/-500/-600 there are one file, sha256-identical). The content hash
    // stays in the name because `public/` ships without a build-time URL rewrite,
    // so a refreshed font must change filename or returning visitors keep the old
    // bytes from cache.
    plan.set(emitted, {
      name: `${f.slug}-${hash}${suffix ? `-${suffix}` : ""}.woff2`,
      slug: f.slug,
    });
  }
  // Verbatim apart from the path, and that is a fact rather than an intention: the
  // substitution must be reversible. The unicode-range is deliberately NOT
  // rewritten — Google and Next emit wildcard ranges like `U+??` (valid CSS for
  // U+0000-U+00FF), which is not corruption and must not be "fixed".
  const name = plan.get(emitted).name;
  const rewritten = block.replace(url, `/fonts/${name}`);
  if (rewritten.replace(/\/fonts\/[^)]+\.woff2/, url) !== block) {
    fail(`block for ${emitted} is not a pure path substitution`);
  }
  faces.push(rewritten);
}

if (plan.size === 0) fail("no next/font/google faces found in the build");

// The `* Fallback` blocks carry Next's computed metric overrides (size-adjust,
// ascent-override) that hold CLS at zero while the webfont swaps in. They name no
// file, so they are copied verbatim — and losing them silently reintroduces a
// layout shift no screenshot catches, so their absence is fatal.
const fallbacks = blocks.filter((b) => /font-family:[^;]*Fallback/.test(b));
if (fallbacks.length < FAMILIES.length) {
  fail(`expected a Fallback block per family, found ${fallbacks.length}`);
}

// The custom properties Next put on <html class="…__variable">, now declared once
// on :root so every `var(--font-*)` consumer in src/ keeps working.
const vars = FAMILIES.map((f) => {
  const m = new RegExp(`--${f.variable.slice(2)}\\s*:\\s*([^;}]+)`).exec(css);
  if (!m) fail(`no ${f.variable} definition in the built CSS`);
  return `  ${f.variable}: ${m[1]};`;
});

// ————— pass 2: validated, now write ————————
mkdirSync(outDir, { recursive: true });
const wanted = new Set([...plan.values()].map((v) => v.name));
for (const stale of readdirSync(outDir).filter((f) => f.endsWith(".woff2") && !wanted.has(f))) {
  unlinkSync(join(outDir, stale));
}
for (const [emitted, { name }] of plan) {
  copyFileSync(join(mediaDir, emitted), join(outDir, name));
}

const namesBySlug = new Map();
for (const { name, slug } of plan.values()) {
  namesBySlug.set(slug, [...(namesBySlug.get(slug) ?? []), name]);
}

writeFileSync(
  join(root, "src", "app", "fonts.css"),
  `/* GENERATED by scripts/vendor-fonts.mjs — do not edit by hand.
 *
 * The four families src/app/layout.tsx used to request from next/font/google,
 * vendored so the build needs no network. Each block below is copied from the CSS a
 * real build emitted, including its unicode-range; the ${fallbacks.length} Fallback
 * blocks are Next's computed metric overrides, kept so swapping fonts in does not
 * move layout. See the header of scripts/vendor-fonts.mjs for why this is not
 * next/font/local, and public/fonts/README.md for the refresh procedure.
 */

:root {
${vars.join("\n")}
}

${faces.join("\n\n")}

${fallbacks.join("\n\n")}
`,
);

writeFileSync(
  join(outDir, "manifest.json"),
  `${JSON.stringify(
    {
      generatedFrom: "the @font-face output of a networked `next build` that used next/font/google",
      note: "regenerate with scripts/vendor-fonts.mjs; see public/fonts/README.md",
      files: FAMILIES.map((f) => ({
        slug: f.slug,
        variable: f.variable,
        count: (namesBySlug.get(f.slug) ?? []).length,
        names: namesBySlug.get(f.slug) ?? [],
      })),
    },
    null,
    2,
  )}\n`,
);

console.log(
  `wrote src/app/fonts.css: ${faces.length} faces + ${fallbacks.length} fallbacks, ${plan.size} files in public/fonts`,
);
for (const f of FAMILIES) {
  console.log(`  ${f.slug}: ${(namesBySlug.get(f.slug) ?? []).length} files -> ${f.variable}`);
}
