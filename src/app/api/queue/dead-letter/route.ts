/**
 * QStash failure callback — THE dead-letter entry point.
 *
 * QStash calls this after a message exhausts its retries. Our contract:
 *  - Respond 200 so QStash stops retrying the DLQ call itself. The original
 *    message is already lost; this is about not creating a second, smaller
 *    storm on top.
 *  - Idempotent on envelope.idempotencyKey via DeadLetter.eventId, in case
 *    the failure callback itself is re-fired (at-least-once).
 *  - Never throws on payload shape: if the request is not our envelope, we
 *    still record it, with eventType "qstash.unrecognised", because
 *    "we could not parse it" is a reason to keep it, not drop it.
 *
 * Security: the failure callback is a public URL. It accepts anything, which
 * is fine, because it never executes the payload — it only STORES it. That
 * is the one thing this endpoint must guarantee structurally, so the shape
 * check is not about rejecting bad payloads, it is about being able to file
 * them correctly.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { auditAppend, envelopeIdempotencyKeyForDlq } from "@/lib/queue/dead-letter";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = { unparseable: true };
  }

  const idem = envelopeIdempotencyKeyForDlq(body);
  const caseRef =
    body &&
    typeof body === "object" &&
    "caseRef" in body &&
    typeof (body as never)["caseRef"] === "string"
      ? (body as { caseRef: string }).caseRef
      : null;
  const eventType =
    body && typeof body === "object" && "jobKind" in body
      ? `qstash.${String((body as { jobKind: unknown }).jobKind)}`
      : "qstash.unrecognised";

  await db.deadLetter
    .upsert({
      where: { eventId: idem },
      create: {
        eventId: idem,
        eventType,
        caseRef,
        payload: JSON.stringify(body).slice(0, 20_000),
        targetUrl: "qstash:failureCallback",
        error: "QStash retries exhausted — see payload for the envelope",
        attempts: 4,
      },
      update: {
        attempts: { increment: 1 },
        error: "QStash retries exhausted — see payload for the envelope",
      },
    })
    .catch((err) => {
      logError("[qstash-dlq] persistence failed", { error: err instanceof Error ? err.message : String(err) });
    });

  await auditAppend(`qstash:dlq:${idem}`, eventType).catch(() => {});
  return NextResponse.json({ stored: true });
}
