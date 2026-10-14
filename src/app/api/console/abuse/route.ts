import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCapability } from "@/lib/auth/guards";
import { safeOrgKey } from "@/lib/abuse/geo";
import { pauseOrg, pausedOrgs, resumeOrg, velocitySnapshot } from "@/lib/abuse/velocity";
import { append as auditAppend } from "@/lib/audit-chain";

export const dynamic = "force-dynamic";

/**
 * The abuse breaker's operator surface.
 *
 * WHY THIS ROUTE EXISTS AT ALL. The velocity breaker auto-pauses an organisation
 * and `ABUSE_PAUSE_TTL_SEC` defaults to **0**, which the config documents as
 * "sticky until a human resumes it". `resumeOrg()`, `pausedOrgs()` and
 * `pauseOrg()` were written, exported, unit-tested — and called by nothing in
 * `src/app` or `src/worker`. There was no way to see that an organisation was
 * paused and no way to un-pause it. So the only pause in the product that is
 * deliberately PERMANENT had no door out, and every dial for that tenant
 * answered `org_auto_paused` forever while the published error catalog called that
 * cause `retryable: true` and told the bank to wait for a human. The human existed
 * in the contract and nowhere in the product.
 *
 * A false-positive burst therefore silences a bank's fraud calling with no visible
 * cause and no remedy, which is how a safety control gets switched off by the
 * people it inconveniences.
 *
 * ── Tenancy is structural, not checked ─────────────────────────────────────────
 * No handler here accepts an org id from the request. The key is always derived
 * from the caller's own session, so resuing another tenant's breaker is not a
 * permission the route could forget to enforce — it is not expressible.
 *
 * ── What this can NOT do ───────────────────────────────────────────────────────
 * Breaker state is in-process unless a deployment installs a shared store
 * (`setPauseStore`). Resuming here clears THIS node. The response says so rather
 * than reporting a clean success an operator would read as "the whole fleet is
 * open again" — a pause that comes back on the next request to a different node is
 * exactly the confusion this surface exists to remove.
 */

const schema = z.object({
  action: z.enum(["resume", "pause"]),
  reason: z.string().trim().min(3).max(200).optional(),
});

/** The caller's own breaker key, or null when the session has no organisation. */
function ownKey(orgId: string): string | null {
  return safeOrgKey(orgId) || null;
}

/** Breaker records belonging to one org key. */
function forOrg(orgKey: string) {
  return pausedOrgs().filter((r) => r.orgId === orgKey);
}

export async function GET(req: NextRequest) {
  // The cookie comes from the request, never from a default: `readSessionCookie`
  // answers null for an absent header, so a GET written without the request would
  // refuse every signed-in operator with 401 and look like a broken session.
  const guard = await requireCapability(req.headers.get("cookie"), "settings:write");
  if (!guard.ok) {
    return NextResponse.json(
      { error: guard.error, code: guard.code },
      { status: guard.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const key = ownKey(guard.orgId);
  if (!key) {
    return NextResponse.json(
      {
        ok: true,
        paused: [],
        scope: "this session has no organisation, so there is no breaker to report",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const records = forOrg(key);
  const snapshot = velocitySnapshot();
  return NextResponse.json(
    {
      ok: true,
      paused: records.map((r) => ({
        orgId: r.orgId,
        at: new Date(r.at).toISOString(),
        expiresAt: r.expiresAt === null ? null : new Date(r.expiresAt).toISOString(),
        // "never" is the honest reading of a null expiry here, because the default
        // configuration produces exactly that: nothing will clear this on its own.
        expires: r.expiresAt === null ? "never — resumes only when a human does" : undefined,
        reason: r.reason,
        signals: r.signals,
        detail: r.detail,
      })),
      /** Non-zero pause count with TTL 0 means a permanent block until resumed. */
      pauseTtlIsSticky: snapshot.thresholds.pauseTtlSec === 0,
      scope: snapshot.scope,
      trackedOrgs: snapshot.trackedOrgs,
      pausedOrgsTotal: snapshot.pausedOrgs,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireCapability(req.headers.get("cookie"), "settings:write");
  if (!guard.ok) {
    return NextResponse.json(
      { error: guard.error, code: guard.code },
      { status: guard.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const key = ownKey(guard.orgId);
  if (!key) {
    return NextResponse.json(
      { error: "This session has no organisation, so there is no breaker to change." },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "action must be resume or pause" },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { action, reason } = parsed.data;

  if (action === "pause") {
    // Deliberate self-silencing is a support/containment action: an org that
    // discovers active fraud on its own line can stop dialling before the rules
    // do. It is sticky by configuration, so saying so out loud matters.
    const made = pauseOrg(guard.orgId, {
      reason: "manual",
      detail: reason ?? "paused by operator",
    });
    void auditAppend(
      {
        callRef: `ABUSE-${key}`.slice(0, 64),
        action: "freeze",
        intent: made ? "abuse_breaker_paused_manual" : "abuse_breaker_pause_noop",
        callerId: guard.identity.accountId,
        meta: { orgKey: key, reason, sticky: velocitySnapshot().thresholds.pauseTtlSec === 0 },
        orgId: guard.orgId,
      },
      { fast: true },
    ).catch(() => {});
    return NextResponse.json(
      { ok: true, paused: made, sticky: velocitySnapshot().thresholds.pauseTtlSec === 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Resume. Answered from the store's own verdict, never assumed: `resumeOrg`
  // returns false when nothing was paused, and reporting success for a no-op
  // would tell an operator they opened a breaker that was never shut.
  const wasPaused = forOrg(key);
  const resumed = resumeOrg(guard.orgId);
  void auditAppend(
    {
      callRef: `ABUSE-${key}`.slice(0, 64),
      action: "freeze",
      intent: resumed ? "abuse_breaker_resumed" : "abuse_breaker_resume_noop",
      callerId: guard.identity.accountId,
      // What the breaker was paused FOR is the thing a reviewer needs after the
      // fact; the resume destroys the record, so it is copied into the audit here.
      meta: {
        orgKey: key,
        resumed,
        wasPausedFor: wasPaused.map((r) => r.reason),
        signals: wasPaused.flatMap((r) => r.signals),
      },
      orgId: guard.orgId,
    },
    { fast: true },
  ).catch(() => {});

  if (!resumed) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_paused",
        note: "This organisation has no open breaker on this node. Breaker state is per-process unless the deployment configures a shared store.",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      resumed: true,
      stillPausedOnThisNode: forOrg(key).length,
      scope: velocitySnapshot().scope,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
