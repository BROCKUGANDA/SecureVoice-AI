import { describe, expect, test } from "bun:test";
/**
 * Gates the process crash handlers.
 *
 * The handlers are invoked by calling the exact function objects registered on
 * `process`, rather than by emitting `uncaughtException` on the real process.
 * Emitting would route through the test runner's own listener too, and a runner
 * that sees a synthetic fatal exception tears down the suite — which would make
 * the gate unable to report anything. The registered function IS the contract:
 * the runtime calls it with the same arguments, in the same event.
 */
import {
  _resetCrashHandlersForTest,
  crashHandlerCounts,
  installProcessCrashHandlers,
} from "@/lib/process-crash-handlers";

type Handler = (...args: unknown[]) => void;

const listenersFor = (event: string): Handler[] =>
  process.listeners(event as never) as unknown as Handler[];

/** Install fresh, returning the handler this module registered plus an exit spy. */
function withHandlers() {
  _resetCrashHandlersForTest();
  const before = {
    uncaught: listenersFor("uncaughtException").length,
    rejected: listenersFor("unhandledRejection").length,
  };
  const exits: number[] = [];
  const handle = installProcessCrashHandlers((code) => {
    exits.push(code);
  });
  const added = {
    uncaught: listenersFor("uncaughtException").slice(before.uncaught),
    rejected: listenersFor("unhandledRejection").slice(before.rejected),
  };
  return { handle, exits, added, before };
}

/** Longer than `EXIT_DEFER_MS`, the window the handler gives buffered log writes. */
const settle = () => new Promise<void>((r) => setTimeout(r, 250));

describe("process crash handlers", () => {
  test("install registers exactly one listener on each event", () => {
    const { added } = withHandlers();
    expect(added.uncaught).toHaveLength(1);
    expect(added.rejected).toHaveLength(1);
  });

  // A second boot path (Next dev's reload, a worker and its preload, a suite)
  // must not stack handlers: two listeners means two exit attempts and doubled
  // crash records in the log an operator reads.
  test("installing twice does not duplicate the listeners", () => {
    const { added, before } = withHandlers();
    expect(added.uncaught).toHaveLength(1);
    installProcessCrashHandlers();
    installProcessCrashHandlers();
    expect(listenersFor("uncaughtException").length).toBe(before.uncaught + 1);
    expect(listenersFor("unhandledRejection").length).toBe(before.rejected + 1);
  });

  test("an unhandled exception is counted, logged and exits non-zero", async () => {
    const { exits, added, handle } = withHandlers();
    added.uncaught[0](new Error("boom in the money path"));
    await settle();
    expect(exits).toEqual([1]);
    expect(handle.uncaughtExceptions()).toBe(1);
    expect(crashHandlerCounts().uncaughtExceptions).toBe(1);
  });

  test("a second exception during the fatal path does not exit twice", async () => {
    const { exits, added } = withHandlers();
    added.uncaught[0](new Error("first"));
    added.uncaught[0](new Error("raised while dying"));
    await settle();
    expect(exits).toEqual([1]);
  });

  test("an unhandled rejection is recorded and the process keeps running", async () => {
    const { exits, added, handle } = withHandlers();
    added.rejected[0](new Error("forgot a catch"), undefined);
    await settle();
    expect(handle.unhandledRejections()).toBe(1);
    // No exit: one rejected request must not kill a healthy server.
    expect(exits).toEqual([]);
  });

  test("a non-Error rejection still produces a record", async () => {
    const { added, handle } = withHandlers();
    added.rejected[0]("a bare string", undefined);
    await settle();
    expect(handle.unhandledRejections()).toBe(1);
  });

  test("dispose removes the listeners this call installed", () => {
    const { added, before, handle } = withHandlers();
    handle.dispose();
    expect(listenersFor("uncaughtException").length).toBe(before.uncaught);
    expect(listenersFor("unhandledRejection").length).toBe(before.rejected);
    expect(added.uncaught).toHaveLength(1);
  });

  test("a stack is captured but bounded", async () => {
    const { added, handle } = withHandlers();
    const err = new Error("deep");
    err.stack = Array.from({ length: 400 }, (_, i) => `    at frame${i}`).join("\n");
    added.rejected[0](err, undefined);
    await settle();
    expect(handle.unhandledRejections()).toBe(1);
  });
});
