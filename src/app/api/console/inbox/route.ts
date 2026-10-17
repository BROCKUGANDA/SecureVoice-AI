import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSignedIn } from "@/lib/credits";
import { acknowledge, inbox } from "@/lib/notifications";
import { parseJson } from "@/lib/validation/safe-log";
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
 * GET  /api/console/inbox        the operator's outstanding alerts (org-scoped)
 * POST /api/console/inbox        `{ action: "acknowledge", id }` — a human saw it
 *
 * Escalation itself is a scheduled job: `advanceEscalations()` runs on the dial
 * worker's tick (src/worker/dial.ts), not from here. An alert that only advanced
 * when someone refreshed the page is not an escalation path, it is a UI effect —
 * which is why this route used to re-export the function as a placeholder caller
 * and no longer does.
 */
const schema = z.object({
  action: z.literal("acknowledge"),
  id: z.string().min(1),
});

export async function GET() {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return failure(guard.status === 401 ? "unauthenticated" : "not_found", {detail: guard.error});
  }
  const rows = await inbox(guard.profile.orgId ?? null);
  return NextResponse.json(
    { ok: true, notifications: rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return failure(guard.status === 401 ? "unauthenticated" : "not_found", {detail: guard.error});
  }
  const body = await parseJson(req);
  if (body === null) return failure("malformed_request", {detail: "Invalid JSON body"});
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return failure("semantically_invalid", {detail: "action=acknowledge and id are required"});
  }

  // Tenancy: a notification from another org must be invisible, not merely
  // unacknowledgeable. 404 rather than 403 — a 403 confirms it exists.
  const owned = await inbox(guard.profile.orgId ?? null, 200);
  if (!owned.some((n) => n.id === parsed.data.id)) {
    return failure("not_found", {detail: "not_found"});
  }

  const result = await acknowledge(parsed.data.id, guard.profile.orgId ?? null);
  if (!result.ok) {
    return failure(result.error === "not_found" ? "not_found" : "state_conflict", {detail: result.error});
  }
  return NextResponse.json({ ok: true });
}
