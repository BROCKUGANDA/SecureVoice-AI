/**
 * UNIT — reconnect behaviour of the browser realtime client
 * (src/lib/realtime-client.ts).
 *
 * The failure this suite exists for is not an exception, it is SILENCE. When the
 * socket dropped — a sleeping laptop, a VPN that reconnected, a deploy that
 * rolled the realtime service — the console used to stay on whatever it had
 * already rendered. The board still looked live. On a fraud desk a stale board
 * that looks live is worse than a visible outage, because the analyst is making
 * calls on it.
 *
 * So the properties asserted here are the ones that distinguish a client that
 * RECOVERS from a client that merely stays quiet:
 *
 *   · An unexpected drop arms a backoff. It is not a terminal state, and it is
 *     not "unavailable" either — the console renders that as a silent fallback
 *     to SSE, which is the opposite of what the client is doing.
 *   · The backoff is FULL jitter — `random(0, ceiling)`, not `ceiling ± jitter`.
 *     The suite proves the random source is consulted AND that a draw of 0
 *     schedules immediately, which no `± jitter` implementation can produce.
 *   · Reconnecting RESUBSCRIBES. socket.io replays its own reserved events and
 *     nothing else, so a reconnect that forgot `join` would come back connected,
 *     quiet, and subscribed to nothing — indistinguishable from working.
 *   · The ladder TERMINATES. An infinite reconnect loop in a browser tab is a
 *     battery bug and a log-spam bug, and after the cap the operator is told
 *     "realtime is down" instead of being retried at forever.
 *   · Nothing is left behind. `close()` is idempotent, cancels a pending backoff,
 *     removes the visibility listener, and a handshake that resolves after it
 *     opens no socket at all — the last one being the classic unmount leak, where
 *     the connection completes into a component that has already gone.
 *
 * Every external edge is injected (`fetch`, the socket factory, the timers, the
 * random source, the visibility API), so the suite runs in microseconds and no
 * assertion depends on a wall clock or on a real websocket.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fullJitterDelay,
  openRealtime,
  type RealtimeDeps,
  type RealtimeHealth,
  type RealtimeHandle,
  type RealtimeStatus,
} from "@/lib/realtime-client";
import type { Socket } from "socket.io-client";

// ── Fakes ─────────────────────────────────────────────────────────────────────

type Listener = (...args: unknown[]) => void;

/**
 * A socket.io stand-in with just the surface this client touches.
 *
 * `emit` and `fire` are deliberately different methods. The client EMITS `join`
 * at the socket; the test FIRES `connect` / `disconnect` / `connect_error` at
 * it. Conflating them would let a test "assert a resubscribe" by echoing the
 * client's own emit back into its own handler.
 */
class FakeSocket {
  readonly opts: Record<string, unknown>;
  readonly listeners = new Map<string, Set<Listener>>();
  readonly emitted: Array<{ event: string; args: unknown[] }> = [];
  auth: Record<string, unknown> = {};
  closeCalls = 0;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
  }

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  /** Client → server. */
  emit(event: string, ...args: unknown[]): this {
    this.emitted.push({ event, args });
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  close(): this {
    this.closeCalls += 1;
    return this;
  }

  disconnect(): this {
    return this;
  }

  /** Server → client. */
  fire(event: string, ...args: unknown[]): this {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    return this;
  }

  /** Every channel this socket was asked to join, in order. */
  joins(): string[] {
    return this.emitted.filter((e) => e.event === "join").map((e) => e.args[0] as string);
  }
}

/**
 * Deterministic timers.
 *
 * Records what was scheduled and with what delay, and hands back an id the
 * client can cancel — so "did close() actually cancel the pending backoff" is an
 * assertion about the real cancellation path, not an inference from silence.
 */
class FakeTimers {
  private seq = 0;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  readonly scheduled: number[] = [];
  readonly cancelled: number[] = [];

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { fn, ms });
    this.scheduled.push(ms);
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.cancelled.push(handle as number);
    this.pending.delete(handle as number);
  };

  /** How many timers are armed right now. */
  get armed(): number {
    return this.pending.size;
  }

  /** Fire the oldest armed timer, once. Returns its scheduled delay. */
  fireOne(): number | null {
    const entry = this.pending.entries().next();
    if (entry.done) return null;
    const [id, timer] = entry.value;
    this.pending.delete(id);
    timer.fn();
    return timer.ms;
  }
}

/** A document whose visibility the test drives by hand. */
class FakeVisibility {
  visibilityState = "visible";
  readonly listeners = new Set<() => void>();
  removed = 0;

  addEventListener(type: string, listener: () => void): void {
    if (type === "visibilitychange") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type !== "visibilitychange") return;
    this.removed += 1;
    this.listeners.delete(listener);
  }

  /** Change state and fire, exactly as a browser does on a tab switch. */
  set(state: string): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

/** Drain every pending microtask so an awaited handshake has actually landed. */
const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

// ── Harness ───────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let grantCalls = 0;
/** When set, the NEXT grant request waits on this before answering. */
let grantGate: Promise<void> | null = null;

beforeEach(() => {
  grantCalls = 0;
  grantGate = null;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/api/console/features")) return json({ consoleLiveFeed: true });
    if (url.includes("/api/console/realtime-token")) {
      if (grantGate) await grantGate;
      grantCalls += 1;
      return json({ token: `grant-${grantCalls}`, orgId: "org_1" });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

type Harness = {
  handle: RealtimeHandle;
  sockets: FakeSocket[];
  timers: FakeTimers;
  visibility: FakeVisibility;
  status: RealtimeStatus[];
  health: RealtimeHealth[];
  randCalls: number;
  /** Delays the ladder actually asked for, in order. */
  delays: number[];
  close: () => void;
};

type Options = {
  callRefs?: string[];
  /** Value the injected random source returns. Defaults to the mid-point. */
  rand?: () => number;
};

async function open(opts: Options = {}): Promise<Harness> {
  const sockets: FakeSocket[] = [];
  const timers = new FakeTimers();
  const visibility = new FakeVisibility();
  const status: RealtimeStatus[] = [];
  const health: RealtimeHealth[] = [];
  const delays: number[] = [];
  const harness = {
    sockets,
    timers,
    visibility,
    status,
    health,
    randCalls: 0,
    delays,
    close: () => {},
  } as Harness;

  const rand = opts.rand ?? (() => 0.5);
  const randSpy = (): number => {
    harness.randCalls += 1;
    return rand();
  };

  const deps: RealtimeDeps = {
    connect: (connectOpts) => {
      const socket = new FakeSocket(connectOpts as Record<string, unknown>);
      sockets.push(socket);
      return socket as unknown as Socket;
    },
    rand: randSpy,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    visibility,
  };

  const handle = await openRealtime({
    callRefs: opts.callRefs ?? ["case-a"],
    onStatus: (next) => status.push(next),
    onHealth: (next) => {
      health.push(next);
      if (next.state === "retrying") delays.push(next.delayMs);
    },
    deps,
  });

  if (!handle) throw new Error("harness: expected the push path to be enabled");
  harness.handle = handle;
  harness.close = () => handle.close();
  return harness;
}

/** Take the feed live. The harness starts with the socket OPEN but unconnected,
 * because `io()` never connects synchronously. */
function goLive(h: Harness): FakeSocket {
  const socket = h.sockets[h.sockets.length - 1]!;
  socket.fire("connect");
  return socket;
}

/** The current socket dies unexpectedly. Arms one backoff — one attempt. */
function drop(h: Harness): void {
  h.sockets[h.sockets.length - 1]!.fire("disconnect", "transport close");
}

/** Serve the armed backoff and return the replacement socket. */
async function serveBackoff(h: Harness): Promise<FakeSocket> {
  h.timers.fireOne();
  await settle();
  return h.sockets[h.sockets.length - 1]!;
}

/** The replacement socket's handshake is refused. One more attempt. */
function failHandshake(h: Harness): void {
  h.sockets[h.sockets.length - 1]!.fire("connect_error", new Error("unauthorized"));
}

/**
 * One failed reconnect: the handshake is refused.
 *
 * Deliberately NOT also a `drop()`. A round that drops AND fails its handshake
 * burns two attempts for one thing that went wrong, which makes the cap
 * assertions uncountable — so the two are driven separately where a test cares
 * about the arithmetic.
 */
async function failOnce(h: Harness): Promise<void> {
  await serveBackoff(h);
  failHandshake(h);
}

// ── The drop ──────────────────────────────────────────────────────────────────

describe("realtime reconnect — an unexpected drop", () => {
  test("arms a backoff rather than giving up", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");

    h.sockets[0]!.fire("disconnect", "transport close");

    expect(h.timers.armed).toBe(1);
    expect(h.health.at(-1)).toMatchObject({ state: "retrying", attempt: 1 });
    expect(h.health.some((x) => x.state === "exhausted")).toBe(false);
  });

  test("says `connecting`, not `unavailable` — it is actively trying", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");
    h.sockets[0]!.fire("disconnect", "transport close");

    // `unavailable` is what the console renders as "sse", i.e. a silent
    // fallback. Saying that while a retry is armed is the opposite of the truth.
    expect(h.status.at(-1)).toBe("connecting");
  });

  test("a drop and its connect_error arm ONE timer, not two", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");
    // A real drop emits both, and socket.io can emit them in either order.
    h.sockets[0]!.fire("disconnect", "transport close");
    h.sockets[0]!.fire("connect_error", new Error("transport close"));

    expect(h.timers.armed).toBe(1);
    expect(h.delays).toHaveLength(1);
  });

  test("actually opens a replacement socket", async () => {
    const h = await open();
    goLive(h);

    drop(h);
    const next = await serveBackoff(h);

    expect(h.sockets).toHaveLength(2);
    expect(next).not.toBe(h.sockets[0]);
    // Every socket is minted on its own grant — a grant lives 60s and the one the
    // first socket used is expired by the time the backoff expires.
    expect(next.opts.auth).toEqual({ token: "grant-2" });
  });
});

// ── The backoff ───────────────────────────────────────────────────────────────

describe("realtime reconnect — backoff", () => {
  test("consults the injected random source on every attempt", async () => {
    const h = await open();

    // The first socket never connects, so every round is one refused handshake
    // and one jitter draw — one for one, which is what makes this countable.
    for (let i = 0; i < 4; i += 1) await failOnce(h);

    expect(h.randCalls).toBe(4);
  });

  test("the observed delay is the one that was scheduled", async () => {
    const h = await open({ rand: () => 0.25 });

    h.sockets[0]!.fire("connect");
    h.sockets[0]!.fire("disconnect", "transport close");

    // The token timeout armed earlier is cleared, so the LAST scheduled delay is
    // the backoff. Asserting the two agree catches a ladder that computes a
    // delay and then ignores it.
    expect(h.delays).toHaveLength(1);
    expect(h.timers.scheduled.at(-1)).toBe(h.delays[0]);
  });

  test("a draw of 0 schedules immediately — full jitter, not delay ± jitter", async () => {
    const h = await open({ rand: () => 0 });

    h.sockets[0]!.fire("connect");
    h.sockets[0]!.fire("disconnect", "transport close");

    // No `ceiling ± jitter` implementation can produce a zero delay: its floor is
    // `ceiling - jitter`. This is the assertion that pins the ALGORITHM and not
    // merely "a delay was used".
    expect(h.delays[0]).toBe(0);
    expect(h.timers.scheduled.at(-1)).toBe(0);
  });

  test("every delay falls inside [0, cap] across a full ladder", async () => {
    const h = await open({ rand: () => 0.999999 });

    for (let i = 0; i < 8; i += 1) await failOnce(h);

    expect(h.delays).toHaveLength(8);
    for (const delay of h.delays) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  test("a high draw grows toward the cap and then stops at it", async () => {
    const h = await open({ rand: () => 1 });

    for (let i = 0; i < 8; i += 1) await failOnce(h);

    // 500 · 2^(n-1), saturated at the 30s ceiling. Strictly non-decreasing: a
    // ladder that shrank between attempts would be retrying faster as the outage
    // got longer.
    expect(h.delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  test("a zero draw stays at zero rather than dropping to a negative delay", async () => {
    // An injected source returning 1 or a negative number must not produce a
    // timer the runtime will fire immediately or not at all.
    expect(fullJitterDelay(3, () => 1, 500, 30_000)).toBe(2_000);
    expect(fullJitterDelay(3, () => -5, 500, 30_000)).toBe(0);
    expect(fullJitterDelay(3, () => 0.5, 500, 30_000)).toBe(1_000);
    expect(fullJitterDelay(99, () => 1, 500, 30_000)).toBe(30_000);
  });
});

// ── Resubscription ────────────────────────────────────────────────────────────

describe("realtime reconnect — resubscription", () => {
  test("a successful reconnect rejoins the original callRefs", async () => {
    const h = await open({ callRefs: ["case-a", "case-b"] });

    drop(h);
    const next = await serveBackoff(h);
    next.fire("connect");

    expect(next.joins()).toEqual(["org:org_1", "case:org_1:case-a", "case:org_1:case-b"]);
  });

  test("the first socket joins them too — the reconnect is not doing extra work", async () => {
    const h = await open({ callRefs: ["case-a"] });
    h.sockets[0]!.fire("connect");

    expect(h.sockets[0]!.joins()).toEqual(["org:org_1", "case:org_1:case-a"]);
  });

  test("a case subscribed DURING the outage is joined when the socket returns", async () => {
    const h = await open({ callRefs: ["case-a"] });
    h.sockets[0]!.fire("connect");
    h.sockets[0]!.fire("disconnect", "transport close");

    // The operator opens a case detail while the feed is down. Nothing is
    // emitted (there is no socket) — the ref has to be remembered anyway.
    h.handle.subscribe("case-z");
    expect(h.sockets).toHaveLength(1);

    h.timers.fireOne();
    await settle();
    h.sockets[1]!.fire("connect");

    expect(h.sockets[1]!.joins()).toEqual(["org:org_1", "case:org_1:case-a", "case:org_1:case-z"]);
  });

  test("a recovered connection reports `connected` and clears the attempt count", async () => {
    const h = await open();

    // Live, then the service restarts and the replacement is refused too.
    goLive(h);
    drop(h);
    const replacement = await serveBackoff(h);
    failHandshake(h);
    expect(h.health.at(-1)).toMatchObject({ state: "retrying", attempt: 2 });

    replacement.fire("connect");

    expect(h.health.at(-1)).toEqual({ state: "connected" });
    expect(h.status.at(-1)).toBe("live");
  });

  test("a successful connect RESETS the ladder — the cap counts CONSECUTIVE failures", async () => {
    const h = await open();
    // Four refused handshakes, then a working connection.
    for (let i = 0; i < 4; i += 1) await failOnce(h);
    goLive(h);

    // Four MORE failures must not exhaust the cap, because the four before them
    // were separated by a working connection.
    for (let i = 0; i < 7; i += 1) await failOnce(h);

    expect(h.health.some((x) => x.state === "exhausted")).toBe(false);
    expect(h.status.at(-1)).toBe("connecting");
  });
});

// ── The cap ───────────────────────────────────────────────────────────────────

describe("realtime reconnect — the attempt cap", () => {
  test("eight failures arm eight retries — the client is not off by one on the early side", async () => {
    const h = await open();

    // socket0 is the INITIAL handshake, so after eight refusals the client has
    // opened seven replacements and has one retry still waiting to be served.
    // Stopping here would mean a cap of seven.
    for (let i = 0; i < 8; i += 1) await failOnce(h);

    expect(h.delays).toHaveLength(8);
    expect(h.sockets).toHaveLength(8);
    expect(h.timers.armed).toBe(1);
    expect(h.health.some((x) => x.state === "exhausted")).toBe(false);
  });

  test("once the eighth retry has also failed the client stops", async () => {
    const h = await open();

    // The ninth refusal is the eighth retry reporting its own failure: eight
    // reconnects were made, all of them failed, and the ladder is spent.
    for (let i = 0; i < 9; i += 1) await failOnce(h);

    expect(h.health.at(-1)).toEqual({ state: "exhausted", attempts: 8 });
    expect(h.status.at(-1)).toBe("unavailable");
    expect(h.timers.armed).toBe(0);
  });

  test("a terminal client opens no further socket, however long it is left open", async () => {
    const h = await open();

    for (let i = 0; i < 9; i += 1) await failOnce(h);
    // The initial handshake plus exactly eight retries — never a ninth.
    expect(h.sockets).toHaveLength(9);

    // No timer is armed, so nothing fires — and an explicit settle proves the
    // loop is dead rather than merely quiet for one tick.
    await settle();
    expect(h.sockets).toHaveLength(9);
    expect(h.timers.armed).toBe(0);
  });

  test("a fresh drop after exhaustion does not restart the ladder", async () => {
    const h = await open();
    for (let i = 0; i < 9; i += 1) await failOnce(h);

    // The engine may still be retrying underneath. The cap is terminal, so this
    // must not buy a ninth attempt.
    h.sockets[8]!.fire("disconnect", "transport close");
    await settle();

    expect(h.timers.armed).toBe(0);
    expect(h.sockets).toHaveLength(9);
    expect(h.health.at(-1)).toMatchObject({ state: "exhausted" });
  });

  test("a grant that cannot be minted costs an attempt and opens no socket", async () => {
    const h = await open();
    goLive(h);
    drop(h);

    // The token endpoint starts failing. Handing the realtime service a handshake
    // it will reject teaches us nothing the token endpoint did not already say.
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/api/console/realtime-token")) {
        return new Response("nope", { status: 503 });
      }
      return saved(input);
    }) as unknown as typeof fetch;

    h.timers.fireOne();
    await settle();

    expect(h.sockets).toHaveLength(1);
    expect(h.health.at(-1)).toMatchObject({ state: "retrying", attempt: 2 });
  });
});

// ── Teardown ──────────────────────────────────────────────────────────────────

describe("realtime reconnect — close()", () => {
  test("during a pending backoff it cancels the timer", async () => {
    const h = await open();
    goLive(h);
    drop(h);

    const armedBefore = [...h.timers.pending.keys()];
    const cancelsBefore = h.timers.cancelled.length;
    expect(armedBefore).toHaveLength(1);

    h.handle.close();

    expect(h.timers.armed).toBe(0);
    // Assert the CANCELLATION, not the absence of a reconnect: a timer that was
    // merely ignored would still fire later and still open a socket.
    expect(h.timers.cancelled).toContain(armedBefore[0] ?? -1);
    expect(h.timers.cancelled.length).toBe(cancelsBefore + armedBefore.length);
  });

  test("no socket is created after a close during a pending backoff", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");
    h.sockets[0]!.fire("disconnect", "transport close");

    h.handle.close();
    await settle();

    // The timer was cleared rather than merely ignored: nothing was scheduled,
    // so nothing fired, so no handshake was started.
    expect(h.sockets).toHaveLength(1);
    expect(grantCalls).toBe(1);
  });

  test("it releases the socket it was holding", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");

    h.handle.close();

    expect(h.sockets[0]!.closeCalls).toBe(1);
    // Listeners go first, so teardown can never be mistaken for a drop.
    expect(h.sockets[0]!.listeners.size).toBe(0);
  });

  test("calling it twice is safe", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");

    expect(() => {
      h.handle.close();
      h.handle.close();
    }).not.toThrow();

    // React Strict Mode double-invokes every cleanup; a second close must not
    // re-close a socket that is already gone.
    expect(h.sockets[0]!.closeCalls).toBe(1);
    expect(h.sockets).toHaveLength(1);
  });

  test("a drop after close does not arm anything", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");
    h.handle.close();

    h.sockets[0]!.fire("disconnect", "transport close");
    h.sockets[0]!.fire("connect_error", new Error("gone"));
    await settle();

    expect(h.timers.armed).toBe(0);
    expect(h.sockets).toHaveLength(1);
  });

  test("it removes the visibility listener", async () => {
    const h = await open();
    expect(h.visibility.removed).toBe(0);

    h.handle.close();

    expect(h.visibility.removed).toBe(1);
    expect(h.visibility.listeners.size).toBe(0);
  });
});

describe("realtime reconnect — the handshake that lands after close()", () => {
  test("does not open a socket nobody will close", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");
    h.sockets[0]!.fire("disconnect", "transport close");

    // The component unmounts while the reconnect's grant request is in flight.
    let release: () => void = () => {
      /* empty */
    };
    grantGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.timers.fireOne();
    await settle();

    h.handle.close();
    expect(h.sockets).toHaveLength(1);

    // The handshake now completes into a component that has already gone. This
    // is the leak: a live socket with no handle, reconnecting forever.
    release();
    await settle();

    expect(h.sockets).toHaveLength(1);
    expect(h.timers.armed).toBe(0);
  });

  test("a connect event that arrives after close does not resurrect the status", async () => {
    const h = await open();
    const socket = h.sockets[0]!;
    h.handle.close();
    const seen = h.status.length;

    socket.fire("connect");

    expect(h.status.slice(seen)).not.toContain("live");
  });
});

// ── Visibility ────────────────────────────────────────────────────────────────

describe("realtime reconnect — visibility", () => {
  test("returning to visible reconnects immediately instead of serving the backoff", async () => {
    const h = await open({ rand: () => 0.9 });
    h.sockets[0]!.fire("connect");
    h.sockets[0]!.fire("disconnect", "transport close");
    expect(h.delays[0]).toBeGreaterThan(0);

    h.visibility.set("visible");
    await settle();

    // The 450ms the ladder had drawn is gone. The operator coming back to the
    // tab is the signal; making them stare at a dead board for half a second is
    // not a cost worth paying.
    expect(h.timers.armed).toBe(0);
    expect(h.sockets).toHaveLength(2);
  });

  test("going HIDDEN does not reconnect", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");
    h.sockets[0]!.fire("disconnect", "transport close");

    h.visibility.set("hidden");
    await settle();

    expect(h.sockets).toHaveLength(1);
    // The ladder is left running: a hidden tab still has to recover on its own.
    expect(h.timers.armed).toBe(1);
  });

  test("no visibility change means no wake-up — the socket stays down", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");
    h.sockets[0]!.fire("disconnect", "transport close");

    await settle();

    expect(h.sockets).toHaveLength(1);
    expect(h.timers.armed).toBe(1);
  });

  test("a wake-up does not reset the cap, so a flapping tab still terminates", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");
    h.sockets[0]!.fire("disconnect", "transport close");

    for (let i = 0; i < 8; i += 1) {
      h.visibility.set("visible");
      await settle();
      h.sockets[h.sockets.length - 1]!.fire("connect_error", new Error("down"));
      await settle();
    }

    expect(h.health.at(-1)).toEqual({ state: "exhausted", attempts: 8 });
    expect(h.timers.armed).toBe(0);
  });

  test("a live socket is left alone by a visibility change", async () => {
    const h = await open();
    h.sockets[0]!.fire("connect");

    h.visibility.set("hidden");
    h.visibility.set("visible");
    await settle();

    expect(h.sockets).toHaveLength(1);
  });

  test("a missing visibility API is not a crash — SSR and bare runners have none", async () => {
    const sockets: FakeSocket[] = [];
    const timers = new FakeTimers();
    const handle = await openRealtime({
      callRefs: ["case-a"],
      onStatus: () => {},
      deps: {
        connect: (opts) => {
          const socket = new FakeSocket(opts as Record<string, unknown>);
          sockets.push(socket);
          return socket as unknown as Socket;
        },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        visibility: null,
      },
    });

    expect(handle).not.toBeNull();
    handle!.close();
  });
});

// ── Configuration, unchanged ──────────────────────────────────────────────────

describe("realtime reconnect — the pre-existing contract is intact", () => {
  test("a disabled feature flag still returns null and never mints a grant", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ consoleLiveFeed: false }), {
        status: 200,
      })) as unknown as typeof fetch;
    const status: RealtimeStatus[] = [];

    const handle = await openRealtime({ callRefs: ["case-a"], onStatus: (s) => status.push(s) });

    expect(handle).toBeNull();
    expect(status).toEqual(["unavailable"]);
    expect(grantCalls).toBe(0);
  });

  test("a refused grant still returns null rather than throwing", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> =>
      String(input).includes("/features")
        ? new Response(JSON.stringify({ consoleLiveFeed: true }), { status: 200 })
        : new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const status: RealtimeStatus[] = [];

    const handle = await openRealtime({ callRefs: ["case-a"], onStatus: (s) => status.push(s) });

    expect(handle).toBeNull();
    expect(status).toEqual(["unavailable"]);
  });

  test("socket.io's own reconnection is off — this module owns the ladder", async () => {
    const h = await open();

    expect(h.sockets[0]!.opts.reconnection).toBe(false);
    expect(h.sockets[0]!.opts.path).toBe("/realtime");
    expect(h.sockets[0]!.opts.transports).toEqual(["websocket"]);
    expect(h.sockets[0]!.opts.forceNew).toBe(true);
  });
});
