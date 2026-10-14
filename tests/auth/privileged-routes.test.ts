/**
 * The privileged actions enforced BY THE ROUTES, not by the guard function.
 *
 * `tests/auth/stepup.test.ts` proves `requirePrivileged()` refuses without a fresh
 * step-up. That is not the same claim as "the console refuses", and the gap between
 * them is exactly where this repo's own security questionnaire went wrong:
 * `docs/SECURITY-QUESTIONNAIRE.md` states that producer-key rotation and BYOK
 * changes are step-up protected, the registry named both actions, the capability map
 * bound them, the guard was tested — and no route called either of them. The
 * document told an auditor something the code did not do.
 *
 * So every refusal case asserts an EFFECT in the database, not a status code alone:
 * a 428 that still revoked the key would be a denial that did not deny. Where a
 * precondition could make an assertion vacuous, the precondition is asserted first —
 * an absent row is not a pass.
 *
 * Every allowance case asserts only that the step-up did NOT fire and that nothing
 * crashed. Whether a tenant's PLAN entitles it to BYOK belongs to
 * `tests/billing/entitlements.test.ts`; pinning a success code here would make this
 * file answer to billing.
 *
 * `getProfile` is the repo's single console identity seam (see the note at the top of
 * tests/tenancy/console-routes.test.ts) and it resolves through `next/headers`, which
 * needs a request scope a directly-invoked handler does not have. It is stubbed at
 * that seam, spread over the real module so no other export is dropped, and pinned to
 * the same account the real session cookie belongs to — so `requireOperator` and
 * `requirePrivileged` describe one person rather than two.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import * as realCredits from "@/lib/credits";
import { POST as keysPOST, DELETE as keysDELETE } from "@/app/api/console/producer-keys/route";
import { POST as settingsPOST } from "@/app/api/console/settings/route";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guards";
import { issueStepUp } from "@/lib/auth/stepup";
import { cleanupRun, makeAccount, makeSession } from "./helpers";

let current: { userId: string; orgId: string } | null = null;
const RUN = Date.now().toString(36);
const madeOrgs: string[] = [];

mock.module("@/lib/credits", () => ({
  ...realCredits,
  getProfile: async () =>
    current
      ? {
          userId: current.userId,
          email: `${current.userId}@securevoice.test`,
          name: "Privileged route fixture",
          role: "operator" as const,
          orgId: current.orgId,
          credits: 500,
        }
      : null,
}));

afterAll(async () => {
  current = null;
  // The orgs are this file's rows, so this file removes them. `cleanupRun()` clears
  // accounts and profiles by email pattern and knows nothing about them.
  for (const id of madeOrgs) await db.organization.delete({ where: { id } }).catch(() => {});
  await cleanupRun();
});

function req(cookie: string, url: string, init: RequestInit = {}) {
  return new NextRequest(url, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

/** An Owner session — every capability, no step-up yet — bound to one identity. */
async function unstepped(tag: string) {
  // A real `Organization` row, because `UserProfile.orgId` is a uuid column with a
  // foreign key and `testOrg()` returns a synthetic label, not one. The route's
  // settings write goes through `withTenantScope`, whose policy hides rows with no
  // organisation — so an org-less fixture profile makes a legal write die on P2025
  // and the case would fail for a missing row instead of for the gate.
  const org = await db.organization.create({
    data: {
      id: crypto.randomUUID(),
      name: `Privileged ${tag} ${RUN}`,
      slug: `privileged-${tag}-${RUN}`,
      createdAt: new Date(),
      // `standard`, in the CONSOLE's vocabulary, which `entitlementPlan` maps to
      // the Growth line — so the BYOK cases reach the step-up gate instead of
      // stopping at the plan check. `growth` here would be an unrecognised tier
      // and fall through to a 402, proving only the order the route deliberately
      // has (plan first, then re-auth).
      planTier: "standard",
    },
    select: { id: true },
  });
  madeOrgs.push(org.id);

  const account = await makeAccount("Owner", tag, { orgId: org.id });
  const session = await makeSession(account);
  // The console seam takes the USER row id, which is a uuid; `identity.accountId`
  // is better-auth's provider-side account id and is a different string entirely.
  // Binding the stub to the wrong one produces `invalid input syntax for type
  // uuid`, which is a fixture bug masquerading as a route bug.
  const user = await db.user.findUnique({ where: { email: account.email }, select: { id: true } });
  expect(user, `no User row for ${account.email}`).not.toBeNull();
  // The console writes settings onto `UserProfile`, which the signup flow creates
  // alongside the user; `createIdentity()` — the fixture's shortcut past signup —
  // does not, so the row is made here.
  await db.userProfile.upsert({
    where: { userId: user!.id },
    create: {
      userId: user!.id,
      email: account.email,
      name: account.identity.name,
      orgId: org.id,
    },
    update: {},
  });
  current = { userId: user!.id, orgId: org.id };
  return { cookie: session.cookie, userId: user!.id, orgId: org.id };
}

/**
 * Re-point the stubbed console identity. `getProfile` below reads a module-level
 * mutable, exactly as the tenancy probe harness does, so it follows the LAST
 * account created rather than the cookie passed in — creating a second identity
 * silently moves the first one's requests to the new org. Any test that holds two
 * sessions has to say which one the route should see.
 */
function become(who: { userId: string; orgId: string }): void {
  current = { userId: who.userId, orgId: who.orgId };
}

/** Grant the action on THIS session, the way a password re-auth would. */
async function grantStepUp(cookie: string) {
  const authed = await requireAuth(cookie);
  expect(authed.ok).toBe(true);
  if (!authed.ok) throw new Error("unreachable: the fixture session is not readable");
  await issueStepUp(authed.session, { ok: true }, "password");
}

const KEYS_URL = "http://localhost/api/console/producer-keys";
const SETTINGS_URL = "http://localhost/api/console/settings";

test("issuing a producer key without a step-up is refused, and no key is minted", async () => {
  const { cookie } = await unstepped("pk-refuse");
  const before = await db.producerKey.count();
  const res = await keysPOST(
    req(cookie, KEYS_URL, { method: "POST", body: JSON.stringify({ label: "unsolicited" }) }),
  );
  expect(res.status).toBe(428);
  expect((await res.json()).code).toBe("step_up_required");
  expect(await db.producerKey.count()).toBe(before);
});

test("revoking is capability-gated but NOT step-up gated — a recorded trade", async () => {
  // Pinned so the asymmetry against POST is read as a decision rather than an
  // oversight. Gating revoke made `tests/tenancy/probe-registry.ts` answer 401
  // before any tenancy logic ran, which emptied the control case of the
  // isolation probe — a proven multi-tenant property lost to soften a reversible
  // action. If revoke is ever gated again, the isolation suite goes inconclusive
  // first and this test goes red alongside it; both are meant to be read together.
  const first = await unstepped("pk-revoke");
  await grantStepUp(first.cookie);
  const created = await keysPOST(
    req(first.cookie, KEYS_URL, { method: "POST", body: JSON.stringify({ label: "to revoke" }) }),
  );
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };

  // A second Owner session that has never re-authenticated can still revoke its
  // OWN key — and only its own, which is the property tenancy isolates.
  const cold = await unstepped("pk-revoke-cold");
  const foreign = await keysDELETE(
    req(cold.cookie, `${KEYS_URL}?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
  expect(foreign.status).toBe(404);
  expect((await db.producerKey.findUnique({ where: { id } }))?.revoked).toBe(false);

  become(first);
  const allowed = await keysDELETE(
    req(first.cookie, `${KEYS_URL}?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
  expect(allowed.status).toBe(200);
  expect((await db.producerKey.findUnique({ where: { id } }))?.revoked).toBe(true);
});

test("attaching a vendor key without a step-up stores nothing", async () => {
  const { cookie, userId } = await unstepped("byok-refuse");
  const res = await settingsPOST(
    req(cookie, SETTINGS_URL, {
      method: "POST",
      body: JSON.stringify({ elevenKey: "sk_secretish_value_123" }),
    }),
  );
  expect(res.status).toBe(428);
  expect((await res.json()).code).toBe("step_up_required");

  // Asserted before the value: a missing profile would make the next line pass for
  // the wrong reason.
  const profile = await db.userProfile.findUnique({ where: { userId } });
  expect(profile, "the fixture account has no UserProfile row to check").not.toBeNull();
  expect(profile!.elevenKeyEnc ?? null).toBe(null);
});

test("a granted step-up gets past the gate", async () => {
  const { cookie } = await unstepped("byok-allow");
  await grantStepUp(cookie);
  const res = await settingsPOST(
    req(cookie, SETTINGS_URL, {
      method: "POST",
      body: JSON.stringify({ elevenKey: "sk_another_value" }),
    }),
  );
  expect(res.status).not.toBe(428);
  expect(res.status).toBeLessThan(500);
});

test("changing nothing sensitive asks for nothing extra", async () => {
  const { cookie } = await unstepped("settings-plain");
  const res = await settingsPOST(
    req(cookie, SETTINGS_URL, {
      method: "POST",
      body: JSON.stringify({ orgName: "Plain Rename" }),
    }),
  );
  expect(res.status).not.toBe(428);
  expect(res.status).toBeLessThan(500);
});

test("CLEARING a vendor key is never gated — a leaving tenant must be able to stop it", async () => {
  const { cookie } = await unstepped("byok-clear");
  const res = await settingsPOST(
    req(cookie, SETTINGS_URL, { method: "POST", body: JSON.stringify({ elevenKey: "" }) }),
  );
  expect(res.status).not.toBe(428);
  expect(res.status).toBeLessThan(500);
});
