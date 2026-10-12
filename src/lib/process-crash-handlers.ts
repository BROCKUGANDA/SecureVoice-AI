import "server-only";
/**
 * Process-level crash handlers for the long-lived Node/Bun processes.
 *
 * ── What happens without them ────────────────────────────────────────────────
 * An `uncaughtException` kills the process with its default action, and an
 * `unhandledRejection` either kills it (Node) or is printed and swallowed (Bun).
 * Neither outcome is recorded by this project's log pipeline, so a container
 * that restarts leaves no trace of why in the log stream an operator is reading —
 * and for a service whose job is to place a fraud-verification call and write the
 * audit row that backs it, "the pod restarted" is not an incident record.
 *
 * ── The two decisions, and why they differ ───────────────────────────────────
 * `uncaughtException` → log, then exit non-zero. The process state is unknown at
 * that point; a handler that keeps the process running turns one bad request
 * into a server that answers traffic from a half-mutated state. Exiting is the
 * safe action, and the orchestrator's restart policy is the recovery. The
 * shutdown path is reused so connections still close.
 *
 * `unhandledRejection` → log LOUDLY, keep running. A rejected promise belongs to
 * one request, not to the process: killing a server that is otherwise healthy
 * because one code path forgot a `catch` trades a bug for an outage. The
 * rejection is still surfaced as an ERROR-level record with the reason and the
 * stack, because the alternative — silence — is how a broken money path hides.
 *
 * Both are re-entrancy guarded: a second exception raised while the first is
 * being logged must not loop the logger forever.
 */
import { logError, logInfo } from "@/lib/validation/safe-log";

export type CrashHandlerHandle = {
  /** Number of exceptions handled. Monotonic; lets a gate prove a handler fired. */
  uncaughtExceptions: () => number;
  /** Number of rejections handled. Monotonic for the same reason. */
  unhandledRejections: () => number;
  /** Remove the listeners this call installed. Idempotent. */
  dispose: () => void;
};

let installed = false;
let uncaughtCount = 0;
let rejectionCount = 0;
/** True while the fatal path is running, so a throw inside it cannot recurse. */
let dying = false;

/** How long the fatal path waits for buffered log writes before exiting. */
const EXIT_DEFER_MS = 50;

/** Best-effort single-line stack, bounded so a crash log cannot exhaust memory. */
function stackOf(err: unknown): string {
  const stack = err instanceof Error ? err.stack : undefined;
  if (!stack) return "";
  return stack.split("\n").slice(0, 8).join("\n").slice(0, 2_000);
}

/**
 * Install one pair of process-wide handlers.
 *
 * Idempotent: a second call returns a handle bound to the same state without
 * registering listeners again, so an app that boots twice (Next dev's hot
 * reload, a test harness, a worker and its preload) cannot stack handlers and
 * multiply the log lines.
 *
 * @param onFatalExit how the process terminates after an uncaught exception.
 * Injectable so a test can drive the fatal path without killing the runner.
 */
export function installProcessCrashHandlers(
  onFatalExit: (code: number) => void = (code) => process.exit(code),
): CrashHandlerHandle {
  const onUncaught = (err: Error): void => {
    uncaughtCount += 1;
    if (dying) return;
    dying = true;
    logError("[process] uncaught exception — exiting", {
      error: err instanceof Error ? err.message : String(err),
      stack: stackOf(err),
      count: uncaughtCount,
    });
    // One tick before the kill: `process.exit` discards buffered writes, and a
    // crash record that never reaches the log stream is the same as no crash
    // record. Bounded and unconditional — a process that will not exit on its
    // own still exits here.
    setTimeout(() => onFatalExit(1), EXIT_DEFER_MS);
  };

  const onRejection = (reason: unknown): void => {
    rejectionCount += 1;
    logError("[process] unhandled rejection — continuing", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: stackOf(reason),
      count: rejectionCount,
    });
  };

  if (!installed) {
    installed = true;
    // `as never` for the same reason as the shutdown module: Bun's typed
    // `process.on` overload enumerates a narrow event union that omits these.
    process.on("uncaughtException" as never, onUncaught as never);
    process.on("unhandledRejection" as never, onRejection as never);
    logInfo("[process] crash handlers installed", {});
  }

  return {
    uncaughtExceptions: () => uncaughtCount,
    unhandledRejections: () => rejectionCount,
    dispose: () => {
      process.off("uncaughtException" as never, onUncaught as never);
      process.off("unhandledRejection" as never, onRejection as never);
    },
  };
}

/** Counters without installing anything — for `/api/health`-style surfaces. */
export function crashHandlerCounts(): { uncaughtExceptions: number; unhandledRejections: number } {
  return { uncaughtExceptions: uncaughtCount, unhandledRejections: rejectionCount };
}

/**
 * Test helper: restore module state so suites that drive a crash do not leak
 * counts, and re-allow installation after a suite disposed its listeners.
 */
export function _resetCrashHandlersForTest(): void {
  installed = false;
  dying = false;
  uncaughtCount = 0;
  rejectionCount = 0;
}
