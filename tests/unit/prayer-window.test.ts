/**
 * The prayer-time window, including the Friday branch that did nothing.
 *
 * `isWithinPrayerWindow` asked Aladhan for real timings and then tested a Friday
 * condition whose two arms both returned `true`, so Jumu'ah was blocked for the
 * same 25 minutes as any other prayer while the platform documented a full hour
 * for it. The window decision is now a pure function, which is what makes the
 * Friday case assertable without waiting for Friday.
 *
 *   bun test tests/unit/prayer-window.test.ts
 */
import { describe, expect, test } from "bun:test";
import { prayerWindowContains } from "@/lib/compliance/prayer-times";

const TIMINGS = { Fajr: "05:30", Dhuhr: "12:30", Asr: "15:45", Maghrib: "18:20", Isha: "19:40" };

// 2026-10-09 is a Friday, 2026-10-08 a Thursday. Local-time constructors, because
// the function reads getHours()/getDay() in the process's own zone — the same
// reading the running system uses.
const friday = (h: number, m: number) => new Date(2026, 9, 9, h, m);
const thursday = (h: number, m: number) => new Date(2026, 9, 8, h, m);

describe("ordinary prayer windows", () => {
  test("a routine call at Dhuhr on a Thursday is inside the 25-minute band", () => {
    expect(prayerWindowContains(TIMINGS, thursday(12, 25))).toBe(true);
    expect(prayerWindowContains(TIMINGS, thursday(12, 45))).toBe(true);
  });

  test("the Thursday band closes 15 minutes after the prayer", () => {
    expect(prayerWindowContains(TIMINGS, thursday(12, 46))).toBe(false);
    expect(prayerWindowContains(TIMINGS, thursday(11, 0))).toBe(false);
  });

  test("Fajr, Asr, Maghrib and Isha all gate", () => {
    expect(prayerWindowContains(TIMINGS, thursday(5, 35))).toBe(true);
    expect(prayerWindowContains(TIMINGS, thursday(15, 50))).toBe(true);
    expect(prayerWindowContains(TIMINGS, thursday(18, 30))).toBe(true);
    expect(prayerWindowContains(TIMINGS, thursday(19, 55))).toBe(true);
  });
});

describe("Jumu'ah", () => {
  // The whole point: Friday's Dhuhr is a congregation, and the block has to last
  // through it rather than 15 minutes past the adhan.
  test("Friday blocks for an hour after Dhuhr, not fifteen minutes", () => {
    expect(prayerWindowContains(TIMINGS, friday(12, 30))).toBe(true);
    expect(prayerWindowContains(TIMINGS, friday(13, 0))).toBe(true);
    expect(prayerWindowContains(TIMINGS, friday(13, 20))).toBe(true);
    expect(prayerWindowContains(TIMINGS, friday(13, 19))).toBe(true);
  });

  test("the Friday window ends when the hour does", () => {
    expect(prayerWindowContains(TIMINGS, friday(13, 21))).toBe(false);
    expect(prayerWindowContains(TIMINGS, friday(14, 0))).toBe(false);
  });

  test("Friday's other prayers keep the ordinary window", () => {
    // Asr on Friday is Asr; only the congregational prayer is longer.
    expect(prayerWindowContains(TIMINGS, friday(15, 50))).toBe(true);
    expect(prayerWindowContains(TIMINGS, friday(16, 1))).toBe(false);
  });

  test("the block still starts before the prayer time on Friday", () => {
    expect(prayerWindowContains(TIMINGS, friday(12, 25))).toBe(true);
    expect(prayerWindowContains(TIMINGS, friday(12, 5))).toBe(false);
  });
});

describe("degenerate timings", () => {
  test("a prayer the provider did not return is skipped, not treated as midnight", () => {
    const partial = { Dhuhr: "12:30", Asr: "", Maghrib: "n/a" };
    expect(prayerWindowContains(partial, thursday(15, 45))).toBe(false);
    expect(prayerWindowContains(partial, thursday(12, 30))).toBe(true);
  });

  test("an empty timings table blocks nothing", () => {
    expect(prayerWindowContains({}, friday(12, 30))).toBe(false);
  });
});
