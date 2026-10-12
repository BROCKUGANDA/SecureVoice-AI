/**
 * The prayer window's WAKE TIME, and the two halves of the gate agreeing.
 *
 * `isWithinPrayerWindow` answers "may we call now", which was enough while the
 * only caller was the ingest gate returning a 409. The dial worker needed a
 * different answer: a routine job accepted at 13:20 Gulf time and claimed at 13:25
 * is inside a window the ingest check had not seen, and it needs to know WHEN TO
 * WAKE — because the retry ladder fires at 15 s, 30 s and 60 s into the same
 * congregation, burns its attempts, and dead-letters a reminder that only needed
 * ten more minutes.
 *
 * The pure function is what is tested, with the timings handed in: the Friday
 * branch depends on the day of the week, and an assertion that has to wait for a
 * Friday is an assertion that never runs. `prayerWindowContains` was split out for
 * the same reason — the Jumu'ah extension used to be a comment rather than a
 * behaviour.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PRAYER_GATE_REGION,
  prayerWindowContains,
  prayerWindowEndsInMs,
} from "@/lib/compliance/prayer-times";

/** 13:00 Dhuhr with the standard ±10/15 and the Friday ±10/50 around it. */
const TIMINGS = { Fajr: "05:30", Dhuhr: "13:00", Asr: "16:15", Maghrib: "18:20", Isha: "19:45" };

/** 2026-10-09 is a Friday, 2026-10-12 a Monday. Fixed, so the branch is permanent. */
const friday = (h: number, m: number) => new Date(2026, 9, 9, h, m, 0, 0);
const monday = (h: number, m: number) => new Date(2026, 9, 12, h, m, 0, 0);

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
}

describe("the two functions never disagree about what a window is", () => {
  test("a moment is inside a window exactly when it has a wake time", () => {
    const probes: [string, number, number][] = [
      ["mid-fajr", 5, 32],
      ["clear mid-morning", 9, 0],
      ["at dhuhr", 13, 0],
      ["ten past dhuhr", 13, 10],
      ["past the dhuhr window", 13, 30],
      ["near maghrib", 18, 15],
      ["last minute of maghrib", 18, 35],
      ["after maghrib", 18, 36],
    ];
    for (const day of [monday, friday]) {
      for (const [label, h, m] of probes) {
        const now = day(h, m);
        const inside = prayerWindowContains(TIMINGS, now);
        const wait = prayerWindowEndsInMs(TIMINGS, now);
        // One equivalence, asserted both directions. If these two ever disagree,
        // the dial worker parks a job the ingest gate would have let through — or
        // the reverse — and neither failure is visible from the outside.
        expect(inside, `${label} ${now.getDay() === 5 ? "Fri" : "Mon"}: contains`).toBe(
          wait !== null,
        );
      }
    }
  });

  test("the wake time lands strictly OUTSIDE the window", () => {
    const now = monday(13, 10);
    const wait = prayerWindowEndsInMs(TIMINGS, now);
    expect(wait).not.toBeNull();
    const wake = new Date(now.getTime() + (wait ?? 0));
    // Waking ON the window's last minute would re-check, refuse, and park again:
    // a busy loop that looks like a defer.
    expect(prayerWindowContains(TIMINGS, wake)).toBe(false);
    expect(wake.getHours() * 60 + wake.getMinutes()).toBe(13 * 60 + 16);
  });

  test("an overlapping window defers past the LATER end, not the first match", () => {
    // Maghrib 18:20 (+15 → 18:35) and Isha 18:30 (−10 → 18:20, +15 → 18:45) both
    // cover 18:25. Waking at 18:36 would still be inside Isha's window.
    const overlapping = { ...TIMINGS, Maghrib: "18:20", Isha: "18:30" };
    const now = monday(18, 25);
    expect(prayerWindowContains(overlapping, now)).toBe(true);
    const wait = prayerWindowEndsInMs(overlapping, now);
    const wake = new Date(now.getTime() + (wait ?? 0));
    expect(prayerWindowContains(overlapping, wake)).toBe(false);
    expect(wake.getHours() * 60 + wake.getMinutes()).toBe(18 * 60 + 46);
  });
});

describe("Jumu'ah gets the hour it claims", () => {
  test("Friday Dhuhr blocks for an hour, and the deferral respects that", () => {
    const now = friday(13, 40);
    expect(prayerWindowContains(TIMINGS, now)).toBe(true);
    // 40 minutes past the prayer, and the Friday window runs to +50, so eleven
    // minutes is the only correct answer. A 25-minute-everywhere window would
    // reply 0 (already clear) and dial into the end of the congregation.
    expect(prayerWindowEndsInMs(TIMINGS, now)).toBe(11 * 60_000);
  });

  test("the same minute on Monday is already clear", () => {
    const now = monday(13, 40);
    expect(prayerWindowContains(TIMINGS, now)).toBe(false);
    expect(prayerWindowEndsInMs(TIMINGS, now)).toBeNull();
  });
});

describe("the gate is one assumption, consulted by both halves", () => {
  test("the region is shared, and the dial worker actually parks", () => {
    // The dial side used to consult NOTHING at prayer time while the ingest gate
    // hardcoded "UAE" in a string literal. Two places holding one assumption is
    // how they diverge silently.
    expect(PRAYER_GATE_REGION).toBe("UAE");
    expect(read("src/lib/compliance/gate.ts")).toContain("PRAYER_GATE_REGION");
    const dial = read("src/worker/dial.ts");
    expect(dial).toContain("PRAYER_GATE_REGION");
    expect(dial).toContain("isWithinPrayerWindow");
    expect(dial).toContain("prayerDeferralMs");
    expect(dial).toContain("dial_deferred_prayer_window");
    // Parked, not refused: a deferred reminder is not a failed call, and the
    // exemption is the one the policy depends on.
    expect(dial).toMatch(/retryable:\s*true/);
    expect(dial).toMatch(/category !== "time_critical_fraud"/);
    // A zero-millisecond defer is a busy loop.
    expect(dial).toMatch(/Math\.max\(60_000/);
  });

  test("a timings object with missing prayers cannot crash the deferral", () => {
    expect(prayerWindowEndsInMs({ Dhuhr: "13:00" }, monday(9, 0))).toBeNull();
    expect(prayerWindowEndsInMs({}, monday(9, 0))).toBeNull();
    // A malformed value is not a window; it must not become an infinite defer.
    expect(prayerWindowEndsInMs({ Dhuhr: "not-a-time" }, monday(13, 0))).toBeNull();
  });
});
