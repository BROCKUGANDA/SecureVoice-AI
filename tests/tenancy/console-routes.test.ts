/**
 * WP-12 GATE — cross-tenant isolation on the CONSOLE ROUTES themselves.
 *
 * Why this file exists: `src/lib/tenancy/isolation-matrix.ts` proves its
 * obligations by running the lookup EXPRESSIONS against fixtures. That proves
 * Prisma honours `{ orgId }` — it does not prove the route passes the right
 * org. A route that computed the correct predicate and then queried with the
 * wrong one would pass every existing check.
 *
 * So these tests drive the real handlers, with the session resolver mocked to two different
 * organisations, and assert each one cannot see or touch the other's data.
 *
 * The property under test throughout is **404, not 403**. A 403 confirms the
 * resource exists, which is itself a leak — the ID space is disclosed.
 *
 * Same mock discipline as tests/console/fire.test.ts: the mock must be
 * registered before any module that transitively imports it is evaluated, so
 * these handlers are imported dynamically inside each test.
 */
import { expect, test, mock } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import * as realCredits from "@/lib/credits";

const RUN = Date.now().toString(36);

// Postgres uuid segments are hex-only, but RUN is base36 and carries letters
// outside [a-f]. Hashing it keeps the per-run uniqueness these fixtures depend
// on while producing a value every uuid column accepts.
const RUN_HEX = createHash("sha256").update(RUN).digest("hex");

// Deterministic UUID-shaped ids. `UserProfile.userId`, `UserProfile.orgId` and
// `Organization.id` are `@db.Uuid` after the Clerk -> Better Auth cutover
// (better-auth.ts sets `advanced.database.generateId = "uuid"`), so a
// `clerk_a_…` string is rejected by Postgres before any assertion runs. The
// org ids are uuid-shaped too because `UserProfile.orgId` references the
// organization row; the other models here keep `orgId` as text, and a uuid is
// valid text.
const uuidFor = (tag: string): string =>
  `${tag
    .replace(/[^a-f0-9]/gi, "")
    .slice(0, 8)
    .padEnd(8, "0")
    .toLowerCase()}-0000-4000-8000-${RUN_HEX.slice(0, 12)}`;
const USER_A = uuidFor("aaaaaaaa");
const USER_B = uuidFor("bbbbbbbb");
const ORG_A = uuidFor("0a0a0a0a");
const ORG_B = uuidFor("0b0b0b0b");

/** Which org the mocked session currently reports. Flipped per test. */
const session = { orgId: ORG_A as string | null, userId: USER_A };

// Mocked at `getProfile`, not at the identity provider.
//
// `getProfile()` in src/lib/credits.ts is now the SINGLE seam every console
// route reads an identity through (it performs the authoritative
// `auth.api.getSession()` and mirrors into UserProfile). Mocking it means these
// tests exercise the real route logic and the real scoping, and it does not
// depend on Better Auth's internal API shape — which is exactly the coupling the
// previous session mock had.
mock.module("@/lib/credits", () => ({
  // The console routes import `requireOperator` / `requireSignedIn` from this
  // same module and those call `getProfile()` internally. Replacing the module
  // wholesale — rather than overriding one seam — drops the other exports and
  // every route then fails to link ("Export named 'requireOperator' not
  // found"). Spread the real module so only the seam under test is replaced.
  ...realCredits,
  getProfile: async () =>
    session.orgId
      ? {
          userId: session.userId,
          email: `${session.userId}@securevoice.ae`,
          name: "Cross Tenant",
          role: "operator" as const,
          orgId: session.orgId,
          credits: 500,
        }
      : null,
}));

function asOrgA(): void {
  session.orgId = ORG_A;
  session.userId = USER_A;
}
function asOrgB(): void {
  session.orgId = ORG_B;
  session.userId = USER_B;
}

let seeded: Promise<{ keyA: string; keyB: string; alertA: string; alertB: string }> | null = null;

/** Seeded once per run: the fixtures carry unique constraints. */
function seedBothOrgs() {
  seeded ??= createBothOrgs();
  return seeded;
}

async function createBothOrgs(): Promise<{
  keyA: string;
  keyB: string;
  alertA: string;
  alertB: string;
}> {
  const keyA = `sk_a_${RUN}`;
  const keyB = `sk_b_${RUN}`;
  // The tenant rows themselves. `UserProfile.orgId` references them, so the
  // profile fixtures below cannot be written until they exist.
  for (const [side, id] of [
    ["A", ORG_A],
    ["B", ORG_B],
  ] as const) {
    await db.organization.create({
      data: {
        id,
        name: `Console Route Org ${side}`,
        slug: `console-route-${side.toLowerCase()}-${RUN_HEX.slice(0, 12)}`,
        createdAt: new Date(),
      },
    });
  }
  // `UserProfile.userId` references the Better Auth `user` row, so the profile
  // fixtures below need their user to exist first.
  await db.user.create({
    data: {
      id: USER_A,
      email: `a-${RUN}@securevoice.ae`,
      name: "A",
      emailVerified: true,
    },
  });
  await db.user.create({
    data: {
      id: USER_B,
      email: `b-${RUN}@securevoice.ae`,
      name: "B",
      emailVerified: true,
    },
  });
  // ProducerKey requires a hash shape, not a usable secret — this is a list
  // fixture, never an authorisation.
  await db.producerKey.create({
    data: { label: "key-a", keyHash: `hash_a_${RUN}`, orgId: ORG_A },
  });
  await db.producerKey.create({
    data: { label: "key-b", keyHash: `hash_b_${RUN}`, orgId: ORG_B },
  });

  const alertA = await db.notification.create({
    data: {
      alertType: "escalation",
      title: "alert-a",
      body: "a",
      dedupeKey: `a-${RUN}`,
      orgId: ORG_A,
    },
  });
  const alertB = await db.notification.create({
    data: {
      alertType: "escalation",
      title: "alert-b",
      body: "b",
      dedupeKey: `b-${RUN}`,
      orgId: ORG_B,
    },
  });

  await db.userProfile.create({
    data: {
      userId: USER_A,
      email: "a@securevoice.ae",
      name: "A",
      role: "operator",
      orgId: ORG_A,
    },
  });
  await db.userProfile.create({
    data: {
      userId: USER_B,
      email: "b@securevoice.ae",
      name: "B",
      role: "operator",
      orgId: ORG_B,
    },
  });

  return { keyA, keyB, alertA: alertA.id, alertB: alertB.id };
}

test("producer-keys: org A lists only org A's machine keys", async () => {
  await seedBothOrgs();
  asOrgA();
  const { GET } = await import("@/app/api/console/producer-keys/route");

  const res = await GET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    keys: { id: string; label: string; orgId: string | null }[];
  };
  const labels = body.keys.map((k) => k.label);

  expect(labels).toContain("key-a");
  // The whole point: the other org's key is not merely unusable, it is absent.
  expect(labels).not.toContain("key-b");
  expect(body.keys.every((k) => k.orgId === ORG_A || k.orgId === null)).toBe(true);
}, 60_000);

test("producer-keys: org B sees the mirror image", async () => {
  await seedBothOrgs();
  asOrgB();
  const { GET } = await import("@/app/api/console/producer-keys/route");

  const body = (await (await GET()).json()) as { keys: { label: string }[] };
  const labels = body.keys.map((k) => k.label);
  expect(labels).toContain("key-b");
  expect(labels).not.toContain("key-a");
}, 60_000);

test("inbox: org A sees only org A's alerts", async () => {
  await seedBothOrgs();
  asOrgA();
  const { GET } = await import("@/app/api/console/inbox/route");

  const res = await GET();
  expect(res.status).toBe(200);
  const raw = await res.text();
  expect(raw).toContain("alert-a");
  expect(raw).not.toContain("alert-b");
}, 60_000);

test("inbox: acknowledging another org's alert is 404, never 403", async () => {
  const { alertB } = await seedBothOrgs();
  asOrgA();
  const { POST } = await import("@/app/api/console/inbox/route");

  const res = await POST(
    new Request("http://localhost/api/console/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "acknowledge", id: alertB }),
    }) as never,
  );

  // 403 would confirm the alert exists. The ID space must stay undisclosed.
  expect(res.status).toBe(404);
  const stillOpen = await db.notification.findUnique({
    where: { id: alertB },
    select: { acknowledgedAt: true },
  });
  expect(stillOpen?.acknowledgedAt ?? null).toBeNull();
}, 60_000);

test("settings: org A cannot read or write org B's profile by user id", async () => {
  await seedBothOrgs();
  asOrgA();
  const { GET, POST } = await import("@/app/api/console/settings/route");

  const own = await GET();
  expect(own.status).toBe(200);
  const body = (await own.json()) as Record<string, unknown>;
  // The settings surface is derived from the AUTHENTICATED identity, never
  // from a client-supplied id, so there is no id to point at the other org.
  expect(JSON.stringify(body)).not.toContain(USER_B);

  const write = await POST(
    new Request("http://localhost/api/console/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: USER_B, role: "owner" }),
    }) as never,
  );
  // A 200 is CORRECT here: the route updates the authenticated caller's own
  // profile and ignores the client-supplied id entirely. What must hold is that
  // the other org's row is untouched and nothing of theirs is echoed back.
  expect(await write.text()).not.toContain(USER_B);

  const victim = await db.userProfile.findUnique({
    where: { userId: USER_B },
    select: { role: true },
  });
  expect(victim?.role).toBe("operator");
}, 60_000);

test("audit: another org's caseRef answers 404, never 403", async () => {
  const caseRef = `SV-XT-${RUN}`;
  await db.case.create({ data: { caseRef, orgId: ORG_B, phone: "+97150000000", language: "en" } });

  asOrgA();
  const { GET } = await import("@/app/api/console/audit/route");

  const res = await GET(new NextRequest(`http://localhost/api/console/audit?callRef=${caseRef}`));
  expect(res.status).toBe(404);
}, 60_000);
