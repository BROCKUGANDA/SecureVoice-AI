/**
 * UNIT — the rung counter behind `sv_tts_rung_total` and `sv_tts_degraded_total`.
 *
 * A degradation metric that cannot move is decoration, and one that moves when
 * nothing happened is an alert fatigue generator, so both directions are pinned
 * here rather than trusted from the scrape: count a primary hit and the degraded
 * gauge must not move; count a fallback and it must.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  countRung,
  degradedSnapshot,
  resetRungCounters,
  rungSnapshot,
} from "@/lib/voice/rung-counter";

beforeEach(() => resetRungCounters());

describe("the rung counter", () => {
  test("every declared rung appears in the snapshot even with zero traffic", () => {
    // A series that only exists after its first event cannot be alerted on its
    // absence — the drop from rung 1 to rung 4 is the signal, so the series are
    // pre-declared the way a Prometheus gauge should be.
    const snapshot = rungSnapshot();
    const names = snapshot.map((s) => s.rung);
    expect(names).toContain("elevenlabs");
    expect(names).toContain("elevenlabs-pool");
    expect(names).toContain("playht");
    expect(names).toContain("emergency");
    for (const s of snapshot) expect(s.total).toBe(0);
  });

  test("a primary hit is counted and is not degradation", () => {
    countRung("elevenlabs");
    const primary = rungSnapshot().find((s) => s.rung === "elevenlabs");
    expect(primary?.total).toBe(1);
    expect(degradedSnapshot()).toBe(0);
  });

  test("a fallback moves the degraded gauge and its own series", () => {
    countRung("playht", true);
    countRung("emergency", true);
    countRung("emergency", true);
    expect(degradedSnapshot()).toBe(3);
    expect(rungSnapshot().find((s) => s.rung === "playht")?.total).toBe(1);
    expect(rungSnapshot().find((s) => s.rung === "emergency")?.total).toBe(2);
  });

  test("an unrecognised source is counted, not dropped", () => {
    // The ladder can grow a rung (or a caller can pass a source this module has
    // never heard of) and the counter must not silently discard it — a metric
    // that loses events exactly when something new happens is worse than no
    // metric.
    countRung("twilio-native", true);
    const extra = rungSnapshot().find((s) => s.rung === "twilio-native");
    expect(extra?.total).toBe(1);
  });
});
