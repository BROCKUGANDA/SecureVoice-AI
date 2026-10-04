/**
 * Onboarding progress, and the "never nag a returning user" rule.
 *
 * The property under test is not "can we store a step" but the anti-nag rule: the
 * guide must appear for an operator who has not finished it and has not skipped
 * it, and NEVER again once either is true. A regression there is the failure
 * that makes operators disable the product, and it is invisible in review because
 * the code that shows the tour is the code that looks helpful.
 *
 * Also covers the "step renamed between deploys" case, which would otherwise
 * leave a guide that can never be finished — and therefore nags forever, which is
 * the same bug from the other direction.
 *
 *   bun test tests/unit/onboarding.test.ts
 */
import { test, expect, describe, afterAll } from "bun:test";
import { db, dbAudit } from "@/lib/db";
import {
  computeState,
  completeStep,
  skipOnboarding,
  resumeOnboarding,
  getOnboarding,
  ONBOARDING_STEPS,
} from "@/lib/onboarding";

const IDS = ONBOARDING_STEPS.map((s) => s.id);
const USER = `11111111-1111-4111-8111-111111111111`;

async function freshUser() {
  await db.onboardingState.deleteMany({ where: { userId: USER } });
  return USER;
}

afterAll(async () => {
  await db.onboardingState.deleteMany({ where: { userId: USER } });
  await db.$disconnect();
  await dbAudit.$disconnect();
});

describe("computeState", () => {
  test("a brand new operator should see the guide", () => {
    const s = computeState({ completedSteps: [], skippedAt: null, completedAt: null });
    expect(s.shouldShow).toBe(true);
    expect(s.done).toBe(0);
    expect(s.percent).toBe(0);
    expect(s.nextStep?.id).toBe(IDS[0]);
  });

  test("progress advances monotonically and reports a percentage", () => {
    let s = computeState({ completedSteps: [], skippedAt: null, completedAt: null });
    for (const id of IDS) {
      s = computeState({
        completedSteps: [...s.completed, id],
        skippedAt: null,
        completedAt: null,
      });
    }
    expect(s.finished).toBe(true);
    expect(s.shouldShow).toBe(false);
    expect(s.percent).toBe(100);
    expect(s.nextStep).toBeNull();
  });

  test("SKIPPED is not the same as FINISHED, and neither nags", () => {
    // The distinction matters: a skip must not fake completion, or the progress
    // indicator would claim coverage the operator never had.
    const skipped = computeState({
      completedSteps: [],
      skippedAt: new Date(),
      completedAt: null,
    });
    expect(skipped.shouldShow).toBe(false);
    expect(skipped.finished).toBe(false);
    expect(skipped.skipped).toBe(true);
  });

  test("a step id that no longer exists is ignored, so the guide stays finishable", () => {
    // Regression shape: a step renamed between deploys leaves an unknown id in
    // the array. If it counted, "every step done" could never become true and the
    // tour would nag forever -- the exact bug this module exists to prevent.
    const s = computeState({
      completedSteps: ["a-step-removed-in-v2", ...IDS],
      skippedAt: null,
      completedAt: null,
    });
    expect(s.finished).toBe(true);
    expect(s.shouldShow).toBe(false);
  });
});

describe("persisted progress", () => {
  test("a returning user is not shown the guide again once finished", async () => {
    const u = await freshUser();
    expect((await getOnboarding(u)).shouldShow).toBe(true);

    for (const id of IDS) await completeStep(u, id);
    const after = await getOnboarding(u);
    expect(after.finished).toBe(true);
    expect(after.shouldShow).toBe(false);
    expect(after.percent).toBe(100);
  }, 60_000);

  test("skipping stops the tour and re-opening is deliberate", async () => {
    const u = await freshUser();
    await completeStep(u, IDS[0]!);
    await skipOnboarding(u);

    const skipped = await getOnboarding(u);
    expect(skipped.shouldShow).toBe(false);
    expect(skipped.skipped).toBe(true);
    // Skipping must NOT claim the operator read the rest.
    expect(skipped.finished).toBe(false);
    expect(skipped.done).toBe(1);

    // The guide stays reachable on purpose.
    const resumed = await resumeOnboarding(u);
    expect(resumed.shouldShow).toBe(true);
    // Progress survived the skip/resume round trip.
    expect(resumed.done).toBe(1);
  }, 60_000);

  test("re-completing a step is idempotent and never erases later progress", async () => {
    const u = await freshUser();
    await completeStep(u, IDS[0]!);
    await completeStep(u, IDS[1]!);
    // Someone clicking "back" to the first step.
    await completeStep(u, IDS[0]!);
    const s = await getOnboarding(u);
    expect(s.completed).toEqual([IDS[0], IDS[1]]);
  }, 60_000);

  test("an unknown step is rejected rather than silently recorded", async () => {
    const u = await freshUser();
    await expect(completeStep(u, "not-a-step")).rejects.toThrow();
    expect((await getOnboarding(u)).done).toBe(0);
  }, 60_000);
});
