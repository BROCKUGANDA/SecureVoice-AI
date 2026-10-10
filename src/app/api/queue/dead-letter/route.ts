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
 * SECURITY — this was unauthenticated until it was made to match its sibling.
 *
 * The old comment here said the endpoint was safe because "it never executes
 * the payload — it only STORES it". That was true and insufficient. What it
 * omitted is line 73: it calls `auditAppend`, which writes into the hash-chained
 * audit log. That chain is the tamper-evident record the entire compliance
 * story rests on — every row's `chainHash` links to the previous one, and
 * `verifyChain()` proves none of them were altered. An unauthenticated writer
 * could therefore inject arbitrary rows into evidence, which is a different and
 * much worse problem than storage abuse.
 *
 * So: the same Upstash-Signature check that guards
 * src/app/api/queue/dispatch/route.ts now guards this one too, using the shared
 * verifier. A request that fails it gets a 401 and never reaches the audit
 * append. QStash will not retry a 401, which is correct — a callback with a bad
 * signature would never succeed on retry either.
 *
 * The URL stays public, as it must: QStash has to be able to reach it. Public
 * reachability and unauthenticated acceptance are different things.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { auditAppend, envelopeIdempotencyKeyForDlq } from "@/lib/queue/dead-letter";
import { verifyQStash } from "@/lib/queue/verify-qstash";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Signature first, before anything reads or stores. The verifier consumes the
  // body as text, so it has to happen exactly once and before any other parse.
  const checked = await verifyQStash(req);
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: checked.status });
  }

  // From here the body is already a parsed value, or null if it was not JSON.
  // The unparseable-account case is preserved exactly as before: an
  // unrecognised payload is still recorded, because "we could not parse it" is
  // a reason to keep it, not drop it.
  const body: unknown = checked.body ?? { unparseable: true };

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
      logError("[qstash-dlq] persistence failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  await auditAppend(`qstash:dlq:${idem}`, eventType).catch(() => {});
  return NextResponse.json({ stored: true });
}
