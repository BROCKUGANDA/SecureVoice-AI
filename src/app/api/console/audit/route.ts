import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/credits";
import { orgScopeFor, scopedDb } from "@/lib/tenancy/guard";
import { withTenantScope } from "@/lib/tenancy/db-scope";
import { verifyChain } from "@/lib/audit-chain";

export const dynamic = "force-dynamic";

/**
 * Operator audit tools.
 *
 *   GET /api/console/audit            → recent intervention cases (SV-F-*)
 *   GET /api/console/audit?callRef=X  → full chain walk for one case:
 *                                       tamper-evidence verdict + rows
 * Operator session required.
 *
 * Every read here is an `AuditLog` read, and `AuditLog` carries `orgId`, so these
 * rows are tenant-owned and a row-level policy exists for the table
 * (`9zzzzzzzzzzzzzzzzzzzzzz_tenant_rls`). That makes this the straightforward
 * case: a session naming a concrete organisation reads inside `withTenantScope`,
 * where the database — not the `where` clause — decides which rows exist. The
 * predicates stay anyway, because whoever reads this file should see the intended
 * scope without having to know what a policy is, and because a policy only binds
 * on the paths that opt in (src/lib/tenancy/db-scope.ts).
 *
 * The org-less session is the deployment's shared namespace (`orgId IS NULL` plus
 * the literal `"default"`). There is no single tenant to pin into `app.org_id`, so
 * the policy has nothing to compare against and that arm keeps the application
 * layer's scope — the same asymmetry `src/app/api/auth/export/route.ts` records.
 *
 * The three reads are not merged into one transaction: they are three statements
 * today, with `verifyChain()` (a library call over its own client) between two of
 * them, and collapsing them would be a restructure rather than a conversion.
 */

export async function GET(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const callRef = req.nextUrl.searchParams.get("callRef");
  // Tenant namespace. A session WITHOUT an active organization is the default
  // state of the reference deployment — it must still be scoped, not treated
  // as "sees everything". Org-less users share the un-namespaced rows
  // (orgId NULL, e.g. seeded demo data) plus the "default" namespace.
  const orgId = guard.profile.orgId;
  // Prisma's `in` filter rejects null members, so the null namespace is an OR.
  const orgScope = orgId ? { orgId } : { OR: [{ orgId: null }, { orgId: "default" }] };
  // The same namespace as a scope object, because it is what selects the path.
  const scope = orgScopeFor(orgId);
  // Hoisted: the slice is applied to the raw query parameter at every use.
  const ref = callRef ? callRef.slice(0, 64) : null;

  if (ref) {
    // tenant check: a probe of another org's caseRef must not confirm existence —
    // same 404 whether the case is foreign or nonexistent.
    const probe = { where: { callRef: ref, ...orgScope }, select: { id: true } } as const;
    const any =
      "orgId" in scope
        ? await withTenantScope(scope.orgId, (tx) => tx.auditLog.findFirst(probe))
        : await scopedDb(scope).auditLog.findFirst(probe);
    if (!any) {
      return NextResponse.json({ error: "Case not found in this workspace" }, { status: 404 });
    }
    const verification = await verifyChain(ref, orgId);
    const walk = {
      where: { callRef: ref, ...orgScope },
      orderBy: { createdAt: "asc" as const },
      select: {
        id: true,
        action: true,
        intent: true,
        redactedText: true,
        meta: true,
        createdAt: true,
      },
      take: 50,
    };
    const rows =
      "orgId" in scope
        ? await withTenantScope(scope.orgId, (tx) => tx.auditLog.findMany(walk))
        : await scopedDb(scope).auditLog.findMany(walk);
    return NextResponse.json({ verification, rows }, { headers: { "Cache-Control": "no-store" } });
  }

  // Case list: the "freeze" action marks case creation in /api/interventions.
  const list = {
    where: { action: "freeze", ...orgScope },
    orderBy: { createdAt: "desc" as const },
    select: { callRef: true, intent: true, redactedText: true, meta: true, createdAt: true },
    take: 12,
  };
  const creations =
    "orgId" in scope
      ? await withTenantScope(scope.orgId, (tx) => tx.auditLog.findMany(list))
      : await scopedDb(scope).auditLog.findMany(list);
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
