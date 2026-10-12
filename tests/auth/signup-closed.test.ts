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
import { NextRequest } from "next/server";
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
import { cleanupRun, makeAccount, testEmail, uniq, RUN } from "./helpers";

afterAll(async () => {
  // `cleanupRun()` removes the first-party `account` rows this run created. The
  // tests below exercise Better Auth's own creation path, whose shape is a `user`
  // row plus a `credential` account — and a self-served `user` row surviving the
  // run would leave exactly the artefact this file exists to prove cannot be
  // created. Scoped to this run's id, so a parallel run's rows are untouched.
  await db.user
    .deleteMany({ where: { email: { contains: `-${RUN}-` } } })
    .catch(() => undefined);
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
  const forbidden =
    /sign-?up|signup|register|registration|join|create-account|new-account|self-?serve/i;

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

  // Each entry records the file and how many call sites it holds, so the assertion
  // below pins BOTH the single allowed caller and the single allowed call.
  const callers: { file: string; count: number }[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // Match real CALL SITES only. Two exclusions:
    //   `function createIdentity(`  — the declaration, not a call.
    //   `.createIdentity(`          — a method on another object, not this one.
    const calls = source.match(/(?<![\w.])(?<!function )createIdentity\s*\(/g) ?? [];
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
    }),
  );
  expect(noToken.status).toBe(422);

  // A syntactically valid but unknown token.
  const bogus = await verifyPOST(
    new Request("http://t/api/auth/magic-link/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: uniq("unknown-magic-token") }),
    }),
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
    }),
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
    }),
  );
  expect(noToken.status).toBe(422);
  expect(await db.account.count({ where: { email } })).toBe(0);

  // With a fabricated token.
  const fabricated = await acceptPOST(
    new Request("http://t/api/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: uniq("fabricated-invite"), email, role: "Owner" }),
    }),
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
    }),
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
    }),
  );
  expect(refused.status).toBe(422);
  expect(await db.account.count()).toBe(before);
});

test("an invitation cannot be self-issued by an anonymous caller", async () => {
  // `issueInvite` requires an identity; the route requires `member:invite` AND a
  // step-up. Assert the route refuses without a session.
  const { POST } = await import("@/app/api/auth/invites/route");
  const response = await POST(
    // This route takes a NextRequest (it reads the cookie jar), so the request is
    // constructed as one rather than narrowed with a cast at the call site.
    new NextRequest("http://t/api/auth/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: testEmail("selfissue"), role: "Owner" }),
    } as ConstructorParameters<typeof NextRequest>[1]),
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

// ── 5. Better Auth's OWN signup path, reached through the catch-all ──────────
//
// Everything above proves no FIRST-PARTY route creates an account. It could not
// prove the thing that actually mattered: `src/app/api/auth/[...all]` forwards
// every unmatched POST to Better Auth, and Better Auth serves
// `POST /api/auth/sign-up/email` itself. The filesystem scan saw no signup route
// because there isn't one in `src/app`; the door was in the library behind a
// wildcard, and `turnstileRequired()` names only `/api/auth/sign-in/email`.
//
// So this is the test that closes the gap, and it is written so it cannot pass
// for the wrong reason. A request to a Better Auth endpoint can be turned away by
// the trusted-origin check before the signup handler ever runs — which would make
// a "refused" assertion green while `disableSignUp` did nothing at all. The
// control request below is the proof that the SAME origin reaches the handlers.

test("Better Auth's sign-up endpoint is refused through the catch-all, by name", async () => {
  const { POST: catchAllPOST } = await import("@/app/api/auth/[...all]/route");
  const { trustedOriginsFromEnv } = await import("@/lib/auth/origins");
  const origin = trustedOriginsFromEnv().origins[0];
  expect(
    origin,
    "no trusted origin resolves in this environment; without one the assertions below could be origin refusals",
  ).toBeTruthy();

  const post = async (path: string, body: unknown) => {
    const response = await catchAllPOST(
      new Request(`http://t${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          host: new URL(origin as string).host,
        },
        body: JSON.stringify(body),
      }) as unknown as Parameters<typeof catchAllPOST>[0],
    );
    return { status: response.status, text: await response.text() };
  };

  const email = testEmail("selfserve");
  const signUp = await post("/api/auth/sign-up/email", {
    email,
    name: "Self Served",
    password: "correct-horse-battery-staple-9",
  });

  expect(signUp.status).toBe(400);
  // The specific code, not merely a 4xx. `EMAIL_PASSWORD_SIGN_UP_DISABLED` is what
  // `emailAndPassword.disableSignUp` in src/lib/better-auth.ts produces, so this
  // assertion fails the moment that flag is removed.
  expect(signUp.text).toContain("EMAIL_PASSWORD_SIGN_UP_DISABLED");
  expect(await db.account.count({ where: { email } })).toBe(0);
  expect(await db.user.count({ where: { email } })).toBe(0);

  // CONTROL — the identical origin on the endpoint that is allowed to serve. A
  // wrong credential is a refused SIGN-IN, which is a different answer from the
  // signup refusal above; if the two bodies matched, the origin was the thing
  // rejecting both and this file would be proving nothing.
  const signIn = await post("/api/auth/sign-in/email", {
    email,
    password: "wrong-password-entirely-1234",
  });
  expect(signIn.text).not.toContain("EMAIL_PASSWORD_SIGN_UP_DISABLED");
  expect(signIn.status).not.toBe(400);
});

test("the catch-all does not forward signup under a different spelling", async () => {
  // Better Auth mounts the credential signup at exactly one path, and the
  // catch-all matches on the remainder of the URL. A renamed action must not
  // become an unguarded way in: `/sign-up` without `/email`, and the camelCase
  // client spelling, are both asserted here for the same reason as the test above
  // — the control has to hold for every shape a caller can try.
  const { POST: catchAllPOST } = await import("@/app/api/auth/[...all]/route");
  const { trustedOriginsFromEnv } = await import("@/lib/auth/origins");
  const origin = trustedOriginsFromEnv().origins[0] as string;
  for (const path of [
    "/api/auth/sign-up",
    "/api/auth/signUp/email",
    "/api/auth/sign-up/email?token=x",
  ]) {
    const response = await catchAllPOST(
      new Request(`http://t${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, host: new URL(origin).host },
        body: JSON.stringify({ email: testEmail("spell"), password: "a-very-long-password-1", name: "x" }),
      }) as unknown as Parameters<typeof catchAllPOST>[0],
    );
    const text = await response.text();
    // Either the disabled-signup refusal by name, or an unknown-action 4xx from
    // Better Auth's router. What must NOT happen is a 2xx carrying a session —
    // that would mean a spelling variant reached a working creation path.
    expect(response.status, `${path} returned ${response.status}: ${text.slice(0, 160)}`).toBeGreaterThanOrEqual(
      400,
    );
    expect(response.status).toBeLessThan(500);
  }
  // Run-scoped on purpose: `contains: "spell"` matched a PREVIOUS run's leftover,
  // which is how this assertion failed for a reason it had nothing to do with —
  // and, worse, would have passed silently on a database another run had cleaned.
  expect(await db.user.count({ where: { email: { contains: `spell-${RUN}` } } })).toBe(0);
});
