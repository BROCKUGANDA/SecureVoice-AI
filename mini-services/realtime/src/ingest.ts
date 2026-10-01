/**
 * Server-to-server ingest: the ONLY way anything enters the fan-out.
 *
 * The app (Next.js) is the sole writer. It signs each POST so that a bug, a
 * misrouted proxy rule, or anything else on the compose network cannot inject a
 * fabricated phase transition into an operator's console.
 *
 * The signing scheme is deliberately the same one banks already receive on
 * /api/webhooks (`SV-Signature: t=…,v1=…`), because a reader of this file should
 * already know it:
 *
 *   signed input   "{t}.{rawBody}"        (t = unix SECONDS)
 *   signature      HMAC-SHA256(secret, signed input)
 *   header         t={t},v1={hex}
 *
 * Verifying over the RAW bytes is the point: re-serialising the parsed JSON can
 * change escaping or key order and would invalidate a valid signature, so the
 * caller must hand us the untouched body text.
 *
 * Replay: `t` must be within REPLAY_WINDOW of now. This bounds how long a
 * captured POST stays useful; it is not a substitute for the audit chain, which
 * is the tamper-evident record. Between the two, a replayed ingest is
 * detectable *and* has no standing once the window closes.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Mirrors REPLAY_WINDOW_SEC in src/lib/config.ts. */
export const REPLAY_WINDOW_SEC = 300;
/** Org ids and call refs are bounded before they can become channel segments. */
const MAX_ORG = 64;
const MAX_CALLREF = 64;
const MAX_BODY_BYTES = 64 * 1024;

export type IngestEvent =
  | { kind: "activity"; orgId: string; callRef: string; payload: Record<string, unknown> }
  | { kind: "presence"; orgId: string; callRef: string; watchers: string[] };

export type IngestResult =
  | { ok: true; event: IngestEvent; channel: string }
  | { ok: false; status: 400 | 401 | 403 | 413; error: string };

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function clean(v: string, max: number): string {
  // Colons are stripped: they delimit channel segments (`case:<org>:<callRef>`),
  // so an orgId carrying one would build a channel nothing can join. Same policy
  // as safeSegment() in channels.ts.
  return v.replace(/[^\w.-]/g, "").slice(0, max);
}

/**
 * A channel may only be written by the org that owns it. This is the guard that
 * stops a caller bug from fanning org A's case data out on org B's channel — the
 * signature proves the POST came from the app, not that it was *correct*.
 */
export function channelBelongsToOrg(channel: string, orgId: string): boolean {
  return channel === `org:${orgId}` || channel.startsWith(`case:${orgId}:`);
}

/** Parse and validate `t=…,v1=…` against the raw body. */
export function verifySignature(
  header: string | null | undefined,
  rawBody: string,
  secret: string | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "bad_signature" } {
  if (!secret) return { ok: false, reason: "missing" };
  if (!header) return { ok: false, reason: "missing" };

  const parts = new Map<string, string>();
  for (const seg of header.split(",")) {
    const idx = seg.indexOf("=");
    if (idx <= 0) continue;
    parts.set(seg.slice(0, idx).trim(), seg.slice(idx + 1).trim());
  }
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1) return { ok: false, reason: "malformed" };

  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > REPLAY_WINDOW_SEC) {
    return { ok: false, reason: "stale" };
  }

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  if (!safeEqual(v1, expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

/** Build the header the app must send for this body. */
export function signIngest(event: unknown, secret: string, nowSec = Math.floor(Date.now() / 1000)): { body: string; header: string } {
  const body = JSON.stringify(event);
  const v1 = createHmac("sha256", secret).update(`${nowSec}.${body}`).digest("hex");
  return { body, header: `t=${nowSec},v1=${v1}` };
}

/** Validate the decoded body. Returns the channel to broadcast on. */
export function parseIngest(input: unknown): IngestResult {
  if (!input || typeof input !== "object") return { ok: false, status: 400, error: "invalid_body" };

  const raw = input as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== "activity" && kind !== "presence") return { ok: false, status: 400, error: "invalid_kind" };

  const orgId = typeof raw.orgId === "string" ? clean(raw.orgId, MAX_ORG) : "";
  if (!orgId) return { ok: false, status: 400, error: "invalid_org" };

  const callRef = typeof raw.callRef === "string" ? clean(raw.callRef, MAX_CALLREF) : "";
  const channel = callRef ? `case:${orgId}:${callRef}` : `org:${orgId}`;
  if (!channelBelongsToOrg(channel, orgId)) return { ok: false, status: 403, error: "channel_org_mismatch" };

  if (kind === "presence") {
    const watchers = Array.isArray(raw.watchers)
      ? raw.watchers.filter((w): w is string => typeof w === "string").map((w) => clean(w, MAX_ORG)).slice(0, 64)
      : [];
    return { ok: true, channel, event: { kind: "presence", orgId, callRef, watchers } };
  }

  const payload = raw.payload && typeof raw.payload === "object" ? (raw.payload as Record<string, unknown>) : {};
  // The payload is redacted by the app before it gets here (src/lib/redact.ts);
  // this cap is the second line of defence, not the first.
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: "payload_too_large" };

  return { ok: true, channel, event: { kind: "activity", orgId, callRef, payload } };
}
