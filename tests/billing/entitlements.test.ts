/**
 * Plan entitlements: what a tier bought, enforced — and refused before the write.
 *
 * The pricing cards advertise BYOK and per-institution policy at Growth and not at
 * Starter. Until `src/lib/billing/entitlements.ts` nothing in the code knew that:
 * every surface guarded with a ROLE check, so a Starter tenant's Owner could do
 * everything an Enterprise tenant's Owner could, and the only difference between the
 * two was the number on the invoice. A card that omits a feature is a statement about
 * what the cheaper tier does NOT include; leaving it unenforced makes the card false
 * in one direction or the other.
 *
 * Two halves are asserted deliberately: the resolver's table, and the refusal
 * reaching the real route with NOTHING written. The second is the one that matters —
 * a 402 emitted after the row is saved is not a refusal, it is a lie about one.
 *
 *   bun test tests/billing/entitlements.test.ts
 */
import { afterAll, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import {
  checkEntitlement,
  entitlementFacts,
  entitlementPlan,
  planEntitles,
} from "@/lib/billing/entitlements";
import type { OrgPlanContext } from "@/lib/billing/plan-context";

/**
 * A context with only the two fields the resolver reads. The rest are display
 * arithmetic (allowance, seats, period) that entitlements never consult, and
 * fabricating them here would let a test pass while reading a field nobody sets.
 */
const ctx = (plan: string | null, tier: string): OrgPlanContext =>
  ({ plan, tier }) as OrgPlanContext;

const RUN = `ent${Date.now().toString(36)}`;

/** organization.id and userProfile.userId are `@db.Uuid`, so a readable tag is
 *  hashed into a stable uuid rather than pasted in as a string the column rejects. */
const HEX = createHash("sha256").update(RUN).digest("hex");
const uuidFor = (tag: string): string =>
  `${createHash("sha256").update(tag).digest("hex").slice(0, 8)}-0000-4000-8000-${HEX.slice(0, 12)}`;
const created: string[] = [];

/**
 * The organisation the mocked guard reports for the session. A `let`, because the
 * route under test must be pointed at the exact tenant whose plan the test just
 * configured — asserting a refusal against some other org's tier would pass for the
 * wrong reason.
 */
let sessionOrgId = `${RUN}-base`;

// The guard is mocked so the route can be exercised without minting a session.
// `mock.module` replaces the module WHOLE, so every export the route's graph reaches
// has to be named here or the import fails at load — which is how a "403 message is
// wrong" failure ends up describing a code path that never ran.
mock.module("@/lib/credits", () => ({
  requireOperator: async () => ({
    ok: true,
    profile: {
      userId: uuidFor("user"),
      email: `probe-${RUN}@securevoice.test`,
      name: "Probe Owner",
      role: "operator",
      orgId: sessionOrgId,
      credits: 500,
      walletScope: "org",
    },
  }),
  requireSignedIn: async () => ({ ok: true, profile: { orgId: sessionOrgId } }),
  getProfile: async () => null,
  roleFromMembership: () => "operator",
}));

// The settings route also re-authenticates ATTACHING a vendor credential
// (`change_byok_credential`), before it consults the plan — so that answering
// "your plan does not include this" cannot leak the tier to whoever holds the
// cookie. Without this stub the BYOK tests below measured 401 from a guard that
// never ran against a real session, rather than the 402 entitlement refusal they
// exist to assert. Step-up itself is exercised for real in
// tests/auth/step-up.test.ts; here it is satisfied, so the entitlement gate is
// the thing under test.
mock.module("@/lib/auth/guards", () => ({
  requirePrivileged: async () => ({ ok: true, orgId: sessionOrgId }),
  requireStepUp: async () => ({ ok: true, orgId: sessionOrgId }),
}));

async function orgWithTier(planTier: string): Promise<string> {
  const id = uuidFor(planTier);
  await db.organization.upsert({
    where: { id },
    // `createdAt` has no database default on this table, so Prisma requires it on
    // create even though every real tenant row arrives through the invite flow.
    create: { id, name: `Entitlement ${planTier}`, slug: id, planTier, createdAt: new Date() },
    update: { planTier },
  });
  created.push(id);
  return id;
}

afterAll(async () => {
  await db.userProfile.deleteMany({ where: { userId: uuidFor("user") } });
  for (const id of created) await db.organization.deleteMany({ where: { id } });
});

// ── 1. The table ─────────────────────────────────────────────────────────────

test("BYOK and institution policy unlock at Growth and are refused at Starter", async () => {
  expect(planEntitles("starter", "byok")).toBe(false);
  expect(planEntitles("starter", "signedWebhooks")).toBe(false);
  expect(planEntitles("growth", "byok")).toBe(true);
  expect(planEntitles("enterprise", "signedWebhooks")).toBe(true);
  // No plan at all — the demo workspace — is not the cheapest SELLING plan.
  expect(planEntitles(null, "byok")).toBe(false);

  const refused = await checkEntitlement(await orgWithTier("demo"), "byok");
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("unreachable");
  expect(refused.status).toBe(402);
  expect(refused.error).toContain("Growth");
  // Names the feature, so an operator knows which field they just lost rather than
  // being told "your plan does not allow this" about an unspecified thing.
  expect(refused.error.toLowerCase()).toContain("elevenlabs");

  // `standard` is the console's paid middle tier and 147 live tenants are decided by
  // this column alone — no Paddle subscription has ever been mirrored for them. A
  // resolver that read only the price id would refuse every one of them.
  expect((await checkEntitlement(await orgWithTier("standard"), "byok")).ok).toBe(true);
  expect((await checkEntitlement(await orgWithTier("enterprise"), "byok")).ok).toBe(true);
});

test("a mirrored subscription's price id outranks the console column", async () => {
  // The two signals are allowed to disagree only in one direction, and the test
  // names the direction: `entitlementPlan` takes the catalog plan when one exists.
  expect(entitlementPlan(ctx("starter", "enterprise"))).toBe("starter");
  expect(entitlementPlan(ctx(null, "enterprise"))).toBe("enterprise");
  expect(entitlementPlan(ctx(null, "standard"))).toBe("growth");
  expect(entitlementPlan(ctx(null, "demo"))).toBeNull();
});

test("an org-less session is refused rather than defaulted open", async () => {
  // The resolver would otherwise hand back the demo tier and grant a feature nobody
  // bought. No plan means no paid feature.
  const refusal = await checkEntitlement(null, "signedWebhooks");
  expect(refusal.ok).toBe(false);
  if (refusal.ok) throw new Error("unreachable");
  expect(refusal.status).toBe(402);
  expect(refusal.error).toContain("no plan");
});

test("the facts surface lists exactly the tiered features, and no guardrail", () => {
  // The vocabulary IS the review: a compliance control appearing here would mean a
  // guardrail that switches off under a pricing plan.
  expect(Object.keys(entitlementFacts(ctx("starter", "demo"))).sort()).toEqual([
    "byok",
    "signedWebhooks",
  ]);
  expect(entitlementFacts(ctx("starter", "demo"))).toEqual({
    byok: false,
    signedWebhooks: false,
  });
  expect(entitlementFacts(ctx("enterprise", "enterprise"))).toEqual({
    byok: true,
    signedWebhooks: true,
  });
});

// ── 2. The refusal reaches the route, and writes nothing ─────────────────────

test("clearing a webhook URL is never a paid feature — downgrading must not strand data", async () => {
  const { POST } = await import("@/app/api/console/settings/route");
  sessionOrgId = await orgWithTier("demo"); // no plan: the least entitled tenant there is

  const response = await POST(
    new NextRequest("http://t/api/console/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // An EMPTY url is the tenant giving the callback up. Gating this would mean a
      // Starter tenant could never stop customer data being posted at an endpoint it
      // no longer controls — a billing control becoming the reason for a leak.
      body: JSON.stringify({ vendorWebhookUrl: "" }),
    }) as unknown as Parameters<typeof POST>[0],
  );

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  expect(body.code).not.toBe("plan_entitlement_required");
  expect(response.status).not.toBe(402);
});

test("naming the institution is never a paid feature either", async () => {
  const { POST } = await import("@/app/api/console/settings/route");
  sessionOrgId = await orgWithTier("demo");

  const response = await POST(
    new NextRequest("http://t/api/console/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // "insurer" changes how the agent addresses a customer mid-fraud-call. A
      // Starter insurer must not be talked to with banking language because of a
      // pricing line.
      body: JSON.stringify({ institutionType: "insurer" }),
    }) as unknown as Parameters<typeof POST>[0],
  );

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  expect(body.code).not.toBe("plan_entitlement_required");
});

test("setting a webhook URL on no-plan tenant IS refused", async () => {
  const { POST } = await import("@/app/api/console/settings/route");
  sessionOrgId = await orgWithTier("demo");

  const response = await POST(
    new NextRequest("http://t/api/console/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vendorWebhookUrl: "https://bank.example/hooks/securevoice" }),
    }) as unknown as Parameters<typeof POST>[0],
  );

  expect(response.status).toBe(402);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.entitlement).toBe("signedWebhooks");
});

test("POST /api/console/settings refuses a Starter BYOK key and saves nothing", async () => {
  const { POST } = await import("@/app/api/console/settings/route");
  // The column speaks the console vocabulary; there is no mirrored subscription here.
  sessionOrgId = await orgWithTier("demo");

  const response = await POST(
    new NextRequest("http://t/api/console/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ elevenKey: "sk_probe_elvenlabs_key_0123456789ab" }),
    }) as unknown as Parameters<typeof POST>[0],
  );

  expect(response.status).toBe(402);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.code).toBe("plan_entitlement_required");
  expect(body.entitlement).toBe("byok");
  expect(body.upgradeTo).toBe("growth");
  expect(typeof body.error).toBe("string");

  // The half that makes it a refusal: nothing was encrypted and nothing was stored.
  const row = await db.userProfile.findUnique({
    where: { userId: uuidFor("user") },
    select: { elevenKeyEnc: true },
  });
  expect(row?.elevenKeyEnc ?? null).toBeNull();
});

test("the same request on a paid standard tenant is not refused on plan grounds", async () => {
  const { POST } = await import("@/app/api/console/settings/route");
  sessionOrgId = await orgWithTier("standard");

  let status = 0;
  let body: Record<string, unknown> = {};
  let thrown: unknown = null;
  try {
    const response = await POST(
      new NextRequest("http://t/api/console/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ elevenKey: "sk_probe_elvenlabs_key_0123456789ab" }),
      }) as unknown as Parameters<typeof POST>[0],
    );
    status = response.status;
    body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (err) {
    thrown = err;
  }

  // The gate is what is under test, and it passed: the request reached the handler's
  // NEXT step. Here that step is `encryptSecret`, which throws because this
  // environment has no AUTH_SECRET — a genuine outcome, and the proof the 402 did
  // not fire. Asserting "not the entitlement refusal" rather than "200" keeps this
  // honest about which of the two it actually measured.
  expect(body.code).not.toBe("plan_entitlement_required");
  expect(status).not.toBe(402);
  if (thrown) {
    expect(String(thrown)).toContain("AUTH_SECRET");
  }
});
