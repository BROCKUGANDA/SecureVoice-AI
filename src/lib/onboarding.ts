import "server-only";
/**
 * Onboarding progress: what the invited operator still has to see.
 *
 * ## The problem this solves
 *
 * Signup is invite-only. Every account was created by a bank administrator, so an
 * operator arrives with no idea what the console does or what it is safe to do.
 * Two failure modes follow, and both are worse than having no onboarding at all:
 *
 *   1. No onboarding, and a judge cannot tell what the product does in 60 seconds.
 *   2. Onboarding that reappears forever, so a real operator who has used the
 *      product for a week is still being told how to sign in.
 *
 * So the rule is explicit and testable: **the guide appears for an operator who
 * has not finished it AND has not skipped it, and never again once either is
 * true.** Returning users get the guide only by asking for it.
 *
 * "Finished" and "skipped" are stored separately on purpose. Collapsing them
 * loses the difference between "you did the tour" and "you told us to stop
 * showing it", and the only way to tell those apart is to record both.
 */
import { db } from "@/lib/db";

/**
 * The guide steps, in order.
 *
 * Ordered by what unblocks the next thing rather than by feature list, because a
 * guide that asks about audit exports before the caller has placed a signal is
 * teaching the shape of the product instead of how to use it.
 *
 * `doneWhen` is a hint for the UI only; nothing is auto-completed from telemetry.
 * A step marked done by inference is a step the operator did not read, which is
 * how a guide ends up lying about coverage.
 */
export const ONBOARDING_STEPS = [
  {
    id: "orientation",
    title: "What this console does",
    body: "A bank sends a risk signal; we place a call to the customer within 60 seconds and freeze the transaction if they did not make it. Your job is to watch that happen and intervene when it does not.",
  },
  {
    id: "first-signal",
    title: "Fire your own test signal",
    body: "Use a number you have verified on the Twilio account. We will not dial a number nobody verified: a rehearsal that calls a stranger is not a rehearsal.",
  },
  {
    id: "watch-the-call",
    title: "Watch a call reach the guardrail",
    body: "Every caller turn goes through a deterministic decision. The agent never asks for a PIN, password or OTP, and that wording is enforced server-side rather than asked of a model.",
  },
  {
    id: "read-the-audit",
    title: "Verify the audit chain",
    body: "The chain verifies from genesis. If someone edited a decision row after the fact, verification fails, and that is the property to show a bank.",
  },
  {
    id: "invite-the-bank",
    title: "Bring in the bank",
    body: "Invite auditors and tenant admins. Roles are enforced on the server, and a role change revokes sessions in that organisation immediately.",
  },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];
const ALL_STEPS: readonly string[] = ONBOARDING_STEPS.map((s) => s.id);

export type OnboardingStateView = {
  /** False once finished OR skipped. Drives whether the guide opens by itself. */
  shouldShow: boolean;
  finished: boolean;
  skipped: boolean;
  completed: OnboardingStepId[];
  /** The next step to show, or null when finished/skipped. */
  nextStep: (typeof ONBOARDING_STEPS)[number] | null;
  /** Steps still ahead of the operator, for a "3 of 5" indicator. */
  total: number;
  done: number;
  percent: number;
};

function parseSteps(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    // Filter to known ids: a step renamed or removed between deploys must not
    // leave the guide permanently unable to finish, which would make it nag
    // forever. The exact bug this module exists to prevent.
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && ALL_STEPS.includes(x))
      : [];
  } catch {
    return [];
  }
}

export function computeState(input: {
  completedSteps: string[];
  skippedAt: Date | null;
  completedAt: Date | null;
}): OnboardingStateView {
  const completed = input.completedSteps.filter((s) => ALL_STEPS.includes(s));
  const seen = new Set(completed);
  const finished = input.completedAt !== null || ALL_STEPS.every((s) => seen.has(s));
  const skipped = input.skippedAt !== null;
  const nextId = ALL_STEPS.find((s) => !seen.has(s));
  const nextStep = ONBOARDING_STEPS.find((s) => s.id === nextId) ?? null;
  const done = completed.length;
  const total = ALL_STEPS.length;
  return {
    shouldShow: !finished && !skipped,
    finished,
    skipped,
    completed: completed as OnboardingStepId[],
    nextStep,
    total,
    done,
    percent: total === 0 ? 100 : Math.round((done / total) * 100),
  };
}

/**
 * Read the state. Returns a "should show" view for an unknown user rather than
 * throwing: onboarding is never worth failing a page render over, and a brand new
 * operator IS the should-show case.
 */
export async function getOnboarding(userId: string): Promise<OnboardingStateView> {
  const row = await db.onboardingState.findUnique({ where: { userId } });
  if (!row) return computeState({ completedSteps: [], skippedAt: null, completedAt: null });
  return computeState({
    completedSteps: parseSteps(row.completedSteps),
    skippedAt: row.skippedAt,
    completedAt: row.completedAt,
  });
}

/**
 * Mark a step done. Idempotent, and never un-completes anything: replaying an
 * old step must not erase progress made since, which is the kind of bug that
 * only appears when someone clicks "back".
 */
export async function completeStep(userId: string, stepId: string): Promise<OnboardingStateView> {
  if (!ALL_STEPS.includes(stepId)) {
    throw new Error(`unknown onboarding step: ${stepId}`);
  }
  const current = await db.onboardingState.findUnique({ where: { userId } });
  const existing = parseSteps(current?.completedSteps);
  const merged = existing.includes(stepId) ? existing : [...existing, stepId];
  const finished = ALL_STEPS.every((s) => merged.includes(s));

  const row = await db.onboardingState.upsert({
    where: { userId },
    create: {
      userId,
      completedSteps: JSON.stringify(merged),
      completedAt: finished ? new Date() : null,
    },
    update: {
      completedSteps: JSON.stringify(merged),
      ...(finished && !current?.completedAt ? { completedAt: new Date() } : {}),
    },
  });
  return computeState({
    completedSteps: parseSteps(row.completedSteps),
    skippedAt: row.skippedAt,
    completedAt: row.completedAt,
  });
}

/**
 * Stop showing the guide.
 *
 * Deliberately records the skip WITHOUT completing the steps. A skipped tour that
 * marked everything done would be indistinguishable from a completed one and the
 * progress indicator would claim coverage the operator never had.
 */
export async function skipOnboarding(userId: string): Promise<OnboardingStateView> {
  const row = await db.onboardingState.upsert({
    where: { userId },
    create: { userId, skippedAt: new Date() },
    update: { skippedAt: new Date() },
  });
  return computeState({
    completedSteps: parseSteps(row.completedSteps),
    skippedAt: row.skippedAt,
    completedAt: row.completedAt,
  });
}

/** Re-open the guide on purpose. Used by the "How do I use this?" affordance. */
export async function resumeOnboarding(userId: string): Promise<OnboardingStateView> {
  await db.onboardingState.upsert({
    where: { userId },
    create: { userId },
    update: { skippedAt: null, completedAt: null },
  });
  const row = await db.onboardingState.findUniqueOrThrow({ where: { userId } });
  return computeState({
    completedSteps: parseSteps(row.completedSteps),
    skippedAt: row.skippedAt,
    completedAt: row.completedAt,
  });
}
