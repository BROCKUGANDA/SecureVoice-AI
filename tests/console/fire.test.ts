/**
 * GATE â€” the operator console's "Fire intervention signal" button traverses the
 * hardened path. This is the button a judge presses, so what it exercises is
 * the product.
 *
 * The defect this file exists to prevent: `src/app/api/console/fire/route.ts`
 * used to build a demo-shaped signal and POST it to `/api/interventions`, an
 * older second ingest with NO policy gate, NO abuse gate, NO `Case` row and NO
 * durable queue â€” which placed the carrier call inside the web request. Its
 * own docstring claimed "the identical flow, provably end to end", which was
 * false. A green build proved nothing about the guardrails because the one
 * surface a human touches was exempt from all of them.
 *
 * What is asserted here, and why each can actually FAIL:
 *
 *   1. A fired signal produces a `Case` row in SCREENED â€” the case state
 *      machine is now ENTERED. The old path minted a caseRef and wrote no row,
 *      so this assertion is false against the defect, not merely absent.
 *   2. A `dial_job` row exists for that caseRef â€” the DURABLE QUEUE is used,
 *      not an in-request carrier call. Asserting the row (rather than the
 *      response field) is what makes this independent of what the handler
 *      claims it did.
 *   3. An opted-out enrolled customer is REFUSED, with nothing persisted â€” so
 *      consent is enforced on this path and not merely forwarded upstream.
 *   4. NO enrolled customer is REFUSED, with nothing persisted. `runPolicyGate`
 *      only checks the consent record's SHAPE; a consent id that resolves to no
 *      `Customer` row yields NULL from the opted-out query and PASSES. The
 *      console therefore has to refuse explicitly, and this is the assertion
 *      that would catch its removal.
 *   5. `amount` reaches the hardened ingest as an INTEGER in minor units, at
 *      the exact expected value â€” the console form collects MAJOR units, so
 *      forwarding it unchanged is a 100x error and forwarding a fraction is a
 *      schema rejection.
 *   6. The forwarded body is v1-SHAPED and the exact signed bytes are what
 *      upstream verified, and the request carried an `Idempotency-Key` (the v1
 *      route rejects without one).
 *   7. The retired `/api/interventions` refuses with a typed 410 and arms
 *      nothing â€” the ungated carrier-call surface is closed.
 *
 * Environment: a real remote Postgres (DATABASE_URL, ~280 ms/round-trip) and
 * The session is MOCKED at module scope, before any module that calls
 * `auth()` / `currentUser()` is imported â€” the same discipline
 * `tests/tenancy/probe-registry.ts` documents.
 *
 *   bun test tests/console/fire.test.ts
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as realCredits from "@/lib/credits";
import { setAbuseConfig } from "@/lib/abuse/config";
import { setOrgGeoPolicy } from "@/lib/abuse/geo";
import { setOrgTestNumbers } from "@/lib/abuse/tiers";
import { topup } from "@/lib/billing/ledger";
import { POST as v1Post } from "@/app/api/v1/interventions/route";
import { POST as retiredPost } from "@/app/api/interventions/route";

// The CONSOLE route is the one module still imported with `await import()`
// inside `fire()`, on purpose: it transitively imports the session resolver
// (@clerk/nextjs/server), and the `mock.module` above must be registered
// before any such module is evaluated â€” a static import would be hoisted
// above the mock. Same discipline as tests/tenancy/probe-registry.ts.

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "console-gate-secret";

/* â”€â”€ Session (mocked at the getProfile seam; the org claim and email are the fixture) â”€â”€ */

// `UserProfile.orgId` is `@db.Uuid` and references the Better Auth
// `organization` row (hazard AU-3: the organization IS the tenant), so the org
// id has to be a real uuid. Other models here keep `orgId` as text, and a uuid
// is valid text, so one constant serves both.
const ORG = `0a0a0a0a-0000-4000-8000-${createHash("sha256")
  .update(Date.now().toString(36))
  .digest("hex")
  .slice(0, 12)}`;
const USER_ID = `00000000-0000-4000-8000-${Date.now().toString(16).slice(-12).padStart(12, "0")}`;
const OPERATOR_EMAIL = "judge@securevoice.ae";

const session = { orgId: ORG as string | null };

// Mocked at `@/lib/credits` rather than at the identity provider, for the same
// reason as tests/tenancy: `getProfile()` is the single seam a console route
// reads identity through, so mocking it exercises the real route and the real
// scoping without coupling the test to Better Auth's API shape.
//
// USER_ID is a UUID because `UserProfile.userId` is `@db.Uuid` after the
// cutover â€” a non-UUID string here is rejected by Postgres before the route runs.
mock.module("@/lib/credits", () => ({
  // The console routes import `requireOperator` / `requireSignedIn` /
  // `deductCredit` / `refundCredit` from this same module. Replacing it
  // wholesale drops those exports and the routes then fail to link, so spread
  // the real module and override only the seam under test.
  ...realCredits,
  getProfile: async () =>
    session.orgId
      ? {
          userId: USER_ID,
          email: OPERATOR_EMAIL,
          name: "Console Gate",
          role: "operator" as const,
          orgId: session.orgId,
          credits: 500,
        }
      : null,
}));

/* â”€â”€ Fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/** Unique per run so repeated runs never collide on the unique customerRef. */
const RUN = Date.now().toString(36);

/** Mirrors `selfCustomerRef()` in the fire route AND `selfRef()` in Console.tsx.
 *  The literal above contains an "@", so the split always has a first part. */
const CUSTOMER_REF = `SELF-${OPERATOR_EMAIL.split("@")[0]!.replace(/\W/g, "").slice(0, 24)}`;

/** A distinct enrolled customer per scenario: the dial gate's per-destination
 *  cooldown is real, so reusing one number would make the second fire a
 *  cooldown refusal instead of the thing under test. */
const PHONE = {
  live: "+971501110001",
  optedOut: "+971501110002",
  foreign: "+971501110003",
};
const CONSENT = {
  live: `CN-${RUN}-LIVE`,
  optedOut: `CN-${RUN}-OPTOUT`,
};

const firedCaseRefs: string[] = [];

/** Whatever the console forwarded, captured verbatim for the byte-level asserts. */
type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody: string;
};
let captured: Captured[] = [];
let consoleUnreachable = 0;

beforeAll(async () => {
  // The dial gate fails CLOSED with no geo allowlist and no verified test
  // number list, so a deployment declares where it will call. These are UAE
  // test numbers in distinct blocks â€” the same declaration an operator makes
  // before a rehearsal, and the reason the console can be exercised at all.
  setOrgGeoPolicy(ORG, { allowlist: ["AE"] });
  setOrgTestNumbers(ORG, [PHONE.live, PHONE.optedOut, PHONE.foreign, "+971501110000"]);
  // This is a gate run, not a fraud wave. WP-14's velocity breaker
  // auto-pauses on a burst inside 60 s, which is right for a smishing campaign
  // and wrong for a synthetic scenario â€” so the ceiling is raised explicitly
  // rather than the production default being weakened.
  setAbuseConfig({ velocity: { burstRateMax: 100, newPrefixBurst: 100 } });

  // The policy gate reserves a real unit from the append-only ledger and fails
  // closed when the balance is empty. Topping up is what an operator does
  // before a rehearsal, and it is what makes the gate meaningful.
  await topup({ orgId: ORG, units: 100, eventId: `console-gate-${RUN}`, reason: "gate fixture" });

  // The tenant row and the auth row the wallet below point at. Both are
  // referenced by foreign key (`UserProfile.orgId` -> organization,
  // `UserProfile.userId` -> user), so the wallet cannot be written first.
  await db.organization.create({
    data: {
      id: ORG,
      name: "Console Gate Org",
      slug: `console-gate-${RUN}`,
      createdAt: new Date(),
    },
  });
  await db.user.create({
    data: {
      id: USER_ID,
      email: `${OPERATOR_EMAIL}.${RUN}`,
      name: "Console Gate",
      emailVerified: true,
    },
  });
  // A wallet for the operator's prepaid credits.
  await db.userProfile.upsert({
    where: { userId: USER_ID },
    create: {
      userId: USER_ID,
      email: OPERATOR_EMAIL,
      name: "Console Gate",
      role: "operator",
      orgId: ORG,
      credits: 500,
    },
    update: { credits: 500 },
  });

  // The enrolled customers. `customerRef` is globally UNIQUE, which is exactly
  // what makes the cross-tenant assertion below meaningful: the identifier
  // alone would otherwise resolve any org's row.
  await db.customer.create({
    data: {
      customerRef: CUSTOMER_REF,
      phone: PHONE.live,
      orgId: ORG,
      lang: "en",
      consentRecordId: CONSENT.live,
    },
  });
}, 120_000);

afterAll(async () => {
  // Each scenario re-points the console's own customer row (customerRef is
  // globally UNIQUE, so a second row cannot carry the same ref), so teardown
  // is a single scoped delete.
  await db.customer.deleteMany({ where: { customerRef: { startsWith: CUSTOMER_REF } } });
  await db.userProfile.deleteMany({ where: { userId: USER_ID } });
  await db.usageLedger.deleteMany({ where: { orgId: ORG } });
  await db.case.deleteMany({ where: { orgId: ORG } });
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  // Last: the auth rows the wallet cascades from.
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: USER_ID } });
  await db.$disconnect();
}, 120_000);

/* â”€â”€ Driving the console â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/**
 * The console forwards over `fetch` to `${req.nextUrl.origin}/api/v1/interventions`.
 * There is no HTTP server in a unit test, so `fetch` is intercepted and handed
 * to the REAL hardened route handler. The gates under test are therefore the
 * production ones â€” this is not a stub of the thing being asserted.
 */
async function installFetchBridge(): Promise<void> {
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("/api/v1/interventions")) return realFetch(input as never, init as never);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k] = v;
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers,
      rawBody: String(init?.body ?? ""),
    });

    // Hand the EXACT bytes and headers to the real handler. If the console
    // signed something other than what it sent, the v1 signature check fails
    // here with a 401 and the assertions below catch it.
    return v1Post(
      new Request(url, { method: "POST", headers, body: String(init?.body ?? "") }) as never,
    );
  }) as typeof fetch;
}

/** Fire the console exactly as Console.tsx does. */
async function fire(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import("@/app/api/console/fire/route");
  const req = new NextRequest("http://localhost/api/console/fire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  } as ConstructorParameters<typeof NextRequest>[1]);
  try {
    return await POST(req);
  } catch (err) {
    consoleUnreachable++;
    throw err;
  }
}

test("console fire: a fired signal enters the case state machine and lands on the durable dial queue", async () => {
  await installFetchBridge();
  captured = [];

  const res = await fire({
    riskScore: 0.94,
    channel: "card",
    lang: "en",
    amountAed: 2500.5,
    merchant: "Electronics World",
  });

  expect(res.status).toBe(202);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.ok).toBe(true);
  const caseRef = body.caseRef as string;
  expect(caseRef).toBeTruthy();
  firedCaseRefs.push(caseRef);

  // (1) The case row MUST exist. Every downstream stage joins on it: the dial
  // worker reads the destination from it, and the post-call webhook and the
  // bank outbox correlate on it. The defect minted a caseRef and wrote no row,
  // so the signal was "accepted", the operator was told 202, and no call could
  // ever be placed.
  const row = await db.case.findUnique({ where: { caseRef } });
  expect(row).not.toBeNull();
  expect(row!.orgId).toBe(ORG);
  // Gates passed, so the case is SCREENED and waiting for the dial worker
  // (SCREENED -> DIALING is owned by src/worker/dial.ts, not by this request).
  expect(["SCREENED", "DIALING", "RINGING", "ANSWERED", "DISCLOSED", "VERIFYING"]).toContain(
    row!.state,
  );

  // (2) The durable queue is used. `dial_job` is the physical table behind the
  // DialJob model (snake_case + @@map); a raw query asserts the ROW rather than
  // the handler's own claim about what it did.
  const jobs = await db.$queryRaw<{ case_ref: string; state: string; payload: string }[]>`
    SELECT case_ref, state, payload FROM dial_job WHERE case_ref = ${caseRef}
  `;
  expect(jobs.length).toBe(1);
  expect(jobs[0]!.state).toBe("PENDING");

  // (5) Money crossed the boundary as an INTEGER in minor units, at the exact
  // value. 2500.5 AED is 250050 fils. Forwarding the form value unchanged would
  // be 100x wrong; forwarding 2500.5 would fail the v1 schema outright.
  expect(Number.isInteger(row!.amountMinor)).toBe(true);
  expect(row!.amountMinor).toBe(250050);
  expect(row!.currency).toBe("AED");

  // The phone came from the ENROLLED row, not from anything the operator typed.
  expect(row!.phone).toBe(PHONE.live);
  expect(row!.consentRecordId).toBe(CONSENT.live);
}, 180_000);

test("console fire: the forwarded signal is v1-shaped, signed over the exact bytes, and carries an Idempotency-Key", async () => {
  // (6) The wire the console sends is the wire a bank's fraud engine sends.
  const sent = captured.at(-1);
  expect(sent).toBeDefined();
  expect(sent!.url).toContain("/api/v1/interventions");
  expect(sent!.method).toBe("POST");

  const parsed = JSON.parse(sent!.rawBody) as Record<string, unknown>;

  // v1 contract fields, and ONLY those â€” the v1 schema is `.strict()` and
  // rejects unknown fields, so the presence of `signal` (the old wrapper) or of
  // `amountAed` would make the upstream 422. That this request was accepted at
  // all is the proof the body is v1-shaped; these asserts name the fields.
  expect(parsed.signal).toBeUndefined();
  expect(parsed.amountAed).toBeUndefined();
  expect(typeof parsed.transaction_ref).toBe("string");
  expect(typeof parsed.risk_score).toBe("number");
  expect(typeof parsed.language).toBe("string");
  expect(parsed.phone).toBe(PHONE.live);
  expect(parsed.currency).toBe("AED");
  expect(parsed.consent_record_id).toBe(CONSENT.live);
  expect(parsed.org_id).toBe(ORG);
  expect(parsed.merchant).toBe("Electronics World");

  // (5, again, at the wire) the amount is an integer in minor units.
  expect(Number.isInteger(parsed.amount)).toBe(true);
  expect(parsed.amount).toBe(250050);

  // The signature covers the EXACT bytes sent â€” verified independently here, so
  // this asserts the console's signing, not just the upstream's acceptance.
  const sv = /^t=(\d{10}),v1=([0-9a-f]{64})$/.exec(
    sent!.headers["SV-Signature"] ?? sent!.headers["sv-signature"] ?? "",
  );
  expect(sv).not.toBeNull();
  const expected = createHmac("sha256", process.env.WEBHOOK_SECRET!)
    .update(`${sv![1]}.${sent!.rawBody}`)
    .digest("hex");
  expect(timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sv![2]!, "hex"))).toBe(true);

  // The v1 route rejects a signal without one (min 8 chars).
  const idem = sent!.headers["Idempotency-Key"] ?? sent!.headers["idempotency-key"] ?? "";
  expect(idem.length).toBeGreaterThanOrEqual(8);
}, 120_000);

test("console fire: an opted-out enrolled customer is refused and nothing is persisted", async () => {
  // Re-point the console's OWN customer at the opted-out row, so the refusal
  // cannot be confused with "no enrollment found".
  await db.customer.deleteMany({ where: { customerRef: CUSTOMER_REF } });
  await db.customer.create({
    data: {
      customerRef: CUSTOMER_REF,
      phone: PHONE.optedOut,
      orgId: ORG,
      consentRecordId: CONSENT.optedOut,
      optedOut: true,
    },
  });
  const before = await db.case.count({ where: { orgId: ORG } });
  captured = [];

  const res = await fire({ riskScore: 0.97, channel: "card", lang: "en", amountAed: 2500 });

  // (3) Consent is enforced ON THIS PATH.
  expect(res.status).toBe(409);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.code).toBe("consent_opted_out");
  expect(body.error).toMatch(/opted out/i);
  expect(body.caseRef).toBeUndefined();

  // No upstream call was made, no case was written, and the operator's credit
  // came back.
  expect(captured.length).toBe(0);
  expect(await db.case.count({ where: { orgId: ORG } })).toBe(before);
  expect(typeof body.creditsRemaining).toBe("number");

  // Restore the live enrollment for the cross-tenant probe.
  await db.customer.deleteMany({ where: { customerRef: CUSTOMER_REF } });
  await db.customer.create({
    data: {
      customerRef: CUSTOMER_REF,
      phone: PHONE.live,
      orgId: ORG,
      consentRecordId: CONSENT.live,
    },
  });
}, 180_000);

test("console fire: no enrolled customer is refused â€” the policy gate does NOT catch this", async () => {
  await db.customer.deleteMany({ where: { customerRef: { startsWith: CUSTOMER_REF } } });
  const before = await db.case.count({ where: { orgId: ORG } });
  captured = [];

  const res = await fire({ riskScore: 0.94, channel: "card", lang: "en", amountAed: 2500 });

  // (4) This is the assertion that would catch the refusal being removed.
  //
  // `runPolicyGate` (src/lib/policy-gate.ts:141-146) checks only the consent
  // record's SHAPE. The opted-out check is the v1 route's raw query, where a
  // consent id resolving to no Customer row yields NULL and PASSES. So an
  // unenrolled operator's signal is NOT refused by any gate â€” the console has
  // to refuse it, and it must refuse rather than invent a destination.
  expect(res.status).toBe(409);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.code).toBe("customer_not_enrolled");
  expect(body.error).toMatch(/no enrolled customer/i);

  // Nothing was armed and nothing was forwarded.
  expect(captured.length).toBe(0);
  expect(await db.case.count({ where: { orgId: ORG } })).toBe(before);
}, 180_000);

test("console fire: a customer enrolled under ANOTHER org resolves to nothing", async () => {
  // Same customerRef, a different org. The console's lookup is the exact
  // tenant-scoped expression /api/interventions issues
  // (`findFirst({ customerRef, orgId })`), so a ref belonging to another org
  // must resolve to NOTHING â€” never to that org's phone number.
  const otherOrg = `${ORG}-OTHER`;
  await db.customer.deleteMany({ where: { customerRef: { startsWith: CUSTOMER_REF } } });
  await db.customer.create({
    data: {
      customerRef: CUSTOMER_REF,
      phone: PHONE.foreign,
      orgId: otherOrg,
      consentRecordId: CONSENT.live,
    },
  });
  const before = await db.case.count({ where: { orgId: ORG } });
  captured = [];

  const res = await fire({ riskScore: 0.94, channel: "card", lang: "en", amountAed: 2500 });

  expect(res.status).toBe(409);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.code).toBe("customer_not_enrolled");
  // The foreign phone number must not appear anywhere in the response.
  expect(JSON.stringify(body)).not.toContain(PHONE.foreign);
  expect(captured.length).toBe(0);
  expect(await db.case.count({ where: { orgId: ORG } })).toBe(before);

  await db.customer.deleteMany({ where: { customerRef: CUSTOMER_REF } });
}, 180_000);

test("the retired /api/interventions refuses and arms nothing", async () => {
  const raw = JSON.stringify({
    signal: {
      caseId: `RETIRED-${RUN}`,
      riskScore: 0.94,
      channel: "card",
      customer: { ref: CUSTOMER_REF, lang: "en" },
      transaction: { amountAed: 2500, merchant: "Electronics World" },
    },
  });
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", process.env.WEBHOOK_SECRET!).update(`${t}.${raw}`).digest("hex");
  const before = await db.case.count({ where: { orgId: ORG } });

  const res = await retiredPost(
    new Request("http://localhost/api/interventions", {
      method: "POST",
      headers: { "content-type": "application/json", "SV-Signature": `t=${t},v1=${v1}` },
      body: raw,
    }) as never,
  );

  // (7) A correctly signed producer gets a typed refusal naming the successor,
  // not a 202 and not a carrier call.
  expect(res.status).toBe(410);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.code).toBe("endpoint_retired");
  expect(body.successor).toBe("/v1/interventions");
  expect(await db.case.count({ where: { orgId: ORG } })).toBe(before);
  expect(consoleUnreachable).toBe(0);
}, 120_000);

test("cleanup: no console fire left the request handler unhandled", () => {
  expect(consoleUnreachable).toBe(0);
  expect(firedCaseRefs.length).toBeGreaterThanOrEqual(1);
});
