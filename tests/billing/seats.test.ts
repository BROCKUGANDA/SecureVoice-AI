/**
 * Seat caps — the plan's limit on how many people a tenant may hold.
 *
 * The properties worth pinning, in order of the harm they prevent:
 *
 *   1. a plan's cap REFUSES the next invitation, with a commercial code the UI
 *      can branch on;
 *   2. the refusal at REDEMPTION does not destroy the invitation — a seat cap is
 *      not the invitee's fault, and a burned token turns a plan change into a
 *      credential that has to be reissued by hand;
 *   3. a downgrade cannot be walked around by redeeming an invitation minted
 *      while the plan was larger;
 *   4. unlimited really means unlimited (Enterprise), and "no plan resolved"
 *      means no cap rather than a wrong cap — the fail-open direction documented
 *      in src/lib/billing/seats.ts;
 *   5. nobody is removed because a plan got smaller.
 *
 * Runs against the real database: the member count comes from the first-party
 * identity store and the plan from the mirrored Paddle rows, so a fake would
 * exercise neither. Every row created here is tracked and deleted BY ID — the
 * billing mirror is shared with real tenants, and a `deleteMany` on a prefix or
 * a whole table would erase subscriptions this test did not create.
 *
 *   bun test tests/billing/seats.test.ts
 */
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { db } from "@/lib/db";
import { seatFacts, seatGate } from "@/lib/billing/seats";
import { acceptInvite, inviteStatus, issueInvite } from "@/lib/auth/invite";
import { listOrgMembers } from "@/lib/auth/identity";
import { cleanupRun, makeMember, testEmail, testOrg, uniq } from "../auth/helpers";

const PRICES: Record<string, string> = {
  starter: `pr_starter_${uniq("p")}`,
  growth: `pr_growth_${uniq("p")}`,
  enterprise: `pr_enterprise_${uniq("p")}`,
};

const SAVED_PRICES = process.env.PADDLE_PRICES;
process.env.PADDLE_PRICES = JSON.stringify({
  usd_250000_monthly: PRICES.starter,
  usd_2500000_yearly: PRICES.starter,
  usd_900000_monthly: PRICES.growth,
  usd_9000000_yearly: PRICES.growth,
  usd_2500000_monthly: PRICES.enterprise,
  usd_25000000_yearly: PRICES.enterprise,
});
// THE INTERVAL IS PART OF THE KEY, and it has to be. Starter's annual price is
// $2,500 x 10 = $25,000 and Enterprise's monthly price is $25,000 — the same
// amount, so `usd_2500000` alone names two different prices. Resolving a plan
// from the amount alone made a Starter ANNUAL subscriber resolve to
// Enterprise, and it would have been rated with Enterprise's 10,000-intervention
// allowance. `usd_2500000_yearly` is Starter; `usd_2500000_monthly` is
// Enterprise.

/** Rows this file created, so cleanup deletes exactly them and nothing else. */
const createdSubscriptions: string[] = [];
const createdCustomers: string[] = [];

/** Mirrored Paddle rows for a synthetic org. `PaddleSubscription` requires a customer. */
async function seedSubscription(
  orgId: string,
  plan: "starter" | "growth" | "enterprise",
  status = "active",
): Promise<void> {
  const tag = uniq("sub");
  const customerId = `ctm_${tag}`;
  const subscriptionId = `sub_${tag}`;
  createdCustomers.push(customerId);
  createdSubscriptions.push(subscriptionId);
  await db.paddleCustomer.create({
    data: { customerId, orgId, email: `${tag}@seats.test`, name: "Seat test customer" },
  });
  await db.paddleSubscription.create({
    data: {
      subscriptionId,
      customerId,
      orgId,
      status,
      priceId: PRICES[plan]!,
      productId: `pro_${tag}`,
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
    },
  });
}

/** `count` identities in one org. The first is the Owner, so Starter's one seat is real. */
async function fillOrg(orgId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await makeMember(i === 0 ? "Owner" : "Analyst", `seat-m${i}`, orgId);
  }
}

async function inviteFor(orgId: string, issuedBy: string) {
  const email = testEmail("seat-invitee");
  const { invite, token } = await issueInvite({
    email,
    name: "invitee",
    role: "Analyst",
    orgId,
    issuedBy,
  });
  return { invite, token, email };
}

afterAll(async () => {
  await db.paddleSubscription
    .deleteMany({ where: { subscriptionId: { in: createdSubscriptions } } })
    .catch(() => {});
  await db.paddleCustomer
    .deleteMany({ where: { customerId: { in: createdCustomers } } })
    .catch(() => {});
  process.env.PADDLE_PRICES = SAVED_PRICES ?? "";
  await cleanupRun();
  await db.$disconnect();
});

// ── 1. The cap refuses ───────────────────────────────────────────────────────

test("a Growth organization at five members cannot invite a sixth", async () => {
  const orgId = testOrg("growth-full");
  await seedSubscription(orgId, "growth");
  await fillOrg(orgId, 5);

  const facts = await seatFacts(orgId);
  expect(facts.seats).toBe(5);
  expect(facts.members).toBe(5);
  expect(facts.remaining).toBe(0);
  expect(facts.plan).toBe("growth");

  const gate = await seatGate(orgId);
  expect(gate.ok).toBe(false);
  if (gate.ok) return;
  expect(gate.code).toBe("seat_limit_reached");
  // The message has to be actionable on its own: what the plan allows, what is
  // used, and that the way forward is an upgrade.
  expect(gate.message).toMatch(/5 seats/);
  expect(gate.message).toMatch(/upgrade/i);
});

test("four of five still invites", async () => {
  const orgId = testOrg("growth-room");
  await seedSubscription(orgId, "growth");
  await fillOrg(orgId, 4);

  const gate = await seatGate(orgId);
  expect(gate.ok).toBe(true);
  if (!gate.ok) return;
  expect(gate.facts.remaining).toBe(1);
});

test("Starter is ONE person in total — the Owner counts against the seat", async () => {
  const orgId = testOrg("starter");
  await seedSubscription(orgId, "starter");
  const owner = await makeMember("Owner", "seat-owner", orgId);

  // If the cap excluded the Owner, Starter would carry two people while its own
  // card says "One named seat".
  expect((await seatFacts(orgId)).members).toBe(1);

  const gate = await seatGate(orgId);
  expect(gate.ok).toBe(false);
  if (gate.ok) return;
  expect(gate.facts.seats).toBe(1);
  expect(gate.message).toMatch(/1 seat/);
  void owner;
});

// ── 2 & 3. Redemption, and the invitation survives a refusal ─────────────────

test("a redemption over the cap is refused and the invitation is NOT consumed", async () => {
  const orgId = testOrg("accept-full");
  await seedSubscription(orgId, "growth");
  const owner = await makeMember("Owner", "seat-a-owner", orgId);
  const { token, email } = await inviteFor(orgId, owner.identity.accountId);

  expect(await inviteStatus(token)).toBe("usable");

  // The seat fills while the invitation sits in the invitee's inbox.
  await fillOrg(orgId, 4);
  const gate = await seatGate(orgId);
  expect(gate.ok).toBe(false);

  const result = await acceptInvite({
    token,
    name: "Late analyst",
    seatGate: async () => (gate.ok ? { ok: true } : { ok: false, message: gate.message }),
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("seat_full");
  // THE POINT OF THE ORDERING: no account exists and the token still works, so
  // the same link redeems the moment a seat frees. A burned invitation would be
  // unrecoverable work caused by the TENANT's billing state.
  expect(await db.account.count({ where: { email } })).toBe(0);
  expect(await inviteStatus(token)).toBe("usable");
});

test("an invitation minted under a bigger plan cannot walk around a downgrade", async () => {
  const orgId = testOrg("downgrade");
  await seedSubscription(orgId, "growth");
  const owner = await makeMember("Owner", "seat-d-owner", orgId);
  const { token } = await inviteFor(orgId, owner.identity.accountId);

  // Growth has room right now.
  expect((await seatGate(orgId)).ok).toBe(true);

  // The plan shrinks under the outstanding invitation.
  await db.paddleSubscription.updateMany({ where: { orgId }, data: { priceId: PRICES.starter } });
  expect((await seatFacts(orgId)).seats).toBe(1);
  expect((await seatGate(orgId)).ok).toBe(false);

  const result = await acceptInvite({
    token,
    seatGate: async () => ({ ok: false, message: "over cap after downgrade" }),
  });
  // The gate is what refuses; the accept path must not skip it just because the
  // invitation itself is perfectly valid.
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("seat_full");
});

test("acceptInvite without a seatGate still redeems — the gate is the caller's policy", async () => {
  const orgId = testOrg("no-gate");
  await seedSubscription(orgId, "starter");
  const owner = await makeMember("Owner", "seat-n-owner", orgId);
  const { token } = await inviteFor(orgId, owner.identity.accountId);

  const result = await acceptInvite({ token });
  expect(result.ok).toBe(true);
});

// ── 4. Unlimited, and the fail-open directions ───────────────────────────────

test("Enterprise is unlimited: seven members and no refusal", async () => {
  const orgId = testOrg("enterprise");
  await seedSubscription(orgId, "enterprise");
  await fillOrg(orgId, 7);

  const facts = await seatFacts(orgId);
  expect(facts.plan).toBe("enterprise");
  expect(facts.seats).toBeNull();
  expect(facts.members).toBe(7);
  expect(facts.remaining).toBeNull();
  expect((await seatGate(orgId)).ok).toBe(true);
});

test("a tenant with no mirrored subscription has no cap, not a wrong cap", async () => {
  // Fail-OPEN, deliberately: a seat cap is commercial, and enforcing a limit
  // because a webhook has not arrived would lock an operator out of inviting
  // their own staff. Documented in src/lib/billing/seats.ts.
  const orgId = testOrg("no-sub");
  await fillOrg(orgId, 3);
  const facts = await seatFacts(orgId);
  expect(facts.plan).toBeNull();
  expect(facts.seats).toBeNull();
  expect(facts.members).toBe(3);
  expect((await seatGate(orgId)).ok).toBe(true);
});

test("a price id this catalog does not publish yields no cap", async () => {
  const orgId = testOrg("unknown-price");
  await seedSubscription(orgId, "growth");
  await db.paddleSubscription.updateMany({
    where: { orgId },
    data: { priceId: "pr_invented_in_the_dashboard" },
  });
  await fillOrg(orgId, 9);
  const facts = await seatFacts(orgId);
  expect(facts.plan).toBeNull();
  expect(facts.seats).toBeNull();
});

test("a canceled subscription does not keep its plan's cap", async () => {
  // `hasPaidAccess` denies `canceled`, and the row is still the newest thing we
  // know about the tenant — so the resolver must read the STATUS, not merely find
  // a row. A canceled Starter would otherwise stay capped at one seat forever.
  const orgId = testOrg("canceled");
  await seedSubscription(orgId, "starter", "canceled");
  await fillOrg(orgId, 2);
  const facts = await seatFacts(orgId);
  expect(facts.plan).toBeNull();
  expect(facts.seats).toBeNull();
});

test("a past_due subscription keeps its cap — grace is not a plan change", async () => {
  const orgId = testOrg("past-due");
  await seedSubscription(orgId, "starter", "past_due");
  await fillOrg(orgId, 1);
  expect((await seatFacts(orgId)).plan).toBe("starter");
  expect((await seatGate(orgId)).ok).toBe(false);
});

// ── 5. Shrinking a plan never removes a member ───────────────────────────────

test("an organization over its cap keeps every existing member and says so honestly", async () => {
  const orgId = testOrg("over-cap");
  await seedSubscription(orgId, "starter");
  await fillOrg(orgId, 4);

  const gate = await seatGate(orgId);
  expect(gate.ok).toBe(false);

  // Nothing was removed to make the number fit: the SAME four identities are
  // still in the store after the refusal.
  expect((await listOrgMembers(orgId)).length).toBe(4);
  const facts = await seatFacts(orgId);
  expect(facts.seats).toBe(1);
  expect(facts.members).toBe(4);
  expect(facts.remaining).toBe(-3);
  expect(facts.atOrOverCap).toBe(true);

  if (gate.ok) return;
  // The wording for an org ALREADY over is not "0 seats remaining" — that reads
  // like a bug to someone who can see four members on screen.
  expect(gate.message).toMatch(/more than/);
  expect(gate.message).toMatch(/existing members keep their access/);
});

// ── 6. The routes are wired to the gate ──────────────────────────────────────

test("the issue route refuses over-cap BEFORE an invitation or an email exists", () => {
  // A source-level gate, in the style of tests/routes and
  // tests/unit/caddy-gateway.test.ts: the seat check must sit between the
  // role-ceiling check and `issueInvite`. Move it after the mint and the
  // invitation exists — and has been emailed — before anybody is refused.
  const src = readFileSync(
    fileURLToPath(new URL("../../src/app/api/auth/invites/route.ts", import.meta.url)),
    "utf8",
  );
  const gateAt = src.indexOf("await seatGate(");
  const mintAt = src.indexOf("await issueInvite(");
  const ceilingAt = src.indexOf('authed.role !== "Owner"');
  expect(gateAt).toBeGreaterThan(-1);
  expect(mintAt).toBeGreaterThan(-1);
  expect(ceilingAt).toBeGreaterThan(-1);
  expect(gateAt).toBeGreaterThan(ceilingAt);
  expect(gateAt).toBeLessThan(mintAt);
  expect(src).toMatch(/status: 402/);
  // The code travels from the gate, so the route cannot invent a refusal the
  // module never gave it. The literal itself is pinned in the gate tests above.
  expect(src).toMatch(/code: seats\.code/);
  // The members list carries the cap, so an operator sees the limit before
  // hitting it rather than being introduced to it by a refusal.
  expect(src).toMatch(/await seatFacts\(/);
});

test("the redemption route maps a full plan to 402, not to 410 Gone", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../src/app/api/auth/invites/accept/route.ts", import.meta.url)),
    "utf8",
  );
  expect(src).toMatch(/seatGate: redeemSeatGate/);
  const seatBranch = src.indexOf('result.reason === "seat_full"');
  const goneBranch = src.indexOf("410");
  expect(seatBranch).toBeGreaterThan(-1);
  // The seat branch must be decided BEFORE the blanket 410, or a full plan is
  // reported as a dead invitation and the invitee asks for one they do not need.
  expect(seatBranch).toBeLessThan(goneBranch);
  expect(src).toMatch(/status: 402/);
});
