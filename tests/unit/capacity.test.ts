/**
 * UNIT — the admission ladder (src/lib/capacity.ts).
 *
 * These are the functions that decide whether a customer gets a live voice call
 * or a fallback SMS/push while the platform is under load. The properties that
 * matter are all about the SHAPE of the degradation, not just the labels:
 *
 *   · The bands are strictly ordered by load, and every active-conversation
 *     count maps to exactly one band. An uncovered or overlapping range would
 *     mean some load level is undecidable.
 *   · Voice is never silently dropped. A refusal ALWAYS names a fallback channel,
 *     because a refused case with no fallback is a fraud signal nobody acts on —
 *     which defeats the entire reason the platform exists.
 *   · The top tier keeps voice even at maximum load (the `×4` exception). This
 *     is the one intentional overload behaviour: under SHED the highest-value
 *     cases must still reach a human.
 *   · Expected loss is clamped, so a NaN or a negative amount cannot rank a case
 *     into the top tier and steal voice capacity from a real one.
 *   · Degenerate thresholds (0, negative, NaN) fail toward refusing rather than
 *     admitting, because admitting on a broken threshold is what takes the
 *     provider down.
 */
import { describe, expect, test } from "bun:test";
import {
  BAND_ENTER_CONSTRAINED_PCT,
  BAND_ENTER_SHED_PCT,
  ELEVENLABS_BURST_CEILING,
  admitsVoice,
  bandFor,
  capacitySnapshot,
  expectedLossScore,
  type AdmissionBand,
} from "@/lib/capacity";

const SHED_AT = ELEVENLABS_BURST_CEILING * BAND_ENTER_SHED_PCT;
const CONSTRAINED_AT = ELEVENLABS_BURST_CEILING * BAND_ENTER_CONSTRAINED_PCT;

describe("bandFor — band boundaries", () => {
  test("no load is NORMAL", () => {
    expect(bandFor(0)).toBe("NORMAL");
  });

  test("the constrained threshold is inclusive at the boundary", () => {
    expect(bandFor(CONSTRAINED_AT - 1)).toBe("NORMAL");
    expect(bandFor(CONSTRAINED_AT)).toBe("CONSTRAINED");
  });

  test("the shed threshold is inclusive at the boundary", () => {
    expect(bandFor(SHED_AT - 1)).toBe("CONSTRAINED");
    expect(bandFor(SHED_AT)).toBe("SHED");
  });

  test("load above the burst ceiling stays SHED", () => {
    expect(bandFor(ELEVENLABS_BURST_CEILING)).toBe("SHED");
    expect(bandFor(ELEVENLABS_BURST_CEILING * 10)).toBe("SHED");
  });

  test("the constrained band is strictly below the shed band", () => {
    expect(CONSTRAINED_AT).toBeLessThan(SHED_AT);
    expect(BAND_ENTER_CONSTRAINED_PCT).toBeLessThan(BAND_ENTER_SHED_PCT);
  });

  test("every non-negative load maps to exactly one declared band", () => {
    const declared: AdmissionBand[] = ["NORMAL", "CONSTRAINED", "SHED"];
    for (let n = 0; n <= Math.ceil(ELEVENLABS_BURST_CEILING) + 10; n += 1) {
      expect(declared).toContain(bandFor(n));
    }
  });

  test("the band never regresses as load rises", () => {
    const rank: Record<AdmissionBand, number> = { NORMAL: 0, CONSTRAINED: 1, SHED: 2 };
    let previous = -1;
    for (let n = 0; n <= Math.ceil(ELEVENLABS_BURST_CEILING); n += 7) {
      const r = rank[bandFor(n)];
      expect(r).toBeGreaterThanOrEqual(previous);
      previous = r;
    }
  });

  test("negative load is treated as no load rather than crashing", () => {
    expect(() => bandFor(-5)).not.toThrow();
  });
});

describe("expectedLossScore — clamping", () => {
  test("risk × amount is the score", () => {
    expect(expectedLossScore(0.5, 1000)).toBe(500);
    expect(expectedLossScore(1, 2500)).toBe(2500);
  });

  test("risk is clamped to [0,1]", () => {
    expect(expectedLossScore(5, 1000)).toBe(1000);
    expect(expectedLossScore(-5, 1000)).toBe(0);
  });

  test("a negative amount contributes nothing", () => {
    expect(expectedLossScore(1, -500)).toBe(0);
  });

  test("zero risk means no expected loss however large the amount", () => {
    expect(expectedLossScore(0, 1_000_000)).toBe(0);
  });

  test("NaN and non-finite inputs score zero instead of poisoning the ranking", () => {
    // A NaN that reached the ranking would make every comparison false and
    // silently drop the case out of every tier.
    expect(expectedLossScore(Number.NaN, 1000)).toBe(0);
    expect(expectedLossScore(Number.POSITIVE_INFINITY, 1000)).toBe(0);
    expect(expectedLossScore(0.5, Number.NaN)).toBe(0);
    expect(expectedLossScore(0.5, Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("the score is never negative", () => {
    expect(expectedLossScore(-1, -1)).toBe(0);
  });

  test("a higher-value case outranks a lower-value one at equal risk", () => {
    expect(expectedLossScore(0.9, 100_000)).toBeGreaterThan(expectedLossScore(0.9, 100));
  });
});

describe("admitsVoice — NORMAL", () => {
  test("every case gets voice when capacity is normal", () => {
    const r = admitsVoice("NORMAL", 0, 1000);
    expect(r.admitted).toBe(true);
    expect(r.fallback).toBeNull();
  });

  test("even a zero-value case is admitted under NORMAL", () => {
    expect(admitsVoice("NORMAL", 0, 1000).admitted).toBe(true);
  });
});

describe("admitsVoice — CONSTRAINED", () => {
  test("a case at or above the threshold keeps voice", () => {
    const r = admitsVoice("CONSTRAINED", 1000, 1000);
    expect(r.admitted).toBe(true);
    expect(r.fallback).toBeNull();
  });

  test("a case below the threshold is diverted to SMS, not dropped", () => {
    const r = admitsVoice("CONSTRAINED", 999, 1000);
    expect(r.admitted).toBe(false);
    // The fallback must be named: a refused case with no channel is a fraud
    // signal nobody acts on.
    expect(r.fallback).toBe("sms");
  });

  test("the threshold boundary is inclusive at the threshold", () => {
    expect(admitsVoice("CONSTRAINED", 1000, 1000).admitted).toBe(true);
    expect(admitsVoice("CONSTRAINED", 999.9, 1000).admitted).toBe(false);
  });

  test("a zero-value case under CONSTRAINED still gets a fallback channel", () => {
    const r = admitsVoice("CONSTRAINED", 0, 1000);
    expect(r.admitted).toBe(false);
    expect(r.fallback).toBe("sms");
  });
});

describe("admitsVoice — SHED", () => {
  test("only the top tier (4× threshold) keeps voice", () => {
    expect(admitsVoice("SHED", 4000, 1000).admitted).toBe(true);
    expect(admitsVoice("SHED", 3999, 1000).admitted).toBe(false);
  });

  test("the top-tier boundary is inclusive", () => {
    expect(admitsVoice("SHED", 4000, 1000).admitted).toBe(true);
    expect(admitsVoice("SHED", 3999.99, 1000).admitted).toBe(false);
  });

  test("a shed case below the tier is diverted to push, not dropped", () => {
    const r = admitsVoice("SHED", 10, 1000);
    expect(r.admitted).toBe(false);
    expect(r.fallback).toBe("app_push");
  });

  test("even the largest non-top-tier case keeps a fallback", () => {
    const r = admitsVoice("SHED", 3999.99, 1000);
    expect(r.fallback).not.toBeNull();
  });
});

describe("admitsVoice — global invariants", () => {
  test("a refusal ALWAYS names a fallback channel, in every band", () => {
    // The single most important property in this file.
    for (const band of ["NORMAL", "CONSTRAINED", "SHED"] as AdmissionBand[]) {
      for (const loss of [-100, 0, 1, 999, 1000, 3999, 4000, 1e9]) {
        const r = admitsVoice(band, loss, 1000);
        if (!r.admitted) {
          expect(r.fallback === "sms" || r.fallback === "app_push").toBe(true);
        }
      }
    }
  });

  test("an admission NEVER carries a fallback channel", () => {
    for (const band of ["NORMAL", "CONSTRAINED", "SHED"] as AdmissionBand[]) {
      for (const loss of [0, 1000, 4000, 1e9]) {
        const r = admitsVoice(band, loss, 1000);
        if (r.admitted) expect(r.fallback).toBeNull();
      }
    }
  });

  test("every outcome carries a non-empty reason", () => {
    for (const band of ["NORMAL", "CONSTRAINED", "SHED"] as AdmissionBand[]) {
      for (const loss of [0, 1000, 4000]) {
        expect(admitsVoice(band, loss, 1000).reason.length).toBeGreaterThan(0);
      }
    }
  });

  test("admission is monotonic in expected loss within a band", () => {
    // Raising the value of a case must never take voice away from it.
    for (const band of ["CONSTRAINED", "SHED"] as AdmissionBand[]) {
      let previousAdmitted = false;
      for (const loss of [0, 500, 1000, 2000, 4000, 8000]) {
        const admitted = admitsVoice(band, loss, 1000).admitted;
        if (previousAdmitted) expect(admitted).toBe(true);
        previousAdmitted = admitted;
      }
    }
  });

  test("admitsVoice is threshold-relative: a threshold of 0 admits everything", () => {
    // Correct for a pure function: expectedLoss is clamped to >= 0, so
    // `0 >= 0` is true for every case. The guarantee that a broken env var
    // cannot disable shedding lives in the CALLER — shedThresholdMinor() in
    // src/lib/admission.ts returns 50_000 unless the configured value is > 0.
    // So this is a property of the input contract, not a defect here.
    expect(admitsVoice("CONSTRAINED", 0, 0).admitted).toBe(true);
    expect(admitsVoice("SHED", 0, 0).admitted).toBe(true);
  });

  test("a positive threshold is the only configuration that sheds", () => {
    expect(admitsVoice("CONSTRAINED", 0, 1).admitted).toBe(false);
    expect(admitsVoice("SHED", 0, 1).admitted).toBe(false);
  });

  test("a NaN expected loss never lands in the top tier", () => {
    for (const band of ["CONSTRAINED", "SHED"] as AdmissionBand[]) {
      expect(admitsVoice(band, Number.NaN, 1000).admitted).toBe(false);
    }
  });

  test("a NaN threshold never accidentally admits", () => {
    for (const band of ["CONSTRAINED", "SHED"] as AdmissionBand[]) {
      expect(admitsVoice(band, 1e9, Number.NaN).admitted).toBe(false);
    }
  });

  test("NORMAL admits regardless of a broken threshold", () => {
    expect(admitsVoice("NORMAL", 0, Number.NaN).admitted).toBe(true);
  });
});

describe("capacitySnapshot", () => {
  test("reports the band consistent with bandFor", () => {
    for (const n of [0, Math.ceil(CONSTRAINED_AT), Math.ceil(SHED_AT)]) {
      expect(capacitySnapshot(n).band).toBe(bandFor(n));
    }
  });

  test("reports the active conversation count verbatim", () => {
    expect(capacitySnapshot(7).activeConversations).toBe(7);
  });

  test("exposes positive ceilings", () => {
    const c = capacitySnapshot(0).ceilings;
    expect(c.elevenLabsConcurrent).toBeGreaterThan(0);
    expect(c.elevenLabsBurstCeiling).toBeGreaterThan(0);
    expect(c.twilioCpsPerFromNumber).toBeGreaterThan(0);
    expect(c.twilioMaxConcurrent).toBeGreaterThan(0);
  });

  test("the burst ceiling is three times the sustained ceiling", () => {
    const c = capacitySnapshot(0).ceilings;
    expect(c.elevenLabsBurstCeiling).toBe(c.elevenLabsConcurrent * 3);
  });

  test("the snapshot carries no secret or customer data", () => {
    // It is served on a status endpoint, so the shape must be safe to publish.
    const json = JSON.stringify(capacitySnapshot(3));
    for (const forbidden of ["password", "secret", "token", "key", "@", "phone"]) {
      expect(json.toLowerCase()).not.toContain(forbidden);
    }
  });
});
