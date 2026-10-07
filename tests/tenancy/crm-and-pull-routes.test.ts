/**
 * WP-12 GATE — cross-tenant isolation on the CRM CONNECTION route and on the
 * bank PULL endpoint.
 *
 * Both were added after the original console-routes suite, and the route sweep
 * refuses to let a guarded route into its `DB_BACKED` exemption unless a suite
 * actually drives its real handler against a live database. Naming them in the
 * sweep is a claim; this file is the proof.
 *
 * The two routes authenticate DIFFERENTLY, which is the point of testing them
 * apart:
 *
 *   /api/console/crm        — a human session (org from the profile). A wrong
 *                             org must see zero connections, and deleting a
 *                             provider it does not own must be a 404-shaped no-op,
 *                             not a 403 that discloses the row exists.
 *   /api/v1/interventions/[id] — a producer key, which NAMES the tenant. Another
 *                             institution's case and a case that never existed
 *                             must be byte-identical responses.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import * as realCredits from "@/lib/credits";
import * as realProducerKeys from "@/lib/producer-keys";

const RUN = Date.now().toString(36);
const RUN_HEX = createHash("sha256").update(RUN).digest("hex");

// See console-routes.test.ts: uuid columns reject base36, and `UserProfile.orgId`
// references the organization row.
const uuidFor = (tag: string): string =>
  `${tag
    .replace(/[^a-f0-9]/gi, "")
    .slice(0, 8)
    .padEnd(8, "0")
    .toLowerCase()}-0000-4000-8000-${RUN_HEX.slice(0, 12)}`;
const USER_A = uuidFor("cccccccc");
const USER_B = uuidFor("dddddddd");
const ORG_A = uuidFor("cacacaca");
const ORG_B = uuidFor("dbdbdbdb");

const session = { orgId: ORG_A as string | null, userId: USER_A };

mock.module("@/lib/credits", () => ({
  ...realCredits,
  getProfile: async () =>
    session.orgId
      ? {
          userId: session.orgId === ORG_A ? USER_A : USER_B,
          email: `${session.orgId}@securevoice.ae`,
          name: "Crm Route Org",
          role: "operator" as const,
          orgId: session.orgId,
          credits: 500,
        }
      : null,
}));

const PLAINTEXT_KEY_A = `svb_${RUN}_a`;
const PLAINTEXT_KEY_B = `svb_${RUN}_b`;
/** Which tenant the presented producer key resolves to. Flipped per test. */
const keySession = { orgId: ORG_A as string | null, keyId: "key-a", callerId: "caller-a" };

// The endpoint authenticates with a producer key. Mocked at the verifying seam,
// not at the HTTP layer, so rate limiting, the case lookup and the response
// envelope are all the real code.
mock.module("@/lib/producer-keys", () => ({
  ...realProducerKeys,
  verifyProducerKey: async (raw: string | null) => {
    if (raw === PLAINTEXT_KEY_A) {
      return {
        ok: true as const,
        orgId: keySession.orgId,
        keyId: `${keySession.keyId}_${RUN}`,
        callerId: `${keySession.callerId}_${RUN}`,
        scopes: ["interventions:read"],
      };
    }
    if (raw === PLAINTEXT_KEY_B) {
      return {
        ok: true as const,
        orgId: ORG_B,
        keyId: `key-b_${RUN}`,
        callerId: `caller-b_${RUN}`,
        scopes: ["interventions:read"],
      };
    }
    return { ok: false as const };
  },
}));

/** A case ref that satisfies the route's own /^SV-F-[A-Z0-9]{6}$/ shape. */
const REF_A = `SV-F-${RUN_HEX.slice(0, 6).toUpperCase()}`;
const REF_B = `SV-F-${RUN_HEX.slice(6, 12).toUpperCase()}`;

let seeded = false;

async function seed(): Promise<void> {
  if (seeded) return;
  seeded = true;

  for (const [side, id] of [
    ["A", ORG_A],
    ["B", ORG_B],
  ] as const) {
    await db.organization.create({
      data: {
        id,
        name: `Crm Route Org ${side}`,
        slug: `crm-route-${side.toLowerCase()}-${RUN_HEX.slice(0, 12)}`,
        createdAt: new Date(),
      },
    });
  }
  for (const [userId, tag] of [
    [USER_A, "c"],
    [USER_B, "d"],
  ] as const) {
    await db.user.create({
      data: { id: userId, email: `${tag}-${RUN}@securevoice.ae`, name: tag, emailVerified: true },
    });
    await db.userProfile.create({
      data: {
        userId,
        email: `${tag}-${RUN}@securevoice.ae`,
        name: tag,
        role: "operator",
        orgId: tag === "c" ? ORG_A : ORG_B,
      },
    });
  }

  // Two CRM connections, one per tenant. `configEnc` holds ciphertext in
  // production; the LIST route only reports masked fields, so a plaintext body
  // here would be equally unreadable to a caller — which is the assertion.
  await db.crmConnection.create({
    data: {
      orgId: ORG_A,
      provider: "zendesk",
      configEnc: "enc_A",
      enabled: true,
      lastStatus: "ok",
      lastSyncAt: new Date("2026-10-01T10:00:00Z"),
    },
  });
  await db.crmConnection.create({
    data: {
      orgId: ORG_B,
      provider: "webhook",
      configEnc: "enc_B_secret_do_not_leak",
      enabled: true,
      lastStatus: "error",
      lastError: "connection refused by peer",
    },
  });

  for (const [caseRef, orgId, outcome] of [
    [REF_A, ORG_A, "confirmed_fraud"],
    [REF_B, ORG_B, "confirmed_fraud"],
  ] as const) {
    await db.case.create({
      data: {
        caseRef,
        orgId,
        state: "NOTIFIED",
        outcome,
        // The redaction is a claim under test, not a fixture convenience: the
        // row holds something recognisable so an accidental leak is visible.
        transcriptRedacted: `[REDACTED] caller disputed charge on card 4242 for merchant ACME STORE`,
        smsSentAt: new Date("2026-10-01T09:00:00Z"),
        createdAt: new Date("2026-10-01T08:00:00Z"),
        updatedAt: new Date("2026-10-01T09:30:00Z"),
      } as never,
    });
  }
}

function asOrgA(): void {
  session.orgId = ORG_A;
  session.userId = USER_A;
}
function asOrgB(): void {
  session.orgId = ORG_B;
  session.userId = USER_B;
}

beforeAll(async () => {
  await seed();
}, 120_000);

afterAll(async () => {
  // Only the fixtures this run created. CrmConnection and Case have no FK to
  // Organization that cascades in a way worth relying on, so delete by id.
  await db.crmConnection.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
  await db.case.deleteMany({ where: { caseRef: { in: [REF_A, REF_B] } } });
  await db.userProfile.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
  await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
}, 120_000);

// ——— /api/console/crm ———

test("crm: org A lists its own connection and never org B's", async () => {
  asOrgA();
  const { GET } = await import("@/app/api/console/crm/route");

  const res = await GET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    connections: { provider: string; masked: Record<string, string> }[];
  };

  expect(body.connections.map((c) => c.provider)).toEqual(["zendesk"]);
  const raw = JSON.stringify(body);
  // Not just unusable: the other tenant's row, provider and error text are absent.
  expect(raw).not.toContain("webhook");
  expect(raw).not.toContain("connection refused by peer");
  expect(raw).not.toContain("enc_B_secret_do_not_leak");
  // And the masked form carries no ciphertext at all.
  expect(raw).not.toContain("enc_");
}, 90_000);

test("crm: org B sees the mirror image", async () => {
  asOrgB();
  const { GET } = await import("@/app/api/console/crm/route");

  const body = (await (await GET()).json()) as { connections: { provider: string }[] };
  expect(body.connections.map((c) => c.provider)).toEqual(["webhook"]);
}, 90_000);

test("crm: deleting a provider you do not own leaves the other tenant's row intact", async () => {
  asOrgA();
  const { DELETE } = await import("@/app/api/console/crm/route");

  // Org A owns zendesk; `webhook` is org B's. The delete is keyed by
  // (orgId, provider), so it can only ever miss.
  const res = await DELETE(
    new NextRequest("http://localhost/api/console/crm?provider=webhook") as never,
  );
  expect(res.status).toBe(200);

  const survivors = await db.crmConnection.findMany({
    where: { orgId: { in: [ORG_A, ORG_B] } },
    select: { orgId: true, provider: true },
  });
  expect(survivors).toEqual(
    expect.arrayContaining([
      { orgId: ORG_A, provider: "zendesk" },
      { orgId: ORG_B, provider: "webhook" },
    ]),
  );
  expect(survivors).toHaveLength(2);
}, 90_000);

test("crm: pausing a provider you do not own does not disable it", async () => {
  asOrgA();
  const { PATCH } = await import("@/app/api/console/crm/route");

  const res = await PATCH(
    new Request("http://localhost/api/console/crm", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "webhook", enabled: false }),
    }) as never,
  );
  expect(res.status).toBe(200);

  const victim = await db.crmConnection.findFirst({
    where: { orgId: ORG_B, provider: "webhook" },
    select: { enabled: true },
  });
  expect(victim?.enabled).toBe(true);
}, 90_000);

// ——— /api/v1/interventions/[id] ———

const pull = async (ref: string, key: string, query = "") => {
  const { GET } = await import("@/app/api/v1/interventions/[id]/route");
  const req = new NextRequest(`http://localhost/api/v1/interventions/${ref}${query}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const res = await GET(req, { params: Promise.resolve({ id: ref }) });
  return { res, text: await res.text() };
};

test("v1 pull: a key returns its own tenant's case", async () => {
  await seed();
  const { res, text } = await pull(REF_A, PLAINTEXT_KEY_A);

  expect(res.status).toBe(200);
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(body.case_ref).toBe(REF_A);
  expect(body.state).toBe("NOTIFIED");
  // Terminal is what lets a poller stop rather than poll forever.
  expect(body.terminal).toBe(true);
  // The event vocabulary is shared with the webhook receiver.
  expect(body).toHaveProperty("resolution_method");
  expect(body).toHaveProperty("customer_response");
  // No transcript without asking for it.
  expect(text).not.toContain("4242");
  expect((body.evidence as { transcript: string }).transcript).toBe(
    "available_with_include=transcript",
  );
}, 90_000);

test("v1 pull: another tenant's case and a case that never existed are indistinguishable", async () => {
  await seed();
  const other = await pull(REF_B, PLAINTEXT_KEY_A);
  const missing = await pull("SV-F-ZZZZZZ", PLAINTEXT_KEY_A);

  expect(other.res.status).toBe(404);
  expect(missing.res.status).toBe(404);
  // Identical but for the per-request id, which is there to be quoted in a
  // support ticket and is not a disclosure: no case_ref echo, and no error text
  // that distinguishes "wrong tenant" from "never existed".
  const stripRequestId = (t: string): string =>
    t.replace(/"requestId":"[^"]*"/, '"requestId":"<id>"');
  expect(stripRequestId(other.text)).toBe(stripRequestId(missing.text));
  expect(other.text).not.toContain(REF_B);
}, 90_000);

test("v1 pull: a malformed reference is the same 404, not a validation lecture", async () => {
  const bad = await pull("not-a-case-ref", PLAINTEXT_KEY_A);
  expect(bad.res.status).toBe(404);
  expect(bad.text).not.toMatch(/SV-F-/);
}, 90_000);

test("v1 pull: without a valid key there is no answer at all", async () => {
  await seed();
  const { GET } = await import("@/app/api/v1/interventions/[id]/route");
  const req = new NextRequest(`http://localhost/api/v1/interventions/${REF_A}`);
  const res = await GET(req, { params: Promise.resolve({ id: REF_A }) });

  expect(res.status).toBe(401);
  expect(await res.text()).not.toContain(REF_A);
}, 90_000);

test("v1 pull: ?include=transcript returns the REDACTED text and an erasure flag", async () => {
  await seed();
  const { res, text } = await pull(REF_A, PLAINTEXT_KEY_A, "?include=transcript");

  expect(res.status).toBe(200);
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(typeof body.transcript_redacted).toBe("string");
  expect(body.erased).toBe(false);
  // The stored row is already redacted; the endpoint must not re-redact or
  // "helpfully" return anything richer.
  expect(text).toContain("[REDACTED]");
}, 90_000);

test("v1 pull: an erased case yields no transcript and says so", async () => {
  await seed();
  const { db: client } = await import("@/lib/db");
  await client.case.update({
    where: { caseRef: REF_A },
    data: { erasedAt: new Date("2026-10-02T00:00:00Z") },
  });

  const { res, text } = await pull(REF_A, PLAINTEXT_KEY_A, "?include=transcript");
  expect(res.status).toBe(200);
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(body.transcript_redacted).toBeNull();
  expect(body.erased).toBe(true);
  expect(text).not.toContain("4242");

  // Restore so the ordering of later assertions is not a trap.
  await client.case.update({ where: { caseRef: REF_A }, data: { erasedAt: null } });
}, 90_000);
