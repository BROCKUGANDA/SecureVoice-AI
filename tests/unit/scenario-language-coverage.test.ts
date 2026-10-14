/**
 * UNIT — language coverage of the scripted demo (src/lib/scenario.ts and the
 * per-language layers scenario-ur.ts / scenario-fr.ts / scenario-sw.ts).
 *
 * This gate exists because a missing transcript is SILENT. `eventText` falls
 * back to English for any language it does not know, so before French and
 * Swahili content existed the deck announced "CALL IN FRANÇAIS / KISWAHILI"
 * and spoke English words — no log, no error, no red test. The selector offers
 * whatever `SUPPORTED_LANGS` declares, so the only honest check is: every
 * supported language, on every event, of every scenario kind, resolves to text
 * that is NOT the English line.
 *
 * Deliberately data-driven so new content cannot dodge it:
 *   · languages come from SUPPORTED_LANGS (src/lib/languages.ts), not a local
 *     list — add a seventh language there and this file fails until it has a
 *     transcript;
 *   · scenario kinds come from SCENARIO_LIBRARY plus the keys of each layer
 *     pack — add a kind anywhere and it must appear everywhere;
 *   · pack FIELDS come from Object.keys(PACKS[kind]) — a field that is written
 *     but never rendered onto the timeline fails.
 *
 * Non-vacuity is asserted explicitly at the end: the counts of strings actually
 * compared must be greater than zero, the deliberate non-translatable literals
 * must be exercised, and a re-implementation of the OLD `eventText` fallthrough
 * must disagree with the current one. If someone reverts `eventText`, the
 * fr/sw assertions below fail rather than the suite passing quietly.
 */
import { describe, expect, test } from "bun:test";
import {
  PACKS,
  SCENARIO_LIBRARY,
  buildScenario,
  eventText,
  type CallLang,
  type ScenarioEvent,
  type ScenarioKind,
  type ScenarioMeta,
} from "@/lib/scenario";
import { FR_PACKS } from "@/lib/scenario-fr";
import { SW_PACKS } from "@/lib/scenario-sw";
import { UR_PACKS } from "@/lib/scenario-ur";
import { SUPPORTED_LANGS } from "@/lib/languages";

/** Every supported language except the source text itself. */
const TRANSLATED_LANGS = SUPPORTED_LANGS.filter((l) => l !== "en");

/** Layers that live outside the timeline (they are patched on by `buildScenario`). */
const LAYERS = [
  { lang: "ur" as const, packs: UR_PACKS },
  { lang: "fr" as const, packs: FR_PACKS },
  { lang: "sw" as const, packs: SW_PACKS },
];

/** A transcript layer line, mirrored from the layer modules' own shape. */
type LayerLine = string | ((m: ScenarioMeta, first: string) => string);

// ── counters: the gate must prove it compared something ──────────────────────
let eventChecks = 0;
let stringChecks = 0;
let literalEchoChecks = 0;
let placeholderChecks = 0;
let packFieldChecks = 0;
let protectedLiteralChecks = 0;

/** The `{{placeholder}}` tokens a string still carries, sorted for comparison. */
function placeholders(text: string): string[] {
  return (text.match(/\{\{\s*[\w.[\]-]+\s*\}\}/g) ?? []).sort();
}

/**
 * The `eventText` as it behaved before fr/sw had content: only ar, hi and ur
 * were consulted and everything else fell through to English. Kept here to
 * prove the gate is sensitive to that exact regression, not to the current code.
 */
function legacyEventText(e: ScenarioEvent, lang: CallLang): string {
  if (lang === "ar") return e.ar;
  if (lang === "hi") return e.hi ?? e.en;
  if (lang === "ur") return e.ur ?? e.en;
  return e.en;
}

// ── kinds, enumerated from the exported data ─────────────────────────────────
const libraryKinds = new Set<ScenarioKind>(SCENARIO_LIBRARY.map((s) => s.kind));
const packKinds = new Set<ScenarioKind>(
  LAYERS.flatMap((layer) => Object.keys(layer.packs) as ScenarioKind[]),
);
const KINDS = [...new Set<ScenarioKind>([...libraryKinds, ...packKinds])];

describe("the language-coverage gate enumerates real data", () => {
  test("SUPPORTED_LANGS carries more than English, so the loop is not empty", () => {
    expect(SUPPORTED_LANGS.length).toBeGreaterThan(1);
    expect(TRANSLATED_LANGS.length).toBeGreaterThanOrEqual(4);
    for (const lang of ["ar", "hi", "ur", "fr", "sw"] as const) {
      expect(TRANSLATED_LANGS).toContain(lang);
    }
  });

  test("the library and every layer pack cover exactly the same kinds", () => {
    expect(libraryKinds.size).toBeGreaterThan(0);
    for (const layer of LAYERS) {
      expect(new Set(Object.keys(layer.packs))).toEqual(libraryKinds);
    }
    expect(packKinds).toEqual(libraryKinds);
    expect(KINDS.length).toBe(libraryKinds.size);
  });
});

describe("each layer pack is aligned with the timeline it patches", () => {
  for (const kind of KINDS) {
    const events = buildScenario(kind);
    for (const layer of LAYERS) {
      test(`${kind}: the ${layer.lang} pack has one line per event`, () => {
        const lines = layer.packs[kind] as LayerLine[] | undefined;
        expect(lines, `${layer.lang} has no pack for kind ${kind}`).toBeDefined();
        expect(lines!.length).toBe(events.length);
        expect(lines!.length).toBeGreaterThan(0);
      });

      test(`${kind}: every ${layer.lang} line is text or a renderer, none undefined`, () => {
        for (const line of layer.packs[kind] as LayerLine[]) {
          expect(["function", "string"]).toContain(typeof line);
          if (typeof line === "string") expect(line.trim().length).toBeGreaterThan(0);
        }
      });
    }
  }
});

describe("every supported language speaks, on every event", () => {
  for (const kind of KINDS) {
    const meta = SCENARIO_LIBRARY.find((s) => s.kind === kind);
    test(`${kind}: all ${TRANSLATED_LANGS.length} translations resolve per event`, () => {
      expect(meta).toBeDefined();
      for (const e of buildScenario(kind)) {
        eventChecks++;
        // A non-translatable literal is one the OTHER languages already echo
        // verbatim (the SMS reply token "NO" is the case that exists). Only
        // then may fr/sw equal English; everywhere else equality is a gap.
        const echoesEnglish = (["ar", "hi", "ur"] as const).every((l) => eventText(e, l) === e.en);
        for (const lang of TRANSLATED_LANGS) {
          const text = eventText(e, lang);
          stringChecks++;
          expect(typeof text, `${kind}/${e.id}/${lang} is not a string`).toBe("string");
          expect(text.trim().length, `${kind}/${e.id}/${lang} is empty`).toBeGreaterThan(0);
          expect(text, `${kind}/${e.id}/${lang} rendered "undefined"`).not.toContain("undefined");
          expect(text, `${kind}/${e.id}/${lang} rendered "NaN"`).not.toContain("NaN");
          if (echoesEnglish) {
            literalEchoChecks++;
            expect(text, `${kind}/${e.id}/${lang} translated a shared literal`).toBe(e.en);
          } else {
            expect(
              text,
              `${kind}/${e.id}/${lang} falls through to the English line — no transcript`,
            ).not.toBe(e.en);
          }
        }
      }
    });
  }

  test("the optional scripts are actually present, not only defaulted by eventText", () => {
    for (const kind of KINDS) {
      for (const e of buildScenario(kind)) {
        for (const field of ["hi", "ur", "fr", "sw"] as const) {
          const value = e[field];
          expect(value, `${kind}/${e.id} has no ${field} script`).toBeTypeOf("string");
          expect((value ?? "").trim().length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("no transcript carries a placeholder the English does not carry", () => {
  for (const kind of KINDS) {
    test(`${kind}: placeholder sets match English exactly`, () => {
      for (const e of buildScenario(kind)) {
        const expected = placeholders(e.en);
        for (const lang of TRANSLATED_LANGS) {
          placeholderChecks++;
          const text = eventText(e, lang);
          expect(
            placeholders(text),
            `${kind}/${e.id}/${lang} left an unfilled placeholder: ${text}`,
          ).toEqual(expected);
          // `${...}` is how the templated lines interpolate; a rendered line can
          // never still contain the marker itself.
          expect(text, `${kind}/${e.id}/${lang} was never rendered`).not.toContain("${");
        }
      }
    });
  }
});

describe("pack fields reach the timeline AND get translated", () => {
  for (const [kindName, pack] of Object.entries(PACKS)) {
    const kind = kindName as ScenarioKind;
    const events = buildScenario(kind);
    const fields = Object.keys(pack);

    test(`${kind}: every pack field is rendered once and carries every language`, () => {
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        const value = pack[field as keyof typeof pack];
        // apiTag is a mono chip, not speech — the timeline shows it verbatim.
        if (!Array.isArray(value)) {
          expect(typeof value).toBe("string");
          expect(events.map((e) => e.tag).filter((t) => t === value)).toHaveLength(1);
          continue;
        }
        const [en, ar, hi] = value as [string, string, string];
        const rendered = events.filter((e) => e.en === en);
        expect(rendered, `PACKS.${kind}.${field} is never rendered onto the timeline`).toHaveLength(
          1,
        );
        const e = rendered[0]!;
        packFieldChecks++;
        expect(e.ar).toBe(ar);
        expect(e.hi).toBe(hi);
        expect(e.ur, `${kind}.${field} has no Urdu`).toBeTruthy();
        expect(e.fr, `${kind}.${field} has no French`).toBeTruthy();
        expect(e.sw, `${kind}.${field} has no Swahili`).toBeTruthy();
        for (const field2 of ["ur", "fr", "sw"] as const) {
          expect(e[field2], `${kind}.${field} speaks English in ${field2}`).not.toBe(en);
        }
      }
    });
  }
});

describe("non-translatable literals survive translation", () => {
  /** Literals that must keep their exact bytes wherever English uses them. */
  const candidates = (m: ScenarioMeta): string[] => {
    const assetTail =
      m.assetId
        .split(/[\s•]+/)
        .filter(Boolean)
        .pop() ?? "";
    return [
      m.caseId,
      m.phone,
      assetTail,
      "AES-256",
      "P1",
      "200 OK",
      "voicemail_detection",
      "NOTIFIED",
      "sms_reply_no",
    ];
  };

  for (const kind of KINDS) {
    test(`${kind}: fr and sw keep every literal the English keeps`, () => {
      const m = SCENARIO_LIBRARY.find((s) => s.kind === kind);
      expect(m).toBeDefined();
      const events = buildScenario(kind);
      const hay = (lang: CallLang) =>
        events.map((e) => `${eventText(e, lang)} ${e.tag ?? ""}`).join("\n");
      const en = hay("en");
      for (const literal of candidates(m!)) {
        if (!literal || !en.includes(literal)) continue;
        protectedLiteralChecks++;
        expect(hay("fr"), `${kind}: French lost the literal ${literal}`).toContain(literal);
        expect(hay("sw"), `${kind}: Swahili lost the literal ${literal}`).toContain(literal);
      }
    });
  }

  test("the SMS reply token stays untranslated while the message around it is not", () => {
    const sms = buildScenario("voicemail")[6]!;
    expect(sms.en).toContain("YES");
    expect(sms.en).toContain("NO");
    for (const lang of ["fr", "sw"] as const) {
      const text = eventText(sms, lang);
      expect(text).not.toBe(sms.en);
      expect(text).toContain("2087");
      expect(text).toContain("YES");
      expect(text).toContain("NO");
    }
  });

  test("French and Swahili use Latin digits, like Hindi, not Arabic-Indic", () => {
    const arabicIndic = /[٠-٩]/;
    const devanagari = /[०-९]/;
    for (const kind of KINDS) {
      for (const e of buildScenario(kind)) {
        for (const lang of ["fr", "sw"] as const) {
          const text = eventText(e, lang);
          expect(text).not.toMatch(arabicIndic);
          expect(text).not.toMatch(devanagari);
        }
      }
    }
  });

  test("the honest-failure rules hold in French and Swahili too", () => {
    const events = buildScenario("voicemail");
    const leaks = ["3,900", "3900", "Gold Souk", "AED", "dirhams", "dirhami", "FRAUD-2026"];
    for (const id of ["e05", "e07"]) {
      const e = events.find((x) => x.id === id)!;
      for (const lang of ["fr", "sw"] as const) {
        const text = eventText(e, lang);
        for (const secret of leaks) {
          expect(text, `${id}/${lang} leaks ${secret}`).not.toContain(secret);
        }
      }
    }
    // Nothing is ever described as frozen on this path — a human decides — and
    // that promise was only ever kept in four of the six languages.
    for (const e of events) {
      expect(eventText(e, "fr")).not.toMatch(/carte est (bloquée|gelée)/);
      expect(eventText(e, "sw")).not.toMatch(/kadi yako (imezuiwa|imefungwa)/);
    }
    const api = events[11]!;
    expect(eventText(api, "fr")).toContain("freeze_staged: false");
    expect(eventText(api, "sw")).toContain("freeze_staged: false");
    expect(eventText(api, "fr")).toMatch(/rien n'est bloqué automatiquement/);
    expect(eventText(api, "sw")).toMatch(/hakuna kitu kinachozuiwa kiotomatiki/);
  });
});

describe("eventText routes fr and sw — the fallthrough this gate replaces", () => {
  const events = buildScenario("card");

  test("fr and sw return their own script, verbatim", () => {
    for (const e of events) {
      const fr = e.fr ?? "";
      const sw = e.sw ?? "";
      expect(fr.length, `${e.id} has no French script`).toBeGreaterThan(0);
      expect(sw.length, `${e.id} has no Swahili script`).toBeGreaterThan(0);
      expect(eventText(e, "fr")).toBe(fr);
      expect(eventText(e, "sw")).toBe(sw);
      expect(eventText(e, "fr")).not.toBe(e.en);
      expect(eventText(e, "sw")).not.toBe(e.en);
    }
  });

  test("a language with no voice at all still falls back to English, never undefined", () => {
    for (const lang of ["de", "zz"] as unknown as CallLang[]) {
      const text = eventText(events[0]!, lang);
      expect(text).toBe(events[0]!.en);
    }
  });

  test("reverting to the old fallthrough WOULD fail this gate", () => {
    // The old `eventText` returned English for fr and sw. Recomputing it here
    // and comparing line by line proves this file guards the fix: every pair
    // that is not a deliberate shared literal must disagree with the old
    // behaviour, and the old behaviour must disagree on more than zero lines.
    let pairs = 0;
    let eventCount = 0;
    let echoes = 0;
    let disagreements = 0;
    for (const kind of KINDS) {
      for (const e of buildScenario(kind)) {
        eventCount++;
        const echoesEnglish = (["ar", "hi", "ur"] as const).every((l) => eventText(e, l) === e.en);
        for (const lang of ["fr", "sw"] as const) {
          pairs++;
          const legacy = legacyEventText(e, lang);
          const current = eventText(e, lang);
          if (legacy === current) {
            // The only way a line may still be English is if it is a literal
            // every language echoes — otherwise this is the gap the gate exists
            // to catch.
            expect(
              echoesEnglish,
              `${kind}/${e.id}/${lang} is untranslated English but not a shared literal`,
            ).toBe(true);
            echoes++;
            continue;
          }
          disagreements++;
          expect(legacy, `${kind}/${e.id}/${lang} the old code was not English`).toBe(e.en);
          expect(current, `${kind}/${e.id}/${lang} is still not translated`).not.toBe(e.en);
        }
      }
    }
    expect(eventCount).toBe(KINDS.length * 17);
    expect(pairs).toBe(eventCount * 2);
    expect(echoes).toBeGreaterThan(0); // the "NO" reply token, ×2 languages
    expect(disagreements).toBe(pairs - echoes);
    expect(disagreements).toBeGreaterThan(0);
  });
});

describe("the gate compared something", () => {
  test("counts are non-zero — this file does not pass vacuously", () => {
    expect(KINDS.length).toBeGreaterThan(0);
    expect(TRANSLATED_LANGS.length).toBeGreaterThan(0);
    expect(eventChecks).toBeGreaterThan(0);
    expect(stringChecks).toBe(eventChecks * TRANSLATED_LANGS.length);
    expect(stringChecks).toBeGreaterThan(0);
    expect(literalEchoChecks).toBeGreaterThan(0); // the "NO" reply token
    expect(placeholderChecks).toBeGreaterThan(0);
    expect(packFieldChecks).toBeGreaterThan(0);
    expect(protectedLiteralChecks).toBeGreaterThan(0);
  });
});
