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
import { afterAll, expect, test, mock } from "bun:test";
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

// ── The two routes converted onto the database-enforced path ─────────────────
//
// `GET /api/console/audit` and the `UserProfile` half of
// `POST|DELETE /api/console/settings` now run their tenant statements inside
// `withTenantScope(orgId, …)` (src/lib/tenancy/db-scope.ts), so the row policy on
// `AuditLog` / `UserProfile` decides what the query can reach. The probes below
// drive the REAL handlers with one tenant's session against another tenant's
// rows.
//
// They are not redundant with the existing predicate-based tests:
//
//   · the audit list read is the query a forgotten predicate would produce, in the
//     sense that its result is decided by the DATABASE rather than by the shape of
//     the `where`;
//   · the settings read has NO org predicate to test at all — it is keyed on
//     `userId`, the caller's own identity — so the misfit fixture below is the
//     only way to observe which row the statement is actually allowed to touch.
//     Reverting that route to a bare `db.` makes the misfit test green-to-red:
//     the handler starts returning the other tenant's white-label name.

const AUDIT_REF = {
  A: `SV-F-CONV${RUN}A`,
  B: `SV-F-CONV${RUN}B`,
  N: `SV-F-CONV${RUN}N`,
} as const;

/** A user whose session names org A while their profile row belongs to org B. */
const MISFIT = uuidFor("dddddddd");
const MISFIT_ORG_NAME = `Org B white-label ${RUN}`;

const CONV_CHAINS = { in: [`ch-${AUDIT_REF.A}`, `ch-${AUDIT_REF.B}`, `ch-${AUDIT_REF.N}`] };

let convFixtures: Promise<unknown> | null = null;

function seedConversionFixtures() {
  convFixtures ??= (async () => {
    await seedBothOrgs();
    for (const [callRef, orgId] of [
      [AUDIT_REF.A, ORG_A],
      [AUDIT_REF.B, ORG_B],
      [AUDIT_REF.N, null],
    ] as const) {
      await db.auditLog.create({
        data: {
          callRef,
          action: "freeze",
          chainHash: `ch-${callRef}`,
          orgId,
          meta: JSON.stringify({ riskScore: 91, channel: "voice" }),
        },
      });
    }
    await db.user.create({
      data: {
        id: MISFIT,
        email: `misfit-${RUN}@securevoice.ae`,
        name: "Misfit",
        emailVerified: true,
      },
    });
    await db.userProfile.create({
      data: {
        userId: MISFIT,
        email: `misfit-${RUN}@securevoice.ae`,
        name: "Misfit",
        role: "operator",
        orgId: ORG_B,
        orgName: MISFIT_ORG_NAME,
      },
    });
  })();
  return convFixtures;
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { chainHash: CONV_CHAINS } });
  await db.userProfile.deleteMany({ where: { userId: MISFIT } });
  await db.user.deleteMany({ where: { id: MISFIT } });
}, 60_000);

test("audit: org A's case list holds its own freeze rows and nobody else's", async () => {
  await seedConversionFixtures();
  asOrgA();
  const { GET } = await import("@/app/api/console/audit/route");

  const body = (await (
    await GET(new NextRequest("http://localhost/api/console/audit"))
  ).json()) as { cases: { callRef: string }[] };
  const refs = body.cases.map((c) => c.callRef);

  expect(refs).toContain(AUDIT_REF.A);
  expect(refs).not.toContain(AUDIT_REF.B);
  // A row with no owner is not fair game for an authenticated tenant either.
  expect(refs).not.toContain(AUDIT_REF.N);

  // Control: all three rows exist and the application role sees them, so the
  // absences above are enforcement rather than missing fixtures.
  expect(
    await db.auditLog.count({
      where: { callRef: { in: [AUDIT_REF.A, AUDIT_REF.B, AUDIT_REF.N] } },
    }),
  ).toBe(3);
}, 60_000);

test("audit: org B sees the mirror image", async () => {
  await seedConversionFixtures();
  asOrgB();
  const { GET } = await import("@/app/api/console/audit/route");

  const refs = (
    (
      (await (await GET(new NextRequest("http://localhost/api/console/audit"))).json()) as {
        cases: { callRef: string }[];
      }
    ).cases ?? []
  ).map((c) => c.callRef);

  expect(refs).toContain(AUDIT_REF.B);
  expect(refs).not.toContain(AUDIT_REF.A);
}, 60_000);

test("audit: another tenant's chain walk is 404 — and the row it looked for is real", async () => {
  await seedConversionFixtures();
  asOrgA();
  const { GET } = await import("@/app/api/console/audit/route");

  const foreign = await GET(
    new NextRequest(`http://localhost/api/console/audit?callRef=${AUDIT_REF.B}`),
  );
  expect(foreign.status).toBe(404);
  // A 404 for a row that does not exist would prove nothing; this one exists and
  // belongs to org B.
  expect(
    (await db.auditLog.findFirst({ where: { callRef: AUDIT_REF.B }, select: { orgId: true } }))
      ?.orgId,
  ).toBe(ORG_B);

  const unowned = await GET(
    new NextRequest(`http://localhost/api/console/audit?callRef=${AUDIT_REF.N}`),
  );
  expect(unowned.status).toBe(404);

  // The caller's own chain still walks.
  const own = await GET(
    new NextRequest(`http://localhost/api/console/audit?callRef=${AUDIT_REF.A}`),
  );
  expect(own.status).toBe(200);
  const rows = ((await own.json()) as { rows: { callRef?: string }[] }).rows;
  expect(rows.length).toBeGreaterThan(0);
}, 60_000);

test("settings: a profile row naming another tenant is not readable by this session", async () => {
  await seedConversionFixtures();
  // The session claims org A; the row it would resolve by userId belongs to org B.
  session.orgId = ORG_A;
  session.userId = MISFIT;
  const { GET } = await import("@/app/api/console/settings/route");

  const res = await GET();
  expect(res.status).toBe(404);
  const body = await res.text();
  expect(body).not.toContain(MISFIT_ORG_NAME);

  // The same statement through the plain client DOES find the row: the refusal
  // came from the policy, not from the `where` clause.
  const raw = await db.userProfile.findUnique({
    where: { userId: MISFIT },
    select: { orgId: true, orgName: true },
  });
  expect(raw?.orgId).toBe(ORG_B);

  // …and org B's own session reads it, so the 404 above is the boundary working
  // rather than the route being broken.
  session.orgId = ORG_B;
  const own = await GET();
  expect(own.status).toBe(200);
  expect(JSON.stringify(await own.json())).toContain(MISFIT_ORG_NAME);
}, 60_000);

test("settings: the converted write path still writes its own tenant's row", async () => {
  await seedConversionFixtures();
  asOrgA();
  const { POST, DELETE } = await import("@/app/api/console/settings/route");

  const orgName = `Converted ${RUN}`;
  const res = await POST(
    new Request("http://localhost/api/console/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `vendorWebhookUrl: ""` also exercises the ORGANISATION write arm, which
      // stays on the application client (organization is invisible to sv_tenant).
      body: JSON.stringify({ orgName, vendorWebhookUrl: "" }),
    }) as never,
  );
  expect(res.status).toBe(200);
  expect(JSON.stringify(await res.json())).toContain(orgName);

  const stored = await db.userProfile.findUnique({
    where: { userId: USER_A },
    select: { orgName: true },
  });
  expect(stored?.orgName).toBe(orgName);

  const removed = await DELETE(
    new NextRequest("http://localhost/api/console/settings?field=elevenKey"),
  );
  expect(removed.status).toBe(200);
  const afterDelete = await db.userProfile.findUnique({
    where: { userId: USER_A },
    select: { orgName: true },
  });
  expect(afterDelete?.orgName).toBe(orgName);
}, 60_000);
