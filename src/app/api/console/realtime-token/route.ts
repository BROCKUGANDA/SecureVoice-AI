import { NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/credits";
import { mintRealtimeToken } from "@/lib/realtime-token";

export const dynamic = "force-dynamic";

/**
 * Mint a short-lived websocket grant for the signed-in operator.
 *
 * The realtime service cannot validate a Clerk session, so this endpoint is
 * where the app's own auth decision is delegated into a token it can verify. The
 * console calls this immediately before each socket handshake; the grant lives
 * 60s and carries the operator's org plus the channels for the cases they are
 * watching.
 *
 * 503 (not 401) when no signing secret is configured: the operator IS signed in,
 * the deployment is just missing REALTIME_INGEST_SECRET. That distinction lets
 * the console fall back to SSE instead of showing an auth error.
 */
export async function POST(req: Request) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  // Case refs are the ones the client is actually watching. Read from the body
  // (not the query string) so they never land in access logs.
  let callRefs: string[] = [];
  try {
    const body = (await req.json()) as { callRefs?: unknown };
    if (Array.isArray(body.callRefs)) {
      callRefs = body.callRefs
        .filter((r): r is string => typeof r === "string")
        .map((r) => r.replace(/[^\w.-]/g, "").slice(0, 64))
        .filter(Boolean)
        .slice(0, 50);
    }
  } catch {
    // An empty grant (org channel only) is valid; a malformed body is not fatal.
  }

  // A Clerk org id looks like `org_…`. With no active organization the session
  // is single-tenant; derive a stable local namespace so channels still work
  // instead of refusing to mint (the org channel would otherwise be unrepresentable).
  const orgId = guard.profile.orgId ?? "default";
  const sub = guard.profile.clerkUserId;

  const minted = mintRealtimeToken(orgId, sub, callRefs);
  if (!minted.ok) {
    return NextResponse.json(
      { error: "Realtime not configured — set REALTIME_INGEST_SECRET to enable the live feed." },
      { status: 503 },
    );
  }

  return NextResponse.json(
    { token: minted.token, orgId, path: "/realtime" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
