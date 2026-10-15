/**
 * SIGN-OUT GATE — signing out revokes the session the routes actually read.
 *
 * There are two session systems behind one browser:
 *
 *   · Better Auth's own session row + cookie. The Auth view signs in with
 *     `authClient.signIn.email()` and `authClient.signOut()` revokes it.
 *   · The first-party `sv_session` store, minted by /api/auth/magic-link/verify,
 *     /api/auth/password, /api/auth/invites/accept and /api/auth/reset/confirm,
 *     and enforced on EVERY authenticated route by `requireAuth` → `verifySession`.
 *
 * Magic link is the PRIMARY operator sign-in (src/lib/auth/magic-link.ts) and that
 * path mints ONLY `sv_session` — it never creates a Better Auth session. So
 * `signOut()` had no Better Auth session to revoke, `/api/auth/logout` (the only
 * thing that sets `revokedAt`) had no callers at all, and the `sv_session` row
 * SURVIVED the sign-out. The UI showed signed-out while every guarded route kept
 * answering `ok: true` until the 15-minute idle or 8-hour absolute limit.
 *
 * That failure is invisible from the browser, which is why it is asserted here
 * the way `session.test.ts` asserts its key property: no cookie-clearing, no
 * client state, no JavaScript cooperating. The session is presented to
 * `verifySession` exactly as a route handler would present it, and the answer
 * must be `revoked`.
 *
 * (3) is a filesystem patrol for the same reason `signup-closed.test.ts` has one:
 * a new sign-out button that calls only `signOut()` reopens the hole, and nobody
 * remembers the second system at the point they write the button.
 */

import { afterAll, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "@/lib/db";
import { revokeFirstPartySessionsOnSignOut } from "@/lib/auth/signout-backstop";
import { verifySession, readSessionCookie } from "@/lib/auth/session";
import { logout } from "@/lib/auth/guards";
import { cleanupRun, makeAccount, makeSession, uniq } from "./helpers";

afterAll(async () => {
  await cleanupRun();
});

/** The Better Auth `userId` that owns a first-party identity's Account row. */
async function userIdFor(accountId: string): Promise<string> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { userId: true },
  });
  if (!account) throw new Error(`no Account row for ${accountId}`);
  return account.userId;
}

/**
 * The backstop is exercised through its own module, NOT through `auth.options`.
 *
 * `tests/auth/signin-lockout.test.ts` replaces `@/lib/better-auth` with
 * `{ auth: {} }` via `mock.module`, and bun applies that process-wide — so a test
 * reading `auth.options.databaseHooks` passes alone and fails in the suite. The
 * wiring is therefore asserted against the source text instead (the last test),
 * which no mock can hide.
 */
const fireSignOutHook = revokeFirstPartySessionsOnSignOut;

// ── The first-party revocation itself ─────────────────────────────────────────

test("a live sv_session authenticates before sign-out", async () => {
  const fixture = await makeAccount("Admin", uniq("so-pre"));
  const { cookie } = await makeSession(fixture);
  const check = await verifySession(readSessionCookie(cookie));
  expect(check.ok).toBe(true);
});

test("sign-out kills sv_session — the cookie is refused, not merely cleared", async () => {
  const fixture = await makeAccount("Admin", uniq("so-a"));
  const { session, cookie } = await makeSession(fixture);

  expect((await verifySession(readSessionCookie(cookie))).ok).toBe(true);

  await logout(session);

  const after = await verifySession(readSessionCookie(cookie));
  expect(after.ok).toBe(false);
  expect(after.ok === false && after.reason).toBe("revoked");
});

// ── The BACKSTOP: a Better Auth sign-out must reach the first-party store ──────
//
// This is the test that fails on the original code. There, `signOut()` revoked a
// Better Auth session that a magic-link sign-in never created, and nothing else
// ran — so the session below stayed live.

test("a Better Auth sign-out revokes the first-party sv_session", async () => {
  const fixture = await makeAccount("Admin", uniq("so-hook"));
  const { cookie } = await makeSession(fixture);
  const userId = await userIdFor(fixture.identity.accountId);

  expect((await verifySession(readSessionCookie(cookie))).ok).toBe(true);

  await fireSignOutHook(userId);

  const after = await verifySession(readSessionCookie(cookie));
  expect(after.ok).toBe(false);
  expect(after.ok === false && after.reason).toBe("revoked");
});

test("the backstop is scoped: another operator's session survives it", async () => {
  const victim = await makeAccount("Admin", uniq("so-vic"));
  const bystander = await makeAccount("Admin", uniq("so-by"));
  const victimSession = await makeSession(victim);
  const bystanderSession = await makeSession(bystander);

  await fireSignOutHook(await userIdFor(victim.identity.accountId));

  expect((await verifySession(readSessionCookie(victimSession.cookie))).ok).toBe(false);
  // The over-revocation trade is per-IDENTITY, never global: signing someone out
  // must not sign out a different operator who happens to be using the console.
  expect((await verifySession(readSessionCookie(bystanderSession.cookie))).ok).toBe(true);
});

test("the backstop never fails the sign-out it is hanging off", async () => {
  // A userId with no Account row resolves to zero accounts and must be a no-op,
  // not a throw. A backstop that can turn a logout into a 500 leaves the client
  // unsure whether it is signed in.
  const fixture = await makeAccount("Admin", uniq("so-ghost"));
  const { cookie } = await makeSession(fixture);

  await fireSignOutHook("00000000-0000-0000-0000-000000000000");

  // The real session is untouched, which is the point: an unrelated sign-out
  // event must not be able to kill somebody else's session either.
  expect((await verifySession(readSessionCookie(cookie))).ok).toBe(true);
});

// ── Call-site patrol: every client sign-out must revoke both systems ───────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

test("no client sign-out calls signOut() without also revoking sv_session", () => {
  const root = resolve(process.cwd(), "src");
  const offenders: string[] = [];
  let signOutCallSites = 0;

  for (const file of sourceFiles(root)) {
    const src = readFileSync(file, "utf8");
    // The definition in auth-client.ts is not a call site.
    if (file.endsWith(join("lib", "auth-client.ts"))) continue;
    if (!/\bsignOut\s*\(/.test(src)) continue;
    signOutCallSites++;
    if (!src.includes("/api/auth/logout")) offenders.push(file);
  }

  // Guard the test itself: if a refactor renames the call, the scan must not
  // silently match nothing and pass vacuously.
  expect(signOutCallSites).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});

test("the first-party logout route still revokes server-side", async () => {
  // The route is idempotent and 200 without a session, so "it exists and revokes"
  // is best asserted by the effect above plus this: the endpoint is reachable and
  // does not 500 when there is nothing to revoke.
  const { POST } = await import("@/app/api/auth/logout/route");
  const res = await POST(new Request("http://localhost/api/auth/logout", { method: "POST" }));
  expect(res.status).toBe(200);
});

test("better-auth.ts actually wires the backstop into session.delete.after", () => {
  // Behaviour is proven above; this proves the behaviour is REACHABLE. A
  // backstop that exists, is correct, and is never invoked is the exact shape of
  // the original bug, so the wiring is a first-class assertion — and reading the
  // file is what makes it immune to `mock.module` on @/lib/better-auth.
  //
  // Comments are stripped before matching: the signature carries a note explaining
  // that Better Auth passes the record unwrapped, and an assertion that forbids a
  // comment between two keys is an assertion about formatting, not about wiring.
  const raw = readFileSync(resolve(process.cwd(), "src/lib/better-auth.ts"), "utf8");
  const src = raw.replace(/^\s*\/\/.*$/gm, "");
  expect(src).toContain("revokeFirstPartySessionsOnSignOut");
  expect(src).toMatch(/databaseHooks\s*:/);
  expect(src).toMatch(/session\s*:\s*\{\s*delete\s*:\s*\{\s*after\s*:/);
});
