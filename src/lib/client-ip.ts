import "server-only";
/**
 * Client IP: one resolver, one pseudonym, one trust decision.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * Three files were each reading an IP header on their own, and they disagreed:
 *
 *   · `src/proxy.ts:122`            — trust-gated on the proxy marker, prefers
 *                                     `cf-connecting-ip`, sanitises, caps at 64.
 *   · `src/app/api/auth/[...all]`   — first `x-forwarded-for` entry. No marker
 *                                     gate, no cap, no sanitisation.
 *   · `src/app/api/pilot/route.ts`  — preferred the proxy header but fell back to
 *                                     raw `x-forwarded-for`.
 *
 * The disagreement was load-bearing. The auth route's value is the key for the
 * failed-credential budget (`auth:${clientIpOf(req)}`) and for Turnstile's
 * `remoteip`. An attacker who reached the origin directly — which is exactly the
 * condition the proxy marker exists to detect — could set `x-forwarded-for` to an
 * arbitrary string and walk a fresh lockout budget per request, forever. The proxy
 * was careful; the one place that had to be was not. Both bypasses now call this.
 *
 * ── Why the address is pseudonymised before it is stored ──────────────────────
 * `Session.ipAddress` holds a raw address because Better Auth writes it, and the
 * audit chain needs something it can CORRELATE BY (an operator asking "did this
 * one human do those other four things?") without retaining an identifier that
 * names a person. `ipPseudonym()` is the middle: a domain-separated HMAC under the
 * platform's existing `AUTH_SECRET`, so the value is stable across requests and
 * across instances — correlation works — but cannot be reversed to an address
 * without the secret. It mirrors the pattern already established for
 * `PIIVault.blindIndex`, and now shares its primitive with `src/lib/hmac.ts`.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 * There is no UNIQUE constraint on an IP, anywhere, and there never should be
 * one. An address is not an identity:
 *
 *   · NAT and CGNAT put thousands of unrelated people behind one address. This
 *     codebase already knows it — `src/app/api/auth/[...all]/route.ts` forgives a
 *     verified sign-in because "a shared egress address is not punished for
 *     someone else's typos".
 *   · One person holds many sessions, on a laptop and a phone, from one address.
 *     That is the multi-session case working correctly, not a duplicate row.
 *   · The address is not tenant-scoped. `Session` has no `orgId`, so a
 *     cross-tenant unique index would be a tenant-isolation hazard, and a
 *     per-tenant one would have to include a nullable `activeOrganizationId` and so
 *     would not be a uniqueness guarantee at all.
 *
 * What IS unique is every AUDIT ROW (`AuditLog.chainHash` is `@unique`) and every
 * SESSION (`Session.token` is `@unique`) — which is the property uniqueness was
 * actually wanted for. `ipBucket()` covers the case that is real, grouping
 * addresses that should count as one actor for rate limiting, and is never used as
 * an identity.
 */

import { HMAC_DOMAIN, hmacDomain } from "@/lib/hmac";
import {
  IP_UNKNOWN,
  IP_UNTRUSTED,
  REQUEST_ID_HEADER,
  ipBucket,
  isRealIp,
  normalizeIp,
  resolveClientIp,
} from "@/lib/ip-normalize";

export {
  IP_UNKNOWN,
  IP_UNTRUSTED,
  REQUEST_ID_HEADER,
  isRealIp,
  normalizeIp,
  ipBucket,
  resolveClientIp,
};

/**
 * Length of the stored IP pseudonym: 128 bits.
 *
 * Past this, two different addresses colliding is not an event a deployment will
 * ever observe (the birthday bound is ~2^64 rows), and short enough that the
 * column stays a cheap index instead of a 64-char string on every audit row.
 */
const IP_PSEUDONYM_CHARS = 32;

/**
 * The correlation key for an address — what gets stored and what audit rows are
 * grouped by.
 *
 * Domain-separated (`sv-audit-ip:`) so this value can never collide with another
 * HMAC over the same secret, and truncated to 128 bits. Null for a non-address:
 * there is nothing to correlate, and a row that stores a constant instead would
 * make every request-less worker event look like it came from one source.
 */
export function ipPseudonym(ip: string): string | null {
  const norm = normalizeIp(ip);
  if (!isRealIp(norm)) return null;
  // Keyed, domain-separated, and reversible only with AUTH_SECRET. A throw here
  // means the deployment has no AUTH_SECRET at all, which must not be papered over
  // with an unkeyed fallback — see `src/lib/hmac.ts`.
  return hmacDomain(HMAC_DOMAIN.auditIp, norm, IP_PSEUDONYM_CHARS);
}

/**
 * A pseudonym for an already-resolved request, or null when the request did not
 * come through the trusted proxy.
 *
 * This is what audit call sites should reach for: it takes the headers rather than
 * an address, so a caller cannot accidentally attribute a row to a header it
 * believed.
 */
export function requestIpPseudonym(headers: Headers | undefined | null): string | null {
  return ipPseudonym(resolveClientIp(headers));
}
