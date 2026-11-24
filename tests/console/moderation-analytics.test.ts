/**
 * GATE — the moderation console's decision-quality analytics.
 *
 * What is asserted here, and why each can actually FAIL:
 *
 *   1. `GET /api/console/moderation` returns an `analytics` object with
 *      verdict/stage/source breakdowns, an honest rates object, and metered
 *      usage totals for the CALLER'S org.
 *   2. Rates are computed from the tenant's own rows only — another org's
 *      decisions must not move this org's refusal/degraded shares
 *      (tenancy: the predicate is the guard's, not a parameter).
 *   3. Empty orgs get `rates: null`, never a flattering 0% — health that has
 *      not been earned must not be published as health.
 *   4. Metered usage reflects the wall-clock budget pieces: `meteredUnits`
 *      sums wallet-neutral `moderation` ledger rows for the org, and the
 *      evidence-row volume (`callsLast7Days`) is windowed.
 *
 * The session is MOCKED at module scope (same discipline as
 * tests/console/fire.test.ts): `mock.module("@/lib/credits")` must be
 * registered before the route is imported, so the route is pulled in with
 * `await import()`.
 *
 *   bun scripts/run-tests.mjs moderation-analytics
 */
import { afterAll, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import * as realCredits from "@/lib/credits";
import { recordModerationUsage } from "@/lib/billing/ledger";

const RUN = Date.now().toString(36);
// uuid columns require uuid-shape org ids (hazard AU-3); distinct per org,
// because a shared prefix would make the two tenants the SAME tenant.
const orgUuid = (seed: string) => {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const ORG = orgUuid(`${RUN}-org`);
const FOREIGN_ORG = orgUuid(`${RUN}-foreign`);
const EMPTY_ORG = orgUuid(`${RUN}-empty`);
const USER_ID = orgUuid(`${RUN}-user`);

const session = { orgId: ORG as string | null };

mock.module("@/lib/credits", () => ({
  ...realCredits,
  getProfile: async () =>
    session.orgId
      ? {
          userId: USER_ID,
          email: "moderation-analytics@securevoice.ae",
          name: "Analytics Gate",
          role: "operator" as const,
          orgId: session.orgId,
          credits: 500,
        }
      : null,
}));

const hashHex = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function seedRow(input: {
  orgId: string;
  stage: string;
  verdict: string;
  source: string;
  daysAgo?: number;
}) {
  const createdAt = new Date(Date.now() - (input.daysAgo ?? 0) * 86_400_000);
  return db.moderationRequest.create({
    data: {
      orgId: input.orgId,
      stage: input.stage,
      verdict: input.verdict,
      categories: input.verdict === "safe" ? ["None"] : ["Spam: Indirect"],
      model: "test-model",
      templateVersion: "test",
      source: input.source,
      refused: input.verdict !== "safe",
      inputHash: hashHex(`${RUN}:${Math.random()}`),
      latencyMs: 120,
      createdAt,
    },
  });
}

async function analytics() {
  const { GET } = await import("@/app/api/console/moderation/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as {
    analytics: {
      windowDays: number;
      totalCalls: number;
      callsLast7Days: number;
      byStage: { stage: string; verdict: string; _count: { _all: number } }[];
      bySource: { source: string; _count: { _all: number } }[];
      rates: { refusalRate: number; degradedShare: number; safeShare: number } | null;
      meteredUnits: number;
      meteredCalls: number;
    };
  };
}

afterAll(async () => {
  await db.moderationRequest.deleteMany({ where: { orgId: { in: [ORG, FOREIGN_ORG] } } });
  await db.usageLedger.deleteMany({ where: { orgId: { in: [ORG, FOREIGN_ORG] } } });
  await db.$disconnect();
});

test("analytics computes verdict/stage/source rates and metered usage from the caller's own rows", async () => {
  // 4 calls: 2 safe/1 input, 1 unsafe/input (refusal), 1 safe/output — plus a
  // degraded-source row to exercise degradedShare. One call 10 days old must
  // be OUTSIDE the 7-day window.
  await seedRow({ orgId: ORG, stage: "input", verdict: "safe", source: "model", daysAgo: 1 });
  await seedRow({ orgId: ORG, stage: "input", verdict: "safe", source: "model", daysAgo: 3 });
  await seedRow({ orgId: ORG, stage: "input", verdict: "unsafe", source: "model", daysAgo: 2 });
  await seedRow({ orgId: ORG, stage: "output", verdict: "safe", source: "degraded", daysAgo: 1 });
  await seedRow({ orgId: ORG, stage: "input", verdict: "safe", source: "model", daysAgo: 10 });

  await recordModerationUsage({
    orgId: ORG,
    traceId: `analytics-meter-${RUN}`,
    stage: "input",
    verdict: "safe",
    units: 33,
  });

  // Foreign tenant noise: must not move my rates.
  await seedRow({
    orgId: FOREIGN_ORG,
    stage: "input",
    verdict: "unsafe",
    source: "model",
    daysAgo: 1,
  });
  await seedRow({
    orgId: FOREIGN_ORG,
    stage: "input",
    verdict: "unsafe",
    source: "model",
    daysAgo: 1,
  });
  await recordModerationUsage({
    orgId: FOREIGN_ORG,
    traceId: `analytics-meter-foreign-${RUN}`,
    stage: "input",
    verdict: "unsafe",
    units: 9999,
  });

  const { analytics: a } = await analytics();

  expect(a.totalCalls).toBe(5);
  expect(a.callsLast7Days).toBe(4);
  expect(a.windowDays).toBe(7);

  // Rates over my 5 rows: refusal = unsafe (1) / 5; degraded = 1 / 5; safe = 4 / 5.
  expect(a.rates).not.toBeNull();
  expect(a.rates!.refusalRate).toBeCloseTo(0.2, 6);
  expect(a.rates!.degradedShare).toBeCloseTo(0.2, 6);
  expect(a.rates!.safeShare).toBeCloseTo(0.8, 6);

  // By-stage mix is present and org-scoped (foreign unsafe rows absent).
  const inputUnsafe = a.byStage.find((r) => r.stage === "input" && r.verdict === "unsafe");
  expect(inputUnsafe?._count._all).toBe(1);

  // Metered usage is mine only.
  expect(a.meteredUnits).toBe(33);
  expect(a.meteredCalls).toBe(1);
});

test("an org with no decisions gets rates: null, never a flattering 0%", async () => {
  session.orgId = EMPTY_ORG; // fresh org, nothing seeded
  try {
    const { analytics: a } = await analytics();
    expect(a.totalCalls).toBe(0);
    expect(a.rates).toBeNull();
    expect(a.meteredUnits).toBe(0);
    expect(a.meteredCalls).toBe(0);
  } finally {
    session.orgId = ORG;
  }
});
