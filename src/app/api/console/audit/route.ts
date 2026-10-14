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

/** Page size ceiling. A UI that cannot ask for more than this cannot walk the log. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Parse and BOUND every filter.
 *
 * An unbounded `limit` is a denial of service dressed as a query parameter, and an
 * unbounded `from` is a scan of the whole table. Every numeric input is clamped and
 * every string is trimmed and capped here, once, rather than at each use.
 */
function readFilters(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const clamp = (v: string | null, max: number) => {
    if (v === null) return null;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(n, max);
  };
  const slice = (v: string | null, max: number) => {
    if (v === null) return null;
    const s = v.trim().slice(0, max);
    return s === "" ? null : s;
  };
  const date = (v: string | null) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  return {
    callRef: slice(p.get("callRef"), 64),
    action: slice(p.get("action"), 40),
    intent: slice(p.get("intent"), 40),
    actor: slice(p.get("actor"), 120),
    // Free text over the redacted transcript and the call reference. Both are
    // user-supplied and neither is interpolated into SQL.
    q: slice(p.get("q"), 120),
    from: date(p.get("from")),
    to: date(p.get("to")),
    limit: clamp(p.get("limit"), MAX_LIMIT) ?? DEFAULT_LIMIT,
    offset: clamp(p.get("offset"), 100_000) ?? 0,
  };
}

type Filters = ReturnType<typeof readFilters>;

/**
 * The tenant-scoped `where` for the row explorer.
 *
 * Every value is a Prisma filter object, so nothing here is string-concatenated
 * into SQL; `q` is an ILIKE with a capped needle rather than a raw pattern.
 */
function rowWhere(orgScope: Record<string, unknown>, f: Filters) {
  const where: Record<string, unknown> = { ...orgScope };
  if (f.callRef) where.callRef = f.callRef;
  if (f.action) where.action = f.action;
  if (f.intent) where.intent = f.intent;
  if (f.actor) where.callerId = f.actor;
  if (f.q) {
    where.OR = [
      { redactedText: { contains: f.q, mode: "insensitive" } },
      { callRef: { contains: f.q, mode: "insensitive" } },
    ];
  }
  if (f.from || f.to) {
    where.createdAt = {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? { lte: f.to } : {}),
    };
  }
  return where;
}

export async function GET(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const scopeKind = req.nextUrl.searchParams.get("scope");
  const filters = readFilters(req);
  // Tenant namespace. A session WITHOUT an active organization is the default
  // state of the reference deployment — it must still be scoped, not treated
  // as "sees everything". Org-less users share the un-namespaced rows
  // (orgId NULL, e.g. seeded demo data) plus the "default" namespace.
  const orgId = guard.profile.orgId;
  // Prisma's `in` filter rejects null members, so the null namespace is an OR.
  const orgScope = orgId ? { orgId } : { OR: [{ orgId: null }, { orgId: "default" }] };
  // The same namespace as a scope object, because it is what selects the path.
  const scope = orgScopeFor(orgId);

  // Org-wide integrity: does the tenant's log still verify?
  //
  // The single number an auditor asks for first, and the one the per-case walk
  // cannot answer: `verifyChain` is per callRef, so a deployment with 40,000
  // chains has no cheap way to say "none of them are broken".
  //
  // Bounded on purpose — the walk is one query per chain — so the response says
  // plainly when the cap was hit rather than implying coverage it did not perform.
  if (scopeKind === "integrity") {
    const INTEGRITY_MAX_CALLREFS = 200;
    const refs =
      "orgId" in scope
        ? await withTenantScope(scope.orgId, (tx) =>
            tx.auditLog.findMany({
              where: orgScope,
              distinct: ["callRef"],
              select: { callRef: true },
              take: INTEGRITY_MAX_CALLREFS,
            }),
          )
        : await scopedDb(scope).auditLog.findMany({
            where: orgScope,
            distinct: ["callRef"],
            select: { callRef: true },
            take: INTEGRITY_MAX_CALLREFS,
          });

    let verified = 0;
    let broken: { callRef: string; brokenAt: string; expected: string; actual: string } | null =
      null;
    for (const { callRef } of refs) {
      const v = await verifyChain(callRef, orgId);
      if (v.ok) verified++;
      else if (!broken) {
        broken = { callRef, brokenAt: v.brokenAt, expected: v.expected, actual: v.actual };
      }
    }

    const totalRows =
      "orgId" in scope
        ? await withTenantScope(scope.orgId, (tx) => tx.auditLog.count({ where: orgScope }))
        : await scopedDb(scope).auditLog.count({ where: orgScope });

    return NextResponse.json(
      {
        chainsChecked: refs.length,
        verified,
        broken,
        totalRows,
        // `true` means "every chain in THIS TENANT was checked" - not "every chain
        // in the database". The cap is on the tenant's rows and `chainsChecked`
        // says which side of it this response landed on.
        complete: refs.length < INTEGRITY_MAX_CALLREFS,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Row explorer: filtered, paged, tenant-scoped.
  if (scopeKind === "rows") {
    const where = rowWhere(orgScope, filters);
    const list = {
      where,
      // `id` is the tie-break: two rows can share a millisecond timestamp (the
      // chain walk exists because of exactly that), and without a stable
      // secondary sort a page boundary can repeat or skip a row.
      orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
      select: {
        id: true,
        callRef: true,
        action: true,
        intent: true,
        callerId: true,
        redactedText: true,
        chainHash: true,
        prevHash: true,
        createdAt: true,
      },
      take: filters.limit + 1, // the extra row is the "is there a next page" probe
      skip: filters.offset,
    };
    const rows =
      "orgId" in scope
        ? await withTenantScope(scope.orgId, (tx) => tx.auditLog.findMany(list))
        : await scopedDb(scope).auditLog.findMany(list);

    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const total =
      "orgId" in scope
        ? await withTenantScope(scope.orgId, (tx) => tx.auditLog.count({ where }))
        : await scopedDb(scope).auditLog.count({ where });

    return NextResponse.json(
      {
        rows: page,
        total,
        limit: filters.limit,
        offset: filters.offset,
        hasMore,
        nextOffset: hasMore ? filters.offset + filters.limit : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Hoisted: the slice is applied to the raw query parameter at every use.
  const ref = filters.callRef;

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
