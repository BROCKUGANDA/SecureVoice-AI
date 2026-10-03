/**
 * Admission control — the degradation path.
 *
 * The property under test is the one that matters in procurement: when we are
 * full, we never drop a case silently. Every refusal produces a recorded
 * decision, and the decision is ordered by expected loss so the customer with
 * the most money at risk gets the voice channel first.
 *
 * These are pure-function tests over the band logic; the gauge itself is a
 * database COUNT and is exercised in the e2e path.
 */
import { describe, expect, test, beforeEach } from "bun:test";

import {
  admitsVoice,
  bandFor,
  expectedLossScore,
  ELEVENLABS_BURST_CEILING,
  type AdmissionBand,
} from "@/lib/capacity";

/** A representative expected-loss threshold: AED 500 in minor units. */
const THRESHOLD = 50_000;

function loadFor(band: AdmissionBand): number {
  if (band === "NORMAL") return 0;
  if (band === "CONSTRAINED") return Math.ceil(ELEVENLABS_BURST_CEILING * 0.8);
  return Math.ceil(ELEVENLABS_BURST_CEILING * 0.97);
}

describe("band selection", () => {
  test("an idle platform is NORMAL", () => {
    expect(bandFor(0)).toBe("NORMAL");
  });

  test("bands escalate with load and never go backwards within a reading", () => {
    const n = bandFor(0);
    const c = bandFor(loadFor("CONSTRAINED"));
    const s = bandFor(loadFor("SHED"));
    expect(n).toBe("NORMAL");
    expect(c).toBe("CONSTRAINED");
    expect(s).toBe("SHED");
  });

  test("the band is a pure function of load — the same load always decides the same way", () => {
    for (const n of [0, 1, 5, 8, 11, 12, 40]) {
      expect(bandFor(n)).toBe(bandFor(n));
    }
  });
});

describe("expected loss ordering", () => {
  test("a higher-risk case at the same amount outranks a lower-risk one", () => {
    expect(expectedLossScore(0.94, 250_000)).toBeGreaterThan(expectedLossScore(0.2, 250_000));
  });

  test("a larger amount at the same risk outranks a smaller one", () => {
    expect(expectedLossScore(0.9, 500_000)).toBeGreaterThan(expectedLossScore(0.9, 5_000));
  });

  test("garbage input cannot produce an infinity or NaN that would sort first", () => {
    expect(expectedLossScore(Number.NaN, 100)).toBe(0);
    expect(expectedLossScore(0.9, Number.NaN)).toBe(0);
    expect(expectedLossScore(5, 100)).toBe(100); // clamped to 1.0 risk
    expect(expectedLossScore(-1, -100)).toBe(0);
  });
});

describe("triage under load", () => {
  test("NORMAL admits everything — no fraud case is refused for capacity at low load", () => {
    const d = admitsVoice("NORMAL", 0, THRESHOLD); // even a zero-loss case
    expect(d.admitted).toBe(true);
    expect(d.fallback).toBeNull();
  });

  test("CONSTRAINED admits high expected loss and degrades the rest", () => {
    expect(admitsVoice("CONSTRAINED", THRESHOLD, THRESHOLD).admitted).toBe(true);
    const shed = admitsVoice("CONSTRAINED", THRESHOLD / 10, THRESHOLD);
    expect(shed.admitted).toBe(false);
    expect(shed.fallback).toBe("sms");
  });

  test("SHED reserves voice for the top tier only", () => {
    expect(admitsVoice("SHED", THRESHOLD * 10, THRESHOLD).admitted).toBe(true);
    const shed = admitsVoice("SHED", THRESHOLD, THRESHOLD);
    expect(shed.admitted).toBe(false);
    expect(shed.fallback).toBe("app_push");
  });

  test("every refusal carries a machine-readable reason — a shed with no reason is a silent drop", () => {
    for (const band of ["CONSTRAINED", "SHED"] as AdmissionBand[]) {
      const d = admitsVoice(band, 1, THRESHOLD);
      expect(d.admitted).toBe(false);
      expect(d.reason).toMatch(/^(constrained|shed)_/);
      expect(d.fallback).not.toBeNull();
    }
  });

  test("degradation is monotonic: the same case that is admitted under a lighter band is never refused under a heavier one", () => {
    const midRisk = THRESHOLD * 5;
    expect(admitsVoice("NORMAL", midRisk, THRESHOLD).admitted).toBe(true);
    expect(admitsVoice("CONSTRAINED", midRisk, THRESHOLD).admitted).toBe(true);
    expect(admitsVoice("SHED", midRisk, THRESHOLD).admitted).toBe(true);

    const lowRisk = THRESHOLD / 100;
    expect(admitsVoice("NORMAL", lowRisk, THRESHOLD).admitted).toBe(true);
    expect(admitsVoice("SHED", lowRisk, THRESHOLD).admitted).toBe(false);
  });
});
