import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { requireSignedIn } from "@/lib/credits";
import { orgScopeFor, scopedDb, type OrgScope } from "@/lib/tenancy/guard";
import { withTenantScope } from "@/lib/tenancy/db-scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/console/analytics — the operator dashboard's numbers, from this tenant's rows.
 *
 * ── Why this route exists at all ─────────────────────────────────────────────
 * The dashboard rendered seven arrays imported from `src/lib/data.ts`: seed
 * figures written by hand ("Fraud Prevention Rate 71%", "Customer Satisfaction
 * 4.1/5", a twelve-week loss-avoided curve rising to AED 496k). Nothing read the
 * database. On a pilot that is not a placeholder problem, it is the worst kind of
 * lie: a bank's fraud team opens the console, sees a prevention rate climbing, and
 * renews against a number this product never measured — and the "4.1/5 CSAT" is a
 * metric we do not COLLECT, so no code path could ever have corrected it.
 *
 * ── The rule this route follows ──────────────────────────────────────────────
 * Every figure is a query over `Case`, `UsageLedger` or `AuditLog`, scoped to the
 * caller's own tenant. A metric the platform does not record is ABSENT from the
 * response — never zero, never a plausible-looking default. Zero is a measurement;
 * absence is the truth. The dashboard therefore renders fewer KPIs than the mock
 * did, and that is the intended outcome.
 *
 * Ratios are returned as NUMERATORS AND DENOMINATORS (`reached.of`), not as
 * percentages, because `0/0` is not 0% — a tenant that has placed no calls has an
 * unknown rate, and rendering "0.0%" there would tell the fraud team their contact
 * rate is terrible when in fact nothing has happened yet.
 *
 * Amounts are grouped by currency. Summing an AED case and a USD case into one
 * "loss avoided" figure produces a number with no unit, which is the kind of
 * aggregate that survives review because it looks like a total.
 *
 * ── Tenant enforcement ───────────────────────────────────────────────────────
 * A session with a concrete active organization runs the whole read inside
 * `withTenantScope` (the transaction becomes `sv_tenant` with `app.org_id` pinned,
 * so the row-level policies decide the boundary below the ORM). A session with no
 * active organization is the shared namespace — `orgId IS NULL` plus `"default"` —
 * and there is no single tenant to pin, so it keeps the application-layer scope.
 * Same asymmetry and same reasoning as `/api/auth/export` and
 * `/api/console/documents`.
 */

const WINDOWS = { defaultDays: 90, maxDays: 366, trendWeeks: 12 } as const;

type Client = Pick<Prisma.TransactionClient, "case" | "usageLedger" | "auditLog" | "$queryRaw">;

const REACHED_STATES = new Set([
  "ANSWERED",
  "DISCLOSED",
  "VERIFYING",
  "CONFIRMED_FRAUD",
  "CONFIRMED_LEGITIMATE",
  "UNCERTAIN",
  "FREEZE_STAGED",
  "ESCALATED",
  "NOTIFIED",
  "CLOSED",
]);

/**
 * The org predicate a raw statement must carry.
 *
 * `$queryRaw` is invisible to the tenancy extension: `guard.ts` installs
 * `$allModels.$allOperations`, which intercepts MODEL operations only, and the
 * repo says so itself at `guard.ts:34-37` — "Prisma's model layer cannot see a
 * hand-written predicate". So every hand-written statement in a tenant read has to
 * restate the scope, and this is that restatement, as a Prisma.sql fragment so the
 * values stay bound rather than interpolated.
 *
 * Mirrors `scopeWhere()` in `src/lib/tenancy/guard.ts` exactly — the shared
 * namespace is `orgId IS NULL OR orgId = 'default'` and NEVER "all orgs". If the
 * two ever drift, this function is the one to change.
 *
 * It is applied on BOTH branches, not only the shared one. On the RLS branch it is
 * redundant (RLS already filters), and redundancy that costs one index-friendly
 * predicate is the cheapest possible insurance against a future refactor moving
 * this query onto the shared path.
 */
function orgPredicate(scope: OrgScope) {
  return "orgId" in scope
    ? Prisma.sql`AND "orgId" = ${scope.orgId}`
    : Prisma.sql`AND ("orgId" IS NULL OR "orgId" = 'default')`;
}

async function compute(client: Client, since: Date, until: Date, scope: OrgScope) {
  const window = { createdAt: { gte: since, lt: until } } as const;

  const [casesOpened, byState, byLanguage, byOutcome, duration, credits, recent, audit, trend] =
    await Promise.all([
      client.case.count({ where: window }),
      client.case.groupBy({ by: ["state"], where: window, _count: { _all: true } }),
      client.case.groupBy({ by: ["language"], where: window, _count: { _all: true } }),
      client.case.groupBy({ by: ["outcome"], where: window, _count: { _all: true } }),
      client.case.aggregate({
        where: { ...window, durationSeconds: { gt: 0 } },
        _avg: { durationSeconds: true },
        _max: { durationSeconds: true },
      }),
      client.usageLedger.aggregate({
        where: { createdAt: { gte: since, lt: until }, kind: "consume" },
        _sum: { units: true },
      }),
      client.case.findMany({
        where: window,
        orderBy: { createdAt: "desc" },
        take: 12,
        select: {
          id: true,
          caseRef: true,
          state: true,
          language: true,
          outcome: true,
          durationSeconds: true,
          merchant: true,
          amountMinor: true,
          currency: true,
          freezeStaged: true,
          handoffQueued: true,
          conversationId: true,
          createdAt: true,
        },
      }),
      client.auditLog.findMany({
        where: { createdAt: { gte: since, lt: until } },
        orderBy: { createdAt: "desc" },
        take: 60,
        select: {
          id: true,
          callRef: true,
          action: true,
          intent: true,
          callerId: true,
          redactedText: true,
          chainHash: true,
          createdAt: true,
        },
      }),
      // Weekly buckets straight from Postgres. Twelve client-side queries would
      // each be a correct answer and a wrong total if the clock moved between them.
      //
      // This is the one statement here that is NOT protected by the model-level
      // tenancy extension, so it carries the org predicate itself. Without it this
      // returned weekly caseload for EVERY tenant to any caller whose session had
      // no organisation — which includes every demo seat, since getProfile() drops
      // the tenant pointer for the demo email.
      client.$queryRaw<{ week: Date; cases: number; confirmed: number; reached: number }[]>`
      SELECT date_trunc('week', "createdAt") AS "week",
             COUNT(*)::int                    AS "cases",
             COUNT(*) FILTER (
               WHERE "state" IN ('CONFIRMED_FRAUD','FREEZE_STAGED','ESCALATED')
             )::int                          AS "confirmed",
             COUNT(*) FILTER (
               WHERE "durationSeconds" IS NOT NULL AND "durationSeconds" > 0
             )::int                          AS "reached"
        FROM "Case"
       WHERE "createdAt" >= ${since} AND "createdAt" < ${until}
       ${orgPredicate(scope)}
       GROUP BY 1
       ORDER BY 1
     `,
    ]);

  const countOf = (state: string): number =>
    byState.find((r) => r.state === state)?._count._all ?? 0;

  // "Reached a human" is a state fact, not a duration fact: an answered call that
  // the customer hung up on inside a second has a null duration and was still
  // reached. The two are different questions and the mock conflated them.
  const reached = byState
    .filter((r) => REACHED_STATES.has(r.state))
    .reduce((acc, r) => acc + r._count._all, 0);

  const confirmedFraud =
    countOf("CONFIRMED_FRAUD") + countOf("FREEZE_STAGED") + countOf("ESCALATED");
  const noAnswer =
    countOf("NO_ANSWER") + countOf("UNREACHABLE") + countOf("VOICEMAIL") + countOf("BUSY");
  const handoffs = await client.case.count({ where: { ...window, handoffQueued: true } });

  // Loss avoided, per currency. Only a case the institution's own risk verdict
  // confirmed as fraud counts, and the figure is the TRANSACTION amount — the
  // platform is reporting what was at stake, not claiming it recovered it.
  const byCurrency = await client.case.groupBy({
    by: ["currency"],
    where: {
      ...window,
      state: { in: ["CONFIRMED_FRAUD", "FREEZE_STAGED", "ESCALATED", "NOTIFIED", "CLOSED"] },
      amountMinor: { not: null },
    },
    _sum: { amountMinor: true },
    _count: { _all: true },
  });

  return {
    window: { from: since.toISOString(), to: until.toISOString(), days: WINDOWS.defaultDays },
    kpis: {
      casesOpened,
      reached: { of: casesOpened, value: reached },
      confirmedFraud: { of: casesOpened, value: confirmedFraud },
      handoffs: { of: reached, value: handoffs },
      noAnswer: { of: casesOpened, value: noAnswer },
      freezesStaged: await client.case.count({ where: { ...window, freezeStaged: true } }),
      callDurationSeconds: {
        average:
          duration._avg.durationSeconds === null ? null : Math.round(duration._avg.durationSeconds),
        longest: duration._max.durationSeconds,
        measuredOver: reached,
      },
      creditsConsumed: credits._sum.units ?? 0,
    },
    lossAvoided: byCurrency.map((row) => ({
      currency: row.currency ?? "UNKNOWN",
      amountMinor: row._sum.amountMinor ?? 0,
      cases: row._count._all,
    })),
    languages: byLanguage
      .map((row) => ({ language: row.language, cases: row._count._all }))
      .sort((a, b) => b.cases - a.cases),
    outcomes: byOutcome
      .map((row) => ({ outcome: row.outcome ?? "not_recorded", cases: row._count._all }))
      .sort((a, b) => b.cases - a.cases),
    states: byState
      .map((row) => ({ state: row.state, cases: row._count._all }))
      .sort((a, b) => b.cases - a.cases),
    trend: trend.map((row) => ({
      weekStart: row.week instanceof Date ? row.week.toISOString() : String(row.week),
      cases: row.cases,
      confirmed: row.confirmed,
      reached: row.reached,
    })),
    recentCalls: recent.map((c) => ({
      id: c.id,
      caseRef: c.caseRef,
      state: c.state,
      language: c.language,
      outcome: c.outcome,
      durationSeconds: c.durationSeconds,
      merchant: c.merchant,
      amountMinor: c.amountMinor,
      currency: c.currency,
      freezeStaged: c.freezeStaged,
      handoffQueued: c.handoffQueued,
      // The download route is the only thing that can mint a playable URL, and it
      // needs a session of its own — so this says whether a recording is
      // RETRIEVABLE, never whether one exists in a bucket this read cannot see.
      hasConversation: c.conversationId !== null,
      createdAt: c.createdAt.toISOString(),
    })),
    audit: audit.map((a) => ({
      id: a.id,
      callRef: a.callRef,
      action: a.action,
      intent: a.intent,
      callerId: a.callerId,
      redactedText: a.redactedText,
      // The chain hash is the tamper evidence, so the console shows a real
      // prefix of it. `verifyChain` is the route that re-derives the whole walk.
      chainHash: a.chainHash.slice(0, 12),
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

export async function GET(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const rawDays = req.nextUrl.searchParams.get("days");
  const requested = rawDays === null ? WINDOWS.defaultDays : Number(rawDays);
  if (!Number.isInteger(requested) || requested < 1 || requested > WINDOWS.maxDays) {
    return NextResponse.json(
      { error: `days must be an integer between 1 and ${WINDOWS.maxDays}` },
      { status: 422 },
    );
  }

  const until = new Date();
  const since = new Date(until.getTime() - requested * 86_400_000);
  const orgId = guard.profile.orgId;
  const scope = orgScopeFor(orgId);

  try {
    const data =
      "orgId" in scope
        ? await withTenantScope(scope.orgId, (tx) => compute(tx, since, until, scope))
        : await compute(scopedDb(scope) as Client, since, until, scope);

    return NextResponse.json(
      {
        data,
        meta: {
          // Stated, so a reviewer can tell "the tenant has no cases" from "the
          // read was scoped to somebody else".
          scopedTo: "orgId" in scope ? scope.orgId : "shared-namespace",
          enforcement: "orgId" in scope ? "row-level-security" : "application-scope",
          windowDays: requested,
          generatedAt: until.toISOString(),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // A 500 here is a query or a policy problem, and the dashboard must be able to
    // say so: a silently empty dashboard reads exactly like an empty tenant.
    return NextResponse.json(
      { error: "analytics_unavailable", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
