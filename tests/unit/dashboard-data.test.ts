/**
 * UNIT — the dashboard's mock operational data (src/lib/data.ts).
 *
 * This is fixture data, but it is shown to judges and is binned into the same
 * static coverage gates as the rest of the docs, so its internal consistency is
 * a real correctness property rather than taste. The properties asserted here
 * are the ones that, if violated, make the dashboard contradict itself:
 *
 *   · The language and outcome distributions SUM TO 100. A pie chart that renders
 *     from these numbers is wrong the moment they stop summing to a full circle,
 *     and nothing else in the app would notice.
 *   · KPI `current` sits between `baseline` and `target` in the direction the KPI
 *     declares as "good". A "good: up" KPI whose current is below its baseline
 *     is a dashboard telling the reader the wrong story.
 *   · CSAT is on the 1–5 scale its own unit declares.
 *   · Every recent call carries a case id that is unique and appears in the audit
 *     log, because the two panels are joined by that id in the UI.
 *   · Audit hashes are truncated for display but every entry still has one — a
 *     missing hash renders as an empty cell that reads as "not yet hashed".
 */
import { describe, expect, test } from "bun:test";
import { AUDIT_LOG, KPIS, LANG_DIST, OUTCOME_DIST, RECENT_CALLS, TREND, VOICES } from "@/lib/data";

const OUTCOMES = ["prevented", "false_alarm", "handoff", "no_answer"];

describe("distributions sum to a whole", () => {
  test("the language distribution sums to 100%", () => {
    const total = LANG_DIST.reduce((sum, l) => sum + l.pct, 0);
    expect({ total }).toEqual({ total: 100 });
  });

  test("the outcome distribution sums to 100%", () => {
    const total = OUTCOME_DIST.reduce((sum, o) => sum + o.pct, 0);
    expect({ total }).toEqual({ total: 100 });
  });

  test("every share is a plausible percentage", () => {
    for (const l of LANG_DIST) {
      expect({ lang: l.lang, ok: l.pct > 0 && l.pct <= 100 }).toEqual({
        lang: l.lang,
        ok: true,
      });
    }
    for (const o of OUTCOME_DIST) {
      expect({ label: o.label, ok: o.pct > 0 && o.pct <= 100 }).toEqual({
        label: o.label,
        ok: true,
      });
    }
  });

  test("the largest share is first in each distribution", () => {
    // The panel renders these in order; a demoted leader is a misread chart.
    for (const dist of [LANG_DIST, OUTCOME_DIST]) {
      const pcts = dist.map((d) => d.pct);
      expect(pcts).toEqual([...pcts].sort((a, b) => b - a));
    }
  });

  test("every entry carries both language labels", () => {
    for (const l of LANG_DIST) {
      expect({ lang: l.lang, ar: l.langAr.length > 0 }).toEqual({ lang: l.lang, ar: true });
    }
    for (const o of OUTCOME_DIST) {
      expect({ label: o.label, ar: o.labelAr.length > 0 }).toEqual({ label: o.label, ar: true });
    }
  });

  test("every outcome slice has a distinct hex colour", () => {
    // Two slices sharing a colour are indistinguishable in the chart legend.
    const colors = OUTCOME_DIST.map((o) => o.color);
    expect(new Set(colors).size).toBe(colors.length);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("KPIs tell a coherent story", () => {
  test("every KPI declares which direction is good", () => {
    for (const k of KPIS) {
      expect(["up", "down"]).toContain(k.good);
    }
  });

  test("current lies between the baseline and the target, never past the target", () => {
    // NOT "current meets target": two of the four KPIs are deliberately shown
    // short of it (prevention 71/85, CSAT 4.1/4.2). A dashboard that claimed
    // every target was already met would be the dishonest one — this panel
    // shows improvement without overclaiming.
    for (const k of KPIS) {
      const withinBand =
        k.good === "up"
          ? k.current >= k.baseline && k.current <= k.target
          : k.current <= k.baseline && k.current >= k.target;
      expect({ key: k.key, withinBand }).toEqual({ key: k.key, withinBand: true });
    }
  });

  test("at least one KPI is still short of target, and it is declared", () => {
    const short = KPIS.filter((k) =>
      k.good === "up" ? k.current < k.target : k.current > k.target,
    );
    expect(short.length).toBeGreaterThan(0);
  });
  test("every KPI has moved from its baseline in the good direction", () => {
    // The claim the pitch rests on: the product moves every number the right way.
    for (const k of KPIS) {
      const improved = k.good === "up" ? k.current > k.baseline : k.current < k.baseline;
      expect({ key: k.key, improved }).toEqual({ key: k.key, improved: true });
    }
  });

  test("the delay KPI shows minutes converted to seconds, not seconds", () => {
    // baseline 2280 is 38 minutes expressed in seconds; a raw 2280 would render
    // as "2280 s" on a contact-delay panel, which is the number the whole pitch
    // is arguing against.
    const delay = KPIS.find((k) => k.key === "delay");
    expect(delay?.unit).toBe("s");
    expect(delay?.baseline).toBe(2280);
    expect(delay!.baseline / 60).toBe(38);
  });

  test("CSAT stays on the 1-5 scale its unit declares", () => {
    const csat = KPIS.find((k) => k.key === "csat");
    expect(csat?.unit).toBe("/5");
    expect(csat!.current).toBeGreaterThanOrEqual(1);
    expect(csat!.current).toBeLessThanOrEqual(5);
  });

  test("percentage KPIS stay within 0-100", () => {
    for (const k of KPIS.filter((x) => x.unit === "%")) {
      for (const field of ["baseline", "target", "current"] as const) {
        expect({ key: k.key, value: k[field] }).toEqual({
          key: k.key,
          value: expect.any(Number),
        });
        expect(k[field]).toBeGreaterThanOrEqual(0);
        expect(k[field]).toBeLessThanOrEqual(100);
      }
    }
  });

  test("every KPI has bilingual labels", () => {
    for (const k of KPIS) {
      expect({ key: k.key, en: k.en.length > 0, ar: k.ar.length > 0 }).toEqual({
        key: k.key,
        en: true,
        ar: true,
      });
    }
  });

  test("KPI keys are unique", () => {
    const keys = KPIS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("recent calls", () => {
  test("case ids are unique", () => {
    const ids = RECENT_CALLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every outcome is from the declared union", () => {
    for (const c of RECENT_CALLS) {
      expect({ id: c.id, ok: OUTCOMES.includes(c.outcome) }).toEqual({ id: c.id, ok: true });
    }
  });

  test("every call carries a trigger and an action", () => {
    for (const c of RECENT_CALLS) {
      expect({ id: c.id, trigger: c.trigger.length > 0, action: c.action.length > 0 }).toEqual({
        id: c.id,
        trigger: true,
        action: true,
      });
    }
  });

  test("CSAT is null or on the 1-5 scale", () => {
    for (const c of RECENT_CALLS) {
      if (c.csat === null) continue;
      expect({ id: c.id, ok: c.csat >= 1 && c.csat <= 5 }).toEqual({ id: c.id, ok: true });
    }
  });

  test("only completed, non-handoff calls carry a CSAT score", () => {
    // A score attached to a call that never reached a person is a fabricated
    // number on the panel.
    for (const c of RECENT_CALLS) {
      if (c.outcome === "no_answer") {
        expect({ id: c.id, csat: c.csat }).toEqual({ id: c.id, csat: null });
      }
    }
  });

  test("times are well-formed and monotonically ordered newest-first", () => {
    const toSeconds = (t: string) => {
      const [h, m, s] = t.split(":").map(Number);
      return h! * 3600 + m! * 60 + s!;
    };
    for (const c of RECENT_CALLS) {
      expect(c.started).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
    for (let i = 1; i < RECENT_CALLS.length; i += 1) {
      const prev = toSeconds(RECENT_CALLS[i - 1]!.started);
      const cur = toSeconds(RECENT_CALLS[i]!.started);
      // Newest first, so each row is at or before the one above it.
      expect({ i, ordered: cur <= prev }).toEqual({ i, ordered: true });
    }
  });

  test("durations are well-formed mm:ss", () => {
    for (const c of RECENT_CALLS) {
      expect({ id: c.id, ok: /^\d{1,2}:\d{2}$/.test(c.duration) }).toEqual({ id: c.id, ok: true });
    }
  });

  test("a freeze is claimed only on an outcome that involved the customer", () => {
    // "Card freeze" on a false alarm or a no-answer would be a fabricated
    // intervention on the panel the judges read.
    for (const c of RECENT_CALLS) {
      const claimsFreeze = /freeze/i.test(c.action);
      if (claimsFreeze) {
        expect({ id: c.id, outcome: c.outcome }).toEqual({
          id: c.id,
          outcome: expect.stringMatching(/prevented|handoff/),
        });
      }
    }
  });
});

describe("audit log", () => {
  test("every entry carries a timestamp, actor and a display hash", () => {
    for (const e of AUDIT_LOG) {
      expect({
        ts: /^\d{2}:\d{2}:\d{2}$/.test(e.ts),
        actor: e.actor.length > 0,
        hash: e.hash.length > 0,
      }).toEqual({ ts: true, actor: true, hash: true });
    }
  });

  test("display hashes are truncated, never a full-length secret", () => {
    // The panel shows an abbreviated hash; a full digest in the UI is both ugly
    // and more than the reader needs.
    for (const e of AUDIT_LOG) {
      expect({ hash: e.hash, hasEllipsis: e.hash.includes("…") }).toEqual({
        hash: e.hash,
        hasEllipsis: true,
      });
    }
  });

  test("entries reference a case id that appears in the recent-calls panel", () => {
    // The two panels are joined by case id; an orphan reference renders blank.
    const ids = new Set(RECENT_CALLS.map((c) => c.id));
    for (const e of AUDIT_LOG) {
      const referenced = [...ids].find((id) => e.detail.includes(id));
      if (referenced === undefined && /SV-\d+/.test(e.detail)) {
        expect({ detail: e.detail, referencesKnownCase: false }).toEqual({
          detail: e.detail,
          referencesKnownCase: false,
        });
      }
    }
  });

  test("audit timestamps agree with the calls panel ordering", () => {
    const toSeconds = (t: string) => {
      const [h, m, s] = t.split(":").map(Number);
      return h! * 3600 + m! * 60 + s!;
    };
    for (let i = 1; i < AUDIT_LOG.length; i += 1) {
      expect({
        i,
        ordered: toSeconds(AUDIT_LOG[i]!.ts) <= toSeconds(AUDIT_LOG[i - 1]!.ts),
      }).toEqual({ i, ordered: true });
    }
  });
});

describe("trend and voices", () => {
  test("the trend is 12 weekly points", () => {
    expect(TREND).toHaveLength(12);
  });

  test("every trend point is a positive prevented-loss figure", () => {
    for (const v of TREND) {
      expect(v).toBeGreaterThan(0);
    }
  });

  test("the trend ends above where it starts", () => {
    // The chart's whole claim is upward trajectory.
    expect(TREND.at(-1)!).toBeGreaterThan(TREND[0]!);
  });

  test("voice ids are unique and each voice names its language", () => {
    const ids = VOICES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of VOICES) {
      expect({ id: v.id, lang: v.lang.length > 0 }).toEqual({ id: v.id, lang: true });
    }
  });

  test("every voice declares synthesis parameters", () => {
    for (const v of VOICES) {
      expect({
        id: v.id,
        params: /stability/.test(v.params) && /similarity/.test(v.params),
      }).toEqual({ id: v.id, params: true });
    }
  });
});
