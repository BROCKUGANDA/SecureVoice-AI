/**
 * The shutdown drain, proven to actually wait.
 *
 * A graceful shutdown is one of the easiest things in the codebase to fake: install
 * a signal handler, call `process.exit`, and it looks correct on a screen where
 * nothing was in flight. This suite drives the one case that distinguishes the two
 * — a unit of work that is still open when the signal arrives — with `exit`
 * injected, so the runner is never the thing that gets terminated.
 *
 *   bun test tests/unit/graceful-shutdown-drain.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetShutdownForTests,
  beginCall,
  endCall,
  getActiveCallCount,
  setupGracefulShutdown,
  waitForActiveCalls,
} from "@/lib/graceful-shutdown";

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => _resetShutdownForTests());

describe("the active-call counter", () => {
  test("counts units of work and never goes below zero", () => {
    const before = getActiveCallCount();
    beginCall();
    expect(getActiveCallCount()).toBe(before + 1);
    endCall();
    endCall();
    endCall();
    // A bug that releases twice must not make a later drain look satisfied while
    // real work is still running.
    expect(getActiveCallCount()).toBe(before);
  });

  test("a release is idempotent", () => {
    const before = getActiveCallCount();
    const release = beginCall();
    release();
    release();
    release();
    expect(getActiveCallCount()).toBe(before);
  });
});

describe("waitForActiveCalls", () => {
  test("resolves true the moment the last unit finishes", async () => {
    const release = beginCall();
    let settled: boolean | null = null;
    const waiting = waitForActiveCalls(5_000).then((v) => {
      settled = v;
      return v;
    });
    await tick();
    expect(settled).toBe(null);
    release();
    // The post-release assertion reads the resolved value: TS does not track the
    // closure assignment to `settled`, even though the callback sets it to `v`.
    expect(await waiting).toBe(true);
  });

  test("gives up with false when the window elapses", async () => {
    beginCall();
    expect(await waitForActiveCalls(30)).toBe(false);
  });

  test("an idle process is already drained", async () => {
    while (getActiveCallCount() > 0) endCall();
    expect(await waitForActiveCalls(1_000)).toBe(true);
  });
});

describe("the shutdown sequence", () => {
  test("waits for in-flight work before closing anything or exiting", async () => {
    const order: string[] = [];
    const handle = setupGracefulShutdown({
      drainMs: 5_000,
      exit: () => order.push("exit"),
      onShutdown: () => {
        order.push("cleanup");
      },
    });

    const release = beginCall();
    const done = handle.shutdown("SIGTERM");
    await tick(20);
    // Nothing has happened yet: the call is still open.
    expect(order).toEqual([]);
    expect(handle.isShuttingDown()).toBe(true);

    release();
    await done;
    // Order is the whole point: stop taking work, wait for accepted work, then
    // close connections, then exit. Closing before the wait would sever exactly
    // the call this exists to protect.
    expect(order).toEqual(["cleanup", "exit"]);
  });

  test("abandons a hung call at the window edge rather than lingering forever", async () => {
    beginCall(); // deliberately never released
    const exitCodes: number[] = [];
    const handle = setupGracefulShutdown({
      drainMs: 40,
      exit: (c) => {
        exitCodes.push(c);
      },
    });
    await handle.shutdown("SIGTERM");
    expect(exitCodes).toEqual([0]);
  });

  test("a second signal is a no-op, not a second exit", async () => {
    let exits = 0;
    const handle = setupGracefulShutdown({
      drainMs: 10,
      exit: () => {
        exits += 1;
      },
    });
    await handle.shutdown("SIGTERM");
    await handle.shutdown("SIGINT");
    await handle.shutdown("anything-else");
    expect(exits).toBe(1);
  });

  test("reports the window it resolved, so the orchestrator can be checked against it", () => {
    const handle = setupGracefulShutdown({ drainMs: 12_345, exit: () => {} });
    expect(handle.drainMs()).toBe(12_345);
  });

  test("a failing cleanup hook cannot block the exit", async () => {
    let exits = 0;
    const handle = setupGracefulShutdown({
      drainMs: 10,
      exit: () => {
        exits += 1;
      },
      onShutdown: () => {
        throw new Error("connection would not close");
      },
    });
    await handle.shutdown("SIGTERM");
    expect(exits).toBe(1);
  });
});
