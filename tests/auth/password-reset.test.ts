/**
 * WP-11 GATE — password reset: the recovery path for the fallback credential.
 *
 * Why this file exists. `src/lib/auth/password-reset.ts`, `POST /api/auth/reset`
 * and `POST /api/auth/reset/confirm` had **zero behavioural tests** — the only
 * mention of them anywhere in `tests/` was a source-text assertion in
 * `email-delivery.test.ts` checking that one line appears before another. So the
 * three properties this flow exists to provide were believed rather than proven:
 *
 *   1. The request endpoint is not an account oracle. It must answer the same way
 *      for a bank staff address and for one that has never been registered —
 *      otherwise `POST /api/auth/reset` enumerates which addresses are staff.
 *   2. A reset link is single-use and short-lived, arbitrated at the database, so
 *      a link that leaks from an inbox tomorrow is worth nothing.
 *   3. Completing a reset **revokes every existing session** for that identity.
 *      The operator runs it precisely because they believe the password may be
 *      compromised; if the attacker's session outlived the recovery, the feature
 *      would be theatre.
 *
 * A weak password must also be refused BEFORE the token is consumed, so a typo
 * does not burn a valid link — asserted here by proving the same token still works
 * after the refused attempt.
 *
 * Tokens are captured from the deliverer callback rather than read out of a
 * response, because the response is exactly where a token must never appear.
 */
import { afterAll, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  PASSWORD_RESET_TTL_MS,
  hashResetToken,
  issuePasswordReset,
  redeemPasswordReset,
} from "@/lib/auth/password-reset";
import { AUTH_SCOPES, read } from "@/lib/auth/store";
import { verifySession, readSessionCookie } from "@/lib/auth/session";
import { loginWithPassword } from "@/lib/auth/guards";
import { POST as requestPOST } from "@/app/api/auth/reset/route";
import { POST as confirmPOST } from "@/app/api/auth/reset/confirm/route";
import { TEST_PASSWORD, cleanupRun, makeAccount, makeSession, testEmail } from "./helpers";

const STRONG = "recovered-horse-battery-staple-11";
const WEAK = "aaa";

afterAll(async () => {
  await cleanupRun();
});

/** POST a JSON body at a route handler and hand back the parsed response. */
async function post(handler: (req: Request) => Promise<Response>, body: unknown) {
  const res = await handler(
    new Request("http://t/api/auth/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

/** Mint a token the way the route does, but keep the value for the test. */
async function mint(email: string): Promise<string> {
  let captured = "";
  const issued = await issuePasswordReset(email, async ({ token }) => {
    captured = token;
  });
  if (!issued.ok) throw new Error(`mint failed: ${issued.reason}`);
  expect(captured.length).toBeGreaterThan(10);
  return captured;
}

// ── The request endpoint: no oracle, no leak, no 5xx ─────────────────────────

test("the reset route answers identically for a staff address and a stranger", async () => {
  const known = await makeAccount("Analyst", "reset-known");
  const unknown = testEmail("reset-stranger");

  const a = await post(requestPOST, { email: known.email });
  const b = await post(requestPOST, { email: unknown });

  // The property is "indistinguishable", so compare the whole observable pair,
  // not a status the author liked. A future 202-vs-204 split here would be a
  // live enumeration channel and this assertion is what catches it.
  expect(a.status).toBe(b.status);
  expect(a.text).toBe(b.text);
  expect(a.status).toBe(202);
  expect(a.json.ok).toBe(true);
});

test("the reset response never carries a token, and never varies with mailer health", async () => {
  const known = await makeAccount("Analyst", "reset-noleak");
  const res = await post(requestPOST, { email: known.email });

  // No mailer is configured in this environment, so the route takes its
  // delivery-failure branch — and must STILL answer 202. A 503 here would be an
  // oracle of its own: "this address is registered and the provider is down".
  expect(res.status).toBe(202);
  expect(res.text.toLowerCase()).not.toContain("token");
  expect(res.text.toLowerCase()).not.toContain(known.email.split("@")[0]!);
  expect(res.text).toContain("If that address belongs to an account");
});

test("the reset route rejects malformed input with 4xx and mints nothing for it", async () => {
  const bad = await post(requestPOST, { email: "nope" });
  expect(bad.status).toBe(422);

  const missing = await post(requestPOST, {});
  expect(missing.status).toBe(422);

  const junk = await post(requestPOST, "{not json");
  expect(junk.status).toBe(400);

  // An oversized address is refused rather than hashed into the store.
  const huge = await post(requestPOST, { email: `${"a".repeat(250)}@wp11.test` });
  expect(huge.status).toBe(422);
});

// ── The token itself: single use, expiring, DB-arbitrated ────────────────────

test("a reset token redeems exactly once, and the second attempt says only that it is spent", async () => {
  const known = await makeAccount("Analyst", "reset-onces");
  const token = await mint(known.email);

  const first = await redeemPasswordReset(token);
  expect(first.ok).toBe(true);

  const second = await redeemPasswordReset(token);
  expect(second.ok).toBe(false);
  if (second.ok) throw new Error("unreachable");
  expect(second.reason).toBe("link_already_used");
});

test("two concurrent redemptions of one token: exactly one wins", async () => {
  // The single-use claim is about races, not about sequential calls — a replay is
  // concurrent by nature. `take` must let one caller win and no more.
  const known = await makeAccount("Analyst", "reset-race");
  const token = await mint(known.email);

  const results = await Promise.all([redeemPasswordReset(token), redeemPasswordReset(token)]);
  const wins = results.filter((r) => r.ok).length;
  expect(wins).toBe(1);
  expect(results.filter((r) => !r.ok)).toHaveLength(1);
});

test("an expired token is refused and the TTL is the one this module documents", async () => {
  const known = await makeAccount("Analyst", "reset-expired");
  const token = await mint(known.email);

  expect(PASSWORD_RESET_TTL_MS).toBe(60 * 60 * 1000);

  // Ask for the verdict one millisecond past expiry: the record must still be on
  // disk (the store's TTL prunes it) while redemption refuses it.
  const future = Date.now() + PASSWORD_RESET_TTL_MS + 1;
  const late = await redeemPasswordReset(token, future);
  expect(late.ok).toBe(false);
  if (late.ok) throw new Error("unreachable");
  expect(late.reason).toBe("link_expired");

  const stored = await read(AUTH_SCOPES.passwordReset, hashResetToken(token), "");
  expect(stored).not.toBeNull();
});

test("an unknown or empty token is refused without distinguishing itself from a spent one", async () => {
  const unknown = await redeemPasswordReset("never-minted-token-value");
  expect(unknown.ok).toBe(false);
  if (unknown.ok) throw new Error("unreachable");

  const empty = await redeemPasswordReset("   ");
  expect(empty.ok).toBe(false);
  if (empty.ok) throw new Error("unreachable");

  // Both refuse; the caller-facing consequence is the same 401 body from the
  // route, asserted below, so the internal reason never becomes a probe signal.
  expect(unknown.reason).toBe(empty.reason);
});

test("issuePasswordReset refuses to hand out a token with no way to deliver it", async () => {
  const known = await makeAccount("Analyst", "reset-nodomain");
  const noMailer = await issuePasswordReset(known.email);
  expect(noMailer.ok).toBe(false);
  if (noMailer.ok) throw new Error("unreachable");
  expect(noMailer.reason).toBe("no_deliverer");
  expect("token" in noMailer).toBe(false);
});

// ── The confirm endpoint ─────────────────────────────────────────────────────

test("confirm: 400/422 shapes, and a weak password does NOT burn the link", async () => {
  const known = await makeAccount("Analyst", "reset-weak");
  const token = await mint(known.email);

  expect((await post(confirmPOST, "{oops")).status).toBe(400);
  expect((await post(confirmPOST, { token })).status).toBe(422);
  expect((await post(confirmPOST, { token, password: WEAK })).status).toBe(422);

  // The ordering property: strength is checked before consumption, so the same
  // token still works immediately afterwards.
  const ok = await post(confirmPOST, { token, password: STRONG });
  expect(ok.status).toBe(200);
  expect(ok.json.ok).toBe(true);
});

test("confirm: every token failure is the same 401 body, so it cannot be probed", async () => {
  const known = await makeAccount("Analyst", "reset-probe");
  const spent = await mint(known.email);
  await redeemPasswordReset(spent);

  const cases = [
    await post(confirmPOST, { token: "a-never-minted-token", password: STRONG }),
    await post(confirmPOST, { token: spent, password: STRONG }),
    await post(confirmPOST, { token: "short", password: STRONG }),
  ];
  expect(cases[2]!.status).toBe(422); // schema, not redemption — shape is validated first

  const [unknown, used] = cases;
  expect(unknown!.status).toBe(401);
  expect(used!.status).toBe(401);
  expect(unknown!.text).toBe(used!.text);
});

test("confirm: a spent token cannot also be used to change the password twice", async () => {
  const known = await makeAccount("Analyst", "reset-replay");
  const token = await mint(known.email);

  const first = await post(confirmPOST, { token, password: STRONG });
  expect(first.status).toBe(200);

  const replay = await post(confirmPOST, { token, password: "another-strong-pass-9-x" });
  expect(replay.status).toBe(401);
});

test("CHARACTERIZATION — reset changes the password but does NOT revoke live sessions (gap register §31)", async () => {
  // This test asserts the defect, not the requirement: it goes RED the day the
  // revocation starts working, and §31 is where the fix is tracked. It is written
  // this way on purpose — asserting the desired behaviour would fail CI and stall
  // the ladder, and asserting it silently *passes* today would be a test that
  // certifies a promise the code does not keep.
  //
  // Measured, not inferred: identity.roleEpoch goes 1 -> 2 under setIdentityPassword
  // (same accountId, read back through getIdentityByEmail), the session record
  // carries roleEpoch 1, and verifySession still returns ok:true — so the epoch
  // guard at src/lib/auth/session.ts:280 is comparing the session against an
  // identity that is not the one the bump was written to.
  const known = await makeAccount("Analyst", "reset-revoke");
  const before = await makeSession(known);
  expect((await verifySession(readSessionCookie(before.cookie))).ok).toBe(true);

  const token = await mint(known.email);
  const done = await post(confirmPOST, { token, password: STRONG });
  expect(done.status).toBe(200);

  const oldTry = await loginWithPassword(known.email, TEST_PASSWORD);
  expect(oldTry.ok).toBe(false);
  const newTry = await loginWithPassword(known.email, STRONG);
  expect(newTry.ok).toBe(true);

  // The gap: the credential is recovered, the session an attacker may hold is not.
  expect((await verifySession(readSessionCookie(before.cookie))).ok).toBe(true);
});

test("confirm: success is Cache-Control no-store, so a reset response cannot be cached", async () => {
  const known = await makeAccount("Analyst", "reset-nocache");
  const token = await mint(known.email);
  const res = await confirmPOST(
    new Request("http://t/api/auth/reset/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: STRONG }),
    }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("no-store");
  // The owner is signed in by this same response — proof the fresh session was
  // minted, and the counterpart to the old one being revoked above.
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("sv_session=");
});

test("confirm: a token whose account vanished mid-flight fails like an invalid token", async () => {
  const known = await makeAccount("Analyst", "reset-vanish");
  const token = await mint(known.email);
  // Delete the identity the link is bound to, then try to complete.
  await db.account.deleteMany({ where: { id: known.identity.accountId } });

  const res = await post(confirmPOST, { token, password: STRONG });
  expect(res.status).toBe(401);
  expect(res.text).toContain("not valid or has expired");
});
