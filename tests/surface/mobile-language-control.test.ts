/**
 * The phone menu carries a language control, and it never duplicates the one in
 * the bar.
 *
 * Two facts made this a defect rather than a nicety:
 *
 *   · the header's language cluster is `hidden … sm:flex`, so below 640px there is
 *     no language control in the bar at all;
 *   · the interface ships in exactly two languages — English and Arabic
 *     (`src/lib/i18n/registry.ts`, and the rule `UI_LANGS` is now derived from
 *     `TRANSLATED_UI_LANGS`). So on a handset, a user who landed in the wrong one
 *     had no way to change it. For an Arabic-speaking operator that meant the
 *     Arabic console was unreachable on the device most of their staff have.
 *
 * The mobile panel existed and was the obvious home for the control, which is why
 * these assertions are structural rather than a repo-wide grep for `setLang`: the
 * property worth protecting is *where* the control is and *when* it is visible.
 *
 *  1. INSIDE the panel. The control has to live between the panel opening and the
 *     account block, because a control rendered outside `{menuOpen && …}` is in
 *     the DOM at widths where nothing shows it, and a grep cannot tell that apart
 *     from a working one.
 *  2. MUTUALLY EXCLUSIVE with the bar cluster. The panel is `md:hidden` (visible
 *     below 768px) and the bar cluster is `sm:flex` (visible at 640px and up), so
 *     640–767px renders both. Without `sm:hidden` on the panel's row a tablet-width
 *     visitor sees two identical language controls at once — and framer-motion's
 *     shared `layoutId` would let the animated pill teleport into the hidden copy,
 *     because `display:none` elements still register a layout id. Hence the second
 *     assertion, and the one that follows it.
 *  3. ONE `layoutId="lang-pill"` in the whole file. The panel's pressed state is a
 *     plain background, so the animation stays a single holder.
 *  4. `aria-pressed` and `font-arabic` on the panel buttons. A toggle that does not
 *     tell an assistive technology which language is active is not a toggle, and
 *     the Arabic label needs the Arabic webfont for the same reason the bar's does.
 *  5. The bar cluster's `l === "ar" && "font-arabic"` is gone. `ARABIC_SCRIPT_LANGS`
 *     already contains `ar`, so the two conditions said the same thing; it is
 *     asserted absent so the duplicate does not come back as "explicit".
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const navSource = readFileSync(join(ROOT, "src", "components", "shell", "Navbar.tsx"), "utf8");

/**
 * The file's own prose is not code.
 *
 * This is not a nicety: the first version of this file asserted
 * `panel.toContain("sm:hidden")`, and the panel's comment explaining why the row
 * is `sm:hidden` satisfied it. Deleting the class from the markup left the gate
 * green. A scan that reads its own documentation reports what the documentation
 * says, not what the component does, so every assertion below runs against the
 * JSX after the comments are stripped.
 */
const nav = navSource.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** The panel's own source: from `menuOpen &&` to the account block that closes it. */
function panelSource(): string {
  const start = nav.indexOf("{menuOpen && (");
  expect(start, "the mobile panel is not rendered behind `menuOpen`").toBeGreaterThan(-1);
  const end = nav.indexOf("<CurrentUserAvatar", start);
  expect(end, "could not find the account block that ends the panel").toBeGreaterThan(start);
  return nav.slice(start, end);
}

test("the comments were stripped before anything was asserted", () => {
  // Positive control for the helper above: if this passes, a comment mentioning
  // the class or the layout id can no longer satisfy an assertion by accident.
  expect(navSource).toContain("sm:hidden");
  expect(navSource).toContain('layoutId="lang-pill"');
  expect(nav).not.toContain("sm:hidden rather than");
  expect(nav).toContain('className="mt-2 flex flex-wrap items-center gap-2 pb-1 sm:hidden"');
});

test("the mobile panel offers the interface languages", () => {
  const panel = panelSource();
  expect(panel).toContain("UI_LANGS.map");
  expect(panel).toContain("setLang(l)");
  expect(panel, "the panel row would be unreachable on a phone if it were not labelled").toContain(
    'aria-label={t("Language", "اللغة", lang)}',
  );
});

test("the panel control and the bar control are never both visible", () => {
  const panel = panelSource();
  // The bar cluster is the one `hidden` at small widths; the panel row must be the
  // one `sm:hidden`. If either class is dropped, 640–767px shows two toggles.
  expect(nav, "the bar cluster must stay hidden below `sm`").toMatch(/hidden[^"]*sm:flex/);
  expect(panel, "the panel row must be hidden at `sm` and up").toContain("sm:hidden");
});

test("only one control holds the animated language pill", () => {
  // Anchored to the attribute on its own line, not a bare substring search: the
  // panel's comment explains why it does NOT use `layoutId`, and a plain match
  // counted that prose as a second holder. A gate that reads its own source as a
  // violation is a gate someone will switch off.
  const holders = nav.match(/^[ \t]*layoutId="lang-pill"[ \t]*$/gm) ?? [];
  expect(holders.length, "a second shared layout id teleports the pill between copies").toBe(1);
});

test("both language toggles say which language is active, and set the Arabic face", () => {
  const groups = [...nav.matchAll(/aria-pressed=\{lang === l\}/g)].length;
  expect(groups, "the bar cluster and the panel row each need `aria-pressed`").toBe(2);

  const arabicFontRules = [...nav.matchAll(/ARABIC_SCRIPT_LANGS\.includes\(l\) && "font-arabic"/g)]
    .length;
  expect(arabicFontRules, "each pill group resolves the script the same way").toBe(2);
  // The redundant sibling of that condition, which only ever restated `ar`.
  expect(nav).not.toMatch(/l === "ar" && "font-arabic"/);
});
