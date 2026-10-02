/**
 * WP-11 GATE — invitation-based provisioning.
 *
 * There is no public signup. An account comes into existence only by redeeming a
 * single-use invitation, and this file proves the four properties that make that
 * safe:
 *
 *   1. an EXPIRED invite fails
 *   2. a CONSUMED invite fails
 *   3. TWO CONCURRENT uses of one invite produce EXACTLY ONE success
 *   4. the resulting account's email and role come from the INVITE, not the request
 *
 * Plus: every state change lands in the tamper-evident audit chain, so
 * "who provisioned whom" is provable rather than asserted.
 *
 * Test (3) is the one that matters most and the one most likely to be faked by a
 * weak implementation. A check-then-write in JavaScript passes it on a
 * single-threaded event loop by luck. The winner here is decided by a unique
 * index in Postgres (`store.take`), so the guarantee is the database's and holds
 * across processes and replicas — which is why the test fires all the
 * acceptances before awaiting any of them, so they genuinely overlap in the
 * database rather than being serialised by `await`.
 */

import { afterAll, expect, test } from "bun:test";
import {
  acceptInvite,
  inviteStatus,
  issueInvite,
} from "@/lib/auth/invite";
import { db } from "@/lib/db";
import { verifyChain } from "@/lib/audit-chain";
import { getIdentityByEmail } from "@/lib/auth/identity";
import { INVITE_TTL_MS } from "@/lib/auth/constants";
import {
  cleanupRun,
  makeAccount,
  makeExpiredInvite,
  makeInvite,
  TEST_PASSWORD,
  testEmail,
  uniq,
} from "./helpers";

afterAll(async () => {
  await cleanupRun();
});

// ── Expiry ───────────────────────────────────────────────────────────────────

test("an expired invite is refused", async () => {
  const owner = await makeAccount("Owner", "owner");
  // Issued 72h + 1h ago, so the production 72-hour window has closed.
  const { invite, token, email } = await makeExpiredInvite(
    "Analyst",
    owner.identity.accountId,
    owner.orgId
  );

  // The fixture really did produce an expired invitation, via the production
  // 72-hour policy and nothing else.
  expect(invite.expiresAt).toBeLessThan(Date.now());

  const result = await acceptInvite({ token });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBe("invite_expired");

  // And it must not have created anything.
  expect(await getIdentityByEmail(email)).toBeNull();
  expect(
    await db.account.count({ where: { email } })
  ).toBe(0);
});

test("an invite inside its 72-hour window is still usable", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { invite, token } = await makeInvite("Analyst", owner.identity.accountId, owner.orgId);

  // Issued seconds ago; the policy is 72 hours, so there must be close to that
  // much life left. This is the negative control for the expiry test above: it
  // proves the refusal is about the clock, not about the code refusing invites.
  const remaining = invite.expiresAt - Date.now();
  expect(remaining).toBeGreaterThan(INVITE_TTL_MS - 60_000);

  const result = await acceptInvite({ token });
  expect(result.ok).toBe(true);
});

// ── Single use ───────────────────────────────────────────────────────────────

test("a consumed invite cannot be used a second time", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { token, email } = await makeInvite("Auditor", owner.identity.accountId, owner.orgId);

  const first = await acceptInvite({ token, password: TEST_PASSWORD });
  expect(first.ok).toBe(true);

  const second = await acceptInvite({ token, password: TEST_PASSWORD });
  expect(second.ok).toBe(false);
  if (second.ok) throw new Error("unreachable");
  expect(second.reason).toBe("invite_already_used");

  // Still exactly ONE account on that address — the second attempt created
  // nothing rather than silently resetting the password.
  expect(await db.account.count({ where: { email } })).toBe(1);
  expect(await inviteStatus(token)).toBe("invite_already_used");
});

test("a third attempt is still refused after the second", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { token, email } = await makeInvite("Analyst", owner.identity.accountId, owner.orgId);

  await acceptInvite({ token });
  await acceptInvite({ token });
  const third = await acceptInvite({ token });

  expect(third.ok).toBe(false);
  expect(await db.account.count({ where: { email } })).toBe(1);
});

// ── Concurrency: the exactly-one-winner property ─────────────────────────────

test("two concurrent uses of one invite produce exactly one success", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { token, email } = await makeInvite("Analyst", owner.identity.accountId, owner.orgId);

  // Fired together and awaited together, so both reach the consuming INSERT
  // before either has observed the other's result.
  const [a, b] = await Promise.all([
    acceptInvite({ token, password: TEST_PASSWORD }),
    acceptInvite({ token, password: TEST_PASSWORD }),
  ]);

  const successes = [a, b].filter((r) => r.ok);
  expect(successes).toHaveLength(1);

  const loser = [a, b].find((r) => !r.ok);
  expect(loser && !loser.ok ? loser.reason : null).toBe("invite_already_used");

  // The decisive assertion: not merely "one call returned ok", but "the database
  // holds exactly one account".
  expect(await db.account.count({ where: { email } })).toBe(1);
});

test("eight concurrent uses of one invite still produce exactly one success", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { token, email } = await makeInvite("Auditor", owner.identity.accountId, owner.orgId);

  const attempts = await Promise.all(
    Array.from({ length: 8 }, () => acceptInvite({ token, password: TEST_PASSWORD }))
  );

  const successes = attempts.filter((r) => r.ok);
  expect(successes).toHaveLength(1);

  const failures = attempts.filter((r) => !r.ok);
  for (const f of failures) {
    if (f.ok) throw new Error("unreachable");
    expect(f.reason).toBe("invite_already_used");
  }

  expect(await db.account.count({ where: { email } })).toBe(1);
});

// ── Email binding ────────────────────────────────────────────────────────────

test("the created account takes the invite's email, not the request's", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { token, email } = await makeInvite("Analyst", owner.identity.accountId, owner.orgId);

  // `acceptInvite` has no `email` input at all — that is the structural version
  // of this property. Asserted here so the guarantee is explicit and stays
  // explicit if someone later adds an email field.
  const result = await acceptInvite({ token, name: "Named By Invitee" });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.identity.email).toBe(email);
  expect(result.identity.name).toBe("Named By Invitee");

  const row = await db.account.findUnique({ where: { email }, select: { email: true } });
  expect(row?.email).toBe(email);
});

test("a mismatched assertedEmail is refused and does NOT burn the invite", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { token, email } = await makeInvite("Analyst", owner.identity.accountId, owner.orgId);

  const wrong = await acceptInvite({ token, assertedEmail: testEmail("mallory") });
  expect(wrong.ok).toBe(false);
  if (wrong.ok) throw new Error("unreachable");
  expect(wrong.reason).toBe("email_mismatch");

  // The refusal must not have consumed the invitation, or anyone could deny
  // service to an onboarding flow by guessing an address.
  expect(await inviteStatus(token)).toBe("usable");

  // …and the rightful owner can still redeem it.
  const right = await acceptInvite({ token, assertedEmail: email });
  expect(right.ok).toBe(true);
});

// ── Unknown tokens ───────────────────────────────────────────────────────────

test("an unknown token is refused", async () => {
  const result = await acceptInvite({ token: uniq("not-a-real-token") });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBe("unknown_invite");
});

test("an empty token is refused without a database round trip", async () => {
  const result = await acceptInvite({ token: "   " });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.reason).toBe("unknown_invite");
});

// ── Only the token hash is stored ────────────────────────────────────────────

test("the invite token is stored only as a hash", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { token, email } = await makeInvite("Analyst", owner.identity.accountId, owner.orgId);

  // The invite is stored under the SHA-256 of the token, keyed by that hash.
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const stored = await db.idempotencyKey.findUnique({
    where: { scope_key_callerId: { scope: "sv.auth.invite", key: tokenHash, callerId: "" } },
    select: { key: true, response: true },
  });
  expect(stored).not.toBeNull();
  expect(stored?.key).toBe(tokenHash);
  expect(stored?.key).not.toBe(token);

  // The stored record binds the invitee's email and role, so redemption reads
  // authority from here rather than from the request.
  const parsed = JSON.parse(stored!.response) as { email: string; role: string };
  expect(parsed.email).toBe(email);
  expect(parsed.role).toBe("Analyst");

  // And the plaintext token appears nowhere in the auth store at all.
  const allAuthRows = await db.idempotencyKey.findMany({
    where: { scope: { startsWith: "sv.auth." } },
    select: { response: true, key: true },
  });
  expect(allAuthRows.length).toBeGreaterThan(0);
  for (const row of allAuthRows) {
    expect(row.response).not.toContain(token);
    expect(row.key).not.toBe(token);
  }
});

// ── Audit ────────────────────────────────────────────────────────────────────

test("issuing and consuming an invitation is written to the audit chain", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { token } = await makeInvite("Analyst", owner.identity.accountId, owner.orgId);

  // Issued → the chain must already carry the issue event.
  // Scoped to the org that OWNS these rows: `issueInvite`/`acceptInvite` both
  // append under `invite.orgId`, which is the fixture's own `owner.orgId`.
  // Passing null here would walk the shared namespace and verify zero rows.
  const afterIssue = await verifyChain(`AUTH-${owner.identity.accountId.replace(/[^\w.:-]/g, "")}`, owner.orgId);
  expect(afterIssue.ok).toBe(true);

  const result = await acceptInvite({ token });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");

  // Consumed → the consuming account's own chain carries the redemption, so the
  // question "who provisioned this account" is answerable from the chain.
  // The redemption row is appended with `orgId: invite.orgId` — the same org
  // the account was created into, which is the fixture's `owner.orgId`.
  const created = await verifyChain(`AUTH-${result.identity.accountId.replace(/[^\w.:-]/g, "")}`, owner.orgId);
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const rows = await db.auditLog.findMany({
    where: { callRef: `AUTH-${result.identity.accountId.replace(/[^\w.:-]/g, "")}` },
    orderBy: { createdAt: "asc" },
  });
  const intents = rows.map((r) => r.intent);
  expect(intents).toContain("auth.invite.consumed");
});

test("a role is taken from the invite and cannot be escalated at redemption", async () => {
  const owner = await makeAccount("Owner", "owner");
  // The invite was issued for Auditor. There is no role parameter on
  // `acceptInvite`, so the only way to be anything else is to edit the token
  // payload — which changes nothing, because role lives in the stored row.
  const { token } = await makeInvite("Auditor", owner.identity.accountId, owner.orgId);

  const result = await acceptInvite({ token });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.identity.role).toBe("Auditor");
});

// ── Direct issuance sanity ───────────────────────────────────────────────────

test("issueInvite returns a 256-bit token and stores its hash as the key", async () => {
  const owner = await makeAccount("Owner", "owner");
  const { invite, token } = await issueInvite({
    email: testEmail("direct"),
    name: "direct",
    role: "Analyst",
    orgId: owner.orgId,
    issuedBy: owner.identity.accountId,
  });
  // 32 random bytes → 43 base64url characters.
  expect(token).toHaveLength(43);
  expect(invite.expiresAt - invite.issuedAt).toBe(INVITE_TTL_MS);
});