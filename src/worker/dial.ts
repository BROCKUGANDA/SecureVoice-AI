/**
 * Dial worker — the process that turns queued jobs into calls.
 *
 * Run as its own service (compose: `dial-worker`) rather than inside the web
 * app, for three reasons: a hung carrier call can never occupy a web request;
 * workers scale independently of request handling; and killing the web tier
 * does not stop fraud interventions.
 *
 * Scaling out is safe by construction — claiming uses FOR UPDATE SKIP LOCKED —
 * so `docker compose up --scale dial-worker=3` needs no coordination.
 *
 * Run directly for a one-shot drain:  bun src/worker/dial.ts --once
 */
import "server-only";

import { claimDialJobs, markDialFailed, markDialPlaced, markDialRecovered, MAX_DIAL_ATTEMPTS } from "@/lib/dial-queue";
import { caseByConversation, transitionCase } from "@/lib/case-state-machine";
import { placeOutboundCall } from "@/lib/elevenlabs/outbound-call";
import { append as auditAppend } from "@/lib/audit-chain";
import { db } from "@/lib/db";

const POLL_INTERVAL_MS = Number(process.env.DIAL_WORKER_POLL_MS ?? 1_000);
const BATCH = Number(process.env.DIAL_WORKER_BATCH ?? 5);
const ONCE = process.argv.includes("--once");

/**
 * Place one claimed job.
 *
 * The recovery check comes first and is the important part: if the case already
 * has a conversation id, the call was placed before this worker (or a previous
 * one) died, and we record that instead of dialling a customer who is already
 * on the phone with us.
 */
async function runJob(job: {
  id: string;
  caseRef: string;
  attemptNo: number;
  attempts: number;
  conversationId: string | null;
}): Promise<void> {
  if (job.conversationId) {
    await markDialRecovered(job.id, job.conversationId);
    return;
  }

  // Join key: the conversation id is what the post-call webhook correlates on,
  // and its presence means a call already exists for this case.
  const existing = await db.case.findFirst({
    where: { caseRef: job.caseRef },
    select: { conversationId: true, state: true, phone: true, language: true, merchant: true, amountMinor: true, currency: true },
  });
  if (existing?.conversationId) {
    await markDialRecovered(job.id, existing.conversationId);
    return;
  }
  if (!existing?.phone) {
    await markDialFailed(job.id, "case has no phone number", job.attempts);
    return;
  }
  // A case already in flight is not re-dialled.
  if (["DIALING", "RINGING", "ANSWERED"].includes(existing.state)) {
    await markDialRecovered(job.id, job.conversationId ?? "");
    return;
  }

  try {
    const result = await placeOutboundCall({
      toNumber: existing.phone,
      language: existing.language ?? "en",
      merchant: existing.merchant ?? undefined,
      amount: existing.amountMinor ?? undefined,
      currency: existing.currency ?? undefined,
      caseRef: job.caseRef,
      dynamicVariables: {
        case_id: job.caseRef,
        merchant: existing.merchant ?? "",
        amount: existing.amountMinor ?? 0,
        currency: existing.currency ?? "",
      },
    });

    await markDialPlaced(job.id, {
      conversationId: result.conversationId,
      callSid: result.callSid,
    });

    // Persist the join key so a crash before this point cannot cause a second
    // dial, and so the post-call webhook can find the case.
    await db.case.updateMany({
      where: { caseRef: job.caseRef },
      data: { conversationId: result.conversationId, state: "DIALING" },
    });

    void auditAppend({
      callRef: job.caseRef,
      action: "handoff",
      intent: "dial_placed",
      callerId: "dial-worker",
      redactedText: `attempt ${job.attemptNo}`,
      meta: {
        jobId: job.id,
        attemptNo: job.attemptNo,
        conversationId: result.conversationId,
        dryRun: result.dryRun,
        latencyMs: 0,
      },
    }).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = await markDialFailed(job.id, message, job.attempts);
    void auditAppend({
      callRef: job.caseRef,
      action: "handoff",
      intent: outcome === "DEAD" ? "dial_dead" : "dial_retry",
      callerId: "dial-worker",
      redactedText: message.slice(0, 120),
      meta: { jobId: job.id, attemptNo: job.attemptNo, attempts: job.attempts, max: MAX_DIAL_ATTEMPTS },
    }).catch(() => {});
    if (outcome === "DEAD") {
      // Dead-lettered: the case must not sit in DIALING forever. Move it to a
      // terminal failure state so it appears in the console as an outcome.
      await transitionCase(job.caseRef, "FAILED").catch(() => {});
    }
  }
}

async function tick(): Promise<number> {
  const jobs = await claimDialJobs(BATCH);
  // Sequential within a batch: the telephony ceiling is per-second, and a
  // parallel burst would race straight into provider rate limiting. Parallelism
  // comes from running more workers, which is the axis that scales cleanly.
  for (const job of jobs) {
    await runJob(job).catch((err) =>
      console.error("[dial-worker] job failed:", job.id, err instanceof Error ? err.message : err),
    );
  }
  return jobs.length;
}

async function main(): Promise<void> {
  const target = process.env.DIAL_TARGET ?? "http://dial-worker";
  console.log(`[dial-worker] starting — poll ${POLL_INTERVAL_MS}ms, batch ${BATCH}, target ${target}`);

  if (ONCE) {
    const n = await tick();
    console.log(`[dial-worker] drained ${n} job(s) and exiting (--once)`);
    return;
  }

  let running = true;
  const stop = () => {
    running = false;
    console.log("[dial-worker] draining — finishing in-flight work");
  };
  // Bun's typed `process.on` overload only enumerates a narrow event union;
  // SIGTERM/SIGINT are valid at runtime and are exactly what compose sends.
  process.on("SIGTERM" as never, stop as never);
  process.on("SIGINT" as never, stop as never);

  while (running) {
    let processed = 0;
    try {
      processed = await tick();
    } catch (err) {
      console.error("[dial-worker] tick failed:", err instanceof Error ? err.message : err);
    }
    // Only idle when there was nothing to do; a backlog is drained flat out.
    if (processed === 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log("[dial-worker] stopped cleanly");
}

// Guard the import so this file can be imported by a test without starting a loop.
if (import.meta.main) {
  main().catch((err) => {
    console.error("[dial-worker] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { runJob, tick };
export { caseByConversation };