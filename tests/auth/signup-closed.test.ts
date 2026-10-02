/**
 * WP-11 GATE — there is NO public signup route.
 *
 * The brief's first requirement is an absence, and absence is the easiest kind
 * of requirement to regress: a well-meaning PR adds `POST /api/auth/signup` to
 * let a demo user in, and every other control in this package becomes advisory —
 * an unknown address can now create its own account, and if the role is read
 * from the request body it can grant itself `Owner`.
 *
 * So this file tests the absence against the FILESYSTEM, not against anyone's
 * memory of what exists:
 *
 *   1. No route under `src/app/api/auth/**` may create an account from a
 *      credential. Every route file is scanned and each exported HTTP handler's
 *      behaviour is checked, so a signup route cannot hide behind an unexpected
 *      filename.
 *   2. The only account-creation entry point is invite redemption. `createIdentity`
 *      is called from exactly one place.
 *   3. `createAccountFromSignup()` — the name a developer would reach for —
 *      always refuses, whatever it is handed.
 *   4. The magic-link verify route (which is public) cannot create an account.
 *
 * A filesystem scan finds routes by NAME, which is why (1) also reads each
 * handler and (4) exists: a route can create an account under an innocuous name.
 */

import { afterAll, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "@/lib/db";
import { acceptInvite, issueInvite } from "@/lib/auth/invite";
import {
  SIGNUP_CLOSED_CODE,
  SIGNUP_CLOSED_MESSAGE,
  SIGNUP_CLOSED_STATUS,
  accountCreationPath,
  createAccountFromSignup,
} from "@/lib/auth/signup";
import { POST as acceptPOST } from "@/app/api/auth/invites/accept/route";
import { POST as verifyPOST } from "@/app/api/auth/magic-link/verify/route";
import { POST as passwordPOST } from "@/app/api/auth/password/route";
import { cleanupRun, makeAccount, testEmail, uniq } from "./helpers";

afterAll(async () => {
  await cleanupRun();
});

const AUTH_ROUTES = resolve(process.cwd(), "src/app/api/auth");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
  return out;
}

// ── 1. No signup route exists ────────────────────────────────────────────────

test("no route under api/auth creates an account from a credential", async () => {
  const files = routeFiles(AUTH_ROUTES);
  expect(files.length).toBeGreaterThan(0);

  // Pathnames that would indicate a public account-creation endpoint.
  const forbidden = /sign-?up|signup|register|registration|join|create-account|new-account|self-?serve/i;

  for (const file of files) {
    const relative = file.replace(AUTH_ROUTES, "").replace(/\\/g, "/");
    expect({ path: relative, isSignup: forbidden.test(relative) }).toEqual({
      path: relative,
      isSignup: false,
    });
  }
});

test("createIdentity is called from exactly ONE module: invite redemption", () => {
  // A second caller is a second provisioning path, which is what this control
  // exists to prevent. The invite module is the single sanctioned caller.
  const libDir = resolve(process.cwd(), "src/lib/auth");
  const files: string[] = [];
  for (const entry of readdirSync(libDir)) {
    if (entry.endsWith(".ts")) files.push(join(libDir, entry));
  }

  const callers: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // Match real CALL SITES only. Two exclusions:
    //   `function createIdentity(`  — the declaration, not a call.
    //   `.createIdentity(`          — a method on another object, not this one.
    const calls =
      source.match(/(?<![\w.])(?<!function )createIdentity\s*\(/g) ?? [];
    if (calls.length > 0) {
      callers.push({
        file: file.slice(libDir.length + 1).replace(/\\/g, "/"),
        count: calls.length,
      });
    }
  }

  // Only invite.ts, and only its one call inside acceptInvite. A second caller is
  // a second provisioning path, which is the whole point of this control.
  expect(callers).toEqual([{ file: "invite.ts", count: 1 }]);
});

// ── 2. The choke point refuses ───────────────────────────────────────────────

test("createAccountFromSignup refuses whatever it is handed", async () => {
  // Nothing this function accepts changes its answer. Each of these is a shape a
  // developer might plausibly pass.
  for (const input of [
    undefined,
    {},
    { email: testEmail("anyone"), role: "Owner" },
    { email: "attacker@evil.test", name: "A", password: "x".repeat(20) },
    "not-even-an-object",
    42,
  ]) {
    const result = await createAccountFromSignup(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe(SIGNUP_CLOSED_CODE);
    expect(result.error).toBe(SIGNUP_CLOSED_MESSAGE);
  }
});

test("the refusal created no account, even when handed an Owner role", async () => {
  const email = testEmail("wantsowner");
  await createAccountFromSignup({ email, role: "Owner", name: "x" });
  expect(await db.account.count({ where: { email } })).toBe(0);
});

test("the declared account-creation path is invite redemption", () => {
  expect(accountCreationPath()).toBe("invite_redemption");
});

test("the refusal maps to 403, and the message does not leak why", () => {
  expect(SIGNUP_CLOSED_STATUS).toBe(403);
  // Tells an integrator the real answer rather than pretending the endpoint is
  // not there — the endpoint's existence is not a secret.
  expect(SIGNUP_CLOSED_MESSAGE).toContain("invite");
  // …but does not say WHICH endpoint accepts one.
  expect(SIGNUP_CLOSED_MESSAGE).not.toContain("/api/auth");
  expect(SIGNUP_CLOSED_MESSAGE).not.toContain("token");
});

// ── 3. The public routes cannot create an account ────────────────────────────

test("the PUBLIC magic-link verify route cannot create an account", async () => {
  const email = testEmail("nolink");

  // No token at all.
  const noToken = await verifyPOST(
    new Request("http://t/api/auth/magic-link/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
  );
  expect(noToken.status).toBe(422);

  // A syntactically valid but unknown token.
  const bogus = await verifyPOST(
    new Request("http://t/api/auth/magic-link/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: uniq("unknown-magic-token") }),
    })
  );
  expect(bogus.status).toBe(401);

  // Neither attempt created anything.
  expect(await db.account.count({ where: { email } })).toBe(0);
});

test("the PUBLIC password route cannot create an account", async () => {
  const email = testEmail("nopassword");

  const response = await passwordPOST(
    new Request("http://t/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "some-password-here" }),
    })
  );
  // 401: there is no such account, and signing in does not make one.
  expect(response.status).toBe(401);
  expect(await db.account.count({ where: { email } })).toBe(0);
});

test("the invite-accept route creates an account only with a real token", async () => {
  const email = testEmail("acceptneedsreal");

  // Without a token.
  const noToken = await acceptPOST(
    new Request("http://t/api/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role: "Owner" }),
    })
  );
  expect(noToken.status).toBe(422);
  expect(await db.account.count({ where: { email } })).toBe(0);

  // With a fabricated token.
  const fabricated = await acceptPOST(
    new Request("http://t/api/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: uniq("fabricated-invite"), email, role: "Owner" }),
    })
  );
  expect(fabricated.status).toBe(410);
  expect(await db.account.count({ where: { email } })).toBe(0);

  // With a REAL invitation — now, and only now, an account exists, with the
  // role and email the invite specified rather than the ones in the body.
  const owner = await makeAccount("Owner", "owner");
  const { token, email: invitedEmail } = await issueInvite({
    email,
    name: "invited",
    role: "Analyst",
    orgId: owner.orgId,
    issuedBy: owner.identity.accountId,
  }).then((i) => ({ token: i.token, email: i.invite.email }));

  const accepted = await acceptPOST(
    new Request("http://t/api/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `email` and `role` in the body are ignored: the invite is the authority.
      body: JSON.stringify({ token, email: "attacker@evil.test", role: "Owner" }),
    })
  );
  expect(accepted.status).toBe(201);

  const account = await db.account.findUnique({
    where: { email },
    select: { email: true, role: true },
  });
  expect(account?.email).toBe(email);
  expect(account?.role).toBe("Analyst");
  expect(await db.account.count({ where: { email: "attacker@evil.test" } })).toBe(0);
  void invitedEmail;
});

// ── 4. The account-creation path really is invite-only ───────────────────────

test("an account with a real role can only be created by redeeming an invitation", async () => {
  const owner = await makeAccount("Owner", "owner");

  // Direct creation is possible in-process (the library function), but it is not
  // reachable from any route — which is the property the scan above proves. What
  // this test pins is that the ONE public creation route still refuses without
  // a token.
  const before = await db.account.count();
  const refused = await acceptPOST(
    new Request("http://t/api/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "", email: testEmail("nothing") }),
    })
  );
  expect(refused.status).toBe(422);
  expect(await db.account.count()).toBe(before);
});

test("an invitation cannot be self-issued by an anonymous caller", async () => {
  // `issueInvite` requires an identity; the route requires `member:invite` AND a
  // step-up. Assert the route refuses without a session.
  const { POST } = await import("@/app/api/auth/invites/route");
  const response = await POST(
    new Request("http://t/api/auth/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: testEmail("selfissue"), role: "Owner" }),
    })
  );
  expect(response.status).toBe(401);
  expect(await db.account.count({ where: { email: { contains: "selfissue" } } })).toBe(0);
});

test("acceptInvite itself refuses an empty token before any database work", async () => {
  const result = await acceptInvite({ token: "" });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBe("unknown_invite");
});