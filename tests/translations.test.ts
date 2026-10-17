/**
 * The translation defects that nothing else catches.
 *
 * Each assertion here corresponds to a defect that shipped to production and was
 * found by READING every EN/AR pair, not by a tool. None of them fail a build,
 * fail lint, or fail a type check:
 *
 *   1. `t(x, x, lang)` — the same string in both language slots. `t()` returns
 *      the `ar` slot for Arabic, so it returns English, silently. This is how
 *      the entire institution-aware vocabulary (Transaction/Claim, Merchant,
 *      Charge Amount, and the takaful variants) reached Arabic operators in
 *      English, inside an otherwise fully translated screen.
 *
 *   2. The same English string translated two different ways in two places.
 *      Invisible locally — the two strings are on different pages — and it is how
 *      "Webhooks" came to be labelled التوقيع ("the signature") on the Dashboard
 *      while the Docs page called the same nav item خطاف الأحداث. Signature is a
 *      different, heavily-used concept in this codebase.
 *
 *   3. A Latin plural welded onto an Arabic noun. `${labelsAr.productNoun}s`
 *      renders "معاملةs"; Arabic pluralises by changing the word.
 *
 * The two DELIBERATE exceptions are asserted as exceptions, so this file cannot
 * be "fixed" by deleting the rule:
 *
 *   · `t("·", "·")` and `t("#0b7a55", "#0b7a55")` — a middle dot and a hex
 *     colour are identical in both languages by definition.
 *   · "Not now" (ليس الآن for a dialog dismiss, لاحقاً for deferring 2FA setup)
 *     and "ok" (تم for a completed action, متصلة for a live CRM connection) —
 *     the Arabic differs because the MEANING differs, not because of drift.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getInstitutionLabels, getInstitutionLabelsAr } from "@/lib/institution-context";

const SRC = "src";

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (!/node_modules|\.next|generated/.test(entry)) walk(p, acc);
    } else if (/\.(tsx?|mjs)$/.test(entry) && !/\.test\.|\.d\.ts/.test(entry)) {
      acc.push(p);
    }
  }
  return acc;
}

const FILES = walk(SRC).map((f) => ({ f, src: readFileSync(f, "utf8") }));

/**
 * Strip comments before scanning.
 *
 * The doc comment on `getInstitutionLabelsAr` QUOTES the broken call
 * (`t(labels.amountLabel, labels.amountLabel, lang)`) in order to explain the
 * defect it fixed. Without this, the gate reports the explanation of the bug as
 * a live instance of it — which is how a rule starts getting disabled for being
 * noisy rather than for being wrong.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

const SCANNABLE = FILES.map(({ f, src }) => ({ f, src: stripComments(src) }));

const ARABIC = /[\u0600-\u06FF]/;

/** Strings that are legitimately identical in both languages. */
const IDENTICAL_BY_NATURE = new Set(["·", "#0b7a55"]);

/**
 * English strings whose Arabic deliberately differs because the meaning does.
 *
 * Each is here with the reason, so a future reader does not "fix" it into the
 * other variant and break the distinction the two call sites are drawing.
 */
const SEMANTIC_SPLITS = new Map<string, string>([
  [
    "Not now",
    "Console dismisses a dialog (ليس الآن); TwoFactorPrompt defers 2FA setup (لاحقاً)",
  ],
  ["ok", "Demo marks an action done (تم); CrmSection marks a live connection (متصلة)"],
  [
    "English",
    "a language list labelled each language in ITSELF: languages.ts/scenario.ts carry the code's own name, Console/Deck carry the Arabic word for it. The endonym is the convention, not drift — see Console.tsx:101, where the Arabic row is deliberately en:'العربية' ar:'العربية'",
  ],
]);

describe("the Arabic surface", () => {
  test("no t() call passes the same string as both languages", () => {
    const offenders: string[] = [];
    for (const { f, src } of SCANNABLE) {
      // The two slots may use DIFFERENT quote characters (`t("x", 'x')`), and
      // the arguments may be quoted literals OR bare expressions. All three forms
      // are part of this defect class, and the shipped one was the THIRD:
      // `t(labels.amountLabel, labels.amountLabel, lang)` has no quote character
      // at all, so every quote-based pattern is structurally blind to it — a rule
      // written only for literals would have reported this file green while the
      // bug was live in the Console. Hence one pattern per shape rather than a
      // clever combined one.
      const LITERAL_MIXED = /\bt\(\s*(["'`])([^"'`]*?)\1\s*,\s*(["'`])([^"'`]*?)\3\s*,/g;
      const LITERAL_SAME = /\bt\(\s*(["'`])([^"'`]*?)\1\s*,\s*\1([^"'`]*?)\1\s*,/g;
      const LITERAL_MULTILINE =
        /\bt\(\s*\n\s*(["'`])([^"'`]*?)\1\s*,\s*\n\s*\1([^"'`]*?)\1\s*,/g;
      // Bare identifiers and member expressions: t(x.y, x.y, lang)
      const EXPRESSION = /\bt\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*,\s*\1\s*,/g;

      for (const re of [LITERAL_MIXED, LITERAL_SAME, LITERAL_MULTILINE]) {
        for (const m of src.matchAll(re)) {
          const value = ((m[2] ?? "") || (m[4] ?? "")).trim();
          const other = ((m[3] ?? "") || (m[5] ?? "")).trim();
          if (!value) continue;
          if (IDENTICAL_BY_NATURE.has(value)) continue;
          if (value === other) {
            offenders.push(`${f}: t(${JSON.stringify(value)}, ${JSON.stringify(value)})`);
          }
        }
      }
      for (const m of src.matchAll(EXPRESSION)) {
        offenders.push(`${f}: t(${m[1]}, ${m[1]}, lang) — expression in both slots`);
      }
    }
    expect(offenders, "a t(x, x) renders English for Arabic and fails silently").toEqual([]);
  });

  test("the same English string is not translated two ways", () => {
    const byEnglish = new Map<string, Map<string, Set<string>>>();
    for (const { f, src } of SCANNABLE) {
      const collect = (re: RegExp) => {
        for (const m of src.matchAll(re)) {
          const en = (m[2] ?? "").trim();
          const ar = (m[4] ?? "").trim();
          if (!en || !ARABIC.test(ar)) continue;
          if (SEMANTIC_SPLITS.has(en)) continue;
          if (!byEnglish.has(en)) byEnglish.set(en, new Map());
          const variants = byEnglish.get(en)!;
          if (!variants.has(ar)) variants.set(ar, new Set());
          variants.get(ar)!.add(f);
        }
      };
      collect(/\bt\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/g);
      collect(
        /\ben:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1[\s\S]{0,80}?\bar:\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/g,
      );
    }

    const drift: string[] = [];
    for (const [en, variants] of byEnglish) {
      if (variants.size > 1) {
        const rendered = [...variants.entries()]
          .map(([ar, files]) => `${ar} (${[...files].join(", ")})`)
          .join("  vs  ");
        drift.push(`"${en}" -> ${rendered}`);
      }
    }
    expect(drift, "the same English string must have ONE Arabic rendering").toEqual([]);
  });

  test("no Latin plural is welded onto an Arabic noun", () => {
    const offenders: string[] = [];
    for (const { f, src } of SCANNABLE) {
      for (const [i, line] of src.split("\n").entries()) {
        if (!ARABIC.test(line)) continue;
        // A number, a technical token or a deliberate unit abbreviation is fine;
        // an identifier being pluralised by appending "s" is not.
        if (/\$\{[^}]*\}\s*[a-z]/i.test(line) && /labels(Ar)?\./.test(line)) {
          offenders.push(`${f}:${i + 1} ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(offenders, "Arabic pluralises by changing the word, not by appending an s").toEqual([]);
  });

  test("the institution vocabulary has an Arabic half for every English key", () => {
    // The parallel maps drift silently: nothing in the type system ties
    // InstitutionLabels to InstitutionLabelsAr, so a new field can be added to
    // one and not the other and the Arabic operator simply sees English again.
    for (const type of ["bank", "insurer"]) {
      for (const shariah of [false, true]) {
        const en = getInstitutionLabels(type, shariah);
        const ar = getInstitutionLabelsAr(type, shariah);
        expect(Object.keys(ar).sort(), `${type}/${String(shariah)}`).toEqual(
          Object.keys(en).sort(),
        );
        for (const [key, value] of Object.entries(ar)) {
          expect(ARABIC.test(value), `${type}.${key} = ${JSON.stringify(value)}`).toBe(true);
        }
      }
    }
  });
});