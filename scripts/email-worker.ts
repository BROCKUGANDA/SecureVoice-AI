#!/usr/bin/env bun
/**
 * Email outbox worker — retries transactional mail that a synchronous send
 * could not deliver.
 *
 * The request path already attempts one immediate send (see enqueueAndSend in
 * src/lib/email/resend.ts) so the happy path needs no worker at all. This
 * process exists for the other path: a transient Resend failure must not lose a
 * magic link, because the operator holding that link is trying to reach a fraud
 * console.
 *
 * Same claim discipline as scripts/outbox-worker.ts (FOR UPDATE SKIP LOCKED plus
 * a compare-and-set re-assert), so you can run N of these safely and a killed
 * worker's lease is reclaimed rather than stranding the row.
 *
 *   bun scripts/email-worker.ts              # run once and exit (cron)
 *   bun scripts/email-worker.ts --loop 10    # run every 10s (dev)
 *   bun scripts/email-worker.ts --once       # drain everything due now
 */
import { drainEmailOutbox } from "../src/lib/email/outbox";
import { sendQueuedEmail } from "../src/lib/email/resend";

const args = new Set(process.argv.slice(2));
const loopArg = process.argv.find((a) => a.startsWith("--loop"));
// Env wins over the flag so a compose deployment can tune poll rate and batch
// without rewriting the command line (docker-compose.yml email-worker).
const intervalSec = loopArg
  ? Number(loopArg.split("=")[1] ?? loopArg.replace("--loop", "")) || 10
  : Number(process.env.EMAIL_WORKER_POLL_MS ?? 10_000) / 1000 || 10;
const batch = Number(process.env.EMAIL_WORKER_BATCH ?? 25) || 25;
// A bare `--loop` with no number means "run the loop", not "run once".
const once = args.has("--once") || !args.has("--loop");

async function tick(): Promise<number> {
  const results = await drainEmailOutbox(batch, sendQueuedEmail);
  if (results.length > 0) {
    for (const r of results) {
      const extra = r.status === "RETRY" ? ` next=${r.nextAttemptAt.toISOString()}` : "";
      console.log(`[email-worker] ${r.id} ${r.status} (attempts=${r.attempts})${extra}`);
    }
  }
  return results.length;
}

if (once) {
  const n = await tick();
  console.log(`[email-worker] drained ${n} message(s)`);
  process.exit(0);
} else {
  console.log(`[email-worker] loop every ${intervalSec}s`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("[email-worker] drain failed:", err);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}
