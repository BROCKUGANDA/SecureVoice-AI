/**
 * The tenant brand colour, driven through the real `POST /api/console/settings`
 * handler against the database.
 *
 * `tests/unit/brand-color.test.ts` proves the gate's arithmetic. It cannot prove
 * the things this file is about, because all three of them only exist between the
 * gate and the screen:
 *
 *   1. the route CALLS the gate — a handler that validated with its own regex
 *      would pass every unit test and accept a colour nothing else accepts;
 *   2. the database CONSTRAINT agrees with the gate — if the CHECK were narrower
 *      than `evaluateBrandPrimary`, a colour the application deliberately
 *      supports (`#ffffff`, corrected per scheme) would pass the route and then
 *      fail the INSERT as a 500 instead of a clean 422;
 *   3. it is TENANT SCOPED — org B's colour must not reach org A, in either
 *      direction. Branding is the first thing a bank's own staff see, so a
 *      tenant seeing another institution's identity on their console is a
 *      disclosure, not a cosmetic bug.
 *
 * Same mock discipline as tests/tenancy/console-routes.test.ts: the session
 * resolver is mocked before anything that imports it is evaluated, and the
 * handlers are imported dynamically inside each test.
 */
import { afterAll, beforeAll, expect, test, mock } from "bun:test";
import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import { evaluateBrandPrimary } from "@/lib/brand/color";

const RUN = Date.now().toString(36);
const RUN_HEX = createHash("sha256").update(RUN).digest("hex");
const uuidFor = (tag: string): string =>
  `${tag
    .replace(/[^a-f0-9]/gi, "")
    .slice(0, 8)
    .padEnd(8, "0")
    .toLowerCase()}-0000-4000-8000-${RUN_HEX.slice(0, 12)}`;

const ORG_A = uuidFor("branda");
const ORG_B = uuidFor("brandb");
const USER_A = uuidFor("useraa");
const USER_B = uuidFor("userbb");

let currentOrg: string | null = null;
let currentUser: string | null = null;

mock.module("@/lib/credits", () => ({
  requireOperator: async () => {
    if (!currentOrg || !currentUser) return { ok: false, status: 401, error: "no session" };
    return {
      ok: true,
      profile: {
        orgId: currentOrg,
        userId: currentUser,
        credits: 0,
        walletScope: "organization",
      },
    };
  },
  // Other exports the settings route's import graph reaches for. They are not
  // exercised here, and a missing one fails the dynamic import with a link error
  // rather than a test failure.
  requireSignedIn: async () => ({ ok: false, status: 401, error: "unused" }),
  getProfile: async () => null,
  netUsageUnits: async () => 0,
}));

const asOrgA = () => {
  currentOrg = ORG_A;
  currentUser = USER_A;
};
const asOrgB = () => {
  currentOrg = ORG_B;
  currentUser = USER_B;
};

beforeAll(async () => {
  for (const [orgId, userId, name] of [
    [ORG_A, USER_A, "Brand A"],
    [ORG_B, USER_B, "Brand B"],
  ] as const) {
    await db.organization.create({
      data: {
        id: orgId,
        name,
        slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${RUN}`,
        createdAt: new Date(),
      },
    });
    // `UserProfile.userId` references the Better Auth `user` row, so the user
    // has to exist first — the same ordering every other console fixture uses.
    await db.user.create({
      data: {
        id: userId,
        email: `${name.toLowerCase()}-${RUN}@securevoice.ae`,
        name,
        emailVerified: true,
      },
    });
    await db.userProfile.create({
      data: {
        userId,
        email: `${name.toLowerCase()}-${RUN}@securevoice.ae`,
        name,
        orgId,
        role: "operator",
      },
    });
  }
});

afterAll(async () => {
  await db.userProfile.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
  await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
});

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/console/settings/route");
  return POST(
    new Request("http://localhost/api/console/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
};

const readBrand = async (orgId: string) => {
  const row = await db.organization.findUnique({
    where: { id: orgId },
    select: { brandPrimary: true },
  });
  return row?.brandPrimary ?? null;
};

// ── the route calls the gate ─────────────────────────────────────────────────

test("a valid colour is stored NORMALISED, not as submitted", async () => {
  asOrgA();
  const res = await post({ brandPrimary: "  #ABC  " });
  expect(res.status).toBe(200);
  // Shorthand is expanded on the way in, so the column always holds the same
  // shape and a reader never has to guess whether `#abc` or `#aabbcc` is there.
  expect(await readBrand(ORG_A)).toBe("#aabbcc");
}, 60_000);

test("a non-hex is refused with 422 and the reason, and nothing is written", async () => {
  asOrgA();
  const before = await readBrand(ORG_A);
  const res = await post({ brandPrimary: "chartreuse" });
  expect(res.status).toBe(422);
  const body = (await res.json()) as { reason?: string; error?: string };
  expect(body.reason).toBe("invalid");
  expect(body.error).toContain("#0b7a55");
  expect(await readBrand(ORG_A)).toBe(before);
}, 60_000);

test("a CSS injection attempt is refused, not sanitised into something applied", async () => {
  asOrgA();
  const before = await readBrand(ORG_A);
  const res = await post({ brandPrimary: "#000;}body{display:none" });
  expect(res.status).toBe(422);
  expect(await readBrand(ORG_A)).toBe(before);
}, 60_000);

// ── the route and the CHECK agree ───────────────────────────────────────────

test("a colour the gate CORRECTS is accepted end to end, not rejected by the CHECK", async () => {
  // `#ffffff` passes the text gate (dark text on white) and is corrected downward
  // for the light card. This is the exact value that produced a 500 when the
  // migration's CHECK excluded it, so it is asserted rather than assumed.
  asOrgA();
  const verdict = evaluateBrandPrimary("#ffffff");
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) return;
  expect(verdict.lightPrimary).not.toBe("#ffffff");

  const res = await post({ brandPrimary: "#ffffff" });
  expect(res.status).toBe(200);
  // Stored is the tenant's CHOICE, not the correction — the settings form and the
  // console must not disagree about what "the brand" is.
  expect(await readBrand(ORG_A)).toBe("#ffffff");
}, 60_000);

test("the database rejects a colour the route would never send", async () => {
  // The CHECK is the backstop for writers this route does not cover. Bypassing
  // the route with a raw client must fail at the database, not succeed quietly.
  //
  // Written as try/catch rather than `expect().rejects` because Prisma returns a
  // lazy PrismaPromise, and an assertion helper that does not await it reports
  // "received: PrismaPromise" instead of the constraint violation — a test that
  // passes for the wrong reason.
  const attempt = async (brandPrimary: string) => {
    try {
      await db.organization.update({ where: { id: ORG_A }, data: { brandPrimary } });
      return null;
    } catch (err) {
      return err as { code?: string; message?: string };
    }
  };

  // Asserted on the CONSTRAINT NAME rather than a Prisma error code: the codes
  // for a CHECK violation differ between driver and Prisma version (P2004 vs
  // P2039 here), but the constraint that fired is the thing under test.
  const fired = async (brandPrimary: string) => {
    const err = await attempt(brandPrimary);
    return err?.message?.includes("organization_brand_primary_chk") ?? false;
  };

  // Not normalised — the route always expands shorthand before writing.
  expect(await fired("#ABC")).toBe(true);
  // Wrong length.
  expect(await fired("#12345")).toBe(true);
  // Not a hex at all.
  expect(await fired("chartreuse")).toBe(true);
  // A CSS injection attempt cannot reach the column even from a raw writer.
  expect(await fired("#000;}body{display:none")).toBe(true);

  // A value the route WOULD send is accepted, so the constraint is not simply
  // rejecting everything — that would pass the four assertions above.
  expect(await attempt("#0b7a55")).toBeNull();
  expect(await readBrand(ORG_A)).toBe("#0b7a55");
}, 60_000);

// ── clearing ─────────────────────────────────────────────────────────────────

test("an empty string clears the colour back to the platform default", async () => {
  asOrgA();
  await post({ brandPrimary: "#123456" });
  expect(await readBrand(ORG_A)).toBe("#123456");

  const res = await post({ brandPrimary: "" });
  expect(res.status).toBe(200);
  expect(await readBrand(ORG_A)).toBeNull();
}, 60_000);

// ── tenancy ──────────────────────────────────────────────────────────────────

test("org B cannot see or overwrite org A's brand", async () => {
  asOrgA();
  await post({ brandPrimary: "#0b3d91" });

  asOrgB();
  const { GET } = await import("@/app/api/console/settings/route");
  const read = (await (await GET()).json()) as Record<string, unknown>;
  expect(read.brandPrimary ?? null).toBeNull();

  // B setting its own colour must leave A's alone.
  await post({ brandPrimary: "#8a1538" });
  expect(await readBrand(ORG_B)).toBe("#8a1538");
  expect(await readBrand(ORG_A)).toBe("#0b3d91");
}, 60_000);

test("a session with no organisation is refused rather than writing a stray colour", async () => {
  // No tenant means there is no row to brand. Accepting it would mean the value
  // is silently dropped and the operator is told it saved.
  currentOrg = null;
  currentUser = null;
  const res = await post({ brandPrimary: "#123456" });
  expect(res.status).toBe(401);
}, 60_000);
