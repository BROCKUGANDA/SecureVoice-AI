/**
 * WP-12 GATE — cross-tenant isolation on the CONSOLE ROUTES themselves.
 *
 * Why this file exists: `src/lib/tenancy/isolation-matrix.ts` proves its
 * obligations by running the lookup EXPRESSIONS against fixtures. That proves
 * Prisma honours `{ orgId }` — it does not prove the route passes the right
 * org. A route that computed the correct predicate and then queried with the
 * wrong one would pass every existing check.
 *
 * So these tests drive the real handlers, with Clerk mocked to two different
 * organisations, and assert each one cannot see or touch the other's data.
 *
 * The property under test throughout is **404, not 403**. A 403 confirms the
 * resource exists, which is itself a leak — the ID space is disclosed.
 *
 * Same Clerk-mock discipline as tests/console/fire.test.ts: the mock must be
 * registered before any module that transitively imports it is evaluated, so
 * these handlers are imported dynamically inside each test.
 */
import { expect, test, mock } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

const RUN = Date.now().toString(36);
const ORG_A = `org-a-${RUN}`;
const ORG_B = `org-b-${RUN}`;
const USER_A = `clerk_a_${RUN}`;
const USER_B = `clerk_b_${RUN}`;

/** Which org the mocked Clerk session currently reports. Flipped per test. */
const session = { orgId: ORG_A as string | null, userId: USER_A };

mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({
    userId: session.userId,
    sessionClaims: session.orgId ? { o: { id: session.orgId } } : {},
  }),
  currentUser: async () => ({
    id: session.userId,
    primaryEmailAddress: { emailAddress: `${session.userId}@securevoice.ae` },
    emailAddresses: [{ emailAddress: `${session.userId}@securevoice.ae` }],
    firstName: "Cross",
    lastName: "Tenant",
    publicMetadata: { role: "operator" },
  }),
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

async function createBothOrgs(): Promise<{ keyA: string; keyB: string; alertA: string; alertB: string }> {
  const keyA = `sk_a_${RUN}`;
  const keyB = `sk_b_${RUN}`;
  // ProducerKey requires a hash shape, not a usable secret — this is a list
  // fixture, never an authorisation.
  await db.producerKey.create({
    data: { label: "key-a", keyHash: `hash_a_${RUN}`, orgId: ORG_A },
  });
  await db.producerKey.create({
    data: { label: "key-b", keyHash: `hash_b_${RUN}`, orgId: ORG_B },
  });

  const alertA = await db.notification.create({
    data: { alertType: "escalation", title: "alert-a", body: "a", dedupeKey: `a-${RUN}`, orgId: ORG_A },
  });
  const alertB = await db.notification.create({
    data: { alertType: "escalation", title: "alert-b", body: "b", dedupeKey: `b-${RUN}`, orgId: ORG_B },
  });

  await db.userProfile.create({
    data: { clerkUserId: USER_A, email: "a@securevoice.ae", name: "A", role: "operator", orgId: ORG_A },
  });
  await db.userProfile.create({
    data: { clerkUserId: USER_B, email: "b@securevoice.ae", name: "B", role: "operator", orgId: ORG_B },
  });

  return { keyA, keyB, alertA: alertA.id, alertB: alertB.id };
}

test("producer-keys: org A lists only org A's machine keys", async () => {
  await seedBothOrgs();
  asOrgA();
  const { GET } = await import("@/app/api/console/producer-keys/route");

  const res = await GET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { keys: { id: string; label: string; orgId: string | null }[] };
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
  const stillOpen = await db.notification.findUnique({ where: { id: alertB }, select: { acknowledgedAt: true } });
  expect(stillOpen?.acknowledgedAt ?? null).toBeNull();
}, 60_000);

test("settings: org A cannot read or write org B's profile by clerk user id", async () => {
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
      body: JSON.stringify({ clerkUserId: USER_B, role: "owner" }),
    }) as never,
  );
  // A 200 is CORRECT here: the route updates the authenticated caller's own
  // profile and ignores the client-supplied id entirely. What must hold is that
  // the other org's row is untouched and nothing of theirs is echoed back.
  expect(await write.text()).not.toContain(USER_B);

  const victim = await db.userProfile.findUnique({ where: { clerkUserId: USER_B }, select: { role: true } });
  expect(victim?.role).toBe("operator");
}, 60_000);

test("audit: another org's caseRef answers 404, never 403", async () => {
  const caseRef = `SV-XT-${RUN}`;
  await db.case.create({ data: { caseRef, orgId: ORG_B, phone: "+97150000000", language: "en" } });

  asOrgA();
  const { GET } = await import("@/app/api/console/audit/route");

  const res = await GET(
    new NextRequest(`http://localhost/api/console/audit?callRef=${caseRef}`),
  );
  expect(res.status).toBe(404);
}, 60_000);
