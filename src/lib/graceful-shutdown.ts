import "server-only";
/**
 * Graceful shutdown for the app process.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 * When Docker (or a rolling deploy, or `docker compose down`) stops this
 * container it sends SIGTERM and, after a grace period, SIGKILL. Next's
 * generated server registers no handler of its own, so the default action for
 * SIGTERM terminates the process immediately and every in-flight request is cut
 * off mid-write. For this product that means a fraud-intervention webhook
 * severed between the carrier call and the audit row, or a customer call dropped
 * while a human is mid-sentence.
 *
 * ── What "graceful" means here, stated plainly ───────────────────────────────
 * There is no `http.Server` to await: Next's standalone bundle does not expose
 * one, and monkey-patching `http.createServer` to capture it is not reliable
 * against the bundle. So this module does the two things that are actually in
 * reach, in the order that matters:
 *
 *   1. STOP TAKING NEW WORK, THEN WAIT FOR THE WORK IN FLIGHT. `beginCall()` /
 *      `endCall()` are a plain in-process counter. On a signal the handler waits
 *      — bounded by `SHUTDOWN_DRAIN_MS` — until that counter reaches zero, so a
 *      call that is already running finishes. The sibling process-level drain
 *      (scripts/server-preload.ts) flips `/api/readyz` to 503 so the proxy stops
 *      routing NEW requests here; this module is what makes the process WAIT for
 *      the ones already accepted instead of exiting on top of them.
 *
 *   2. CLOSE SHARED CONNECTIONS. Redis pub/sub is the connection this process
 *      owns that a peer would notice going away, so it is closed explicitly
 *      (`closePubSub()`), along with any hook the caller registers. Closing after
 *      the drain, not before, so an in-flight call can still publish.
 *
 * The wait is a BOUNDED window, not a promise of completion — a call that hangs
 * past the window is abandoned so the process still exits and the orchestrator
 * does not have to SIGKILL it. The window defaults to 65s, which is longer than
 * the longest single interaction this deployment serves (a Twilio call leg).
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   // once, at process start-up
 *   setupGracefulShutdown({ onShutdown: async () => { await closeSomething(); } });
 *
 *   // around each unit of work that must not be cut off
 *   const release = beginCall();
 *   try { await handleIntervention(); } finally { release(); }
 */

import { closePubSub } from "@/lib/redis-pubsub";
import { logError, logInfo, logWarn } from "@/lib/validation/safe-log";

/** The signals a container/orchestrator sends to ask a process to stop. */
export type ShutdownSignal = "SIGTERM" | "SIGINT";

export type ShutdownOptions = {
  /**
   * How long to wait for active calls to finish before exiting anyway.
   * Defaults to `SHUTDOWN_DRAIN_MS` (env) or 65_000ms.
   */
  drainMs?: number;
  /** Extra cleanup run after the drain, before exit. A throw here is logged, not fatal. */
  onShutdown?: () => Promise<void> | void;
  /**
   * How the process terminates. Defaults to `process.exit`. Injectable so a test
   * can drive a full shutdown without killing the test runner — the one reason
   * this is a parameter and not a bare `process.exit` call.
   */
  exit?: (code: number) => void;
};

/** The handle returned by `setupGracefulShutdown`, for tests and health checks. */
export type ShutdownHandle = {
  /** Run the shutdown sequence now. Idempotent — the second call is a no-op. */
  shutdown: (signal?: ShutdownSignal | string) => Promise<void>;
  /** True once a shutdown has begun (any signal, or a direct `shutdown()` call). */
  isShuttingDown: () => boolean;
  /**
   * The resolved drain window in ms.
   *
   * Exposed because the window is only real if the orchestrator waits at least
   * as long: Docker's default is 10s, so `stop_grace_period` in
   * docker-compose.yml has to exceed this. `tests/unit/shutdown-window.test.ts`
   * reads it from here rather than restating a number that could drift from the
   * code it is supposed to describe.
   */
  drainMs: () => number;
};

/* ── Active-call counter ───────────────────────────────────────────────────── */

/**
 * The number of units of work that must be allowed to finish. Deliberately a
 * single integer, not a registry of promises: the call sites already know when
 * their work starts and ends, and a counter cannot leak a reference to a call
 * that has completed.
 */
let activeCalls = 0;

/** Callbacks resolved when the counter reaches zero. */
const drainWaiters = new Set<() => void>();

/** Hooks registered through `setupGracefulShutdown({ onShutdown })`. */
const cleanupHooks: Array<() => Promise<void> | void> = [];

/** True once a shutdown has started; guards re-entry and signal storms. */
let shuttingDown = false;

/** True once signal handlers have been installed; makes setup idempotent. */
let installed = false;

/**
 * Mark a unit of work as started.
 *
 * @returns A release function. It is idempotent — calling it twice decrements
 *          once — so a `finally` block and an error path can both call it safely.
 */
export function beginCall(): () => void {
  activeCalls += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    endCall();
  };
}

/**
 * Mark a unit of work as finished. Never drives the counter below zero: an
 * unbalanced `endCall()` (a bug) must not make the drain wait look satisfied
 * when real work is still running.
 */
export function endCall(): void {
  if (activeCalls > 0) activeCalls -= 1;
  if (activeCalls === 0) {
    for (const waiter of [...drainWaiters]) waiter();
    drainWaiters.clear();
  }
}

/** How many units of work are in flight right now. */
export function getActiveCallCount(): number {
  return activeCalls;
}

/** True once a shutdown has begun. A route can use this to start refusing work. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/* ── Drain ─────────────────────────────────────────────────────────────────── */

/**
 * Resolve when the counter reaches zero, or when `timeoutMs` elapses.
 *
 * @returns `true` if the calls drained in time, `false` if the window expired
 *          with work still running.
 */
export function waitForActiveCalls(timeoutMs: number): Promise<boolean> {
  if (activeCalls === 0) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const waiter = (): void => finish(true);
    const finish = (drained: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      drainWaiters.delete(waiter);
      resolve(drained);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    // Never the reason the process stays alive: the running server already keeps
    // the event loop busy, so this fires in practice without holding the process
    // open on its own.
    timer.unref?.();

    drainWaiters.add(waiter);
    // The counter may have hit zero between the check above and the add here.
    if (activeCalls === 0) finish(true);
  });
}

/** Resolve the drain window: explicit option, then env, then a safe default. */
function resolveDrainMs(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const raw = Number(process.env.SHUTDOWN_DRAIN_MS ?? 65_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 65_000;
}

/** Close everything this process owns, after the drain. A failure is logged, never fatal. */
async function runCleanup(): Promise<void> {
  try {
    await closePubSub();
  } catch (err) {
    logError("[shutdown] closing the pub/sub connection failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  for (const hook of cleanupHooks) {
    try {
      await hook();
    } catch (err) {
      logError("[shutdown] a shutdown hook failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/* ── Public API ────────────────────────────────────────────────────────────── */

/**
 * Install SIGTERM/SIGINT handlers and return a handle that can also drive the
 * shutdown directly (tests, an explicit `process.on("beforeExit")`, a health
 * endpoint that wants to trigger a drain).
 *
 * Idempotent: calling it twice installs one set of handlers and returns a handle
 * bound to the same state. Safe to call at module scope in the server preload.
 */
export function setupGracefulShutdown(options: ShutdownOptions = {}): ShutdownHandle {
  const drainMs = resolveDrainMs(options.drainMs);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  if (options.onShutdown) cleanupHooks.push(options.onShutdown);

  /**
   * The whole sequence, in order: stop accepting (the flag + the readyz drain in
   * server-preload.ts), wait for in-flight work, close connections, exit.
   */
  const shutdown = async (signal: ShutdownSignal | string = "SIGTERM"): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    const active = getActiveCallCount();
    logInfo("[shutdown] signal received — draining", {
      signal,
      activeCalls: active,
      drainMs,
    });

    // 1. Wait for work in flight, bounded by the drain window.
    const drained = await waitForActiveCalls(drainMs);
    if (!drained) {
      logWarn("[shutdown] drain window elapsed with calls still active", {
        signal,
        activeCalls: getActiveCallCount(),
        drainMs,
      });
    }

    // 2. Close shared connections and run caller-registered hooks.
    await runCleanup();

    logInfo("[shutdown] clean exit", {
      signal,
      drained,
      remainingCalls: getActiveCallCount(),
    });
    exit(0);
  };

  if (!installed) {
    installed = true;
    // Bun's typed process.on overload enumerates a narrow event union; the same
    // `as never` cast is used by src/worker/dial.ts, src/worker/retention.ts and
    // scripts/server-preload.ts. The handler stays registered and re-entry is
    // guarded by the `shuttingDown` flag rather than by `once`, so a second
    // signal while draining is a clean no-op instead of a crash.
    process.on("SIGTERM" as never, (() => void shutdown("SIGTERM")) as never);
    process.on("SIGINT" as never, (() => void shutdown("SIGINT")) as never);
    logInfo("[shutdown] graceful shutdown handlers installed", {
      drainMs,
      signals: ["SIGTERM", "SIGINT"],
    });
  }

  return { shutdown, isShuttingDown, drainMs: () => drainMs };
}

/**
 * Test helper: restore the module to its initial state — counter, waiters, hooks
 * and flags. Does not unregister signal handlers (the installed flag is left
 * alone so a later `setupGracefulShutdown` does not double-register).
 */
export function _resetShutdownForTests(): void {
  activeCalls = 0;
  shuttingDown = false;
  drainWaiters.clear();
  cleanupHooks.length = 0;
}
