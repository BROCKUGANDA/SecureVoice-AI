import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSignedIn } from "@/lib/credits";
import { advanceEscalations, acknowledge, inbox } from "@/lib/notifications";
import { badRequest, parseJson } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * GET  /api/console/inbox        the operator's outstanding alerts (org-scoped)
 * POST /api/console/inbox        `{ action: "acknowledge", id }` — a human saw it
 *
 * Escalation itself is a scheduled job (`advanceEscalations`), not something a
 * request triggers: an alert that only advances when someone refreshes the page
 * is not an escalation path, it is a UI effect.
 */
const schema = z.object({
  action: z.literal("acknowledge"),
  id: z.string().min(1),
});

export async function GET() {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
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
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "action=acknowledge and id are required" }, { status: 422 });
  }

  // Tenancy: a notification from another org must be invisible, not merely
  // unacknowledgeable. 404 rather than 403 — a 403 confirms it exists.
  const owned = await inbox(guard.profile.orgId ?? null, 200);
  if (!owned.some((n) => n.id === parsed.data.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await acknowledge(parsed.data.id, guard.profile.orgId ?? null);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}

export { advanceEscalations };
