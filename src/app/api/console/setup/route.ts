import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/credits";
import { SETUP_STEPS, completeSetup, getSetup, saveSetupStep, skipSetup } from "@/lib/setup";
import { append as auditAppend } from "@/lib/audit-chain";
import { makeFailure, type FailureCode, type FailureInit } from "@/lib/failures/envelope";

function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  const f = makeFailure(code, init);
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}

export const dynamic = "force-dynamic";

/**
 * The multi-step onboarding wizard.
 *
 *   GET  /api/console/setup → { step, completed, org, telecom, ai, webhooks }
 *   POST /api/console/setup { action, step, data }
 *        action "save"    → validate one step, write it, return the next step
 *        action "finish"  → stamp setupCompletedAt
 *        action "skip"    → reset progress, leave the tenant un-onboarded
 *
 * Everything the wizard configures is TENANT state, so the org is derived from
 * the session and a session with no organization is a 409 — never a silent
 * write to nowhere.
 *
 * What this response NEVER contains: a stored ElevenLabs key, LLM key, Twilio
 * auth token or webhook signing secret. Those are returned as masked strings or
 * booleans by `getSetup`, and the only way to change them is to submit a new one.
 */

export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) {
    return failure(guard.status === 401 ? "unauthenticated" : "not_found", {detail: guard.error});
  }
  if (!guard.profile.orgId) {
    return failure("state_conflict", {detail: "No organization is linked to this account, so there is no institution to set up."});
  }

  const setup = await getSetup(guard.profile.orgId, guard.profile.userId);
  return NextResponse.json(
    { ok: true, steps: SETUP_STEPS, ...setup },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return failure(guard.status === 401 ? "unauthenticated" : "not_found", {detail: guard.error});
  }
  const orgId = guard.profile.orgId;
  if (!orgId) {
    return failure("state_conflict", {detail: "No organization is linked to this account, so there is no institution to set up."});
  }

  let body: { action?: unknown; step?: unknown; data?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return failure("malformed_request", {detail: "Invalid JSON body"});
  }

  const action = body.action ?? "save";

  if (action === "finish") {
    const done = await completeSetup(orgId);
    await auditAppend({
      callRef: `SETUP-${orgId.slice(0, 24)}`,
      action: "consent",
      intent: "setup_completed",
      callerId: guard.profile.userId,
      orgId,
      redactedText: "institution setup completed",
      meta: {},
    });
    return NextResponse.json({
      ok: true,
      completed: true,
      completedAt: done.completedAt.toISOString(),
      step: SETUP_STEPS.length,
    });
  }

  if (action === "skip") {
    const res = await skipSetup(orgId);
    return NextResponse.json({ ok: res.ok, step: res.step, skipped: true });
  }

  if (action !== "save") {
    return failure("semantically_invalid", {detail: `action must be save | finish | skip, got "${String(action)}"`});
  }

  const step = Number(body.step);
  if (!Number.isInteger(step) || step < 1 || step > SETUP_STEPS.length) {
    return failure("semantically_invalid", {detail: `step must be 1–${SETUP_STEPS.length}`});
  }
  const data =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : null;
  if (!data) return failure("semantically_invalid", {detail: "data must be an object"});

  const res = await saveSetupStep(orgId, guard.profile.userId, step, data);
  if (!res.ok) return failure("semantically_invalid", {detail: res.error});

  // Which FIELDS changed, never their values — this trail must never become a
  // place a signing key or a provider credential is written down.
  await auditAppend({
    callRef: `SETUP-${orgId.slice(0, 24)}`,
    action: "consent",
    intent: "setup_step_saved",
    callerId: guard.profile.userId,
    orgId,
    redactedText: `setup step ${step} saved`,
    meta: {},
  });

  return NextResponse.json({ ok: true, step: res.step, completed: false });
}
