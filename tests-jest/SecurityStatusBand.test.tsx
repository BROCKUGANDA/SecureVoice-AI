/**
 * The live status band on the public Security page.
 *
 * This exists because of a bug that shipped: the band fetched `/api/status`,
 * which is operator-only **by design**, and stored the response WITHOUT checking
 * `r.ok`. An anonymous visitor therefore rendered the 401 body `{error}` as a
 * status object — `ok` undefined printed **"Degraded"**, `version` undefined
 * printed **"vundefined"**, and every other cell was a dash. The page looked
 * broken while reporting a status it had never received.
 *
 * The regression guard is therefore not "it renders" but "an error response can
 * never become a reading". Three cases, because either half alone is a failure:
 *
 *   1. a healthy payload renders its values (the band is real, not decoration)
 *   2. a 401 renders NO reading — not "Degraded", not "vundefined"
 *   3. a 200 carrying a malformed body is treated as a failure, not a status
 */
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { useApp } from "@/lib/store";
import { Security } from "@/views/Security";

function mount() {
  useApp.setState({ view: "security", lang: "en", highContrast: false });
  return render(<Security />);
}

/** A response object shaped like the public /api/health payload. */
function health(payload: Record<string, unknown>, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  } as unknown as Response;
}

const LIVE = { ok: true, uptimeSec: 3661, version: "0.2.1", region: "UAE", release: null };

/**
 * Installs a fetch that serves the given responses in order and records every
 * call, so a spec can assert WHAT was asked and HOW OFTEN. The env's jest
 * build has no `fetch` on `global` to spy on, so direct assignment is the
 * idiom the sibling view specs already use.
 */
function recorder(...responses: Array<Response>) {
  const calls: unknown[][] = [];
  let i = 0;
  global.fetch = (async (input: unknown, init?: unknown) => {
    calls.push([input, init]);
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return next;
  }) as unknown as typeof fetch;
  return calls;
}

/** The same, but every call from `indexToThrow` onward throws. */
function recorderThrowing(good: Response, indexToThrow: number) {
  const calls: unknown[][] = [];
  let i = 0;
  global.fetch = (async (input: unknown, init?: unknown) => {
    calls.push([input, init]);
    const n = i;
    i += 1;
    // Every probe from the failure onward keeps failing. A recorder that
    // recovered on the next call would let the old reading reappear and the
    // assertion would pass for the wrong reason.
    if (n >= indexToThrow) throw new Error("network down");
    return good;
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  cleanup();
});

describe("Security live status band", () => {
  it("renders the version and uptime from a healthy probe", async () => {
    const calls = recorder(health(LIVE));
    mount();

    await waitFor(() => expect(screen.getByText("v0.2.1")).toBeTruthy());
    // 3661s is 1h 1m — the band formats it, it does not print raw seconds.
    expect(screen.getByText("1h 1m")).toBeTruthy();
    expect(screen.getByText("Operational")).toBeTruthy();
    // The PUBLIC probe, uncached. The operator endpoint must never be asked.
    expect(calls[0]).toEqual(["/api/health", { cache: "no-store" }]);
  });

  it("shows NO reading when the probe is a 401 — the bug this guards", async () => {
    // Exactly what the public page used to receive from the operator endpoint.
    recorder(health({ error: "Sign in required" }, false, 401));
    mount();

    // The band starts at "Probing…"; once the failed probe lands it must still
    // hold no reading at all, rather than having invented one.
    await waitFor(() => expect(screen.getByText("Probing…")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Degraded")).toBeNull();
    expect(screen.queryByText("vundefined")).toBeNull();
    expect(screen.queryByText(/^v/)).toBeNull();
  });

  it("treats a 200 with a malformed body as a failure, not a status", async () => {
    recorder(health({ something: "else" }));
    mount();

    await waitFor(() => expect(screen.getByText("Probing…")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("vundefined")).toBeNull();
    expect(screen.queryByText(/^v/)).toBeNull();
  });

  it("clears a good reading when the next probe fails", async () => {
    // A status panel showing an old number as if it were live is worse than one
    // admitting it has none, so a failed probe must clear the previous reading.
    // The band re-probes on an interval, so this drives the timer rather than
    // waiting out the real 20s the component schedules.
    jest.useFakeTimers();
    try {
      const calls = recorderThrowing(health(LIVE), 1);
      mount();

      await waitFor(() => expect(screen.getByText("v0.2.1")).toBeTruthy());
      // One healthy reading is on screen; now advance past the poll interval so
      // the second (failing) probe runs and must clear it.
      jest.advanceTimersByTime(21_000);
      await waitFor(() => expect(screen.queryByText("v0.2.1")).toBeNull());
      expect(calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
