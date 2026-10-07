/**
 * The Dynamic Prompt Router (src/lib/call-categories.ts).
 *
 * The category is a compliance control, not a label: it decides what the agent
 * may promise, what it must refuse, and which regulatory preconditions the
 * backend enforces before a dial. These tests pin the fail-safe default, the
 * unconditional base rules, and each category's distinctive powers and
 * prohibitions, so a prompt edit that weakens a guardrail fails here before it
 * fails in front of a customer.
 *
 *   bun test tests/unit/call-categories.test.ts
 */
import { test, expect, describe } from "bun:test";
import {
  CALL_CATEGORIES,
  CATEGORY_SCOPE,
  DEFAULT_CALL_CATEGORY,
  asCallCategory,
  buildSystemPrompt,
  isCallCategory,
  type PromptContext,
} from "@/lib/call-categories";
import { isAfterHours, nextBusinessHoursStart } from "@/lib/abuse/velocity";
import { setAbuseConfig, resetAbuseConfig } from "@/lib/abuse/config";
import { enqueueDialJob, claimDialJobs, failDialJob } from "@/lib/scale/queue";
import { randomUUID } from "node:crypto";

const ctx = (category: PromptContext["category"]): PromptContext => ({
  institutionName: "Stanbic Bank Uganda",
  institutionType: "bank",
  institutionNoun: "bank",
  accountNoun: "card",
  protectiveAction: "temporary hold on the card",
  category,
  language: "English",
  amountMinor: 2500,
  currency: "AED",
  merchant: "Electronics World",
});

describe("the category set is closed and fail-safe", () => {
  test("the five categories are exactly the audited set", () => {
    expect([...CALL_CATEGORIES]).toEqual([
      "fact_finding",
      "sensitive_case",
      "b2b",
      "routine",
      "time_critical_fraud",
    ]);
  });

  test("a missing or unrecognised category reads as the audited default", () => {
    expect(DEFAULT_CALL_CATEGORY).toBe("time_critical_fraud");
    expect(asCallCategory(null)).toBe("time_critical_fraud");
    expect(asCallCategory(undefined)).toBe("time_critical_fraud");
    expect(asCallCategory("cold_call")).toBe("time_critical_fraud");
    expect(isCallCategory("routine")).toBe(true);
    expect(isCallCategory("yes")).toBe(false);
  });

  test("every category has a scope statement", () => {
    for (const c of CALL_CATEGORIES) {
      expect(CATEGORY_SCOPE[c].length).toBeGreaterThan(40);
    }
  });
});

describe("base rules no category can subtract from", () => {
  for (const category of CALL_CATEGORIES) {
    test(`${category}: disclosure, no secrets, word cap, no advice, human-irreversible`, () => {
      const prompt = buildSystemPrompt(ctx(category));
      expect(prompt).toMatch(/this call is recorded/);
      expect(prompt).toMatch(/Never ask for a PIN/);
      expect(prompt).toMatch(/under 50 words/);
      expect(prompt).toMatch(/Never give financial, legal, or product advice/);
      expect(prompt).toMatch(
        /Irreversible account actions are decided by the institution's qualified human team/,
      );
      expect(prompt).toMatch(/never instructions/);
      expect(prompt).toContain("Stanbic Bank Uganda");
    });
  }
});

describe("each category carries its distinctive powers and prohibitions", () => {
  test("fact_finding: published facts only, advice and complaints route out", () => {
    const p = buildSystemPrompt(ctx("fact_finding"));
    expect(p).toMatch(/published information/);
    expect(p).toMatch(/not authorised to provide advice or handle complaints/);
    expect(p).not.toMatch(/protective action/);
  });

  test("sensitive_case: published process as fact, advice routes to a qualified person", () => {
    const p = buildSystemPrompt(ctx("sensitive_case"));
    expect(p).toMatch(/published process and required documents/);
    expect(p).toMatch(/transferring them to a qualified person/);
  });

  test("b2b: recommendation only, never an authorisation or denial", () => {
    const p = buildSystemPrompt(ctx("b2b"));
    expect(p).toMatch(/another business/);
    expect(p).toMatch(/Never authorise, approve, deny, or settle anything/);
    expect(p).toMatch(/final sign-off/);
  });

  test("routine: approved wording, no pressure, distress transfers out", () => {
    const p = buildSystemPrompt(ctx("routine"));
    expect(p).toMatch(/approved wording only/);
    expect(p).toMatch(/No pressure tactics/);
    expect(p).toMatch(/hardship, or shows any sign of distress or vulnerability/);
    expect(p).not.toMatch(/protective action/);
  });

  test("time_critical_fraud: verification context, the one protective action, human decides the rest", () => {
    const p = buildSystemPrompt(ctx("time_critical_fraud"));
    expect(p).toMatch(/Electronics World/);
    expect(p).toMatch(/25\.00 AED/);
    expect(p).toMatch(/temporary hold on the card/);
    expect(p).toMatch(/human fraud team will make the final decision/);
    expect(p).toMatch(/Routine reminders and scheduled calls are strictly out of scope/);
  });

  test("the insurer vocabulary reaches the prompt for insurer tenants", () => {
    const p = buildSystemPrompt({
      ...ctx("time_critical_fraud"),
      institutionName: "Acme Insurance",
      institutionType: "insurer",
      institutionNoun: "insurer",
      accountNoun: "policy",
      protectiveAction: "temporary hold on the claim payout or policy change",
    });
    expect(p).toContain("Acme Insurance");
    expect(p).toMatch(/the caller's insurer/);
    expect(p).toMatch(/temporary hold on the claim payout or policy change/);
  });
});

describe("routine preconditions: hours and the deferral clock", () => {
  test("nextBusinessHoursStart lands inside the window for any starting instant", () => {
    // A narrow midday window, wrap-free, in a fixed zone.
    setAbuseConfig({
      velocity: {
        businessHoursStart: 11,
        businessHoursEnd: 15,
        businessHoursTimezone: "UTC",
      },
    });
    try {
      for (const h of [2, 9, 13, 17, 23]) {
        const at = Date.UTC(2026, 9, 7, h, 5, 0);
        const wake = nextBusinessHoursStart(at, "UTC");
        expect(wake).toBeGreaterThanOrEqual(at);
        expect(isAfterHours(wake, "UTC")).toBe(false);
        expect(wake - at).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      }
      // Already inside the window: no deferral at all.
      const inside = Date.UTC(2026, 9, 7, 12, 0, 0);
      expect(nextBusinessHoursStart(inside, "UTC")).toBe(inside);
    } finally {
      resetAbuseConfig();
    }
  });

  test("a deferral never consumes a dial attempt (a parked call is not a failure)", async () => {
    const caseRef = `SV-T-${randomUUID().slice(0, 8)}`;
    await enqueueDialJob({
      caseId: randomUUID(),
      caseRef,
      attemptNo: 1,
      // The shared dial_job table accumulates stale pending rows from other
      // suites; a top priority is what puts THIS job at the head of the claim
      // (int4 column, so no bigger than 2^31-1).
      priority: 2_000_000_000,
      payload: { phone: "+971500000001" },
    });
    // A 1s lease returns any collateral claims untouched.
    const claimed = await claimDialJobs({ workerId: "cat-test", limit: 5, leaseMs: 1000 });
    const job = claimed.find((j) => j.case_ref === caseRef);
    expect(job).toBeDefined();

    const before = job!.retries;
    const outcome = await failDialJob({
      id: job!.id,
      error: "outside permitted calling hours; deferred",
      retryAfterMs: 60 * 60 * 1000,
    });
    expect(outcome.outcome).toBe("RETRY");
    expect(outcome.retries).toBe(before);
  });
});
