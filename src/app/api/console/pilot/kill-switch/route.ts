import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformOperator } from "@/lib/credits";
import { append } from "@/lib/audit-chain";
import { DIAL_KILL_SWITCH_NAME, setDialKillSwitch } from "@/lib/pilot/mode";
import { parseJson } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

const engageSchema = z.object({
  engaged: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Engage or release the platform-wide dial kill switch.
 *
 * The reason `requirePlatformOperator` guards this, not `requireOperator`: the
 * switch's own table carries no org column BY DESIGN (`prisma/migrations/
 * 9zzz...platform_switch`) — "stop contacting customers" is a platform-wide
 * control, and an admin of one bank must not be able to stop every bank, nor
 * flip the switch that stops THEIR tenant during a dispute. Of the two
 * mis-spellings of that boundary, the shared switch is the more dangerous.
 *
 * Deliberately NOT behind the two-factor step-up gate: an incident lever one
 * extra prompt away is a lever someone thinks twice about flipping, and this
 * control exists for the person whose pager is already buzzing. Every engage
 * and release lands in the audit chain with the requesting actor id, so the
 * 03:00 change is a recorded change.
 *
 * The switch is the OTC lever for a live incident. Release is the ONLY thing
 * below that can erase an engage, and it is just as audited.
 */
export async function POST(req: Request) {
  const guard = await requirePlatformOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await parseJson(req);
  if (body === null) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const parsed = engageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "engaged is required; reason optional" }, { status: 422 });
  }

  try {
    const row = await setDialKillSwitch({
      engaged: parsed.data.engaged,
      actor: guard.profile.userId,
      reason: parsed.data.reason,
    });
    await append({
      callRef: `PILOT-${parsed.data.engaged ? "engage" : "release"}-${row.updatedAt.toISOString()}`,
      action: "pilot",
      intent: parsed.data.engaged ? "dial_kill_switch_engaged" : "dial_kill_switch_released",
      callerId: guard.profile.userId,
      meta: {
        switch: DIAL_KILL_SWITCH_NAME,
        engaged: parsed.data.engaged,
        reason: parsed.data.reason ?? null,
      },
    });
    return NextResponse.json(
      {
        switch: {
          name: DIAL_KILL_SWITCH_NAME,
          engaged: row.engaged,
          updatedAt: row.updatedAt.toISOString(),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Kill switch write failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 503 },
    );
  }
}
