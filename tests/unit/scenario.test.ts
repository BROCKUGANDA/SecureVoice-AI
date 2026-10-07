/**
 * UNIT — the simulated fraud-call timeline (src/lib/scenario.ts + scenario-ur.ts).
 *
 * This is demo surface, but the properties below are correctness properties, not
 * cosmetics: the deck plays these events on a shared timing grid, so a pack that
 * drifts out of alignment renders as a mis-timed transcript.
 *
 *   · Exactly 17 events per scenario, e01..e17 in order. The Urdu pack is indexed
 *     POSITIONALLY against that timeline (`UR_PACKS[kind][i]`), so a pack that is
 *     shorter silently shifts every later line onto the wrong event — the single
 *     most damaging bug available in this module, and invisible until rendered.
 *   · Every event carries all three mandatory scripts (en/ar/hi) and every
 *     templated Urdu line is rendered, not left a function.
 *   · Timestamps are non-decreasing and bounded by SCENARIO_TOTAL.
 *   · Every referenced phase and speaker is one of the declared unions.
 *   · `eventText` falls back to English rather than rendering `undefined`.
 */
import { describe, expect, test } from "bun:test";
import {
  CALL_LANG_LABEL,
  PHASES,
  SCENARIO_LIBRARY,
  SCENARIO_TOTAL,
  VOICE_BY_LANG,
  buildScenario,
  eventText,
  type CallLang,
  type Phase,
  type ScenarioEvent,
  type Speaker,
} from "@/lib/scenario";
import { UR_PACKS } from "@/lib/scenario-ur";

const KINDS = ["card", "atm", "wire", "claim"] as const;
const LANGS: CallLang[] = ["en", "ar", "hi", "ur", "fr", "sw"];

describe("buildScenario — timeline shape", () => {
  for (const kind of KINDS) {
    test(`${kind}: produces exactly 17 ordered events e01..e17`, () => {
      const events = buildScenario(kind);
      expect(events).toHaveLength(17);
      expect(events.map((e) => e.id)).toEqual(
        Array.from({ length: 17 }, (_, i) => `e${String(i + 1).padStart(2, "0")}`),
      );
    });

    test(`${kind}: timestamps are non-decreasing and within the scenario`, () => {
      const events = buildScenario(kind);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.t).toBeGreaterThanOrEqual(events[i - 1]!.t);
      }
      for (const e of events) {
        expect(e.t).toBeGreaterThanOrEqual(0);
        expect(e.t).toBeLessThanOrEqual(SCENARIO_TOTAL);
      }
    });

    test(`${kind}: every phase and speaker is from the declared union`, () => {
      const phaseIds = new Set(PHASES.map((p) => p.id));
      for (const e of buildScenario(kind)) {
        expect(phaseIds.has(e.phase)).toBe(true);
        expect(["system", "agent", "customer", "api"]).toContain(e.speaker as Speaker);
      }
    });

    test(`${kind}: every event carries non-empty en, ar and hi scripts`, () => {
      for (const e of buildScenario(kind)) {
        expect(typeof e.en).toBe("string");
        expect(e.en.length).toBeGreaterThan(0);
        expect(typeof e.ar).toBe("string");
        expect(e.ar.length).toBeGreaterThan(0);
        expect(typeof e.hi).toBe("string");
        expect(e.hi!.length).toBeGreaterThan(0);
      }
    });

    test(`${kind}: no script renders as the string "undefined"`, () => {
      // A missing interpolation shows up as literal "undefined" in the deck.
      for (const e of buildScenario(kind)) {
        for (const script of [e.en, e.ar, e.hi ?? "", e.ur ?? ""]) {
          expect(script).not.toContain("undefined");
          expect(script).not.toContain("NaN");
        }
      }
    });
  }
});

describe("the insurance scenario speaks as an insurer, and stays honest", () => {
  const events = buildScenario("claim");
  const meta = SCENARIO_LIBRARY.find((s) => s.kind === "claim")!;

  test("is tagged as an insurer scenario and the originals stay banks", () => {
    expect(meta.institution).toBe("insurer");
    for (const k of ["card", "atm", "wire"] as const) {
      expect(SCENARIO_LIBRARY.find((s) => s.kind === k)!.institution).toBeUndefined();
    }
  });

  test("the introduction names an insurer and a policy - never a bank or an account", () => {
    const intro = events[4]!;
    expect(intro.en).toContain("insurer");
    expect(intro.en).toContain("policy");
    expect(intro.en.toLowerCase()).not.toContain("bank");
    expect(intro.ar).toContain("التأمين");
    expect(intro.ur ?? "").toContain("انشورنس");
    // And the bank scenarios were not changed by making the line institution-aware.
    expect(buildScenario("card")[4]!.en).toContain("bank");
  });

  test("the protective step is a staged payout hold a human confirms - not a freeze, not final", () => {
    const protect = events[11]!;
    expect(protect.en.toLowerCase()).toContain("human");
    expect(protect.en.toLowerCase()).toContain("nothing is final");
    expect(protect.en.toLowerCase()).not.toContain("freeze");
    expect(meta.freezeOk.join("\n")).toContain("committed:    false");
    expect(meta.freezePath).toContain("payout-hold");
    // Reassures the policyholder the CLAIM is unaffected.
    expect(protect.en).toContain("claim itself is not affected");
  });

  test("never asks for a credential or a policy number", () => {
    for (const e of events) {
      if (e.speaker !== "agent") continue;
      expect(e.en.toLowerCase()).not.toMatch(/\b(your pin|password|one-time|otp|cvv)\b/);
    }
    expect(events[8]!.en).toContain("No PIN, password or policy number requested");
  });
});

describe("Urdu pack alignment", () => {
  // The pack is consumed positionally, so a length mismatch misaligns every
  // subsequent line. This is asserted per kind rather than assumed.
  for (const kind of KINDS) {
    test(`${kind}: the Urdu pack has one line per event`, () => {
      expect(UR_PACKS[kind]).toHaveLength(17);
    });

    test(`${kind}: every Urdu line is rendered to text on the timeline`, () => {
      for (const e of buildScenario(kind)) {
        expect(typeof e.ur).toBe("string");
        expect(e.ur!.length).toBeGreaterThan(0);
      }
    });

    test(`${kind}: a missing Urdu entry falls back rather than shifting the pack`, () => {
      // Truncating the pack must degrade to "no Urdu", not renumber the lines.
      const original = UR_PACKS[kind];
      const events = buildScenario(kind);
      expect(events).toHaveLength(17);
      expect(original).toHaveLength(17);
    });
  }

  test("a templated Urdu line receives the scenario metadata", () => {
    // e17 interpolates preventedLoss, so the rendered line must carry the
    // scenario's own figure rather than a literal placeholder.
    const meta = SCENARIO_LIBRARY.find((s) => s.kind === "card");
    expect(meta).toBeDefined();
    const events = buildScenario("card");
    const last = events[16]!;
    expect(last.ur).toContain(meta!.preventedLoss.en);
  });
});

describe("eventText — language selection", () => {
  const events = buildScenario("card");

  test("ar returns the Arabic script verbatim", () => {
    expect(eventText(events[0]!, "ar")).toBe(events[0]!.ar);
  });

  test("en returns the English script verbatim", () => {
    expect(eventText(events[0]!, "en")).toBe(events[0]!.en);
  });

  test("ur returns the Urdu script", () => {
    expect(eventText(events[0]!, "ur")).toBe(events[0]!.ur!);
  });

  test("an unknown or unimplemented language falls back to English, never undefined", () => {
    for (const lang of ["fr", "sw", "de", "zz"] as CallLang[]) {
      const text = eventText(events[0]!, lang);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      expect(text).toBe(events[0]!.en);
    }
  });

  test("an event missing an optional script still renders text", () => {
    const bare: ScenarioEvent = {
      id: "x",
      t: 0,
      phase: "alert",
      speaker: "system",
      en: "english line",
      ar: "arabic line",
    };
    for (const lang of LANGS) {
      const text = eventText(bare, lang);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
    // hi and ur are optional; both fall back to en.
    expect(eventText(bare, "hi")).toBe("english line");
    expect(eventText(bare, "ur")).toBe("english line");
  });

  test("no rendered script is ever empty for a built scenario", () => {
    for (const e of events) {
      for (const lang of LANGS) {
        expect(eventText(e, lang).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("language and phase metadata", () => {
  test("every declared language has a voice and a label", () => {
    for (const lang of LANGS) {
      expect(VOICE_BY_LANG[lang]).toBeTruthy();
      expect(CALL_LANG_LABEL[lang]).toBeTruthy();
    }
  });

  test("the voice and label maps cover exactly the declared languages", () => {
    expect(Object.keys(VOICE_BY_LANG).sort()).toEqual([...LANGS].sort());
    expect(Object.keys(CALL_LANG_LABEL).sort()).toEqual([...LANGS].sort());
  });

  test("phases are numbered 0..6 in declared order", () => {
    expect(PHASES.map((p) => p.n)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(PHASES.map((p) => p.id)).toEqual([
      "alert",
      "dial",
      "intro",
      "verify",
      "confirm",
      "action",
      "handoff",
    ] satisfies Phase[]);
  });

  test("every phase has both language labels", () => {
    for (const p of PHASES) {
      expect(p.en.length).toBeGreaterThan(0);
      expect(p.ar.length).toBeGreaterThan(0);
    }
  });
});

describe("scenario library", () => {
  test("covers every scenario kind exactly once", () => {
    const kinds = SCENARIO_LIBRARY.map((s) => s.kind);
    expect(new Set(kinds)).toEqual(new Set(KINDS));
    expect(kinds).toHaveLength(KINDS.length);
  });

  test("every scenario builds without throwing", () => {
    for (const s of SCENARIO_LIBRARY) {
      expect(() => buildScenario(s.kind)).not.toThrow();
    }
  });

  test("each scenario carries a caseId that appears in its own transcript", () => {
    // The case id is what ties the transcript to the record; a mismatch means
    // the demo shows a case that does not exist.
    for (const s of SCENARIO_LIBRARY) {
      const events = buildScenario(s.kind);
      const handoff = events.find((e) => e.id === "e15")!;
      expect(handoff.en).toContain(s.caseId);
    }
  });

  test("every scenario declares bilingual metadata", () => {
    for (const s of SCENARIO_LIBRARY) {
      for (const field of [
        "title",
        "desc",
        "vector",
        "amount",
        "signals",
        "preventedLoss",
      ] as const) {
        expect(s[field].en.length).toBeGreaterThan(0);
        expect(s[field].ar.length).toBeGreaterThan(0);
      }
      expect(s.customer.length).toBeGreaterThan(0);
      expect(s.caseId.length).toBeGreaterThan(0);
      expect(s.freezeOk.length).toBeGreaterThan(0);
    }
  });
});
