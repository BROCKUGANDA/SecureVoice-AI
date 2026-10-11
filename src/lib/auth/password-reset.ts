import "server-only";
/**
 * Password-reset tokens (the FALLBACK path).
 *
 * Read src/lib/auth/magic-link.ts:5-15 first. Magic-link-first is a deliberate
 * stance — passwords exist on this system only so an operator on a locked-down
 * network with no mail access can get in at all. This module is the recovery
 * path for that fallback credential, and it is deliberately the weakest of the
 * three auth flows.
 *
 * Shape mirrors issueMagicLink exactly, for the same reason its module header
 * gives: the token is written to the store BEFORE the email goes out, so a
 * failed delivery leaves a stranded token — but a stranded reset token expires
 * in minutes and is single-use, so the cost of a send failure is one wasted
 * row, not a live credential.
 *
 * Enumeration defence: like the magic-link endpoint, the request route returns
 * the same answer whether or not the address has an account, so this cannot be
 * used to discover which addresses are bank staff.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AUTH_SCOPES, put, read, take } from "@/lib/auth/store";
import { normalizeEmail } from "@/lib/auth/password";

/** Short-lived. A reset link sitting in an inbox for a week is a liability. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

type ResetRecord = {
  email: string;
  createdAt: number;
  expiresAt: number;
};

export type PasswordResetDeliverer = (input: {
  email: string;
  token: string;
  expiresAt: number;
}) => Promise<void>;

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a reset token and hand it to `deliver`.
 *
 * The caller is responsible for only calling this when the address has an
 * account (or for passing a no-op deliverer when it does not) — see the route.
 * Returns the token ONLY on success so tests can assert on it; the route never
 * serialises it into a response.
 */
export async function issuePasswordReset(
  email: string,
  deliver?: PasswordResetDeliverer,
): Promise<{ ok: true; email: string; token: string } | { ok: false; reason: string }> {
  const normalized = normalizeEmail(email);
  if (!normalized.includes("@") || normalized.length > 254) {
    return { ok: false, reason: "invalid_email" };
  }
  if (!deliver) {
    return { ok: false, reason: "no_deliverer" };
  }

  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  const record: ResetRecord = {
    email: normalized,
    createdAt: now,
    expiresAt: now + PASSWORD_RESET_TTL_MS,
  };
  await put(
    AUTH_SCOPES.passwordReset,
    hashResetToken(token),
    "",
    record,
    new Date(record.expiresAt),
  );

  await deliver({ email: normalized, token, expiresAt: record.expiresAt });

  return { ok: true, email: normalized, token };
}

/** Consume a reset token and return the bound email. Single use. */
export async function redeemPasswordReset(
  token: string,
  now = Date.now(),
): Promise<
  | { ok: true; email: string }
  | { ok: false; reason: "unknown_link" | "link_expired" | "link_already_used" }
> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) return { ok: false, reason: "unknown_link" };

  const hash = hashResetToken(trimmed);
  const record = await read<ResetRecord>(AUTH_SCOPES.passwordReset, hash, "");
  if (!record) {
    // Constant-time no-op so an unknown token costs the same work as a known
    // one — the same shape redeemMagicLink uses.
    timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(hash, "hex"));
    return { ok: false, reason: "unknown_link" };
  }
  if (record.expiresAt <= now) {
    return { ok: false, reason: "link_expired" };
  }

  // Separate consumed scope, exactly as the magic link does it: the token row
  // records the binding, the marker records that it was SPENT. Conflating them
  // would make redemption a no-op because the token row already exists.
  const claim = await take(
    AUTH_SCOPES.passwordResetConsumed,
    hash,
    "",
    { redeemedAt: now, email: record.email },
    new Date(record.expiresAt),
  );
  if (!claim.ok) return { ok: false, reason: "link_already_used" };

  return { ok: true, email: record.email };
}

/** Constant-time compare for a caller that has plaintext + hash in hand. */
export function tokensMatch(plain: string, storedHash: string): boolean {
  const a = Buffer.from(hashResetToken(plain), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}