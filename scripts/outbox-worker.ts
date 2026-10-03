#!/usr/bin/env bun
/**
 * Outbox worker (WP-5) — the ONLY thing that performs network I/O for bank
 * notifications. No request handler ever awaits a fetch.
 *
 * Claims with FOR UPDATE SKIP LOCKED, so you can run N of these safely.
 * Delivery retries follow the declared ladder (~1m, 5m, 30m, 2h, 3h, 12h)
 * and a sixth failure dead-letters the event for admin replay.
 *
 *   bun scripts/outbox-worker.ts              # run once and exit (cron)
 *   bun scripts/outbox-worker.ts --loop 10    # run every 10s (dev)
 *   bun scripts/outbox-worker.ts --once       # drain everything due now
 */
import { drainOutbox } from "../src/lib/outbox";

const args = new Set(process.argv.slice(2));
const loopArg = process.argv.find((a) => a.startsWith("--loop"));
const intervalSec = loopArg
  ? Number(loopArg.split("=")[1] ?? loopArg.replace("--loop", "")) || 10
  : 10;
const once = args.has("--once") || !args.has("--loop");

async function tick(): Promise<number> {
  const results = await drainOutbox(25);
  if (results.length > 0) {
    for (const r of results) {
      const extra = r.status === "RETRY" ? ` next=${r.nextAttemptAt.toISOString()}` : "";
      console.log(`[outbox] ${r.id} ${r.status} (attempts=${r.attempts})${extra}`);
    }
  }
  return results.length;
}

if (once) {
  const n = await tick();
  console.log(`[outbox] drained ${n} event(s)`);
  process.exit(0);
} else {
  console.log(`[outbox] worker loop every ${intervalSec}s`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("[outbox] drain failed:", err);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}
