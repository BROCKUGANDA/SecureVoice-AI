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
  // Tenant namespace. A session WITHOUT a Clerk organization is the default
  // state of the reference deployment — it must still be scoped, not treated
  // as "sees everything". Org-less users share the un-namespaced rows
  // (orgId NULL, e.g. seeded demo data) plus the "default" namespace.
  const orgId = guard.profile.orgId;
  // Prisma's `in` filter rejects null members, so the null namespace is an OR.
  const orgScope = orgId ? { orgId } : { OR: [{ orgId: null }, { orgId: "default" }] };
  if (callRef) {
    // tenant check: a probe of another org's caseRef must not confirm existence —
    // same 404 whether the case is foreign or nonexistent.
    const any = await db.auditLog.findFirst({
      where: { callRef: callRef.slice(0, 64), ...orgScope },
      select: { id: true },
    });
    if (!any) {
      return NextResponse.json({ error: "Case not found in this workspace" }, { status: 404 });
    }
    const verification = await verifyChain(callRef.slice(0, 64));
    const rows = await db.auditLog.findMany({
      where: { callRef: callRef.slice(0, 64), ...orgScope },
      orderBy: { createdAt: "asc" },
      select: { id: true, action: true, intent: true, redactedText: true, meta: true, createdAt: true },
      take: 50,
    });
    return NextResponse.json({ verification, rows }, { headers: { "Cache-Control": "no-store" } });
  }

  // Case list: the "freeze" action marks case creation in /api/interventions.
  const creations = await db.auditLog.findMany({
    where: { action: "freeze", ...orgScope },
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
