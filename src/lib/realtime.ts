import "server-only";
/**
 * App-side bridge to the realtime service.
 *
 * `audit-chain.append()` calls notify() after a successful write. Two rules make
 * this safe to have inside the audit path:
 *
 *   1. It never throws and never rejects. An audit-chain write is a compliance
 *      record; a websocket fan-out that is down, slow or misconfigured must not
 *      be able to fail it or change its latency profile. Failures are swallowed
 *      after a log line — the console falls back to the SSE stream, so losing a
 *      push degrades the UI, not the record.
 *   2. It sends only what is already redacted. Callers pass the same redacted
 *      payload the chain stores, so no raw transcript or credential can leak
 *      through a channel that has a different retention story than the database.
 *
 * Transport is a plain POST to /ingest signed with the same SV-Signature scheme
 * the platform already uses for bank webhooks, replay-window included.
 */

import { signIngestBody } from "@/lib/realtime-token";
import { realtimeConfigured } from "@/lib/flags";

const INGEST_PATH = "/ingest";

/** Resolve the service URL. In compose it is the service name, never localhost. */
function endpoint(): string | null {
  const base = process.env.REALTIME_URL?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, "") + INGEST_PATH;
}

/** Short timeout — a fan-out that has not landed in 1.5s is not worth waiting on. */
const TIMEOUT_MS = 1_500;

export type BroadcastInput = {
  orgId: string | null | undefined;
  callRef: string;
  payload: Record<string, unknown>;
};

/**
 * Fan one event out. Resolves either way; never rejects.
 * Callers that want to know whether it worked can await and read `delivered`.
 */
export async function notifyRealtime(input: BroadcastInput): Promise<{ delivered: boolean }> {
  // Gated on the flag as well as the secret: a deployment that has the secret
  // left over from an earlier rollout should stop emitting signed requests the
  // moment the flag goes off, rather than continuing to depend on the service
  // being up.
  if (!realtimeConfigured()) return { delivered: false };

  const url = endpoint();
  if (!url) return { delivered: false };

  // Without an org there is no channel to fan out on (the service derives the
  // channel name from the org), so this is a no-op rather than a fallback to a
  // guessable global room.
  const orgId = input.orgId;
  if (!orgId) return { delivered: false };

  const signed = signIngestBody({
    kind: "activity",
    orgId,
    callRef: input.callRef,
    payload: input.payload,
  });
  if (!("body" in signed)) return { delivered: false };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "sv-signature": signed.header },
      body: signed.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Never let a proxy or fetch cache swallow a phase transition.
      cache: "no-store",
    });
    return { delivered: res.ok };
  } catch {
    // Expected whenever the realtime service is absent — a local dev run without
    // compose, or a rolling restart. The console still updates via SSE.
    return { delivered: false };
  }
}
