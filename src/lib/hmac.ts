import "server-only";
/**
 * One keyed-hash primitive, so "stable but irreversible" has a single definition.
 *
 * Every place in this codebase that needs a value it can CORRELATE BY but must not
 * be able to REVERSE had grown its own `createHash("sha256").update(salt + secret)`
 * line. That is the same design in five places, and five places is one more than
 * the next person will check before adding a sixth.
 *
 * The rules it enforces, which are the rules those call sites were individually
 * getting right:
 *
 *   · The key is NEVER a constant and NEVER a fallback. An index whose key is
 *     guessable is an index an attacker can precompute for every value in the
 *     world, so a missing secret REFUSES rather than degrading.
 *   · The key is DERIVED, not the raw secret: `sha256(domain || AUTH_SECRET)`.
 *     Distinct domains therefore produce distinct keys, and a value hashed for
 *     one purpose can never collide with, or be brute-forced against, a value
 *     hashed for another.
 *   · The domain is part of the key derivation AND the message, so the separation
 *     survives even a caller who picks a colliding domain name.
 */

import { createHash, createHmac } from "node:crypto";

/** Domains in use. Keeping them here means a typo is a compile error, not a collision. */
export const HMAC_DOMAIN = {
  /** Pseudonymised client IP for audit correlation. */
  auditIp: "sv-audit-ip",
  /** Searchable index for `PIIVault`. See src/lib/compliance/pii-vault.ts. */
  blindIndex: "sv-blind",
  /** Session-token signing. See src/lib/auth/session.ts. */
  session: "sv-session-v1",
} as const;

export type HmacDomain = (typeof HMAC_DOMAIN)[keyof typeof HMAC_DOMAIN];

function derivedKey(domain: HmacDomain): Buffer {
  const base = process.env.AUTH_SECRET;
  if (!base) {
    // Fail LOUD and fail CLOSED. There is no `?? "dev-secret"` here on purpose: a
    // guessable key makes every pseudonym in the system reversible by anyone, and
    // it fails silently — every value still correlates, so nothing looks wrong
    // until the day the index leaks.
    throw new Error(
      "AUTH_SECRET is required to derive a keyed pseudonym — refusing to build a reversible-by-default identifier.",
    );
  }
  return createHash("sha256").update(`${domain}:${base}`).digest();
}

/**
 * Domain-separated keyed pseudonym of `value`.
 *
 * `hexChars` truncates the digest. The full SHA-256 is 64 hex chars; callers
 * carrying this into an index column choose the shortest length that keeps
 * collisions unreachable in their row count.
 */
export function hmacDomain(domain: HmacDomain, value: string, hexChars?: number): string {
  const full = createHmac("sha256", derivedKey(domain)).update(value).digest("hex");
  if (hexChars === undefined) return full;
  if (!Number.isInteger(hexChars) || hexChars < 8 || hexChars > 64) {
    throw new Error(`hmacDomain: hexChars must be an integer 8..64 (got ${hexChars})`);
  }
  return full.slice(0, hexChars);
}

/** The raw derived key, for callers that need to drive a primitive themselves. */
export function hmacKey(domain: HmacDomain): Buffer {
  return derivedKey(domain);
}
