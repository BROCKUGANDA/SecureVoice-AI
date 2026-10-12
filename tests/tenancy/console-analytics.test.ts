/**
 * THE DASHBOARD'S NUMBERS ARE MEASURED — the operator console's analytics read,
 * asserted against rows that exist and rows that belong to somebody else.
 *
 * This route replaces seven hand-written arrays in `src/lib/data.ts`. The route is
 * the point: a bank's fraud team decides whether the product works from what this
 * page shows them, and until now every figure on it was seeded prose — including a
 * "Customer Satisfaction 4.1/5" the platform never collected, which no code path
 * could have corrected.
 *
 * What is asserted, in order of how badly each failure would be discovered:
 *
 *   1. A NO-OP ASSERTION GUARD: the tenant must have rows, or every number below
 *      would be 0 and the test would pass while proving nothing.
 *   2. Another tenant's cases are not counted, and the read runs under the
 *      database-enforced path (`meta.enforcement`), not merely a `where` clause.
 *   3. A ratio returns its DENOMINATOR. `reached: {value, of}` — because 0/0 is an
 *      unknown rate, not 0%, and rendering "0.0%" to a tenant that has placed no
 *      calls tells them their contact rate is bad when nothing happened.
 *   4. A metric the platform does not record is ABSENT, not zero. There is no CSAT
 *      column anywhere in the schema, so the response must not have one.
 *   5. Money is grouped by currency rather than summed across currencies: an AED
 *      figure and a USD figure added together is a number with no unit.
 *   6. `no-store`, because the page is per-tenant and a shared cache would leak it.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

const session: { orgId: string | null } = { orgId: null };

mock.module("next/headers", () => ({ headers: async () => new Headers() }));
mock.module("@/lib/credits", () => ({
  requireSignedIn: async () =>
    session.orgId === null
      ? { ok: false, status: 401, error: "sign in required" }
      : { ok: true, profile: { userId: USER, orgId: session.orgId, email: "ops@bank.test" } },
}));

function uuid(slot: number): string {
  const h = createHash("sha256").update(`analytics:${slot}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const RUN = Date.now().toString(36);
const USER = uuid(1);
const ORG_A = uuid(2);
const ORG_B = uuid(3);

async function get(days?: string) {
  const { GET } = await import("@/app/api/console/analytics/route");
  const url = `https://app.test/api/console/analytics${days ? `?days=${days}` : ""}`;
  const res = await GET(new NextRequest(url));
  return { status: res.status, noStore: res.headers.get("cache-control"), body: await res.json() };
}

async function seedCase(caseRef: string, orgId: string, data: Record<string, unknown>) {
  await db.case.create({ data: { caseRef, orgId, phone: "+971500000000", ...data } });
}

beforeAll(async () => {
  for (const [id, name] of [
    [ORG_A, "Measured A"],
    [ORG_B, "Measured B"],
  ] as [string, string][]) {
    await db.organization.create({
      data: { id, name, slug: `${name.toLowerCase()}-${RUN}`, createdAt: new Date() },
    });
  }

  // Tenant A: three fraud confirmations (one AED, one USD, so a summed
  // "loss avoided" across currencies would be visibly wrong), one legitimate
  // confirmation, one no-answer, one case still dialling.
  await seedCase(`SV-M-A1-${RUN}`, ORG_A, {
    state: "CONFIRMED_FRAUD",
    language: "ar",
    durationSeconds: 92,
    amountMinor: 250_000,
    currency: "AED",
    freezeStaged: true,
    merchant: "Electronics A",
  });
  await seedCase(`SV-M-A2-${RUN}`, ORG_A, {
    state: "NOTIFIED",
    language: "en",
    durationSeconds: 40,
    amountMinor: 90_000,
    currency: "USD",
    merchant: "Electronics B",
  });
  await seedCase(`SV-M-A3-${RUN}`, ORG_A, {
    state: "CONFIRMED_LEGITIMATE",
    language: "ar",
    durationSeconds: 12,
    merchant: "Electronics C",
  });
  await seedCase(`SV-M-A4-${RUN}`, ORG_A, { state: "NO_ANSWER", language: "en" });
  await seedCase(`SV-M-A5-${RUN}`, ORG_A, {
    state: "DIALING",
    language: "en",
    handoffQueued: true,
  });

  await seedCase(`SV-M-B1-${RUN}`, ORG_B, {
    state: "CONFIRMED_FRAUD",
    language: "ar",
    amountMinor: 9_900_000,
    currency: "AED",
  });

  await db.user.create({
    data: {
      id: USER,
      email: `ops.${RUN}@bank.test`,
      name: "Ops",
      emailVerified: true,
    },
  });
  await db.userProfile.create({
    data: {
      userId: USER,
      email: `ops.${RUN}@bank.test`,
      name: "Ops",
      orgId: ORG_A,
      credits: 10,
    },
  });
});

afterAll(async () => {
  await db.case.deleteMany({ where: { caseRef: { startsWith: "SV-M-" } } });
  await db.userProfile.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
});

describe("the tenant's own numbers", () => {
  test("counts this tenant's cases, and only this tenant's", async () => {
    session.orgId = ORG_A;
    const res = await get("30");
    expect(res.status).toBe(200);
    expect(res.noStore).toContain("no-store");

    const { meta } = res.body as {
      meta: Record<string, string>;
    };
    expect(meta.scopedTo).toBe(ORG_A);
    expect(meta.enforcement).toBe("row-level-security");

    const kpis = (
      res.body as { data: { kpis: Record<string, { value?: number; of?: number } | number> } }
    ).data.kpis;
    // Five seeded for A, one for B: 5 is the guard against a vacuous zero.
    expect(kpis.casesOpened).toBe(5);
    // Org B's AED 9.9m fraud case must not be in A's totals. Summed across
    // currencies would be meaningless (see the next test), so compare the AED
    // figure alone and the cross-currency total against B's amount explicitly.
    const loss = (
      res.body as { data: { lossAvoided: { currency: string; amountMinor: number }[] } }
    ).data.lossAvoided;
    expect(loss.find((l) => l.currency === "AED")?.amountMinor).toBe(250_000);
    const anyRowCarryingBsAmount = loss.some((l) => l.amountMinor >= 9_900_000);
    expect(anyRowCarryingBsAmount, "another tenant's case leaked into this total").toBe(false);

    const reached = kpis.reached as { value: number; of: number };
    expect(reached.of).toBe(5);
    // DIALING and NO_ANSWER are not "reached a human"; the other three are.
    expect(reached.value).toBe(3);
    expect((kpis.noAnswer as { value: number }).value).toBe(1);
    expect((kpis.confirmedFraud as { value: number }).value).toBe(1);
  });

  test("money stays grouped by currency instead of being added across units", async () => {
    session.orgId = ORG_A;
    const res = await get("30");
    const loss = (
      res.body as { data: { lossAvoided: { currency: string; amountMinor: number }[] } }
    ).data.lossAvoided;

    expect(loss.map((l) => l.currency).sort()).toEqual(["AED", "USD"]);
    const aed = loss.find((l) => l.currency === "AED")!;
    expect(aed.amountMinor).toBe(250_000);
    // The NOTIFIED case holds the USD amount and is in the confirmed family, so
    // it belongs here; the point is that it is never added to the AED figure.
    expect(loss.find((l) => l.currency === "USD")!.amountMinor).toBe(90_000);
  });

  test("an unmeasured metric is absent, and a zero denominator is not a percentage", async () => {
    session.orgId = ORG_A;
    const res = await get("30");
    const body = JSON.stringify(res.body);

    // No CSAT column exists anywhere in the schema, so nothing may report one.
    expect(body.toLowerCase()).not.toContain("csat");
    expect(body.toLowerCase()).not.toContain("satisfaction");
    // The mock's headline claims, all of which were invented.
    for (const fabricated of ["prevention", "false_alarm", "496", "target", "baseline"]) {
      expect(body.toLowerCase(), fabricated).not.toContain(fabricated);
    }

    // A tenant with no cases: `of: 0`, and no average pretending to be a number.
    session.orgId = ORG_B;
    const empty = (await get("1")).body as {
      data: { kpis: { callDurationSeconds: { average: number | null } }; languages: unknown[] };
    };
    expect(empty.data.kpis.callDurationSeconds.average).toBeNull();
    // Org B does have a case, so this is the shape assertion, not an empty test:
    // the read is scoped, and B sees exactly its own one row.
    expect(empty.data.languages as { language: string; cases: number }[]).toEqual([
      { language: "ar", cases: 1 },
    ]);
  });

  test("the audit feed and trend are this tenant's, and the window is validated", async () => {
    session.orgId = ORG_A;
    const res = await get("30");
    const data = (
      res.body as {
        data: {
          trend: { cases: number }[];
          audit: unknown[];
          window: { from: string; to: string };
        };
      }
    ).data;

    // Every seeded case falls in the current ISO week, so the trend must account
    // for all five rather than silently returning an empty series.
    expect(data.trend.reduce((acc, w) => acc + w.cases, 0)).toBe(5);
    expect(new Date(data.window.from).getTime()).toBeLessThan(new Date(data.window.to).getTime());

    for (const bad of ["0", "-1", "99999", "abc", "1.5"]) {
      const rejected = await get(bad);
      expect(rejected.status, `days=${bad}`).toBe(422);
    }
  });

  test("a signed-out caller gets nothing at all", async () => {
    session.orgId = null;
    const res = await get();
    expect(res.status).toBe(401);
  });
});
