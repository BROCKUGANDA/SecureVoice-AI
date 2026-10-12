/**
 * Server preload: graceful shutdown for the standalone Next server.
 *
 *   bun --preload ./server-preload.ts server.js
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 * Next's generated `server.js` registers NO SIGTERM/SIGINT handler (verified:
 * `grep -n 'SIGTERM|SIGINT' .next/standalone/server.js` finds nothing). Docker's
 * `stop` sends SIGTERM, the default action terminates the process immediately,
 * and every in-flight request — including a fraud-intervention webhook mid-write
 * — is cut off. A deploy then drops live traffic, which for this product means a
 * dropped customer call.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 * A `--preload` module runs in the SAME process as the server, before it starts.
 * So:
 *
 *   1. On SIGTERM, set the drain flag. It is published as an ENV var because the
 *      route handlers run in this same process, so `process.env` is shared with
 *      them — that is the whole reason this is a preload and not a wrapper
 *      process. `/api/readyz` reads it and starts answering 503.
 *   2. Caddy's active health check (`health_uri /api/readyz` on the upstream)
 *      sees the 503 and takes this instance OUT of rotation, so no NEW request
 *      arrives here. That is what actually prevents dropped requests; the timer
 *      below only bounds how long the process lingers.
 *   3. After the drain window, exit.
 *
 * ── The limitation, stated plainly ──────────────────────────────────────────
 * This waits a BOUNDED WINDOW, not for connection completion. The standalone
 * server does not expose its `http.Server`, so there is no `server.close()`
 * callback to await; monkey-patching `http.createServer` to capture it is not
 * reliable against a bundled server. The window must therefore be longer than
 * the slowest expected request. 65s is chosen to exceed a Twilio call leg, which
 * is the longest single interaction this deployment serves.
 *
 * Ordering matters and is the point: traffic stops arriving FIRST (step 2), the
 * process exits SECOND. Waiting without first draining is just a slow kill.
 */

const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 65_000);

let draining = false;

function beginDrain(signal: string): void {
  if (draining) return;
  draining = true;

  // Shared with the route handlers (same process) — see the header.
  process.env.SV_DRAINING = "1";

  console.log(
    `[shutdown] ${signal} received — /api/readyz now reports draining so the proxy takes this instance out of rotation; exiting in at most ${DRAIN_MS}ms`,
  );

  // unref'd so it never becomes the reason the process stays alive, but the
  // running HTTP server keeps the loop busy so this does fire in practice.
  const timer = setTimeout(() => {
    console.log("[shutdown] drain window elapsed — exiting");
    process.exit(0);
  }, DRAIN_MS);
  timer.unref?.();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  // Bun's typed process.on overload enumerates a narrow event union; the same
  // cast is used by src/worker/dial.ts and src/worker/retention.ts.
  process.on(signal as never, () => beginDrain(signal));
}
