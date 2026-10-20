import { NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/credits";
import { pilotStatus } from "@/lib/pilot/mode";

export const dynamic = "force-dynamic";

/**
 * The pilot state an operator can act on.
 *
 * `src/lib/pilot/mode.ts` owns the mode and the kill switch; this route is the
 * read surface. It is shown to every signed-in console role on purpose: a
 * specialist mid-incident must be able to SEE that dialling is stopped even
 * though they are not the person allowed to un-stop it.
 *
 * The org operand of the status is derived from the session, never from a
 * query parameter: a tenant goes on trusting a signed-in session, not whatever
 * org id a caller happened to put in a URL. The kill switch, the mode and the
 * caps are platform-level and the same for every org; only the today/in-flight
 * counters differ.
 */
export async function GET() {
  const guard = await requireSignedIn();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const status = await pilotStatus(guard.profile.orgId ?? null);
    return NextResponse.json({ pilot: status }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { error: `Pilot status unavailable: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 503 },
    );
  }
}
