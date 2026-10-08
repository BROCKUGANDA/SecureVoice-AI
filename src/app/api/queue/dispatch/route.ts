/**
 * QStash dispatch endpoint — one entry point for every queued job kind.
 *
 * Why one endpoint rather than four: the envelope carries `jobKind`, and every
 * handler already knows the payload shape it expects. Splitting into four
 * endpoints would mean four identical signature-verification blocks, four
 * identical EnvelopeError handlers, and four more places to drift.
 *
 * Trust model: this URL is PUBLIC by necessity (QStash must be able to reach
 * it). The request authorizes nothing on its own — QStash's Upstash-Signature
 * header is the only credential we accept. The envelope gate (`parseEnvelope`)
 * is the structural gate; each job handler is the semantic gate that owns what
 * the payload means and acts idempotently against the DB.
 *
 * Failure contract:
 *  - bad signature            → 401, QStash will NOT retry (it never would succeed)
 *  - malformed envelope       → 4xx, QStash will NOT retry (same reason)
 *  - handler throws           → 500, QStash retries with its backoff ladder
 *  - retries exhausted        → QStash failureCallback → /api/queue/dead-letter
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { Receiver } from "@upstash/qstash";
import { parseEnvelope, EnvelopeError, type JobEnvelope, type JobKind } from "@/lib/queue/envelope";
import {
  handleTriggerCall,
  handlePostCallResolution,
  handleSmsFallback,
  handleScheduledRetry,
} from "./handlers";

export const dynamic = "force-dynamic";

const CURRENT = process.env.QSTASH_CURRENT_SIGNING_KEY ?? "";
const NEXT = process.env.QSTASH_NEXT_SIGNING_KEY ?? "";

async function verify(req: NextRequest): Promise<{ ok: boolean; body: unknown }> {
  if (!CURRENT && !NEXT)
    return { ok: false, body: { error: "QStash signing keys not configured" } };
  const signature = req.headers.get("upstash-signature") ?? "";
  const raw = await req.text();
  // Try both keys: Upstash rotates, and during rotation both signatures must
  // still be accepted. A wrong-key 401 that silently breaks production would
  // arrive the day after a rotation, not the day it is announced.
  for (const key of [CURRENT, NEXT]) {
    if (!key) continue;
    try {
      const receiver = new Receiver({ currentSigningKey: key, nextSigningKey: key });
      const ok = await receiver.verify({ signature, body: raw });
      if (ok) return { ok: true, body: JSON.parse(raw) };
    } catch {
      // try the next key
    }
  }
  return { ok: false, body: { error: "invalid Upstash-Signature" } };
}

export async function POST(req: NextRequest) {
  const checked = await verify(req);
  if (!checked.ok) {
    return NextResponse.json(checked.body, { status: 401 });
  }

  let envelope: JobEnvelope;
  try {
    envelope = parseEnvelope(checked.body);
  } catch (err) {
    if (err instanceof EnvelopeError) {
      return NextResponse.json({ error: `envelope rejected: ${err.message}` }, { status: 422 });
    }
    return NextResponse.json({ error: "envelope rejected" }, { status: 422 });
  }

  try {
    await dispatch(envelope);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // A thrown handler is a 5xx so QStash's retry/backoff ladder runs. After
    // the ladder is exhausted QStash calls the failureCallback URL — that is
    // where DeadLetter rows come from. The handler itself must not swallow
    // exceptions into a 200 unless the outcome is genuinely terminal (e.g. the
    // case was already resolved at the consumer side).
    console.error(
      `[queue] handler for ${envelope.jobKind} failed:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}

async function dispatch(envelope: JobEnvelope): Promise<void> {
  const handlers: Record<JobKind, (e: JobEnvelope) => Promise<void>> = {
    "call.trigger": handleTriggerCall,
    "call.postCall": handlePostCallResolution,
    "sms.fallback": handleSmsFallback,
    "retry.callback": handleScheduledRetry,
  };
  await handlers[envelope.jobKind](envelope);
}
