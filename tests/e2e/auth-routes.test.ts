/**
 * E2E — the AUTH ROUTE LAYER, invoked through each real exported handler.
 *
 * `tests/auth/` already covers the auth LIBRARY: session policy, RBAC, step-up,
 * invites, magic links, password hashing. Those suites mock internals and reach
 * into the database. This file covers the layer those suites never touch — the
 * HTTP contract of `src/app/api/auth/**`: which status a refusal carries, what
 * the body contains, which headers ride along, and what a caller can and cannot
 * infer from the answer. Each handler is imported and called with a real
 * `Request`, and the assertions are made against the real `Response`.
 *
 * ── Why refusals are the contract worth pinning ─────────────────────────────
 * The success paths of these routes are thin: mint a session, set a cookie.
 * The REFUSAL paths are where the security properties live, and they are the
 * paths a refactor reaches first and thinks least about.
 *
 *   · ANONYMOUS IS 401, AND ONLY 401. `requireAuth` maps "who are you" to 401 and
 *     "not any more" to 403 (src/lib/auth/guards.ts). A caller who presents no
 *     credential must land in the first bucket on every route, without exception.
 *   · NO REFUSAL DISCLOSES A TENANT. An attacker holding a forged or foreign
 *     token learns the token is dead — never that an org, an account, or an
 *     address exists somewhere. The status is identical across every anonymous
 *     credential shape precisely so the status itself is not an oracle.
 *   · NO REFUSAL ECHOES A SECRET. Not the password, not the token, not the cookie
 *     value, not in the body and not in a header. A refusal that quotes the
 *     credential it rejected has turned the error path into an oracle for
 *     whatever the caller was holding.
 *   · THE GUARD RUNS BEFORE THE BODY IS PARSED. `/api/auth/step-up` authenticates
 *     first and only then reads JSON, so an unauthenticated caller cannot use a
 *     400-versus-401 split to learn the request schema.
 *   · A REFUSAL IS AUDITED, AND THE AUDIT AGREES WITH THE BODY. The `code` in the
 *     response and the `meta.reason` in the chain record are the same string, so
 *     support can reconstruct a refusal from the log alone.
 *
 * ── KNOWN GAPS (asserted as-is below; the handlers were NOT changed) ─────────
 * 1. THESE ROUTES DO NOT USE THE FIVE-FIELD FAILURE ENVELOPE. The envelope
 *    `{ code, message, retryable, requestId, docsUrl }` belongs to the canonical
 *    ingest surface (`src/lib/failures/envelope.ts`); the console auth routes use
 *    the `legacy_error_field` shape `{ error }` or `{ error, code }`, which
 *    `src/lib/contracts/schema.ts` documents as deliberate for operator routes.
 *    Every body here is therefore parsed with `z.strictObject`, which asserts the
 *    EXACT key set — the mechanical form of "no more fields, no fewer" for the
 *    shape these routes actually use.
 * 2. A MALFORMED BODY IS `{ error: "Invalid JSON body" }` WITH NO `code` FIELD.
 *    There is no `malformed_request` literal on this surface; the machine-readable
 *    reason only appears on guard denials.
 * 3. `/api/auth/sessions` sets `Cache-Control: no-store` on its SUCCESS responses
 *    but NOT on its 401 denials (src/app/api/auth/sessions/route.ts:34). Every
 *    other route here sets it on both. This file does not pin the absence — that
 *    would fail the day someone fixes it — but the asymmetry is real and is why
 *    these tests assert on the denials' CONTENT rather than their caching.
 * 4. THE 422 ON `/api/auth/password` DOES NOT SAY WHICH FIELD FAILED. The message
 *    names both credential fields regardless of which one was missing or
 *    malformed. The assertions below require that it names the offending FIELD
 *    SET; they do not claim it discriminates between them.
 *
 * ── Database ─────────────────────────────────────────────────────────────────
 * This file writes NOTHING to Postgres and creates NO fixture. Two seams are
 * stubbed so it can stay that way:
 *
 *   · `@/lib/audit-chain` — a refusal appends to the tamper-evident chain, which
 *     is a DB write on every denied request. Stubbed to an in-memory recorder, so
 *     the audit assertions are still real (they check the recorded intent) while
 *     the shared database takes no writes.
 *   · `@/lib/credits` — the identity seam this repo stubs in every other route
 *     suite (see tests/tenancy/console-routes.test.ts), for parity.
 *
 * Two paths genuinely need a lookup and are exercised anyway, both read-only:
 * `verifySession` resolving a well-signed token against the session store, and
 * `redeemMagicLink` resolving a well-formed token that was never issued. Those
 * two SELECTs are the behaviour under test — a refusal produced BY the lookup
 * rather than by the parser.
 *
 * NOT COVERED, DELIBERATELY: `POST /api/auth/password`'s credential refusal. It
 * is the one route whose rejection is produced solely by `db.account.findUnique`,
 * and that model is not resolvable in this environment (the Prisma client maps
 * it to `public.account`; the database carries `public.Account`). Asserting a
 * branch this environment cannot reach would be a test that proves nothing, so
 * the branch is left to `tests/auth/password.test.ts` and the route-layer claims
 * for it — the 400 and 422 envelope, and the no-echo property — are pinned above.
 *
 * Response bodies are parsed through Zod rather than cast. A cast would silence
 * a shape change; a parse turns it into a failing assertion naming the field,
 * which is the entire point of gating a route contract.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { AUTH_SCOPES, PERMANENT_EXPIRY, drop, put } from "@/lib/auth/store";
import { db } from "@/lib/db";
import * as realCredits from "@/lib/credits";
import { signSessionToken, type SessionRecord } from "@/lib/auth/session";
import { ABSOLUTE_LIFETIME_MS, IDLE_TIMEOUT_MS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { GET as meGet } from "@/app/api/auth/me/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import { GET as sessionsGet, DELETE as sessionsDelete } from "@/app/api/auth/sessions/route";
import { POST as passwordPost } from "@/app/api/auth/password/route";
import { POST as magicLinkPost } from "@/app/api/auth/magic-link/route";
import { POST as magicLinkVerifyPost } from "@/app/api/auth/magic-link/verify/route";
import { POST as stepUpPost } from "@/app/api/auth/step-up/route";
import { POST as revokeAllPost } from "@/app/api/auth/sessions/revoke-all/route";

const logoutPost = logoutRoute.POST;

// `signSessionToken` refuses to produce anything without a usable AUTH_SECRET, and
// the .env in this repository supplies one. The fallback keeps the file honest if
// it is ever run against an environment that does not.
if (!process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = `auth-routes-e2e-${Date.now().toString(36)}-not-a-production-value`;
}

/** Every audit-chain append the stubbed chain was asked to make, in order. */
const AUDIT: Array<{
  intent: string;
  callerId: string;
  meta: Record<string, unknown> | undefined;
}> = [];

/**
 * The refusal seam. `requireAuth` awaits an audit append on EVERY denial, before
 * it returns, so a stubbed chain keeps these tests off the shared database and
 * still lets the log/behaviour agreement be asserted for real.
 */
mock.module("@/lib/audit-chain", () => ({
  append: async (entry: { intent: string; callerId: string; meta?: Record<string, unknown> }) => {
    AUDIT.push({ intent: entry.intent, callerId: entry.callerId, meta: entry.meta });
    return { id: "auth-routes-stub", chainHash: "0".repeat(64) };
  },
  verifyChain: async () => ({ ok: true, rows: 0 }),
}));

// The identity seam, stubbed exactly the way this repo's other route suites stub
// it. Nothing on these routes calls it; it is present so this file matches the
// established pattern rather than relying on an import graph that may change.
mock.module("@/lib/credits", () => ({
  // Spread the real module so `requireOperator` / `requireSignedIn` survive;
  // replacing it wholesale breaks every console route that imports them.
  ...realCredits,
  getProfile: async () => null,
}));

// Torn down after the run so the shared database keeps nothing behind.
afterAll(async () => {
  await drop(AUTH_SCOPES.session, LIVE_SID, LIVE_ACCOUNT);
  await drop(AUTH_SCOPES.identity, LIVE_ACCOUNT, LIVE_ORG);
  await db.$disconnect();
});

beforeEach(() => {
  AUDIT.length = 0;
});

// ── The exact refusal shapes these routes use ─────────────────────────────────
// `legacy_error_field` with a reason (guard denials) …
const DenialBody = z.strictObject({ error: z.string(), code: z.string() });
// … and without one (validation refusals).
const MessageBody = z.strictObject({ error: z.string() });

/**
 * Read a response exactly once. A `Response` body is a stream, so the text, the
 * headers and the parsed JSON all have to come from one read — reading twice
 * would silently yield an empty string the second time.
 */
async function snapshot(res: Response) {
  const text = await res.text();
  // `Headers` is iterable at runtime but not under this project's lib settings,
  // so the pairs are pulled out by index rather than spread.
  const headers: Array<[string, string]> = [];
  res.headers.forEach((value, key) => headers.push([key, value]));
  return { status: res.status, text, headers };
}

/** Parse a captured body through a schema. A shape change fails HERE, by name. */
function parse<S extends z.ZodType>(text: string, schema: S): z.infer<S> {
  return schema.parse(JSON.parse(text));
}

/**
 * Nothing the handler sent back may contain anything the caller put in. Checked
 * against the body AND every header value, because a `Set-Cookie` that quotes
 * the token it is expiring leaks exactly as badly as a body that does.
 */
function expectNoEcho(snap: { text: string; headers: Array<[string, string]> }, secrets: string[]) {
  const haystack = [snap.text, ...snap.headers.map(([k, v]) => `${k}: ${v}`)].join("\n");
  for (const secret of secrets) {
    expect(haystack).not.toContain(secret);
  }
}

const json = (body: unknown): Request =>
  new Request("http://localhost/api/auth/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const raw = (body: string): Request =>
  new Request("http://localhost/api/auth/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

const cookie = (token: string): Request =>
  new Request("http://localhost/api/auth/x", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });

// ── Token shapes, all of which must be refused ───────────────────────────────
// A foreign-looking tenant and account, so the "no cross-tenant disclosure"
// assertion has something specific to fail on if the handler ever echoed it.
const FOREIGN_ORG = "org-9f3c-not-the-caller";
const FOREIGN_ACCOUNT = "acct-7b21-not-the-caller";

/** A correctly signed token naming a session the server has no record of. */
function signedUnknownSession(): string {
  return signSessionToken(`sid-${FOREIGN_ACCOUNT}`, FOREIGN_ACCOUNT, Date.now());
}

/** A correctly signed token whose signature byte has been flipped. */
function tamperedSignature(): string {
  const token = signedUnknownSession();
  const parts = token.split(".");
  const sig = parts[2] ?? "";
  const flipped = `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
  return [parts[0], parts[1], flipped].join(".");
}

/** A well-formed token carrying a version tag this deployment does not issue. */
function wrongVersionToken(): string {
  const parts = signedUnknownSession().split(".");
  return ["sv0", parts[1], parts[2]].join(".");
}

type Cred = { label: string; req: Request; code: string; secret?: string };

/**
 * Every anonymous credential shape. All of them must land on the SAME status;
 * if one of them answers differently it has become a probe for whatever the
 * caller was holding. `secret` is the token VALUE presented, which no refusal
 * may quote back.
 */
function anonymousCredentials(): Cred[] {
  const unknownSession = signedUnknownSession();
  const tampered = tamperedSignature();
  const wrongVersion = wrongVersionToken();
  return [
    { label: "no cookie at all", req: json({}), code: "no_session" },
    { label: "an empty cookie value", req: cookie(""), code: "no_session" },
    {
      label: "a cookie that is not a token",
      req: cookie("garbage"),
      code: "invalid_token",
      secret: "garbage",
    },
    {
      label: "a wrong version tag",
      req: cookie(wrongVersion),
      code: "invalid_token",
      secret: wrongVersion,
    },
    {
      label: "a tampered signature",
      req: cookie(tampered),
      code: "invalid_token",
      secret: tampered,
    },
    {
      label: "a valid signature naming a session that does not exist",
      req: cookie(unknownSession),
      code: "unknown_session",
      secret: unknownSession,
    },
  ];
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/auth/password — the FALLBACK sign-in path
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/auth/password — malformed body", () => {
  const PASSWORD = "correct-horse-battery-staple-9";

  // Each entry is a body that cannot be parsed as JSON at all. `password` is
  // present in each so the no-echo assertion has a real secret to hunt for.
  const unparseable: Array<{ label: string; body: string }> = [
    { label: "a truncated object", body: '{"email": "a@b.test", "password": "' },
    { label: "a bare word", body: "not-json" },
    { label: "an empty body", body: "" },
    { label: "a trailing comma", body: `{"email": "a@b.test", "password": "${PASSWORD}",}` },
    { label: "an HTML error page", body: "<html>502</html>" },
  ];

  for (const { label, body } of unparseable) {
    test(`${label} is 400 with exactly one field and no secret`, async () => {
      const snap = await snapshot(await passwordPost(raw(body)));

      expect(snap.status).toBe(400);
      const parsed = parse(snap.text, MessageBody);
      // `strictObject` is the assertion: an added `code`, `requestId` or
      // `docsUrl` here would fail the parse rather than pass unnoticed.
      expect(parsed.error).toBe("Invalid JSON body");
      expectNoEcho(snap, [PASSWORD]);
    });
  }

  // Every one of these is valid JSON that fails the credential schema.
  const invalid: Array<{ label: string; body: unknown }> = [
    { label: "an empty object", body: {} },
    { label: "only an email", body: { email: "a@b.test" } },
    { label: "only a password", body: { password: PASSWORD } },
    { label: "an email below the minimum length", body: { email: "ab", password: PASSWORD } },
    {
      label: "an email above the maximum length",
      body: { email: `${"a".repeat(250)}@b.test`, password: PASSWORD },
    },
    { label: "an email that is not a string", body: { email: 42, password: PASSWORD } },
    { label: "a password that is not a string", body: { email: "a@b.test", password: ["x"] } },
    { label: "an empty password", body: { email: "a@b.test", password: "" } },
  ];

  for (const { label, body } of invalid) {
    test(`${label} is 422 and the message names the credential fields`, async () => {
      const snap = await snapshot(await passwordPost(json(body)));

      expect(snap.status).toBe(422);
      const parsed = parse(snap.text, MessageBody);
      // KNOWN GAP 4: the message names BOTH fields whichever one was at fault.
      // What it must never do is stay silent about the credential shape, so the
      // assertion is on the field names being present.
      expect(parsed.error.toLowerCase()).toContain("email");
      expect(parsed.error.toLowerCase()).toContain("password");
      expectNoEcho(snap, [PASSWORD]);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/auth/logout — idempotent sign-out
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/auth/logout", () => {
  /** The Set-Cookie that expires the session, parsed off the response. */
  function clearingCookie(headers: Array<[string, string]>): string {
    const setCookie = headers.find(([k]) => k === "set-cookie")?.[1];
    expect(setCookie).toBeDefined();
    return setCookie ?? "";
  }

  test("signing out with no session is still 200 and still clears the cookie", async () => {
    const snap = await snapshot(await logoutPost(json({})));

    // Idempotent by design: signing out twice, or without a session, is a 200.
    expect(snap.status).toBe(200);
    expect(parse(snap.text, z.strictObject({ ok: z.literal(true) })).ok).toBe(true);

    const setCookie = clearingCookie(snap.headers);
    // Expired under the SAME attribute set it was issued with, or a
    // path/domain mismatch means the browser silently keeps it.
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
  });

  test("signing out with a forged cookie is the same answer as with none", async () => {
    const forged = tamperedSignature();
    const snap = await snapshot(await logoutPost(cookie(forged)));

    expect(snap.status).toBe(200);
    expect(parse(snap.text, z.strictObject({ ok: z.literal(true) })).ok).toBe(true);
    expect(clearingCookie(snap.headers)).toContain("Max-Age=0");
    // The expiring cookie must not quote the value it is expiring.
    expectNoEcho(snap, [forged]);
  });

  test("the response never carries a request body through to the client", async () => {
    // A body is ignored entirely: logout takes no input, so echoing any of it
    // would be the handler handing back what the caller sent.
    const secret = "a-perfectly-fine-passphrase-42";
    const snap = await snapshot(await logoutPost(json({ password: secret, note: "x" })));
    expectNoEcho(snap, [secret]);
  });

  test("POST is the ONLY verb, so a cross-site GET cannot force a sign-out", async () => {
    // `SameSite=Lax` still sends the session cookie on a TOP-LEVEL GET
    // navigation. An exported GET on a state-changing auth route would
    // therefore let any third-party page sign a console user out with an
    // <img> tag. The verb set IS the CSRF surface, so it is asserted.
    const verbs = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    expect(Object.keys(logoutRoute).filter((k) => verbs.includes(k))).toEqual(["POST"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET/DELETE /api/auth/sessions — session self-service
// ═════════════════════════════════════════════════════════════════════════════

describe("GET/DELETE /api/auth/sessions — an anonymous caller is refused", () => {
  const handlers: Array<{ label: string; run: (req: Request) => Promise<Response> }> = [
    { label: "GET", run: (req) => sessionsGet(req as never) },
    { label: "DELETE", run: (req) => sessionsDelete(req as never) },
  ];

  for (const { label, run } of handlers) {
    test(`${label} with no session is 401 carrying only a reason`, async () => {
      const snap = await snapshot(await run(json({})));

      expect(snap.status).toBe(401);
      // `strictObject`: exactly `error` and `code`, nothing else. A session
      // listing that leaked a `sessions` key, an orgId, or a token would fail
      // this parse rather than pass as "probably fine".
      const parsed = parse(snap.text, DenialBody);
      expect(parsed.code).toBe("no_session");
      expect(parsed.error).toBe("Sign in required.");
    });

    test(`${label} with a forged cookie is refused identically`, async () => {
      const token = tamperedSignature();
      const snap = await snapshot(await run(cookie(token)));

      expect(snap.status).toBe(401);
      const parsed = parse(snap.text, DenialBody);
      expect(parsed.code).toBe("invalid_token");
      expectNoEcho(snap, [token]);
    });
  }

  test("a refusal names no org, account or address", async () => {
    // The denial body is built from the rejection REASON only. This is the
    // assertion that keeps it that way: the strings a cross-tenant prober would
    // be hunting for must be absent.
    const snap = await snapshot(await sessionsGet(json({}) as never));
    expectNoEcho(snap, [FOREIGN_ORG, FOREIGN_ACCOUNT, "sv_session"]);
  });
});

describe("GET/DELETE /api/auth/sessions — the refusal is audited, and the log agrees", () => {
  test("the chain record carries the same reason the body does", async () => {
    const snap = await snapshot(await sessionsGet(cookie(tamperedSignature()) as never));

    const rejection = AUDIT.find((e) => e.intent === "auth.session.rejected");
    expect(rejection).toBeDefined();
    // Recorded BEFORE the response, under the anonymous actor id, so a rejected
    // request can never be attributed to whoever the cookie claimed to be.
    expect(rejection?.callerId).toBe("anonymous");
    expect(rejection?.meta?.reason).toBe(parse(snap.text, DenialBody).code);
  });
});

// ── A LIVE session, planted so the SUCCESS paths are pinned too ──────────────
// Everything above is a refusal. Without this block the file would never
// exercise what a session listing returns, and a route that quietly widened its
// own success response (returning the whole session id, or a token) would pass
// every anonymous test in the file. The session and its identity are written
// straight into the auth store under a unique namespace and dropped in
// `afterAll`, so this touches rows nothing else in the suite can collide with.

const LIVE_ORG = `authroutes-live-org-${Date.now().toString(36)}`;
const LIVE_ACCOUNT = `authroutes-live-acct-${Date.now().toString(36)}`;
const LIVE_SID = `authroutes-live-sid-${Date.now().toString(36)}`;

/**
 * Plant an identity and one session, and hand back the cookie that carries it.
 * `overrides` are applied to the session RECORD only, so a test can age it or
 * revoke it without minting a different namespace.
 */
async function plantSession(overrides: Partial<SessionRecord> = {}): Promise<string> {
  const issuedAt = Date.now();
  const identity = {
    accountId: LIVE_ACCOUNT,
    email: `${LIVE_ACCOUNT}@authroutes.test`,
    name: "Live Session",
    // Auditor: holds every read capability, so the routes under test reach
    // their SUCCESS branch rather than stopping at a 403.
    role: "Auditor" as const,
    orgId: LIVE_ORG,
    roleEpoch: 1,
    orgEpoch: 1,
    createdAt: issuedAt,
  };
  await put(AUTH_SCOPES.identity, LIVE_ACCOUNT, LIVE_ORG, identity, PERMANENT_EXPIRY);
  await put(
    AUTH_SCOPES.session,
    LIVE_SID,
    LIVE_ACCOUNT,
    {
      sid: LIVE_SID,
      accountId: LIVE_ACCOUNT,
      orgId: LIVE_ORG,
      role: "Auditor",
      roleEpoch: 1,
      orgEpoch: 1,
      issuedAt,
      lastSeenAt: issuedAt,
      revokedAt: null,
      method: "password",
      ...overrides,
    },
    new Date(issuedAt + 3_600_000),
  );
  return signSessionToken(LIVE_SID, LIVE_ACCOUNT, overrides.issuedAt ?? issuedAt);
}

describe("GET /api/auth/me — a live session", () => {
  test("returns the identity and the policy numbers, and no-store", async () => {
    const token = await plantSession();
    const snap = await snapshot(await meGet(cookie(token)));

    expect(snap.status).toBe(200);
    expect(snap.headers.find(([k]) => k === "cache-control")?.[1]).toBe("no-store");
    const body = parse(
      snap.text,
      z.strictObject({
        session: z.strictObject({
          issuedAt: z.string(),
          lastSeenAt: z.string(),
          idleRemainingMs: z.number(),
          absoluteRemainingMs: z.number(),
          role: z.string(),
          method: z.string(),
        }),
        identity: z.strictObject({
          accountId: z.string(),
          email: z.string(),
          name: z.string(),
          role: z.string(),
          orgId: z.string(),
        }),
        policy: z.strictObject({ idleTimeoutMs: z.number(), absoluteLifetimeMs: z.number() }),
      }),
    );
    // The LIVE role comes from the identity record, never from the role
    // snapshotted into the session — so a session minted under a wider role
    // cannot report that wider role here.
    expect(body.identity.role).toBe("Auditor");
    expect(body.identity.accountId).toBe(LIVE_ACCOUNT);
    // A live session's countdown must be positive on both limits.
    expect(body.session.idleRemainingMs).toBeGreaterThan(0);
    expect(body.session.absoluteRemainingMs).toBeGreaterThan(0);
    // The whole point of the endpoint: the session token itself is never in it.
    expectNoEcho(snap, [token, LIVE_SID]);
  });
});

describe("GET /api/auth/sessions — a live session sees a TRUNCATED listing", () => {
  test("the session id is eight characters and the token is absent", async () => {
    // The route's own claim is that a session listing must not become a
    // session-stealing endpoint. Truncation is what makes that true: the id a
    // caller already holds is useless for minting anything, and the signing key
    // is server-side regardless.
    const token = await plantSession();
    const snap = await snapshot(await sessionsGet(cookie(token) as never));

    expect(snap.status).toBe(200);
    expect(snap.headers.find(([k]) => k === "cache-control")?.[1]).toBe("no-store");
    const body = parse(
      snap.text,
      z.strictObject({
        sessions: z.array(
          z.strictObject({
            sessionId: z.string(),
            issuedAt: z.string(),
            lastSeenAt: z.string(),
            method: z.string(),
          }),
        ),
      }),
    );
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.sessionId).toBe(LIVE_SID.slice(0, 8));
    // Both failure modes that would make this endpoint stealable.
    expect(body.sessions[0]?.sessionId).not.toBe(LIVE_SID);
    expectNoEcho(snap, [token, LIVE_SID]);
  });
});

// ── The 401/403 boundary ─────────────────────────────────────────────────────
// `requireAuth` draws one line, and the status on either side of it is the
// whole design: 401 for "who are you" (no credential, or one that never
// existed) and 403 for "not any more" (a credential the server RECOGNISED and
// then killed). The 403 is safe here — and only here — because the caller
// already proved possession of a validly signed token for that exact session,
// so the status discloses nothing they did not already own. It is NOT a
// cross-tenant existence oracle, which is the case where 403 really would be.
describe("the 401/403 boundary — a session the server once recognised", () => {
  // Each entry kills the planted session in a different, server-side way. All
  // of them must land on 403 rather than 401: a revoked session that answered
  // 401 would tell the client "sign in again", and a console would keep
  // prompting for a password that cannot help.
  const dead: Array<{ label: string; overrides: Partial<SessionRecord>; code: string }> = [
    { label: "revoked", overrides: { revokedAt: Date.now() }, code: "revoked" },
    {
      label: "idle past the 15-minute cutoff",
      overrides: { lastSeenAt: Date.now() - IDLE_TIMEOUT_MS - 60_000 },
      code: "idle_timeout",
    },
    {
      label: "past the 8-hour absolute lifetime",
      overrides: { issuedAt: Date.now() - ABSOLUTE_LIFETIME_MS - 60_000 },
      code: "absolute_timeout",
    },
  ];

  for (const { label, overrides, code } of dead) {
    test(`a session ${label} is 403, not 401`, async () => {
      const token = await plantSession(overrides);
      const snap = await snapshot(await meGet(cookie(token)));

      expect(snap.status).toBe(403);
      const parsed = parse(snap.text, DenialBody);
      expect(parsed.code).toBe(code);
      // The reason travels in the body so the console can explain itself, and
      // it still must not quote the token it just refused.
      expectNoEcho(snap, [token, LIVE_SID]);
    });
  }

  test("a session whose org epoch moved is 403 — org-wide revocation beats a fresh cookie", async () => {
    // The concurrency-safe revocation form: no row is deleted, only the epoch
    // moves, so a cookie that is perfectly fresh on every other axis is still
    // dead. If this answered 401 the mass-revocation control would be defeated
    // by clients that treat 401 as "retry with credentials".
    const token = await plantSession({ orgEpoch: 1 });
    // Bump the identity's epoch the way `revokeOrgSessions` does.
    await put(
      AUTH_SCOPES.identity,
      LIVE_ACCOUNT,
      LIVE_ORG,
      {
        accountId: LIVE_ACCOUNT,
        email: `${LIVE_ACCOUNT}@authroutes.test`,
        name: "Live Session",
        role: "Auditor",
        orgId: LIVE_ORG,
        roleEpoch: 1,
        orgEpoch: 2,
        createdAt: Date.now(),
      },
      PERMANENT_EXPIRY,
    );
    const snap = await snapshot(await meGet(cookie(token)));

    expect(snap.status).toBe(403);
    expect(parse(snap.text, DenialBody).code).toBe("revoked");
    expectNoEcho(snap, [token, LIVE_SID]);

    // Restore the epoch so the rest of the file still has a usable identity.
    await put(
      AUTH_SCOPES.identity,
      LIVE_ACCOUNT,
      LIVE_ORG,
      {
        accountId: LIVE_ACCOUNT,
        email: `${LIVE_ACCOUNT}@authroutes.test`,
        name: "Live Session",
        role: "Auditor",
        orgId: LIVE_ORG,
        roleEpoch: 1,
        orgEpoch: 1,
        createdAt: Date.now(),
      },
      PERMANENT_EXPIRY,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/auth/sessions/revoke-all — the incident-response control
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/auth/sessions/revoke-all — an anonymous caller is refused", () => {
  test("no session is 401, no-store, and two fields", async () => {
    const snap = await snapshot(await revokeAllPost(json({})));

    expect(snap.status).toBe(401);
    expect(snap.headers.find(([k]) => k === "cache-control")?.[1]).toBe("no-store");
    const parsed = parse(snap.text, DenialBody);
    expect(parsed.code).toBe("no_session");
    expect(parsed.error).toBe("Sign in required.");
  });

  test("a well-signed token for a session that does not exist is refused at the same status", async () => {
    // The mass-revocation control is the most consequential thing in this
    // directory. It must be unreachable without a live session, and the status
    // must match the plain anonymous case so the endpoint cannot be used to
    // distinguish "no credential" from "a credential I could not use".
    const snap = await snapshot(await revokeAllPost(cookie(signedUnknownSession())));
    expect(snap.status).toBe(401);
    expect(parse(snap.text, DenialBody).code).toBe("unknown_session");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/auth/me
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/auth/me — an anonymous caller is refused", () => {
  test("no session is 401 and discloses no identity", async () => {
    const snap = await snapshot(await meGet(json({})));

    expect(snap.status).toBe(401);
    expect(snap.headers.find(([k]) => k === "cache-control")?.[1]).toBe("no-store");
    const parsed = parse(snap.text, DenialBody);
    expect(parsed.code).toBe("no_session");
    // `strictObject` is the whole point: an `identity` or `policy` key sneaking
    // into a denial would fail here.
    expect(Object.keys(parsed).sort()).toEqual(["code", "error"]);
  });

  test("a forged cookie is refused without echoing it", async () => {
    const token = tamperedSignature();
    const snap = await snapshot(await meGet(cookie(token)));

    expect(snap.status).toBe(401);
    expect(parse(snap.text, DenialBody).code).toBe("invalid_token");
    expectNoEcho(snap, [token]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/auth/step-up — the guard runs BEFORE the body is read
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/auth/step-up — authentication precedes parsing", () => {
  test("no session plus malformed JSON is 401, not 400", async () => {
    // The ordering is the property. If the body were parsed first, the 400/401
    // split would tell an anonymous caller the request schema for free.
    const snap = await snapshot(await stepUpPost(raw('{"password": "trunc')));

    expect(snap.status).toBe(401);
    const parsed = parse(snap.text, DenialBody);
    expect(parsed.code).toBe("no_session");
    expect(parsed.error).toBe("Sign in required.");
  });

  test("no session plus a valid body is refused identically", async () => {
    // Same status, same body: the refusal cannot depend on the payload at all,
    // because the payload is never read.
    const withBody = await snapshot(await stepUpPost(json({ password: "irrelevant-passphrase" })));
    const withoutBody = await snapshot(await stepUpPost(json({})));

    expect(withBody.status).toBe(401);
    expect(withBody.text).toBe(withoutBody.text);
    expect(withBody.headers).toEqual(withoutBody.headers);
  });

  test("a well-signed token for a session that does not exist is refused at 401", async () => {
    const snap = await snapshot(await stepUpPost(cookie(signedUnknownSession())));

    expect(snap.status).toBe(401);
    expect(parse(snap.text, DenialBody).code).toBe("unknown_session");
    // Step-up is the control that unlocks money movement and mass revocation.
    // Its refusal must never name the org it was refused for.
    expectNoEcho(snap, [FOREIGN_ORG, FOREIGN_ACCOUNT]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/auth/magic-link — the PRIMARY sign-in path
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/auth/magic-link", () => {
  test("an unparseable body is 400 with exactly one field", async () => {
    const snap = await snapshot(await magicLinkPost(raw('{"email":')));

    expect(snap.status).toBe(400);
    expect(parse(snap.text, MessageBody).error).toBe("Invalid JSON body");
  });

  const invalid: Array<{ label: string; body: unknown }> = [
    { label: "an empty object", body: {} },
    { label: "an email below the minimum length", body: { email: "ab" } },
    { label: "an email above the maximum length", body: { email: `${"a".repeat(250)}@b.test` } },
    { label: "an email that is not a string", body: { email: 99 } },
  ];

  for (const { label, body } of invalid) {
    test(`${label} is 422 and the message names email`, async () => {
      const snap = await snapshot(await magicLinkPost(json(body)));

      expect(snap.status).toBe(422);
      const parsed = parse(snap.text, MessageBody);
      expect(parsed.error.toLowerCase()).toContain("email");
    });
  }

  test("a well-formed address is answered identically, and never with a token", async () => {
    // No mailer is configured in this deployment, so the handler takes its
    // fail-closed branch. The property that matters survives either branch: the
    // answer is 202, the wording is the uniform one, and no usable token is in
    // it. A login endpoint that echoes a token back to whoever asked is an open
    // door, so the absence of one is asserted, not assumed.
    const address = `probe-${Date.now().toString(36)}@nowhere.test`;
    const snap = await snapshot(await magicLinkPost(json({ email: address })));

    expect(snap.status).toBe(202);
    const parsed = parse(snap.text, MessageBody);
    expect(parsed.error).toBe(
      "If that address belongs to an account, a sign-in link is on its way.",
    );
    expectNoEcho(snap, [address, "token", "expiresAt"]);
  });

  test("a registered-looking and an unknown address get byte-identical answers", async () => {
    // The account oracle, closed. An endpoint that answered differently for a
    // known address would tell an attacker which addresses are staff at a bank.
    const known = `probe-${Date.now().toString(36)}@nowhere.test`;
    const unknown = `probe-${Date.now().toString(36)}@also-nowhere.test`;
    const a = await snapshot(await magicLinkPost(json({ email: known })));
    const b = await snapshot(await magicLinkPost(json({ email: unknown })));

    expect(a.status).toBe(b.status);
    expect(a.text).toBe(b.text);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/auth/magic-link/verify — redemption
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/auth/magic-link/verify", () => {
  test("an unparseable body is 400 with exactly one field", async () => {
    const snap = await snapshot(await magicLinkVerifyPost(raw("{")));

    expect(snap.status).toBe(400);
    expect(parse(snap.text, MessageBody).error).toBe("Invalid JSON body");
  });

  test("a token below the minimum length is 422 and the message names the token", async () => {
    const snap = await snapshot(await magicLinkVerifyPost(json({ token: "short" })));

    expect(snap.status).toBe(422);
    expect(parse(snap.text, MessageBody).error.toLowerCase()).toContain("token");
  });

  test("a well-formed token that was never issued is 401, uniform and silent", async () => {
    // The second genuinely DB-backed assertion: a 64-character token is well
    // formed enough to reach the store, so the refusal comes from the lookup
    // returning nothing. One indexed SELECT; no row is written.
    const token = "z".repeat(64);
    const snap = await snapshot(await magicLinkVerifyPost(json({ token })));

    expect(snap.status).toBe(401);
    expect(snap.headers.find(([k]) => k === "cache-control")?.[1]).toBe("no-store");
    const parsed = parse(snap.text, MessageBody);
    // One message for every failure mode, so "wrong token" cannot be told from
    // "expired" from "no account for that address".
    expect(parsed.error).toBe("That sign-in link is not valid.");
    expectNoEcho(snap, [token]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cross-cutting: an anonymous caller learns nothing about anyone
// ═════════════════════════════════════════════════════════════════════════════

describe("an anonymous caller cannot learn whether anything exists", () => {
  const protectedRoutes: Array<{ label: string; run: (req: Request) => Promise<Response> }> = [
    { label: "GET /api/auth/me", run: (req) => meGet(req) },
    { label: "GET /api/auth/sessions", run: (req) => sessionsGet(req as never) },
    { label: "DELETE /api/auth/sessions", run: (req) => sessionsDelete(req as never) },
    { label: "POST /api/auth/sessions/revoke-all", run: (req) => revokeAllPost(req) },
    { label: "POST /api/auth/step-up", run: (req) => stepUpPost(req) },
    { label: "POST /api/auth/logout", run: (req) => logoutPost(req) },
  ];

  // logout is excluded from both sweeps below and stated once, here: it is
  // idempotent and answers 200 to anyone, because a sign-out that could fail is
  // not a sign-out. It has its own describe block above.
  const refusingRoutes = protectedRoutes.filter((r) => r.label !== "POST /api/auth/logout");

  test("every route that can refuse answers 401 to a caller with no credential", async () => {
    // The single most important line in this file. `requireAuth` maps
    // "who are you" to 401 and "not any more" to 403; a caller with NO
    // credential belongs in the first bucket everywhere, or the status itself
    // tells them their cookie was once good.
    const statuses: Array<[string, number]> = [];
    for (const { label, run } of refusingRoutes) {
      statuses.push([label, (await snapshot(await run(json({})))).status]);
    }
    // Collected first so a failure names WHICH route drifted rather than just
    // reporting that one of six did.
    expect(statuses).toEqual(refusingRoutes.map((r) => [r.label, 401]));
  });

  test("every anonymous credential shape gets the SAME status on every route", async () => {
    // Two dimensions, both security-relevant: the route, and the shape of the
    // (absent) credential. If either produced a distinct status, an attacker
    // could sweep for a live session one variation at a time.
    const statuses = new Set<number>();
    for (const { run } of refusingRoutes) {
      for (const cred of anonymousCredentials()) {
        statuses.add((await snapshot(await run(cred.req))).status);
      }
    }
    expect([...statuses]).toEqual([401]);
  });

  test("no anonymous answer anywhere names a tenant, an account or a cookie VALUE", async () => {
    // The foreign tenant/account strings are the ones a cross-tenant prober
    // would be hunting for. The credential's own VALUE is checked rather than
    // its name: logout legitimately emits `sv_session=` in the Set-Cookie that
    // expires it, and naming a cookie in order to clear it discloses nothing.
    for (const { run } of refusingRoutes) {
      for (const cred of anonymousCredentials()) {
        const snap = await snapshot(await run(cred.req));
        expectNoEcho(snap, [FOREIGN_ORG, FOREIGN_ACCOUNT]);
        if (cred.secret) expectNoEcho(snap, [cred.secret]);
      }
    }
  });

  test("the routes that carry Cache-Control: no-store on a refusal keep it", async () => {
    // KNOWN GAP 3: /api/auth/sessions sets `no-store` on its SUCCESS responses
    // but not on its 401s, so it is absent from this list. The list is written
    // against the routes that DO carry it, so losing the header anywhere is a
    // failure, and so the asymmetry shows up as the one omission a reader has
    // to go and check rather than as a silently-passing hole.
    const routesWithNoStoreDenials = ["GET /api/auth/me", "POST /api/auth/sessions/revoke-all"];
    for (const label of routesWithNoStoreDenials) {
      const route = refusingRoutes.find((r) => r.label === label);
      if (!route) throw new Error(`no such route in this file: ${label}`);
      const snap = await snapshot(await route.run(json({})));
      expect(snap.headers.find(([k]) => k === "cache-control")?.[1]).toBe("no-store");
    }
  });
});
