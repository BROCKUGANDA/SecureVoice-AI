import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/guards";
import {
  completeStep,
  getOnboarding,
  skipOnboarding,
  resumeOnboarding,
  ONBOARDING_STEPS,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    action: z.enum(["complete", "skip", "resume"]),
    step: z.string().optional(),
  })
  .strict();

/**
 * GET /api/onboarding — the caller's progress through the guide.
 *
 * Returns the step list from the server rather than shipping the copy to the
 * client, so the guide text has one owner and cannot drift between the two.
 */
export async function GET(req: Request) {
  const authed = await requireAuth(req.headers.get("cookie"));
  if (!authed.ok) {
    return NextResponse.json(
      { error: authed.error, code: authed.code },
      { status: authed.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const state = await getOnboarding(authed.identity.accountId);
  return NextResponse.json(
    { ...state, steps: ONBOARDING_STEPS },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/onboarding — record progress.
 *
 * `.strict()` because an unknown field here means the client and server disagree
 * about the contract, and silently ignoring it is how a caller ends up believing
 * it recorded something it did not.
 */
export async function POST(req: Request) {
  const authed = await requireAuth(req.headers.get("cookie"));
  if (!authed.ok) {
    return NextResponse.json(
      { error: authed.error, code: authed.code },
      { status: authed.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid onboarding action", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const userId = authed.identity.accountId;
  try {
    if (parsed.data.action === "skip") {
      return NextResponse.json(await skipOnboarding(userId));
    }
    if (parsed.data.action === "resume") {
      return NextResponse.json(await resumeOnboarding(userId));
    }
    // An unknown step id is a 422 rather than a silent no-op: the client would
    // otherwise advance its own UI while the server recorded nothing.
    if (!parsed.data.step || !ONBOARDING_STEPS.some((s) => s.id === parsed.data.step)) {
      return NextResponse.json(
        { error: "unknown onboarding step", detail: parsed.data.step ?? null },
        { status: 422 },
      );
    }
    return NextResponse.json(await completeStep(userId, parsed.data.step));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "onboarding update failed" },
      { status: 500 },
    );
  }
}
