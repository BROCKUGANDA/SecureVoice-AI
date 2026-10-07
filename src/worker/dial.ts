/**
 * Dial worker — the runnable loop around src/lib/scale/queue.ts.
 *
 * The queue module owns the semantics (SKIP LOCKED claiming, lease expiry,
 * bounded attempts, the dead-letter state). This file owns only the loop and
 * the side effect: turning a claimed job into a call.
 *
 * It runs as its own compose service rather than inside the web app, so a hung
 * carrier call never occupies an HTTP request and killing the web tier does not
 * stop fraud interventions. Scaling out is safe by construction — claiming uses
 * FOR UPDATE SKIP LOCKED — so `--scale dial-worker=3` needs no coordination.
 *
 * One-shot drain (useful in CI and for an operator flushing after an incident):
 *   bun src/worker/dial.ts --once
 */
// NOTE: deliberately NO `import "server-only"` here. That marker exists so the
// Next bundler fails loudly if a client component reaches server code; this file
// is a standalone Bun process outside any bundle, where the package only throws
// and prevents the worker from starting at all. The imports below are all
// server-only modules and are never reachable from a client bundle.

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { drainDialQueue, type DialJob, type DialOutcome } from "@/lib/scale/queue";
import { placeOutboundCall } from "@/lib/elevenlabs/outbound-call";
import { append as auditAppend } from "@/lib/audit-chain";
import { db } from "@/lib/db";
import { transitionCase } from "@/lib/case-state-machine";
import { sendUnreachableSms } from "@/lib/elevenlabs/sms-fallback";

const WORKER_ID =
  process.env.DIAL_WORKER_ID ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const POLL_MS = Number(process.env.DIAL_WORKER_POLL_MS ?? 1_000);
const BATCH = Number(process.env.DIAL_WORKER_BATCH ?? 5);
const LEASE_MS = Number(process.env.DIAL_WORKER_LEASE_MS ?? 60_000);
const ONCE = process.argv.includes("--once");

type JobPayload = {
  to?: string;
  phone?: string;
  language?: string;
  merchant?: string;
  amount?: number;
  currency?: string;
  transaction_ref?: string;
};

function parsePayload(job: DialJob): JobPayload {
  try {
    const v = JSON.parse(job.payload) as unknown;
    return v && typeof v === "object" ? (v as JobPayload) : {};
  } catch {
    return {};
  }
}

/**
 * Place one call.
 *
 * The recovery check comes first and is the part that matters: if the case
 * already carries a conversation id, a previous worker placed this call and died
 * before recording it. Dialling again would call a customer who is already on
 * the phone with us — the one failure the queue's unique index cannot prevent
 * on its own, because the provider accepted the call outside our transaction.
 */
async function handle(job: DialJob): Promise<DialOutcome> {
  const payload = parsePayload(job);

  const existing = await db.case.findFirst({
    where: { caseRef: job.case_ref },
    select: { conversationId: true, state: true, phone: true },
  });
  if (existing?.conversationId) {
    // Already placed by a worker that died before writing it down.
    return { ok: true };
  }

  // The destination comes from the Case row, never from the job payload.
  //
  // The payload's `to` is written as `redactText(signal.phone)` on the ingest
  // path, so it reads "[REDACTED]" — correct for an audit/display field and
  // fatal for a dial instruction. Trusting it sends "[REDACTED]" to the
  // telephony provider, which dry-run mode cannot detect because
  // `placeOutboundCall` returns a synthetic conversation id without ever
  // looking at the number. The plaintext destination already lives on the case
  // row, which is the one place it is legitimately stored.
  const to = existing?.phone ?? payload.phone;
  if (!to) {
    return { ok: false, error: "case row has no destination phone", retryable: false };
  }
  if (!/^\+[1-9]\d{6,14}$/.test(to)) {
    // Fail closed rather than dial a redaction placeholder or a mangled number:
    // a wrong destination here means an unrelated customer gets a fraud call.
    return {
      ok: false,
      error: `destination is not a valid E.164 number: ${to.slice(0, 4)}`,
      retryable: false,
    };
  }

  try {
    const result = await placeOutboundCall({
      toNumber: to,
      language: payload.language ?? "en",
      merchant: payload.merchant ?? undefined,
      amount: payload.amount ?? undefined,
      currency: payload.currency ?? undefined,
      caseRef: job.case_ref,
      dynamicVariables: {
        case_id: job.case_id,
        case_ref: job.case_ref,
        merchant: payload.merchant ?? "",
        amount: payload.amount ?? 0,
        currency: payload.currency ?? "",
        transaction_ref: payload.transaction_ref ?? "",
      },
    });

    // The case state machine is the SINGLE WRITER for case state. This used to
    // be a raw `db.case.updateMany`, which bypassed the writer, skipped the
    // legality check (SCREENED -> DIALING and RETRY_SCHEDULED -> DIALING are
    // the only legal ways in) and wrote NO transition audit row — so a case
    // could reach DIALING with nothing in the chain saying it did.
    // transitionCase writes the row, the legality check and the audit entry
    // together, and throws IllegalTransitionError rather than forcing a state
    // the table forbids.
    await transitionCase(job.case_ref, "DIALING", { conversationId: result.conversationId });

    void auditAppend({
      callRef: job.case_ref,
      action: "handoff",
      intent: "dial_placed",
      callerId: WORKER_ID,
      redactedText: `attempt ${job.attempt_no}`,
      meta: {
        jobId: job.id,
        attemptNo: job.attempt_no,
        retries: job.retries,
        conversationId: result.conversationId,
        dryRun: result.dryRun,
      },
      orgId: job.org_id ?? undefined,
    }).catch(() => {});

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void auditAppend({
      callRef: job.case_ref,
      action: "handoff",
      intent: "dial_failed",
      callerId: WORKER_ID,
      redactedText: message.slice(0, 120),
      meta: { jobId: job.id, attemptNo: job.attempt_no, retries: job.retries },
      orgId: job.org_id ?? undefined,
    }).catch(() => {});
    // Retryable: a busy signal or a transient provider error is worth another
    // attempt; a rejected number is not, and retrying it wastes quota.
    const permanent = /not a valid|invalid|not.*reachable|permission/i.test(message);
    return { ok: false, error: message.slice(0, 300), retryable: !permanent };
  }
}

/**
 * The voice channel has definitively failed for this case (every attempt spent,
 * or the number was undiallable). SMS is the only way left to reach the
 * customer, so try it - once, honestly worded, never in dry-run. All of those
 * rules live in `sendUnreachableSms`; this only supplies the amount the voice
 * agent would have read.
 */
async function onDead(job: DialJob): Promise<void> {
  const payload = parsePayload(job);
  await sendUnreachableSms({
    caseRef: job.case_ref,
    reason: "dial_exhausted",
    amount: payload.amount ?? null,
    currency: payload.currency ?? null,
  });
}

async function tick(): Promise<number> {
  const result = await drainDialQueue({
    workerId: WORKER_ID,
    handler: handle,
    onDead,
    limit: BATCH,
    leaseMs: LEASE_MS,
  });
  return result.claimed;
}

async function main(): Promise<void> {
  console.log(
    `[dial-worker] ${WORKER_ID} starting — batch ${BATCH}, lease ${LEASE_MS}ms, poll ${POLL_MS}ms`,
  );

  if (ONCE) {
    const n = await tick();
    console.log(`[dial-worker] claimed ${n} job(s) and exiting (--once)`);
    return;
  }

  let running = true;
  const stop = () => {
    running = false;
    console.log("[dial-worker] draining — finishing in-flight work");
  };
  // Bun's typed process.on overload enumerates a narrow event union; SIGTERM
  // and SIGINT are valid at runtime and are exactly what compose sends.
  process.on("SIGTERM" as never, stop as never);
  process.on("SIGINT" as never, stop as never);

  while (running) {
    let claimed = 0;
    try {
      claimed = await tick();
    } catch (err) {
      console.error("[dial-worker] tick failed:", err instanceof Error ? err.message : err);
    }
    // Only idle when there was nothing to do — a backlog drains flat out.
    if (claimed === 0) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log("[dial-worker] stopped cleanly");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[dial-worker] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { handle, tick, WORKER_ID };
