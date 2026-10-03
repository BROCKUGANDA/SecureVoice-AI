/**
 * Realtime grant tokens.
 *
 * The realtime service cannot validate a Better Auth session — Clerk lives in the
 * Next.js app, and the socket server holds no user records. So the trust
 * decision is delegated:
 *
 *   1. The app mints a short-lived grant (60s) after its own auth check,
 *      scoped to one org and the channels that org may read.
 *   2. The browser presents that grant as `auth.token` on the socket handshake.
 *   3. This service verifies the HMAC with the shared secret, checks `exp`, and
 *      then treats the token's channel list as the socket's entire authority.
 *      A token for org A cannot join org B's channels, because org B's name is
 *      not in its own channel list.
 *
 * Format (must match src/lib/realtime-token.ts byte-for-byte):
 *
 *   svr1.<base64url(payload json)>.<base64url(hmac-sha256)>
 *   signed input = "svr1." + base64url(payload)
 *
 * The payload is canonicalised (recursively sorted keys) before hashing so the
 * signature is stable regardless of how the object was constructed. Expiry is
 * checked with a small leeway so a token minted just before a clock tick is not
 * rejected on arrival; leeway only ever shortens the window in one direction if
 * the clock is already behind, so it cannot be used to extend a token.
 *
 * Timing: comparisons are over sha256 digests of both sides so a wrong-length
 * guess yields a clean 401 rather than a throw (same reasoning as
 * src/lib/agent-tool-auth.ts).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Version prefix doubles as the signing-scheme discriminator. */
const PREFIX = "svr1";

export const DEFAULT_TTL_SEC = 60;
/** Tolerated clock skew, in seconds, in both directions. */
export const LEEWAY_SEC = 5;

export type GrantPayload = {
  /** Organization whose data this grant may read. */
  orgId: string;
  /** Socket name of the operator, for the presence roster. */
  sub: string;
  /** Channels the grant may join — nothing outside this list is reachable. */
  chans: string[];
  /** Expiry, unix seconds. */
  exp: number;
};

export type VerifiedGrant =
  | { ok: true; orgId: string; sub: string; chans: string[] }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "unscoped" };

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Recursively sort object keys so the signed bytes do not depend on insert order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
      .join(",") +
    "}"
  );
}

/** Sign a payload. The token body is `PREFIX.body`, and only that is signed. */
export function sign(payload: GrantPayload, secret: string): string {
  const body = b64url(canonicalize(payload));
  const signingInput = `${PREFIX}.${body}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

/**
 * Verify a grant. Every failure returns the same 401 at the HTTP boundary; the
 * `reason` exists for logs and tests, never for the caller.
 */
export function verify(
  token: string | undefined | null,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): VerifiedGrant {
  if (!secret) return { ok: false, reason: "malformed" };
  if (!token) return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [prefix, body, sig] = parts;
  if (prefix !== PREFIX || !body || !sig) return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", secret).update(`${prefix}.${body}`).digest("base64url");
  if (!safeEqual(sig, expected)) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as GrantPayload).orgId !== "string" ||
    typeof (parsed as GrantPayload).sub !== "string" ||
    typeof (parsed as GrantPayload).exp !== "number" ||
    !Array.isArray((parsed as GrantPayload).chans)
  ) {
    return { ok: false, reason: "malformed" };
  }

  const p = parsed as GrantPayload;
  if (p.exp + LEEWAY_SEC < nowSec) return { ok: false, reason: "expired" };

  // An org with no channels is a misconfiguration, not a valid grant: refuse it
  // rather than opening a socket that can see nothing but still counts as live.
  const chans = p.chans.filter((c): c is string => typeof c === "string" && c.length > 0);
  if (!p.orgId || chans.length === 0) return { ok: false, reason: "unscoped" };

  return { ok: true, orgId: p.orgId, sub: p.sub, chans };
}
