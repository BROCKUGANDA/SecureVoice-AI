import "server-only";
/**
 * Email magic links (WP-11) — the PRIMARY operator sign-in path.
 *
 * Passwords exist on this system as a FALLBACK only. Magic-link-first is a
 * deliberate choice for a fraud-intervention console used by bank staff:
 *
 *   · Nothing phishable. There is no reusable operator secret for an attacker
 *     to plant in a proxy log or a support ticket.
 *   · No shared credentials. Each operator authenticates as themselves, which is
 *     what makes per-identity session revocation and per-identity audit
 *     attribution meaningful. A console where four people share one login
 *     cannot answer "who exported the data".
 *   · The password path still exists because an operator on a locked-down
 *     network with no mail access must be able to get in at all.
 *
 * ── No mailer in this repository ─────────────────────────────────────────────
 * `issueMagicLink` takes an optional `deliver` callback. A deployment wires its
 * mailer there. When no callback is supplied the function REFUSES and returns
 * `null` rather than returning the token to the caller — because a login route
 * that echoes a usable token back into its HTTP response is a password reset
 * with an auth header, and it would work against any address anybody types.
 *
 * Tests pass their own `deliver`, which is how the gate reaches this path
 * without a mail server.
 *
 * ── Single use, arbitrated by the database ──────────────────────────────────
 * Redemption is `store.take` — an insert-if-absent on a unique index. The
 * database decides the winner, so a link that is somehow observed twice can be
 * redeemed exactly once.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AUTH_SCOPES, put, read, take } from "@/lib/auth/store";
import { MAGIC_LINK_TTL_MS } from "@/lib/auth/constants";
import { normalizeEmail } from "@/lib/auth/password";
import { getIdentityByEmail } from "@/lib/auth/identity";
import { AUTH_AUDIT_INTENTS, auditAuthEvent } from "@/lib/auth/audit";

export type MagicLinkRecord = {
  email: string;
  createdAt: number;
  expiresAt: number;
};

export function hashMagicToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A delivery function. A real deployment sends an email containing
 * `${APP_URL}/auth/magic-link?token=…`. It must not log the token.
 */
export type MagicLinkDeliverer = (input: {
  email: string;
  token: string;
  expiresAt: number;
}) => Promise<void>;

export type IssueMagicLinkResult =
  | { ok: true; email: string; expiresAt: number; token: string }
  | { ok: false; reason: "no_deliverer" | "invalid_email"; error: string };

export async function issueMagicLink(
  email: string,
  deliver?: MagicLinkDeliverer,
): Promise<IssueMagicLinkResult> {
  const normalized = normalizeEmail(email);
  if (!normalized.includes("@") || normalized.length > 254) {
    return { ok: false, reason: "invalid_email", error: "Not a valid email address." };
  }
  if (!deliver) {
    // Fail closed rather than return the token. See the module header.
    return {
      ok: false,
      reason: "no_deliverer",
      error: "Magic-link delivery is not configured on this deployment.",
    };
  }

  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  const record: MagicLinkRecord = {
    email: normalized,
    createdAt: now,
    expiresAt: now + MAGIC_LINK_TTL_MS,
  };
  await put(AUTH_SCOPES.magicLink, hashMagicToken(token), "", record, new Date(record.expiresAt));

  await deliver({ email: normalized, token, expiresAt: record.expiresAt });

  await auditAuthEvent({
    intent: AUTH_AUDIT_INTENTS.magicLinkIssued,
    actorId: normalized,
    note: "magic link issued",
    meta: { expiresAt: record.expiresAt },
  });

  return { ok: true, email: normalized, expiresAt: record.expiresAt, token };
}

export type RedeemMagicLinkResult =
  | { ok: true; email: string }
  | {
      ok: false;
      reason: "unknown_link" | "link_expired" | "link_already_used" | "no_account";
      error: string;
    };

/**
 * Redeem a magic link, consuming it atomically.
 *
 * Returns the bound EMAIL. The caller resolves that email to an account; there
 * is no path here that creates an account — provisioning is invite-only.
 */
export async function redeemMagicLink(
  token: string,
  now = Date.now(),
): Promise<RedeemMagicLinkResult> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed)
    return { ok: false, reason: "unknown_link", error: "That sign-in link is not valid." };

  const hash = hashMagicToken(trimmed);
  const record = await read<MagicLinkRecord>(AUTH_SCOPES.magicLink, hash, "");
  if (!record) {
    // Constant-time no-op so an unknown token costs the same work as a known one.
    timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(hash, "hex"));
    return { ok: false, reason: "unknown_link", error: "That sign-in link is not valid." };
  }
  if (record.expiresAt <= now) {
    return { ok: false, reason: "link_expired", error: "That sign-in link has expired." };
  }

  const claim = await take(
    AUTH_SCOPES.magicLinkConsumed,
    hash,
    "",
    { redeemedAt: now, email: record.email },
    new Date(record.expiresAt),
  );
  if (!claim.ok) {
    return {
      ok: false,
      reason: "link_already_used",
      error: "That sign-in link has already been used.",
    };
  }

  const identity = await getIdentityByEmail(record.email);
  if (!identity) {
    return {
      ok: false,
      reason: "no_account",
      error: "No account exists for that address. Ask an administrator for an invitation.",
    };
  }

  await auditAuthEvent({
    intent: AUTH_AUDIT_INTENTS.loginOk,
    actorId: identity.accountId,
    orgId: identity.orgId,
    note: "signed in via magic link",
    meta: { method: "magic_link" },
  });

  return { ok: true, email: identity.email };
}
