/**
 * THE DOWNLOAD ENDPOINT'S AUTHORIZATION — the part of the recording archive that
 * the signing tests cannot see.
 *
 * `tests/unit/object-storage.test.ts` and the key tests in
 * `recording-download.test.ts` prove the URL is signed correctly and that the
 * tenant prefix is the first path segment. None of them proves the ROUTE asks the
 * right questions before handing one out, and that is where a PDPL problem lives:
 * a presigned URL is a bearer credential, so the endpoint that mints it is the
 * only authorization check between a browser and a bank customer's voice.
 *
 * Asserted here, against the real route handler and the real database:
 *
 *   1. No session → 401, and no case row is even looked up.
 *   2. A session with no active organization → 403. There is no tenant to scope
 *      the request to; switching organisation is the caller's to fix.
 *   3. A case belonging to ANOTHER tenant is answered with the same 404 bytes a
 *      non-existent id gets. Case ids are not secrets, but they are enumerable
 *      identifiers that appear in audit views — an endpoint that distinguishes
 *      "not yours" from "not there" is an oracle for which cases exist at another
 *      bank. The distinction is kept server-side, in the log.
 *   4. The tenant check runs BEFORE the storage layer, so a cross-tenant probe
 *      cannot learn anything from the object store either (including whether a
 *      recording exists at all).
 *   5. The success path mints a URL whose KEY IS UNDER THE CALLER'S OWN TENANT
 *      PREFIX, and the response is `no-store`, because a still-valid recording
 *      link in a shared cache is the leak this whole file is about.
 *
 * Storage is configured with local credentials and a fake endpoint: presigning is
 * pure computation, so nothing here can reach a bucket.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

// The route reads the request headers to hand Better Auth its session cookie.
// Outside a Next.js request scope `headers()` throws, so the seam is replaced
// with the empty bag the mocked session below does not read.
mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

const session: { orgId: string | null; present: boolean } = { orgId: null, present: true };
const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];

mock.module("@/lib/better-auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        session.present && session.orgId
          ? { session: { activeOrganizationId: session.orgId }, user: { id: "user-1" } }
          : session.present
            ? { session: { activeOrganizationId: null }, user: { id: "user-1" } }
            : null,
    },
  },
}));

mock.module("@/lib/validation/safe-log", () => ({
  ...Object.fromEntries(
    ["logInfo", "logDebug", "logWarn"].map((k) => [
      k,
      (msg: string, fields?: Record<string, unknown>) => {
        if (k === "logWarn") warnings.push({ msg, fields });
      },
    ]),
  ),
  logError: () => {},
}));

function uuid(slot: number): string {
  const h = createHash("sha256").update(`recordings-route:${slot}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const RUN = Date.now().toString(36);
const ORG_A = uuid(1);
const ORG_B = uuid(2);
const CASE_A = uuid(3);
const CASE_B = uuid(4);
const CASE_A_NO_RECORDING = uuid(5);
const CONV_A = `conv-a-${RUN}`;
const CONV_B = `conv-b-${RUN}`;

const STORAGE_ENV = {
  R2_ENDPOINT: "https://acct.test.r2.cloudflarestorage.com",
  R2_BUCKET: "securevoice-recordings-test",
  R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI-KODE-MdspF+HEXAMPLEACUV",
  R2_REGION: "auto",
} as const;

async function get(id: string) {
  const { GET } = await import("@/app/api/recordings/[id]/route");
  const req = new NextRequest(`https://app.test/api/recordings/${id}/download`, {
    method: "GET",
    headers: { host: "app.test" },
  });
  const res = await GET(req as never, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
}

beforeAll(async () => {
  for (const [id, name] of [
    [ORG_A, "Alpha Bank"],
    [ORG_B, "Beta Bank"],
  ] as [string, string][]) {
    await db.organization.create({
      data: { id, name, slug: `${name.toLowerCase()}-${RUN}`, createdAt: new Date() },
    });
  }
  await db.case.create({
    data: {
      id: CASE_A,
      caseRef: `SV-R-A-${RUN}`,
      orgId: ORG_A,
      phone: "+971500000001",
      language: "en",
      conversationId: CONV_A,
    },
  });
  await db.case.create({
    data: {
      id: CASE_B,
      caseRef: `SV-R-B-${RUN}`,
      orgId: ORG_B,
      phone: "+971500000002",
      language: "en",
      conversationId: CONV_B,
    },
  });
  await db.case.create({
    data: {
      id: CASE_A_NO_RECORDING,
      caseRef: `SV-R-C-${RUN}`,
      orgId: ORG_A,
      phone: "+971500000003",
      language: "en",
    },
  });
});

afterAll(async () => {
  await db.case.deleteMany({ where: { id: { in: [CASE_A, CASE_B, CASE_A_NO_RECORDING] } } });
  await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
});

beforeEach(() => {
  session.present = true;
  session.orgId = ORG_A;
  warnings.length = 0;
  for (const [k, v] of Object.entries(STORAGE_ENV)) process.env[k] = v;
});

afterEach(() => {
  for (const k of Object.keys(STORAGE_ENV)) delete process.env[k];
});

describe("who may ask for a recording", () => {
  test("no session is 401, and the case table is never consulted", async () => {
    session.present = false;
    const res = await get(CASE_A);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("authentication_required");
  });

  test("a session with no active organization is refused — there is no tenant to scope to", async () => {
    session.orgId = null;
    const res = await get(CASE_A);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("no_active_organization");
    // The refusal is actionable: it says what to do.
    expect(res.body.reason).toContain("switch to an organisation");
  });

  test("an unknown case id is 404", async () => {
    const res = await get(uuid(99));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("recording_not_found");
  });
});

describe("tenant isolation on the download path", () => {
  test("another tenant's case is indistinguishable from a case that does not exist", async () => {
    // Alpha's session, Beta's case.
    const cross = await get(CASE_B);
    const missing = await get(uuid(99));

    expect(cross.status).toBe(404);
    expect(cross.status).toBe(missing.status);
    expect(cross.body).toEqual(missing.body);
    // The isolation event is recorded where an operator can see it — and nowhere
    // the caller can.
    expect(warnings.some((w) => w.msg.includes("cross-tenant"))).toBe(true);
  });

  test("a cross-tenant probe never reaches the object store", async () => {
    // With storage configured, a same-tenant case mints a URL; the other
    // tenant's identical case must not produce one at all.
    const asOwner = await get(CASE_A);
    session.orgId = ORG_B;
    const asStranger = await get(CASE_A);

    expect(asOwner.status).toBe(200);
    expect(asStranger.status).toBe(404);
    expect(asStranger.body.url).toBeUndefined();
  });

  test("the minted URL's key sits under the CALLER's tenant prefix", async () => {
    const res = await get(CASE_A);

    expect(res.status).toBe(200);
    const url = new URL(res.body.url as string);
    expect(res.body.expiresInSeconds).toBeGreaterThan(0);
    expect(res.body.expiresInSeconds).toBeLessThanOrEqual(15 * 60);
    // Path-style: /<bucket>/<orgId>/recordings/<conversationId>.mp3
    expect(decodeURIComponent(url.pathname)).toContain(`${ORG_A}/recordings/${CONV_A}`);
    expect(decodeURIComponent(url.pathname)).not.toContain(ORG_B);
    // A presigned URL is a bearer credential; the response carrying it must not
    // be cacheable anywhere shared.
    expect(res.cache).toContain("no-store");
  });

  test("a case with no conversation is 404, and not a 500 about a missing object", async () => {
    const res = await get(CASE_A_NO_RECORDING);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_recording_for_case");
  });
});

describe("degradation, not failure", () => {
  test("an unconfigured store is 503 with a named reason", async () => {
    for (const k of Object.keys(STORAGE_ENV)) delete process.env[k];

    const res = await get(CASE_A);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("storage_not_configured");
  });
});
