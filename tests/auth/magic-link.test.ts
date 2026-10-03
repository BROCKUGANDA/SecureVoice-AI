/**
 * WP-11 GATE — magic-link sign-in (the PRIMARY operator path) and the password
 * fallback, plus the store primitives they rest on.
 *
 * The brief makes email magic link primary and password the fallback, so this
 * file asserts the PRIMARY path works properly rather than treating it as an
 * afterthought:
 *   · a link is single-use, arbitrated by the database
 *   · a link expires
 *   · redemption NEVER creates an account (provisioning is invite-only)
 *   · with no mailer configured, `issueMagicLink` REFUSES rather than returning
 *     the token to the caller — otherwise the "primary" path is an open door
 *
 * The store section underneath covers the exactly-once primitive that every
 * control in WP-11 depends on: `take` must let exactly one of N concurrent
 * callers win, and `put` must overwrite rather than accumulate.
 */

import { afterAll, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { issueMagicLink, redeemMagicLink } from "@/lib/auth/magic-link";
import { AUTH_SCOPES, put, read, take, patch, drop, listFor } from "@/lib/auth/store";
import { MAGIC_LINK_TTL_MS } from "@/lib/auth/constants";
import { PERMANENT_EXPIRY } from "@/lib/auth/store";
import { loginWithPassword } from "@/lib/auth/guards";
import { POST as magicLinkPOST } from "@/app/api/auth/magic-link/route";
import { POST as verifyPOST } from "@/app/api/auth/magic-link/verify/route";
import { POST as passwordPOST } from "@/app/api/auth/password/route";
import { makeAccount, makeInvite, cleanupRun, TEST_PASSWORD, testEmail, uniq } from "./helpers";

afterAll(async () => {
  await cleanupRun();
});

// ── Magic link: the primary path ─────────────────────────────────────────────

test("with no mailer configured, issueMagicLink REFUSES and returns no token", async () => {
  const result = await issueMagicLink(testEmail("nomailer"));

  // This is the important assertion. Returning the token to the caller would
  // make the primary sign-in path an open door: anyone could POST any address
  // and receive a working token in the response.
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBe("no_deliverer");
  expect("token" in result).toBe(false);
});

test("the magic-link route never echoes a token, even with no mailer", async () => {
  const email = testEmail("route");
  const response = await magicLinkPOST(
    new Request("http://t/api/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  );

  // Uniform acknowledgement, so the endpoint is not an account oracle.
  expect(response.status).toBe(202);
  const body = (await response.json()) as Record<string, unknown>;
  const serialised = JSON.stringify(body);
  expect(serialised).not.toContain("token");
  expect(serialised.toLowerCase()).not.toContain(email);
});

test("the magic-link route answers identically for a known and an unknown address", async () => {
  const known = await makeAccount("Analyst", "known");
  const unknown = testEmail("unknown-address");

  const knownRes = await magicLinkPOST(
    new Request("http://t/api/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: known.email }),
    }),
  );
  const unknownRes = await magicLinkPOST(
    new Request("http://t/api/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: unknown }),
    }),
  );

  expect(knownRes.status).toBe(unknownRes.status);
  expect(await knownRes.text()).toBe(await unknownRes.text());
});

test("a magic link issues and can be redeemed, but only by an existing account", async () => {
  const account = await makeAccount("Analyst", "analyst");

  // Capture the token through a test delivery function, which is how a real
  // deployment's mailer would receive it.
  let captured = "";
  const issued = await issueMagicLink(account.email, async (input) => {
    captured = input.token;
  });
  expect(issued.ok).toBe(true);
  expect(captured).toHaveLength(43);

  const remaining = issued.ok ? issued.expiresAt - Date.now() : 0;
  expect(remaining).toBeGreaterThan(MAGIC_LINK_TTL_MS - 60_000);

  const redeemed = await redeemMagicLink(captured);
  expect(redeemed.ok).toBe(true);
  if (redeemed.ok) expect(redeemed.email).toBe(account.email);
});

test("a magic link is single-use — the second redemption is refused", async () => {
  const account = await makeAccount("Analyst", "analyst");
  let captured = "";
  await issueMagicLink(account.email, async (i) => {
    captured = i.token;
  });

  expect((await redeemMagicLink(captured)).ok).toBe(true);
  const second = await redeemMagicLink(captured);
  expect(second.ok).toBe(false);
  if (second.ok) throw new Error("unreachable");
  expect(second.reason).toBe("link_already_used");
});

test("concurrent redemptions of one link produce exactly one success", async () => {
  const account = await makeAccount("Analyst", "analyst");
  let captured = "";
  await issueMagicLink(account.email, async (i) => {
    captured = i.token;
  });

  const attempts = await Promise.all(Array.from({ length: 6 }, () => redeemMagicLink(captured)));
  expect(attempts.filter((r) => r.ok)).toHaveLength(1);
});

test("an expired magic link is refused", async () => {
  const account = await makeAccount("Analyst", "analyst");
  let captured = "";
  await issueMagicLink(account.email, async (i) => {
    captured = i.token;
  });

  // Redeem "in the future", past the link's own expiry.
  const result = await redeemMagicLink(captured, Date.now() + MAGIC_LINK_TTL_MS + 1000);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBe("link_expired");
});

test("a valid link for an address with NO account is refused — it cannot create one", async () => {
  const email = testEmail("noaccount");
  let captured = "";
  const issued = await issueMagicLink(email, async (i) => {
    captured = i.token;
  });
  expect(issued.ok).toBe(true);

  const redeemed = await redeemMagicLink(captured);
  expect(redeemed.ok).toBe(false);
  if (redeemed.ok) throw new Error("unreachable");
  expect(redeemed.reason).toBe("no_account");

  // The decisive part: no account was created.
  expect(await db.account.count({ where: { email } })).toBe(0);
});

test("an unknown magic token is refused", async () => {
  const result = await redeemMagicLink(uniq("bogus-magic-token"));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBe("unknown_link");
});

test("the verify route cannot sign in without a real token", async () => {
  const account = await makeAccount("Analyst", "analyst");
  const response = await verifyPOST(
    new Request("http://t/api/auth/magic-link/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: uniq("not-real") }),
    }),
  );
  expect(response.status).toBe(401);
});

// ── Password: the FALLBACK path ──────────────────────────────────────────────

test("the password path signs in a provisioned account", async () => {
  const account = await makeAccount("Admin", "admin");
  const result = await loginWithPassword(account.email, TEST_PASSWORD);

  if (!result.ok) throw new Error(`expected a session, got: ${result.reason}`);
  expect(result.identity.role).toBe("Admin");
  // `session` is the IssuedSession, so the method is one level down.
  expect(result.session.record.method).toBe("password");
});

test("the password path sets a session cookie on success", async () => {
  const account = await makeAccount("Admin", "admin");
  const response = await passwordPOST(
    new Request("http://t/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: account.email, password: TEST_PASSWORD }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("sv_session=");
  // HttpOnly and SameSite are the two attributes that matter most.
  expect(cookie.toLowerCase()).toContain("httponly");
  expect(cookie.toLowerCase()).toContain("samesite=lax");
});

test("a wrong password and an unknown address give the IDENTICAL error", async () => {
  const account = await makeAccount("Admin", "admin");

  const wrongPassword = await loginWithPassword(account.email, "not-the-password-x");
  const unknownAddress = await loginWithPassword(testEmail("ghost"), TEST_PASSWORD);

  expect(wrongPassword.ok).toBe(false);
  expect(unknownAddress.ok).toBe(false);
  if (wrongPassword.ok || unknownAddress.ok) throw new Error("unreachable");
  // Identical reason AND message — otherwise the endpoint enumerates staff.
  expect(wrongPassword.reason).toBe(unknownAddress.reason);
  expect(wrongPassword.error).toBe(unknownAddress.error);
});

test("an account with no password cannot sign in with one", async () => {
  // Invite-only accounts may be magic-link-only. A guessed password must not
  // create a session.
  const account = await makeAccount("Analyst", "nopw", { password: null });
  const result = await loginWithPassword(account.email, TEST_PASSWORD);
  expect(result.ok).toBe(false);
});

test("the session a password login issues is subject to the same idle policy", async () => {
  const account = await makeAccount("Admin", "admin");
  const result = await loginWithPassword(account.email, TEST_PASSWORD);
  if (!result.ok) throw new Error("unreachable");

  // The path issue sets the same record shape, so the idle check applies.
  const { verifySession } = await import("@/lib/auth/session");
  const check = await verifySession(result.session.token);
  expect(check.ok).toBe(true);
  if (!check.ok) throw new Error("unreachable");
  expect(check.session.lastSeenAt).toBeGreaterThan(0);
});

// ── Store primitives: the exactly-once guarantee everything rests on ─────────

test("take(): one of N concurrent callers wins", async () => {
  const key = uniq("take-race");
  const attempts = await Promise.all(
    Array.from({ length: 10 }, () =>
      take("sv.test.scope", key, "", { ok: true }, PERMANENT_EXPIRY),
    ),
  );
  expect(attempts.filter((a) => a.ok)).toHaveLength(1);
  expect(attempts.filter((a) => !a.ok).every((a) => a.reason === "already_taken")).toBe(true);
});

test("take(): the winner is decided by the database, not by read order", async () => {
  // Two DIFFERENT keys: both must succeed. This is the negative control proving
  // the race test above is detecting the conflict and not just a broken scope.
  const a = await take("sv.test.scope", uniq("key-a"), "", {}, PERMANENT_EXPIRY);
  const b = await take("sv.test.scope", uniq("key-b"), "", {}, PERMANENT_EXPIRY);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
});

test("put() overwrites rather than accumulating rows", async () => {
  const key = uniq("put-overwrite");
  await put("sv.test.scope", key, "", { v: 1 }, PERMANENT_EXPIRY);
  await put("sv.test.scope", key, "", { v: 2 }, PERMANENT_EXPIRY);
  const rows = await db.idempotencyKey.count({
    where: { scope: "sv.test.scope", key, callerId: "" },
  });
  expect(rows).toBe(1);
  expect(await read<{ v: number }>("sv.test.scope", key, "")).toEqual({ v: 2 });
});

test("the same key in two different scopes are independent", async () => {
  const key = uniq("scope-isolation");
  await take("sv.test.scope-one", key, "", { which: "one" }, PERMANENT_EXPIRY);
  // The same key string in another scope must be a free slot.
  const second = await take("sv.test.scope-two", key, "", { which: "two" }, PERMANENT_EXPIRY);
  expect(second.ok).toBe(true);
});

test("an expired record reads as absent even before the evictor runs", async () => {
  const key = uniq("expired");
  await put("sv.test.scope", key, "", { v: 1 }, new Date(Date.now() - 1000));
  // The boot-time evictor is best-effort and may not have run, so expiry must be
  // enforced on READ too. This is the fail-closed direction.
  expect(await read("sv.test.scope", key, "")).toBeNull();
});

test("a corrupt record reads as absent, never as a partial object", async () => {
  const key = uniq("corrupt");
  await db.idempotencyKey.create({
    data: {
      scope: "sv.test.scope",
      key,
      callerId: "",
      response: "{not json",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  expect(await read("sv.test.scope", key, "")).toBeNull();
});

test("patch() rewrites in place and drop() removes", async () => {
  const key = uniq("patch-drop");
  await put("sv.test.scope", key, "", { n: 1 }, PERMANENT_EXPIRY);

  const patched = await patch<{ n: number }>("sv.test.scope", key, "", (cur) => ({ n: cur.n + 1 }));
  expect(patched).toEqual({ n: 2 });

  await drop("sv.test.scope", key, "");
  expect(await read("sv.test.scope", key, "")).toBeNull();
});

test("listFor() returns records for one caller only", async () => {
  const caller = uniq("caller");
  await put("sv.test.scope", uniq("mine"), caller, { mine: true }, PERMANENT_EXPIRY);
  await put("sv.test.scope", uniq("theirs"), uniq("other"), { mine: false }, PERMANENT_EXPIRY);

  const mine = await listFor<{ mine: boolean }>("sv.test.scope", caller);
  expect(mine.length).toBe(1);
  // Length is asserted to be exactly 1 directly above, so the element is present.
  expect(mine[0]!.mine).toBe(true);
  // Keys are returned so a caller can act on them (e.g. a revocation sweep).
  expect(typeof mine[0]!.key).toBe("string");
});

test("auth state lives in reserved sv.auth.* namespaces", () => {
  // Nothing outside src/lib/auth can collide with a payload-dedupe key.
  for (const scope of Object.values(AUTH_SCOPES)) {
    expect(scope.startsWith("sv.auth.")).toBe(true);
  }
  const values = Object.values(AUTH_SCOPES);
  expect(new Set(values).size).toBe(values.length);
});

// ── The invite flow that provisions a magic-link-only account ───────────────

test("an invited account with no password can still be created and identified", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { token, email } = await makeInvite("Analyst", owner.identity.accountId, owner.orgId);

  const { acceptInvite } = await import("@/lib/auth/invite");
  const result = await acceptInvite({ token });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.identity.email).toBe(email);

  // Magic-link-only: no password was set, so the password path cannot work.
  const viaPassword = await loginWithPassword(email, TEST_PASSWORD);
  expect(viaPassword.ok).toBe(false);

  // But a magic link can sign them in, because they have an account.
  let captured = "";
  await issueMagicLink(email, async (i) => {
    captured = i.token;
  });
  const redeemed = await redeemMagicLink(captured);
  expect(redeemed.ok).toBe(true);
});
