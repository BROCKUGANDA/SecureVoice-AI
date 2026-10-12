/**
 * The two static tables that remain in `src/lib/data.ts`, and the reason the rest
 * of the file is gone.
 *
 * This suite used to be 316 lines asserting that fabricated operational data was
 * internally consistent: the language shares summed to 100%, the twelve-week curve
 * was monotonic-ish, "every KPI has moved from its baseline in the good direction",
 * no call claimed a freeze without a customer. Every one of those was a real
 * assertion about a number nobody measured, and the last one is the tell — a gate
 * that requires a fictional dataset to stay flattering is not a test, it is a
 * rubric for the fiction.
 *
 * What survives is what is genuinely static, and what a static table CAN be wrong
 * about:
 *
 *   · `KPIS` is the pitch page's baseline-and-target statement. It is allowed to
 *     name a target the product has not hit — that is what a target is — but it
 *     must say which number is the goal and which is the starting point, and it
 *     must not have quietly become all-green. A pitch deck that shows every metric
 *     already beaten is not a pitch, it is a claim, and this one is read by banks.
 *   · `VOICES` is the catalogue an operator registers from. Its failure mode is
 *     two rows with the same id (the select would key-collide) or an empty field
 *     rendered as a blank option.
 */
import { describe, expect, test } from "bun:test";
import { KPIS, VOICES } from "@/lib/data";

describe("KPIS — a stated goal, not a measurement", () => {
  test("every KPI declares which direction is good", () => {
    for (const k of KPIS) {
      expect(["up", "down"], k.key).toContain(k.good);
    }
  });

  test("at least one KPI is still short of target, and it is declared", () => {
    // A deck where everything is already won is a marketing claim about the
    // present. The honest reading of this table is "here is the gap".
    const short = KPIS.filter((k) =>
      k.good === "up" ? k.current < k.target : k.current > k.target,
    );
    expect(short.length).toBeGreaterThanOrEqual(1);
  });

  test("the current value sits between the baseline and the target", () => {
    for (const k of KPIS) {
      const lo = Math.min(k.baseline, k.target);
      const hi = Math.max(k.baseline, k.target);
      expect(k.current, k.key).toBeGreaterThanOrEqual(lo);
      expect(k.current, k.key).toBeLessThanOrEqual(hi);
    }
  });

  test("percentage KPIs stay on the scale their unit declares", () => {
    for (const k of KPIS) {
      if (k.unit !== "%") continue;
      for (const v of [k.baseline, k.current, k.target]) {
        expect(v, `${k.key} ${v}`).toBeGreaterThanOrEqual(0);
        expect(v, `${k.key} ${v}`).toBeLessThanOrEqual(100);
      }
    }
  });

  test("a seconds KPI carries seconds, not a minutes figure in a seconds unit", () => {
    const delay = KPIS.find((k) => k.key === "delay");
    expect(delay).toBeDefined();
    if (!delay) return;
    expect(delay.unit).toBe("s");
    // 2,280 s is 38 minutes, which is the point being made. Reading a raw 38 in a
    // field labelled seconds would understate the problem the product solves.
    expect(delay.baseline).toBeGreaterThan(600);
  });

  test("a /5 score stays on its declared scale", () => {
    for (const k of KPIS) {
      if (k.unit !== "/5") continue;
      for (const v of [k.baseline, k.current, k.target]) {
        expect(v, `${k.key} ${v}`).toBeGreaterThanOrEqual(1);
        expect(v, `${k.key} ${v}`).toBeLessThanOrEqual(5);
      }
    }
  });

  test("both languages and unique keys, because the page maps over them", () => {
    const keys = new Set<string>();
    for (const k of KPIS) {
      expect(k.en.length).toBeGreaterThan(2);
      expect(k.ar.length).toBeGreaterThan(2);
      expect(keys.has(k.key), k.key).toBe(false);
      keys.add(k.key);
    }
  });
});

describe("VOICES — the registration catalogue", () => {
  test("ids are unique and every field the select renders is present", () => {
    const ids = new Set<string>();
    for (const v of VOICES) {
      expect(v.id.length).toBeGreaterThan(1);
      expect(ids.has(v.id), v.id).toBe(false);
      ids.add(v.id);
      expect(v.name.length).toBeGreaterThan(1);
      expect(v.lang.length).toBeGreaterThan(1);
      expect(v.desc.length).toBeGreaterThan(8);
      expect(v.params.length).toBeGreaterThan(4);
    }
  });

  test("the catalogue is labelled in the language it speaks", () => {
    // Two voices, not six: this table lists the REGISTERED voices the console can
    // offer to add, not the platform's supported delivery languages
    // (src/lib/languages.ts, six of them). The rest resolve through the
    // per-language ELEVENLABS_VOICE_* environment keys instead of a name here, so
    // a longer list in this file would be a second source of truth that drifts.
    // Asserted as "each entry says what language it is" rather than as a count
    // this table was never the owner of.
    const langs = new Set(VOICES.map((v) => v.lang));
    expect(langs.size).toBe(VOICES.length);
    for (const v of VOICES) {
      expect(v.lang.trim().length).toBeGreaterThan(1);
    }
  });
});
