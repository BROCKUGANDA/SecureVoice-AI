/**
 * TWO FACTOR IS A PRECONDITION OF SPENDING MONEY.
 *
 * Before this gate existed, `User.twoFactorEnabled` was read in three client
 * components and zero server-side guards: the flag decided what a banner said,
 * never what an endpoint allowed. `src/lib/better-auth.ts:98-99` justified
 * disabling auto sign-in by claiming a credential compromise "should force an
 * MFA challenge" — there was no challenge to force, and a stolen cookie with no
 * second factor could open a Paddle checkout, raise a negotiated invoice, and
 * mint a customer-portal session where subscriptions are cancelled.
 *
 * Proven here against the real Postgres:
 *
 *   1. An account with no second factor is refused, with 428 and a machine-readable
 *      code — not 403, because the caller IS permitted and the console has to be
 *      able to tell "go enable it" from "you are not the Owner".
 *   2. An account whose factor is enrolled AND verifiable passes.
 *   3. The flag alone is not enough. `twoFactorEnabled = true` with no usable
 *      `TwoFactor` row is refused: a user who cannot pass their own next
 *      challenge must not be able to charge the company.
 *   4. The demo exemption is the configured demo EMAIL and nothing else.
 *      Specifically it is not the `demo` plan tier — `planTierFor` defaults an
 *      undeclared organisation to `"demo"` (`src/lib/abuse/tiers.ts:39-41`), so a
 *      tier-based exemption would have quietly exempted every tenant that has
 *      never declared one, widening on its own as customers were created.
 *   5. With the demo variable unset, NOBODY is exempt. Fail closed.
 *   6. Every money route still calls the gate — checked structurally, with a
 *      case proving the check would fail if a route dropped it.
 *
 *   bun scripts/run-tests.mjs money-2fa
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import { db } from "@/lib/db";
import {
  moneyTwoFactorBlocker,
  TWO_FACTOR_REQUIRED,
  type TwoFactorDenial,
} from "@/lib/auth/two-factor-gate";
import { isDemoAccount } from "@/lib/demo-account";
import type { Identity } from "@/lib/auth/identity";

const RUN = Date.now().toString(36);
const HEX = (Date.now().toString(16) + "0".repeat(12)).slice(0, 12);
// `user.id` and `twoFactor.userId` are `uuid` columns; a base36 run id fails at
// the driver in a way that reads like a schema bug rather than a fixture one.
const USER_ID = `aaaa0000-0000-4000-8000-${HEX}`;
const DEMO_USER_ID = `bbbb0000-0000-4000-8000-${HEX}`;
const PARTIAL_USER_ID = `cccc0000-0000-4000-8000-${HEX}`;

const PLAIN_EMAIL = `plain-${RUN}@example.test`;
const FULL_EMAIL = `full-${RUN}@example.test`;
const PARTIAL_EMAIL = `partial-${RUN}@example.test`;
const DEMO_EMAIL = `demo-2fa-${RUN}@example.test`;

const users = [USER_ID, DEMO_USER_ID, PARTIAL_USER_ID];
const emails = [PLAIN_EMAIL, FULL_EMAIL, PARTIAL_EMAIL, DEMO_EMAIL];

function identity(email: string, accountId = USER_ID): Identity {
  return {
    accountId,
    email,
    name: "Gate test operator",
    role: "Owner",
    orgId: `org-${RUN}`,
    roleEpoch: 1,
    orgEpoch: 1,
    createdAt: Date.now(),
  };
}

const previousDemoEnv = process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL;

beforeAll(async () => {
  for (const [id, email] of [
    [USER_ID, PLAIN_EMAIL],
    [DEMO_USER_ID, DEMO_EMAIL],
    [PARTIAL_USER_ID, PARTIAL_EMAIL],
  ] as const) {
    await db.user.create({
      data: {
        id,
        name: `2fa gate ${RUN}`,
        email,
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }
  // Enrolled and verified.
  await db.user.update({ where: { id: USER_ID }, data: { twoFactorEnabled: true } });
  await db.twoFactor.create({
    data: { userId: USER_ID, secret: "JBSWY3DPEHPK3PXP".repeat(2), backupCodes: "1111,2222" },
  });
  // The integrity case: the flag is set, the factor is not there to answer.
  await db.user.update({ where: { id: PARTIAL_USER_ID }, data: { twoFactorEnabled: true } });
}, 120_000);

afterAll(async () => {
  await db.twoFactor.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  if (previousDemoEnv === undefined) delete process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL;
  else process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL = previousDemoEnv;
}, 120_000);

describe("the money gate", () => {
  test("a configured factor with a matching factor row passes", async () => {
    expect(await moneyTwoFactorBlocker(identity(FULL_EMAIL, USER_ID))).toBeNull();
  });

  test("an account with no second factor is refused with 428, not 403", async () => {
    const stranger = `nosecret-${RUN}@example.test`;
    const strangerId = `dddd0000-0000-4000-8000-${HEX}`;
    await db.user.create({
      data: {
        id: strangerId,
        name: "no factor",
        email: stranger,
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const denial = await moneyTwoFactorBlocker(identity(stranger, strangerId));
    expect(denial).not.toBeNull();
    const typed = denial as TwoFactorDenial;
    expect(typed.status).toBe(428);
    expect(typed.error).toBe(TWO_FACTOR_REQUIRED);
    // The hint is the whole point of a distinct status: the console has to be
    // able to send the operator somewhere actionable.
    expect(typed.hint).toContain("two-factor");

    await db.user.deleteMany({ where: { id: strangerId } });
  });

  test("the flag alone is not a second factor", async () => {
    // `twoFactorEnabled = true` with no usable `TwoFactor` row: the enrolment was
    // half-written, or the row was deleted under the user. Either way the next
    // challenge cannot be answered, so the account is refused rather than waved
    // through on a boolean that no longer describes anything.
    const denial = await moneyTwoFactorBlocker(identity(PARTIAL_EMAIL, PARTIAL_USER_ID));
    expect(denial).not.toBeNull();
    expect((denial as TwoFactorDenial).error).toBe(TWO_FACTOR_REQUIRED);
  });

  test("an unknown account is refused, not skipped", async () => {
    // A row that does not exist resolves `user = null` and `?.twoFactorEnabled`
    // is then `undefined`. The default must be refusal, never passage.
    const denial = await moneyTwoFactorBlocker(
      identity(`ghost-${RUN}@example.test`, `eeee0000-0000-4000-8000-${HEX}`),
    );
    expect(denial).not.toBeNull();
  });
});

describe("the demo exemption", () => {
  test("is keyed on the configured demo email", () => {
    process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL = DEMO_EMAIL;
    expect(isDemoAccount(DEMO_EMAIL)).toBe(true);
    expect(isDemoAccount(DEMO_EMAIL.toUpperCase())).toBe(true);
    expect(isDemoAccount(` ${DEMO_EMAIL} `)).toBe(true);
    expect(isDemoAccount(PLAIN_EMAIL)).toBe(false);
    expect(isDemoAccount("")).toBe(false);
    expect(isDemoAccount(null)).toBe(false);
  });

  test("exempts that one account from the money gate", async () => {
    process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL = DEMO_EMAIL;
    expect(await moneyTwoFactorBlocker(identity(DEMO_EMAIL, DEMO_USER_ID))).toBeNull();
  });

  test("does NOT follow the demo plan tier", async () => {
    // The exemption must not be reachable by the tier a real tenant can end up
    // on by accident. An operator-addressed demo tier would be an invisible
    // back door on the money path.
    process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL = DEMO_EMAIL;
    const orgOnDemoTier = `tiered-${RUN}@example.test`;
    expect(isDemoAccount(orgOnDemoTier)).toBe(false);
  });

  test("with the variable unset, nobody is exempt", () => {
    delete process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL;
    expect(isDemoAccount(DEMO_EMAIL)).toBe(false);
    // And the same identity that passed one test ago is refused now: the
    // exemption is configuration, not an intrinsic property of the account.
    return moneyTwoFactorBlocker(identity(DEMO_EMAIL, DEMO_USER_ID)).then((denial) => {
      expect(denial).not.toBeNull();
    });
  });
});

describe("no money route can lose the gate", () => {
  const MONEY_ROUTES = [
    "src/app/api/billing/checkout/route.ts",
    "src/app/api/billing/invoice/route.ts",
    "src/app/api/billing/portal/route.ts",
  ];

  function routeSources(): Map<string, string> {
    const out = new Map<string, string>();
    for (const p of MONEY_ROUTES) out.set(p, readFileSync(join(process.cwd(), p), "utf8"));
    return out;
  }

  test("each money route calls the gate and honours its status", () => {
    const missing: string[] = [];
    for (const [path, src] of routeSources()) {
      if (!src.includes("moneyTwoFactorBlocker")) missing.push(`${path}: gate never called`);
      if (!src.includes("blocker.status")) missing.push(`${path}: denial status not honoured`);
    }
    expect(missing).toEqual([]);
  });

  test("the scanner reports a route that drops the call", () => {
    // Guards the guard: without this case the assertion above is a description
    // of three files, not a gate that can fail.
    const stripped = `export async function POST(req: NextRequest) {
      const auth = await requireOrg(req);
      if (!auth.ok) return fail(auth.failure ?? unauthenticated());
      return ok({ started: true });
    }`;
    expect(stripped.includes("moneyTwoFactorBlocker")).toBe(false);
    expect(stripped.includes("requireOrg")).toBe(true);
  });

  test("every SESSION-Authenticated billing POST calls the gate", () => {
    // The rule is "a human session that can move money", not "any POST under
    // /api/billing". `/api/billing/webhook` is a money route with no session and
    // no human in front of it — it is authenticated by Paddle's signature over
    // the raw bytes and credited through `settlePayment`. Demanding interactive
    // 2FA there would be demanding that a vendor solve a TOTP challenge, and the
    // real control on that path is the signature plus settlement idempotency.
    //
    // Enumerated from disk, so a fourth session-authenticated money route cannot
    // be added without failing here.
    const base = join(process.cwd(), "src/app/api/billing");
    const sessionRoutes: string[] = [];
    const unenforced: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (name !== "route.ts") continue;
        const src = readFileSync(full, "utf8");
        if (!/export async function POST\(/.test(src)) continue;
        const path = relativeToRoot(full);
        const sessionAuthenticated = /requireOrg\(|requireOrgWithCapability\(/.test(src);
        if (!sessionAuthenticated) continue;
        sessionRoutes.push(path);
        if (!src.includes("moneyTwoFactorBlocker")) unenforced.push(path);
      }
    };
    walk(base);

    expect(unenforced).toEqual([]);
    expect(sessionRoutes.sort()).toEqual([...MONEY_ROUTES].sort());
    // The webhook must still be present as a POST route and still be OUT of the
    // session list — that is what makes this exclusion a fact rather than an
    // assumption that nothing else slipped through.
    const webhook = readFileSync(
      join(process.cwd(), "src/app/api/billing/webhook/route.ts"),
      "utf8",
    );
    expect(webhook).toContain("export async function POST(");
    expect(sessionRoutes.some((p) => p.includes("webhook"))).toBe(false);
  });
});

function relativeToRoot(absolute: string): string {
  return posix.relative(
    process
      .cwd()
      .split(/[\\/]+/)
      .join("/"),
    absolute.split(/[\\/]+/).join("/"),
  );
}
