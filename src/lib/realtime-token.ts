import "server-only";
/**
 * Minting side of the realtime grant token.
 *
 * The realtime service (mini-services/realtime/src/auth.ts) verifies what this
 * file mints. The two implementations must produce byte-identical signatures:
 * the payload is recursively key-sorted and the signed input is
 * `"svr1." + base64url(payload)`. If either side drifts, every socket handshake
 * fails with `unauthorized` and the cause is not obvious from the symptom — so
 * the canonicalisation below is duplicated deliberately, and test/auth.test.ts
 * in the service pins the format.
 *
 * Trust model: this is the ONLY place a realtime grant comes from. It runs after
 * `requireSignedIn()` / `requireOperator()`, so a caller who is not a signed-in
 * operator of the org never reaches the signer. The grant therefore carries
 * authority the app has already established — it does not create any.
 *
 * Lifetime is deliberately short (60s). A grant is presented once per socket
 * handshake, so a long TTL would only widen the replay window without helping
 * anyone; reconnection mints a fresh one.
 */

import { createHmac } from "node:crypto";
import { env } from "@/lib/config";

/** Must match PREFIX in mini-services/realtime/src/auth.ts. */
const PREFIX = "svr1";
export const REALTIME_TOKEN_TTL_SEC = env.realtimeTokenTtlSec;

/** Dedicated realtime secret. Deliberately no AGENT_TOOL_SECRET fallback:
 *  that secret crosses the wire on ElevenLabs tool calls — reusing it here
 *  would let a leak there mint console grants and forge live broadcasts. */
function ingestSecret(): string | undefined {
  return process.env.REALTIME_INGEST_SECRET || undefined;
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

export type MintResult = { ok: true; token: string } | { ok: false; error: "not_configured" };

/** Channels an org's operators may watch. Derived, never client-supplied. */
function channelsFor(orgId: string, callRefs: string[]): string[] {
  const chans = [`org:${orgId}`];
  for (const ref of callRefs) chans.push(`case:${orgId}:${ref}`);
  return chans;
}

/**
 * Mint a grant for one signed-in operator.
 *
 * @param orgId   Better Auth organization id the session is scoped to
 * @param sub     operator identifier, used for the presence roster
 * @param callRefs cases to subscribe to in addition to the org-wide channel
 */
export function mintRealtimeToken(orgId: string, sub: string, callRefs: string[] = []): MintResult {
  const secret = ingestSecret();
  if (!secret) return { ok: false, error: "not_configured" };

  const payload = {
    orgId,
    sub,
    chans: channelsFor(orgId, callRefs),
    exp: Math.floor(Date.now() / 1000) + REALTIME_TOKEN_TTL_SEC,
  };
  const body = Buffer.from(canonicalize(payload)).toString("base64url");
  const signingInput = `${PREFIX}.${body}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return { ok: true, token: `${signingInput}.${sig}` };
}

/** Sign an ingest POST. Mirrors mini-services/realtime/src/ingest.ts exactly. */
export function signIngestBody(
  event: unknown,
  nowSec = Math.floor(Date.now() / 1000),
): { body: string; header: string } | { ok: false; error: "not_configured" } {
  const secret = ingestSecret();
  if (!secret) return { ok: false, error: "not_configured" };
  const body = JSON.stringify(event);
  const v1 = createHmac("sha256", secret).update(`${nowSec}.${body}`).digest("hex");
  return { body, header: `t=${nowSec},v1=${v1}` };
}
