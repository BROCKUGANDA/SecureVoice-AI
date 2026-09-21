import { NextRequest, NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/credits";
import { db } from "@/lib/db";
import { verifyChain } from "@/lib/audit-chain";

export const dynamic = "force-dynamic";

/**
 * Operator audit tools.
 *
 *   GET /api/console/audit            → recent intervention cases (SV-F-*)
 *   GET /api/console/audit?callRef=X  → full chain walk for one case:
 *                                       tamper-evidence verdict + rows
 * Operator session required.
 */

export async function GET(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const callRef = req.nextUrl.searchParams.get("callRef");
  const orgId = guard.profile.orgId;
  if (callRef) {
    // tenant check: a probe of another org's caseRef must not confirm existence
    if (orgId) {
      const any = await db.auditLog.findFirst({ where: { callRef: callRef.slice(0, 64) }, select: { orgId: true } });
      if (any && any.orgId !== orgId) {
        return NextResponse.json({ error: "Case not found in this workspace" }, { status: 404 });
      }
    }
    const verification = await verifyChain(callRef.slice(0, 64));
    const rows = await db.auditLog.findMany({
      where: { callRef: callRef.slice(0, 64) },
      orderBy: { createdAt: "asc" },
      select: { id: true, action: true, intent: true, redactedText: true, meta: true, createdAt: true },
      take: 50,
    });
    return NextResponse.json({ verification, rows }, { headers: { "Cache-Control": "no-store" } });
  }

  // Case list: the "freeze" action marks case creation in /api/interventions.
  // Org-scoped when the session carries an active organization.
  const creations = await db.auditLog.findMany({
    where: { action: "freeze", ...(orgId ? { orgId } : {}) },
    orderBy: { createdAt: "desc" },
    select: { callRef: true, intent: true, redactedText: true, meta: true, createdAt: true },
    take: 12,
  });
  const cases = creations.map((c) => {
    let meta: Record<string, unknown> = {};
    try {
      meta = c.meta ? JSON.parse(c.meta) : {};
    } catch {}
    return {
      callRef: c.callRef,
      riskScore: meta.riskScore ?? null,
      channel: meta.channel ?? null,
      lang: meta.lang ?? null,
      plannedAction: meta.plannedAction ?? null,
      at: c.createdAt,
    };
  });
  return NextResponse.json({ cases }, { headers: { "Cache-Control": "no-store" } });
}
