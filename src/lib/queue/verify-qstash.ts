/**
 * Shared QStash signature verification.
 *
 * Extracted from src/app/api/queue/dispatch/route.ts, which had the only copy.
 * Two endpoints receive QStash callbacks — dispatch and dead-letter — and the
 * second one had no verification at all, so anyone on the internet could drive
 * it. A verifier that exists in one place and not the other is how that
 * happens, so it now lives here and both call it.
 *
 * The raw body must be read ONCE and passed as text: `req.text()` consumes the
 * stream, so a handler that tries to read it again gets an empty body.
 */
import type { NextRequest } from "next/server";
import { Receiver } from "@upstash/qstash";

const CURRENT = process.env.QSTASH_CURRENT_SIGNING_KEY ?? "";
const NEXT = process.env.QSTASH_NEXT_SIGNING_KEY ?? "";

export type QStashVerification =
  | { ok: true; body: unknown }
  | { ok: false; status: number; error: string };

/**
 * Verify `upstash-signature` against the raw request body.
 *
 * Both signing keys are tried because Upstash rotates them, and during a
 * rotation window both old and new signatures must be accepted. Rejecting a
 * still-valid old key would break the day AFTER a rotation is announced, which
 * is the worst possible moment to discover it.
 *
 * Fail-closed when no keys are configured: a deploy that forgot to set them
 * must refuse QStash traffic rather than accept anything, or the endpoint is
 * public again and the missing config is invisible.
 */
export async function verifyQStash(req: NextRequest): Promise<QStashVerification> {
  if (!CURRENT && !NEXT) {
    return { ok: false, status: 503, error: "QStash signing keys not configured" };
  }

  const signature = req.headers.get("upstash-signature") ?? "";
  const raw = await req.text();

  for (const key of [CURRENT, NEXT]) {
    if (!key) continue;
    try {
      const receiver = new Receiver({ currentSigningKey: key, nextSigningKey: key });
      const ok = await receiver.verify({ signature, body: raw });
      if (ok) return { ok: true, body: JSON.parse(raw) as unknown };
    } catch {
      // Malformed JSON still parses below under the caller's own guard; a
      // wrong key simply means "try the next one".
    }
  }
  return { ok: false, status: 401, error: "invalid upstash-signature" };
}

/** Whether this deployment can verify QStash at all. Callers log on this. */
export const qstashConfigured = Boolean(CURRENT || NEXT);
