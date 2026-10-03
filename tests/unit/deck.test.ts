/**
 * UNIT — the pitch-deck content (src/lib/deck.ts).
 *
 * `DECK` is 16 hand-authored bilingual slides that the deck viewer renders and
 * the presenter speaks verbatim. Nothing else in the app can catch a content
 * mistake: a slide with `id: 0`, a duplicated `layout`, an empty Arabic title,
 * or an English string pasted into `scriptAr` still *type-checks* and still
 * renders — it just ships a broken pitch.
 *
 * Properties pinned here. Thresholds were chosen from the measured content
 * (see the per-test comments) and sit below the observed minimums, so ordinary
 * copy edits have headroom while truncation and cross-language paste errors
 * fail loudly.
 *
 *   · Shape — exactly 16 slides; `id`s unique, ascending, contiguous 1..16.
 *     The viewer keys and pages by `id`, so a gap or a reordering is a
 *     navigation bug, not a cosmetic one.
 *   · Layouts — every slide uses a declared `SlideLayout`, and all 16 declared
 *     layouts are used exactly once. A repeated layout means a slide was
 *     copy-pasted and never re-classified; a missing one leaves a layout the
 *     renderer implements with no content to exercise.
 *   · Required copy — `kicker`/`titleEn`/`titleAr`/`scriptEn`/`scriptAr` are
 *     non-empty and trimmed on every slide. Empty is not "a blank slide", it
 *     is a hole in the deck.
 *   · Bilingual separation — Arabic fields really are Arabic script (a
 *     majority of their non-space characters), English fields contain no
 *     Arabic at all, and no Arabic field is byte-identical to its English
 *     counterpart. This is the "copied EN into the AR field" bug, invisible to
 *     the type checker and embarrassing on stage.
 *   · Speaker scripts are real — both scripts clear a floor in characters AND
 *     in words, and land on terminal punctuation, so a `scriptEn` truncated
 *     mid-sentence fails instead of presenting a fragment.
 *   · Subheadline convention as it actually holds in this deck: `subAr` is
 *     supplied only when `subEn` exists — an Arabic subhead with no English
 *     source would be an unsourced translation. The reverse is deliberate:
 *     interior slides that carry a subhead use it as an English-only
 *     supporting caption (a data source, a one-line definition, a URL), and
 *     only the two bookends (cover, closing) plus the problem slide carry the
 *     subhead in both languages.
 *   · Kicker section numbering — slides 2..15 are numbered `NN · Section`
 *     where NN is the slide's position, and the cover/closing are unnumbered.
 *     A reordered or dropped slide breaks the visible section sequence.
 *   · Hygiene — no `undefined`/`NaN`/`TODO`/placeholder text, no unresolved
 *     template placeholders, and no secret-shaped tokens in the serialised
 *     deck (a stray API key committed into a demo deck is a real incident).
 *
 * Not covered here: what the renderer does with a layout. That is view
 * behaviour, not content.
 */
import { describe, expect, test } from "bun:test";
import { DECK } from "@/lib/deck";
import type { Slide, SlideLayout } from "@/lib/deck";

/** Every member of the `SlideLayout` union declared in src/lib/deck.ts. */
const ALL_LAYOUTS: readonly SlideLayout[] = [
  "cover",
  "statement",
  "stats",
  "pillars",
  "flow",
  "components",
  "voice",
  "architecture",
  "table",
  "metrics",
  "security",
  "risks",
  "roadmap",
  "team",
  "proof",
  "closing",
];

/** Required non-optional copy fields, as `[id, value]` pairs so a failed
 *  expectation reports which slide broke it. */
const REQUIRED: ReadonlyArray<
  keyof Pick<Slide, "kicker" | "titleEn" | "titleAr" | "scriptEn" | "scriptAr">
> = ["kicker", "titleEn", "titleAr", "scriptEn", "scriptAr"];

/** Any Arabic-script character — Arabic-Indic digits and punctuation included. */
const ARABIC = /[؀-ۿ]/;

/** Fraction of a string's non-whitespace characters that are Arabic script. */
const arabicRatio = (s: string): number => {
  const chars = [...s].filter((c) => !/\s/.test(c));
  return chars.length === 0 ? 0 : chars.filter((c) => ARABIC.test(c)).length / chars.length;
};

const wordCount = (s: string): number => s.trim().split(/\s+/u).filter(Boolean).length;

const ids = (slides: readonly Slide[]): number[] => slides.map((s) => s.id);

describe("DECK — slide identity", () => {
  test("holds exactly the 16 slides the deck is specified to have", () => {
    expect(DECK).toHaveLength(ALL_LAYOUTS.length);
  });

  test("ids are unique", () => {
    expect(new Set(ids(DECK)).size).toBe(DECK.length);
  });

  test("ids ascend in array order — the deck plays back in declaration order", () => {
    const ordered = ids(DECK);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  });

  test("ids are contiguous 1..16, so no slide is skipped by the viewer's paging", () => {
    expect(ids(DECK)).toEqual(Array.from({ length: DECK.length }, (_, i) => i + 1));
  });
});

describe("DECK — layouts", () => {
  test("every slide uses a declared SlideLayout value", () => {
    expect(
      DECK.map((s) => [s.id, s.layout] as const).filter(
        ([, layout]) => !ALL_LAYOUTS.includes(layout),
      ),
    ).toEqual([]);
  });

  test("the used layouts are a permutation of all 16 declared layouts", () => {
    expect(DECK.map((s) => s.layout).sort()).toEqual([...ALL_LAYOUTS].sort());
  });

  test("no layout is used twice — a duplicate means a slide was never re-classified", () => {
    const counts = ALL_LAYOUTS.map(
      (layout) => [layout, DECK.filter((s) => s.layout === layout).length] as const,
    );
    expect(counts).toEqual(ALL_LAYOUTS.map((layout) => [layout, 1] as const));
  });
});

describe("DECK — required copy", () => {
  test("every required field is a non-empty string", () => {
    const pairs = DECK.flatMap((s) => REQUIRED.map((field) => [s.id, field, s[field]] as const));
    expect(pairs.filter(([, , v]) => typeof v !== "string" || v.trim().length === 0)).toEqual([]);
  });

  test("no required field carries leading or trailing whitespace that would render on the slide", () => {
    const pairs = DECK.flatMap((s) =>
      REQUIRED.map((field) => [s.id, field, s[field], (s[field] as string).trim()] as const),
    );
    expect(pairs.filter(([, , raw, trimmed]) => raw !== trimmed)).toEqual([]);
  });

  test("titles are headline-length, not paragraphs pasted into the wrong slot", () => {
    const overlong = DECK.filter((s) => s.titleEn.length > 120 || s.titleAr.length > 120).map(
      (s) => s.id,
    );
    expect(overlong).toEqual([]);
  });

  test("titles are distinct — no two slides open with the same headline", () => {
    expect(new Set(DECK.map((s) => s.titleEn)).size).toBe(DECK.length);
  });

  test("kickers are distinct", () => {
    expect(new Set(DECK.map((s) => s.kicker)).size).toBe(DECK.length);
  });
});

describe("DECK — bilingual separation", () => {
  test("no Arabic field is a byte-identical copy of its English counterpart", () => {
    const identical = DECK.filter(
      (s) =>
        s.titleEn === s.titleAr ||
        s.scriptEn === s.scriptAr ||
        (s.subEn !== undefined && s.subEn === s.subAr),
    ).map((s) => s.id);
    expect(identical).toEqual([]);
  });

  test("Arabic titles and scripts are actually written in Arabic script", () => {
    // Measured minimum is slide 6 ("ElevenLabs" and "Twilio" pull the
    // title ratio down to 0.64); 0.5 still catches a Latin-only field.
    const notArabic = DECK.filter(
      (s) => arabicRatio(s.titleAr) < 0.5 || arabicRatio(s.scriptAr) < 0.5,
    ).map((s) => s.id);
    expect(notArabic).toEqual([]);
  });

  test("no English field contains Arabic script — the languages are not transposed", () => {
    const leaked = DECK.filter(
      (s) =>
        ARABIC.test(s.titleEn) ||
        ARABIC.test(s.scriptEn) ||
        ARABIC.test(s.kicker) ||
        (s.subEn !== undefined && ARABIC.test(s.subEn)),
    ).map((s) => s.id);
    expect(leaked).toEqual([]);
  });

  test("an Arabic subhead is Arabic script too", () => {
    const notArabic = DECK.filter((s) => s.subAr !== undefined && arabicRatio(s.subAr) < 0.5).map(
      (s) => s.id,
    );
    expect(notArabic).toEqual([]);
  });
});

describe("DECK — speaker scripts are real", () => {
  test("every English script is long enough to be spoken", () => {
    // Measured minimum: 467 chars / 74 words. The floors below that
    // (200 chars / 40 words) still reject a truncated or stubbed slide.
    const weak = DECK.filter((s) => s.scriptEn.length <= 200 || wordCount(s.scriptEn) < 40).map(
      (s) => s.id,
    );
    expect(weak).toEqual([]);
  });

  test("every Arabic script is long enough to be spoken", () => {
    // Measured minimum: 169 chars / 27 words; the Arabic scripts are
    // condensed summaries, so the floor is lower than the English one.
    const weak = DECK.filter((s) => s.scriptAr.length <= 100 || wordCount(s.scriptAr) < 20).map(
      (s) => s.id,
    );
    expect(weak).toEqual([]);
  });

  test("every script lands on terminal punctuation — none is cut mid-sentence", () => {
    const unterminated = DECK.filter(
      (s) => !/[.!؟…"']$/u.test(s.scriptEn) || !/[.!؟…"']$/u.test(s.scriptAr),
    ).map((s) => s.id);
    expect(unterminated).toEqual([]);
  });

  test("no slide field carries an unresolved template placeholder", () => {
    // A `TBD` or `{{name}}` left in a caption is not caught by any type
    // check; it reaches the stage as literal text. Checked across every
    // string on the slide, not just the two scripts.
    const placeholder = /\{\{|\}\}|<[A-Z_]{3,}>|\bTBD\b|\bTK\b/u;
    const fields = [
      "kicker",
      "titleEn",
      "titleAr",
      "subEn",
      "subAr",
      "scriptEn",
      "scriptAr",
    ] as const;
    const dirty = DECK.flatMap((s) =>
      fields
        .filter((field) => s[field] !== undefined && placeholder.test(s[field] as string))
        .map((field) => `${s.id}.${field}`),
    );
    expect(dirty).toEqual([]);
  });
});

describe("DECK — subheadline convention", () => {
  test("an Arabic subhead is never supplied without its English source", () => {
    expect(ids(DECK.filter((s) => s.subAr !== undefined && s.subEn === undefined))).toEqual([]);
  });

  test("slides without an English subhead carry no Arabic one either", () => {
    expect(ids(DECK.filter((s) => s.subEn === undefined && s.subAr !== undefined))).toEqual([]);
  });

  test("every subhead that is present is non-empty and trimmed", () => {
    const bad = DECK.filter(
      (s) =>
        (s.subEn !== undefined && (s.subEn.trim().length === 0 || s.subEn !== s.subEn.trim())) ||
        (s.subAr !== undefined && (s.subAr.trim().length === 0 || s.subAr !== s.subAr.trim())),
    ).map((s) => s.id);
    expect(bad).toEqual([]);
  });

  test("the two bookend slides — cover and closing — carry the pitch line in both languages", () => {
    const cover = DECK[0]!;
    const closing = DECK[DECK.length - 1]!;
    expect(cover.layout).toBe("cover");
    expect(closing.layout).toBe("closing");
    expect(
      ids([cover, closing].filter((s) => s.subEn !== undefined && s.subAr !== undefined)),
    ).toEqual([cover.id, closing.id]);
  });
  test("interior subheads are English-only captions; both-language subheads stay on 1, 2 and 16", () => {
    // Recorded reality, stated as fact: the deck supplies `subAr` only on
    // the cover, the problem statement and the closing. Every other
    // `subEn` is a supporting English caption (a data-source line, a
    // one-line definition, the demo URL).
    expect(ids(DECK.filter((s) => s.subAr !== undefined))).toEqual([1, 2, 16]);
    expect(ids(DECK.filter((s) => s.subEn !== undefined))).toEqual([1, 2, 3, 4, 15, 16]);
  });
});

describe("DECK — kicker section numbering", () => {
  test("the cover and closing kickers are unnumbered brand lines", () => {
    expect(/^\d/.test(DECK[0]!.kicker)).toBe(false);
    expect(/^\d/.test(DECK[DECK.length - 1]!.kicker)).toBe(false);
  });

  test("each interior kicker is numbered to its own position — section NN is slide NN+1", () => {
    const mismatched = DECK.slice(1, -1)
      .filter((s) => {
        const match = /^(\d{2}) · \S/.exec(s.kicker);
        return match === null || Number(match[1]) !== s.id - 1;
      })
      .map((s) => s.id);
    expect(mismatched).toEqual([]);
  });

  test("the numbered sections run 01..14 without a gap or repeat", () => {
    const numbers = DECK.slice(1, -1).map((s) => Number(/^(\d{2}) · /.exec(s.kicker)![1]));
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });
});

describe("DECK — content hygiene", () => {
  test("no slide contains a leaked runtime artefact or an unfinished marker", () => {
    const artefacts = ["undefined", "NaN", "TODO", "FIXME", "Lorem ipsum"];
    const dirty = DECK.filter((s) => artefacts.some((a) => JSON.stringify(s).includes(a))).map(
      (s) => s.id,
    );
    expect(dirty).toEqual([]);
  });

  test("the serialised deck carries no secret-shaped token", () => {
    const serialised = JSON.stringify(DECK);
    const secretShapes = [
      /sk-[A-Za-z0-9_-]{16,}/, // OpenAI-style key
      /AKIA[0-9A-Z]{16}/, // AWS access key id
      /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub token
      /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack token
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM block
      /Bearer\s+[A-Za-z0-9._-]{20,}/, // bearer credential
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
      /\b[0-9a-f]{32,}\b/i, // long hex literal (key/secret material)
      /\b[A-Za-z0-9+/]{40,}={0,2}\b/, // long base64 literal
    ];
    for (const shape of secretShapes) {
      expect(serialised).not.toMatch(shape);
    }
  });

  test("the deck survives a JSON round-trip unchanged", () => {
    // Consumers re-parse the deck (slides are cached or persisted), so a
    // value that does not survive serialisation is a defect.
    expect(JSON.parse(JSON.stringify(DECK)) as Slide[]).toEqual(DECK);
  });
});
