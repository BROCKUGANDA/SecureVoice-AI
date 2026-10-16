"use client";

/**
 * Browser-side realtime client for the Command Center.
 *
 * Design rule: this is an ACCELERATOR, never a dependency. The console already
 * has a working transport — the SSE stream at /api/console/events, which polls
 * the audit chain and is the source of truth. The websocket is a latency
 * improvement on top of it, so every failure mode here (no secret configured,
 * 503 from the token endpoint, refused handshake, network drop) resolves to
 * "keep using SSE" rather than an error state. `onActivity` is called for pushes
 * and the caller re-reads through the same path it already trusts.
 *
 * Grant lifecycle: tokens are minted per handshake and live 60s, so a fresh one
 * is fetched before every connect — the FIRST one and every reconnect after it.
 * A grant is never cached, because a cached grant is an expired one.
 *
 * ── Reconnection ────────────────────────────────────────────────────────────
 *
 * Before this, a dropped socket was permanent: the operator's board went
 * quietly stale and nothing on screen said so. On a fraud console that is worse
 * than an obvious outage, because a stale board still LOOKS live.
 *
 * socket.io's own reconnect loop is deliberately DISABLED and the ladder here
 * is hand-rolled (`reconnection: false`), for two reasons that no amount of
 * configuring the built-in one fixes:
 *
 *   1. socket.io does not re-send application events. It replays its own
 *      reserved events (`auth`, `connect`, …) and nothing else, so a client
 *      that reconnected under it would come back CONNECTED and subscribed to
 *      no channels at all — no activity, no error, a board that looks live and
 *      is not. The `join` emits are this module's, so resubscribing is this
 *      module's job.
 *   2. Its ladder is a fixed multiple with no jitter. Every console on the
 *      platform dropped by the same deploy reconnects on the same tick, which
 *      is exactly the moment the recovering realtime service is least able to
 *      take them. See `fullJitterDelay` for why FULL jitter and not `± jitter`.
 *
 * What replaces it: full-jitter exponential backoff, a bounded number of
 * consecutive attempts, and a terminal state after them. A browser tab that
 * reconnects forever is a battery bug and a log-spam bug, and an operator has
 * to be able to tell "realtime is down" from "realtime is fine".
 */

import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import { parseRealtimeFrame, type CreditDeductedEvent } from "@/lib/realtime-events";

/**
 * The three states every existing consumer already renders.
 *
 * DELIBERATELY NOT WIDENED for reconnect. `LiveOpsPanelProps` (in
 * src/components/ops/LiveOpsPanel.tsx) re-declares this union inline as
 * `"connecting" | "live" | "unavailable"` rather than importing it, so adding a
 * member here would stop Console.tsx from compiling — and this module must not
 * be able to break a file it does not own. The reconnect lifecycle is therefore
 * reported on its OWN channel, `RealtimeHealth`, which is additive: a caller
 * that never reads it keeps compiling and keeps working.
 *
 * The mapping onto these three is what an operator already understands:
 * "connecting" = we are trying, "live" = pushes are flowing, "unavailable" =
 * the console is on SSE, which is a supported state and not an error.
 */
export type RealtimeStatus = "connecting" | "live" | "unavailable";

/**
 * The reconnect lifecycle, reported separately from {@link RealtimeStatus}.
 *
 * `RealtimeStatus` answers "is the board live?"; this answers "what is the
 * client doing about it?", which is the difference between a badge that says
 * `sse` and one that says `sse — realtime down, giving up`. Delivered to
 * `onHealth`, never to `onStatus`.
 */
export type RealtimeHealth =
  /** A socket is connected and the channels are joined. */
  | { state: "connected" }
  /** A retry is pending; `delayMs` is what full jitter actually drew. */
  | { state: "retrying"; attempt: number; delayMs: number }
  /** The attempt cap was reached. No further attempt will be made. */
  | { state: "exhausted"; attempts: number };

/**
 * Ask the server which client-visible features are enabled.
 *
 * A failed read is treated as "off": the socket is an accelerator, so when in
 * doubt the console stays on SSE, which is the path it shipped with.
 */
async function fetchClientFlags(signal?: AbortSignal): Promise<{ consoleLiveFeed: boolean }> {
  try {
    const res = await fetch("/api/console/features", { signal, cache: "no-store" });
    if (!res.ok) return { consoleLiveFeed: false };
    const body = (await res.json()) as { consoleLiveFeed?: unknown };
    return { consoleLiveFeed: body.consoleLiveFeed === true };
  } catch {
    return { consoleLiveFeed: false };
  }
}

export type CaseActivity = {
  id: string;
  action: string;
  intent: string | null;
  chainHash: string;
  ts: string;
};

export type PresenceUpdate = { channel: string; watchers: string[] };

/**
 * Typed frames the registry declares but no reader on this page consumes
 * (`consumed: false` in src/lib/realtime-events.ts), warned once per type.
 *
 * The per-type memo is the whole design: dropping a frame silently is the exact
 * failure this platform keeps having to hunt down (a declared shape nothing
 * produces, or a produced shape nothing consumes, both look like a working
 * screen), and spamming the console on every transition on a busy org channel
 * would make the warning unreadable. One line per type per JS context is the
 * honest middle.
 */
const warnedUnconsumed = new Set<string>();

function warnUnconsumed(type: string): void {
  if (warnedUnconsumed.has(type)) return;
  warnedUnconsumed.add(type);
  console.warn(
    `[realtime] "${type}" is on the wire and read by nothing here — see its entry in ` +
      "src/lib/realtime-events.ts (consumed: false). It is not rendered, deliberately.",
  );
}

/** Must match SOCKET_PATH in mini-services/realtime/src/constants.ts. */
const SOCKET_PATH = "/realtime";
/** Give up on the push path for this session if a grant does not arrive. */
const TOKEN_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_REALTIME_TOKEN_TIMEOUT_MS) || 4_000;
const CONNECT_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_REALTIME_CONNECT_TIMEOUT_MS) || 6_000;
/** Cap on case subscriptions per socket (mirrors the server's channel cap). */
const MAX_CHANNELS = 50;

/** First reconnect is scheduled no later than this many ms after a drop. */
const RECONNECT_BASE_MS = Number(process.env.NEXT_PUBLIC_REALTIME_RECONNECT_BASE_MS) || 500;
/**
 * Ceiling on a single backoff delay.
 *
 * Past ~30s a retry stops being a recovery strategy and starts being a poll:
 * if the service has been down for more than half a minute the SSE fallback is
 * already the honest answer, and the extra attempts only buy the laptop's
 * battery. Full jitter draws BELOW this, never above.
 */
const RECONNECT_MAX_MS = Number(process.env.NEXT_PUBLIC_REALTIME_RECONNECT_MAX_MS) || 30_000;
/**
 * Consecutive failures tolerated before the client stops.
 *
 * Eight attempts against a full-jitter ladder spanning ~0–30s covers roughly a
 * two-minute outage, which is longer than a rolling deploy or a sleeping laptop
 * takes to come back. Past that the operator is better served by an honest
 * "realtime is down" than by a tab that reconnects every thirty seconds for the
 * rest of the shift.
 */
const RECONNECT_MAX_ATTEMPTS = Number(process.env.NEXT_PUBLIC_REALTIME_MAX_ATTEMPTS) || 8;

// ── Test seams ─────────────────────────────────────────────────────────────────

/**
 * The slice of `document` the visibility wake-up needs.
 *
 * A structural type rather than `Document` so a test can hand in a two-method
 * stub instead of a whole DOM, and so the module has no hard dependency on a
 * global that does not exist during SSR or under `bun test`.
 */
export type RealtimeVisibility = {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

export type RealtimeConnectOptions = Partial<ManagerOptions & SocketOptions>;

export type RealtimeDeps = {
  /** Defaults to socket.io's `io`. */
  connect?: (opts: RealtimeConnectOptions) => Socket;
  /** Defaults to `Math.random`. Must return a value in [0, 1). */
  rand?: () => number;
  /** Defaults to the global `setTimeout`. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Defaults to the global `clearTimeout`. */
  clearTimeout?: (handle: unknown) => void;
  /**
   * Defaults to `document` when one exists. Pass `null` explicitly to model a
   * tab with no visibility API at all — that is the SSR/undefined-document
   * case, and it must degrade to "no wake-up", never to a throw.
   */
  visibility?: RealtimeVisibility | null;
};

const defaultConnect = (opts: RealtimeConnectOptions): Socket => io(opts);

/**
 * Read the ambient document, or `null` when there isn't one.
 *
 * `typeof document` rather than a try/catch around a property read: during SSR
 * and in a bare test runner the global does not exist at all, and referencing it
 * unguarded is a ReferenceError, not a `null`.
 */
function defaultVisibility(): RealtimeVisibility | null {
  if (typeof document === "undefined") return null;
  const doc = document as unknown as RealtimeVisibility;
  if (typeof doc?.addEventListener !== "function") return null;
  return doc;
}

/**
 * Full-jitter exponential backoff: `random(0, min(cap, base · 2^(attempt-1)))`.
 *
 * ── Why full jitter, specifically ──────────────────────────────────────────
 *
 * A recovering service is a shared resource and the consoles are the queue in
 * front of it. What matters is not how quickly each client retries but how many
 * arrive in the SAME instant, because that is the number that re-kills the
 * service that just came up. So the delay has to decorrelate clients, not merely
 * perturb them:
 *
 *   · Fixed delay (plain exponential) is worst. Every console dropped by one
 *     deploy reconnects at exactly the same tick, forever, because they all
 *     have the same history. That is a self-inflicted thundering herd, and it
 *     recurs on every retry — the service is knocked down by the very clients
 *     it is trying to serve.
 *   · `delay ± jitter` (the popular shortcut) is much better but still wrong
 *     here for two reasons. First it can exceed the cap — the ladder's ceiling
 *     is the one guarantee a reconnect loop has, and `cap + jitter` breaks it.
 *     Second, a ± band is a narrow cluster around a deterministic value: N
 *     clients land in roughly ±N/spread of each other, whereas full jitter
 *     spreads them uniformly across the entire window, which is what actually
 *     minimises the arrival peak.
 *   · Full jitter (uniform over [0, ceiling]) is the variant the AWS backoff
 *     study measured as best under contention, and it is the one whose density
 *     is flat across the whole window, so the instantaneous arrival rate is as
 *     low as the window allows. It also makes the DELAY ITSELF unobservable to a
 *     server, so the retries cannot be trivially synchronised.
 *
 * The cost is that a backoff can draw 0ms and retry immediately. That is
 * deliberate and bounded: the attempt counter, not the delay, is what
 * guarantees termination.
 *
 * `rand` is injected so a test can prove the jitter is actually consulted
 * rather than asserting on a wall clock.
 */
export function fullJitterDelay(
  attempt: number,
  rand: () => number = Math.random,
  baseMs: number = RECONNECT_BASE_MS,
  maxMs: number = RECONNECT_MAX_MS,
): number {
  const step = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(maxMs, baseMs * 2 ** (step - 1));
  const drawn = rand();
  // Clamped on both sides: an injected source that returns 1 or a negative
  // number must not produce a negative timer delay or one past the ceiling.
  const bounded = Math.min(1, Math.max(0, drawn));
  return Math.floor(bounded * ceiling);
}

export type RealtimeOptions = {
  /** Case refs the operator is watching; each becomes a channel subscription. */
  callRefs: string[];
  /** Called for every activity event on a joined channel. */
  onActivity?: (activity: CaseActivity, channel: string) => void;
  /**
   * Called for every wallet movement on the tenant channel.
   *
   * Credit events share the `activity` envelope but not the case shape: they are
   * published with an empty callRef, so the service fans them out on
   * `org:<orgId>` rather than a case channel, and they carry the authoritative
   * remaining balance instead of a case action. Routing them separately keeps a
   * balance out of the case feed and a case action out of the wallet chip.
   */
  onCredit?: (credit: CreditDeductedEvent) => void;
  /** Called when a channel's watcher roster changes. */
  onPresence?: (update: PresenceUpdate) => void;
  /** Status transitions, so the UI can show live vs. degraded. */
  onStatus?: (status: RealtimeStatus) => void;
  /**
   * Reconnect lifecycle. Separate from `onStatus` so the three-state badge is
   * untouched; a caller that wants "giving up" rather than "sse" reads this.
   */
  onHealth?: (health: RealtimeHealth) => void;
  /** Test seams. Every field defaults to the real thing; production omits it. */
  deps?: RealtimeDeps;
};

export type RealtimeHandle = {
  /** Subscribe to an additional case (e.g. the operator opened a case detail). */
  subscribe: (callRef: string) => void;
  /** Tear everything down. Safe to call more than once. */
  close: () => void;
};

type Grant = { token: string; orgId: string };

async function fetchGrant(callRefs: string[], signal: AbortSignal): Promise<Grant | null> {
  const res = await fetch("/api/console/realtime-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callRefs }),
    signal,
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { token?: unknown; orgId?: unknown };
  if (typeof body.token !== "string" || typeof body.orgId !== "string") return null;
  return { token: body.token, orgId: body.orgId };
}

function normaliseRefs(callRefs: string[]): string[] {
  return [
    ...new Set(
      callRefs
        .filter((r): r is string => typeof r === "string")
        .map((r) => r.replace(/[^\w.-]/g, "").slice(0, 64))
        .filter(Boolean),
    ),
  ].slice(0, MAX_CHANNELS);
}

/**
 * Open the realtime feed. Returns null when the push path is unavailable, which
 * is the signal to rely on SSE alone — not an error.
 */
export async function openRealtime(opts: RealtimeOptions): Promise<RealtimeHandle | null> {
  const { onActivity, onCredit, onPresence, onStatus } = opts;
  const setStatus = onStatus ?? (() => {});
  const setHealth = opts.onHealth ?? (() => {});
  const refs = normaliseRefs(opts.callRefs);

  // Seams resolved once, at the edge. Everything below reads these names, so a
  // test substitutes the four functions and never has to reach for a global.
  const deps = opts.deps;
  const connect = deps?.connect ?? defaultConnect;
  const rand = deps?.rand ?? Math.random;
  const later = deps?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel =
    deps?.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  // `in` rather than `??` so an explicit `null` (no visibility API — SSR, a
  // bare test runner) is distinguishable from "not configured" (auto-detect).
  const visibility = deps && "visibility" in deps ? (deps.visibility ?? null) : defaultVisibility();

  // Feature gate first, so a disabled deployment never spends a grant request or
  // opens a socket that will only be refused.
  const flags = await fetchClientFlags();
  if (!flags.consoleLiveFeed) {
    setStatus("unavailable");
    return null;
  }

  // Abort a hung grant request rather than leaving the console with no live feed
  // and no error — after this we simply stay on SSE.
  const tokenAbort = new AbortController();
  const tokenTimer = later(() => tokenAbort.abort(), TOKEN_TIMEOUT_MS);

  let granted: Grant | null = null;
  try {
    granted = await fetchGrant(refs, tokenAbort.signal);
  } catch {
    granted = null;
  } finally {
    cancel(tokenTimer);
  }

  if (!granted) {
    setStatus("unavailable");
    return null;
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  /** Once true, nothing further happens: no socket, no timer, no listener. */
  let closed = false;
  /**
   * Bumped by every teardown. Async work captures it BEFORE its first await and
   * re-checks it after, so a handshake that lands after `close()` cannot open a
   * socket nobody holds a handle to — the leak this exists to prevent.
   */
  let generation = 0;
  /** Consecutive failures. Reset to zero by a successful connect. */
  let attempt = 0;
  /** The one pending backoff timer, or null. At most one exists per drop. */
  let retryTimer: unknown = null;
  let socket: Socket | null = null;
  let orgId = granted.orgId;

  /**
   * Every case ref this client has ever been asked to watch.
   *
   * A SET, not the original array, because `subscribe()` can be called during an
   * outage: the ref has to survive the disconnect and be re-joined by the next
   * `joinAll`, or an operator who opened a case mid-outage silently stops
   * receiving it when the socket comes back.
   */
  const watched = new Set<string>(refs);

  const joinAll = (target: Socket): void => {
    // The tenant channel carries org-level events. Wallet movements have no
    // case, so `announceCredit` (src/lib/credits.ts) publishes them with an
    // empty callRef and the service fans them out on `org:<orgId>`. That name
    // is seeded into EVERY grant by `channelsFor`, so joining it is not an
    // escalation — and a client that never joins it simply never sees a balance
    // change made by a colleague, a webhook or a queue worker.
    target.emit("join", `org:${orgId}`);
    for (const ref of watched) target.emit("join", `case:${orgId}:${ref}`);
  };

  /**
   * Drop the current socket completely: listeners first, so teardown can never
   * be mistaken for a drop, then the transport, then the Manager.
   *
   * `close()` alone is not enough. socket.io's Manager holds the engine even
   * with reconnection off, and a Manager left attached to a dead socket is a
   * live transport no one has a handle to.
   */
  function disposeSocket(): void {
    const previous = socket;
    socket = null;
    if (!previous) return;
    try {
      previous.removeAllListeners();
      previous.close();
      previous.disconnect();
    } catch {
      // Already torn down by the engine. Nothing left to release.
    }
  }

  function cancelRetry(): void {
    if (retryTimer === null) return;
    cancel(retryTimer);
    retryTimer = null;
  }

  /**
   * One reconnect attempt: mint a grant, then open a socket on it.
   *
   * The grant is fetched FRESH on every reconnect rather than reused. Grants
   * live 60s, so the one the previous socket connected with is expired by the
   * time a backoff expires — reconnecting with it would present a stale token,
   * be refused with `unauthorized`, and burn an attempt against the cap for
   * nothing. The first connection passes the grant it was already handed, so the
   * handshake costs exactly one token request, as it did before.
   *
   * A failed grant therefore counts as a FAILED ATTEMPT and goes back to sleep
   * without opening a socket. Opening one anyway would send the realtime
   * service a handshake it has to reject, to learn something the token endpoint
   * already told us.
   */
  async function openOnce(pregranted?: Grant): Promise<void> {
    if (closed) return;
    const mine = generation;

    let fresh: Grant | null = pregranted ?? null;
    if (!fresh) {
      try {
        fresh = await fetchGrant([...watched], new AbortController().signal);
      } catch {
        fresh = null;
      }
    }

    // The leak guard: `close()` ran while the grant was in flight. Creating the
    // socket now would hand a live connection to a component that has already
    // unmounted, and nothing would ever close it.
    if (closed || mine !== generation) return;

    if (!fresh) {
      scheduleRetry();
      return;
    }

    orgId = fresh.orgId;

    // The previous socket is released HERE rather than at the drop, because a
    // socket that failed its handshake is not gone — it is sitting on a Manager
    // with a live engine. Replacing it without disposing would leave one of
    // those per retry, which is the same leak as never closing at all.
    disposeSocket();

    try {
      const next: Socket = connect({
        path: SOCKET_PATH,
        auth: { token: fresh.token },
        // websocket first, polling as the fallback the service ships server-side
        // (mini-services/realtime/src/server.ts lists both). A websocket that
        // cannot even be established — a proxy that refuses the upgrade — would
        // otherwise be a permanent outage on this path, which is why the client
        // used to sit hard-coded on one transport. A LIVE socket never downgrades
        // mid-session: socket.io tries the first transport and only walks the
        // list when a handshake fails, and upgrade only ever moves UP the list.
        transports: ["websocket", "polling"],
        // See the header: socket.io's ladder cannot jitter for us and cannot
        // replay our `join` emits, so it is off and this module reconnects.
        reconnection: false,
        timeout: CONNECT_TIMEOUT_MS,
        forceNew: true,
      });
      socket = next;

      next.on("connect", () => {
        if (closed || mine !== generation) return;
        attempt = 0;
        // The resubscribe. A reconnect is a NEW socket with NO subscriptions: a
        // client that comes back without this looks exactly like a working one
        // — connected, quiet, wrong.
        joinAll(next);
        setStatus("live");
        setHealth({ state: "connected" });
      });

      next.on("connect_error", () => scheduleRetry());
      next.on("disconnect", () => scheduleRetry());

      next.on(
        "activity",
        (msg: { channel: string; event?: { kind: string; payload?: unknown } }) => {
          if (msg.event?.kind !== "activity") return;
          // The receive side of the contract. `payload` is `unknown` — the service
          // relays it verbatim (`mini-services/realtime/src/ingest.ts` holds no
          // schema), a proxy can be in the path, and a producer can ship a frame
          // this build has never seen. `parseRealtimeFrame` is the only thing that
          // turns it into a shape this file is allowed to read; previously every
          // non-credit payload was cast straight to `CaseActivity`, which is how a
          // `case_state` frame reached the feed as "SV-1234 · undefined".
          const frame = parseRealtimeFrame(msg.event.payload);
          if (!frame) {
            console.warn(
              "[realtime] dropped a frame outside the event registry",
              msg.channel,
              msg.event.payload,
            );
            return;
          }
          // No `type` at all: the audit-activity row, the frame the console's live
          // feed is built from. Routed first because it is the only untyped shape.
          if (!("type" in frame)) {
            onActivity?.(frame, msg.channel);
            return;
          }
          // Wallet movements share the activity envelope but not the case shape.
          // Routed by `type`, not by channel name: a mislabelled channel must not
          // be able to feed a credit balance into the case feed, nor a case action
          // into a wallet chip.
          if (frame.type === "credit.deducted") {
            onCredit?.(frame);
            return;
          }
          // Every other declared typed frame: valid, delivered, unread. Loud rather
          // than silently cast into a renderer that has no field for it. A type
          // added to the registry lands here too, so it cannot arrive unnoticed.
          warnUnconsumed(frame.type);
        },
      );

      next.on("presence", (msg: PresenceUpdate) => onPresence?.(msg));
    } catch {
      // `connect()` threw before a socket existed. That is still one failed
      // attempt, and the ladder has to treat it as one or a permanently broken
      // client would stop after the first failure.
      scheduleRetry();
    }
  }

  /**
   * Arm the backoff for a drop, or give up if the cap is spent.
   *
   * Three things call this (connect_error, disconnect, the timer itself) and a
   * single drop emits more than one of them, so the pending-timer guard is the
   * contract: exactly one armed timer per drop, whatever fires.
   */
  function scheduleRetry(): void {
    if (closed || retryTimer !== null) return;

    if (attempt >= RECONNECT_MAX_ATTEMPTS) {
      cancelRetry();
      disposeSocket();
      // The same status the console already reads as "on SSE". The badge is
      // honest; `onHealth({state:"exhausted"})` is what lets a caller say WHY.
      setStatus("unavailable");
      setHealth({ state: "exhausted", attempts: attempt });
      return;
    }

    attempt += 1;
    const delayMs = fullJitterDelay(attempt, rand);
    // "connecting", not "unavailable": we are actively trying, and the console
    // already renders that as an amber "connecting" rather than a silent fall
    // back to sse.
    setStatus("connecting");
    setHealth({ state: "retrying", attempt, delayMs });

    retryTimer = later(() => {
      retryTimer = null;
      void openOnce();
    }, delayMs);
  }

  // ── Visibility-aware backoff ───────────────────────────────────────────────

  let onVisible: (() => void) | null = null;
  if (visibility) {
    onVisible = () => {
      if (closed) return;
      if (visibility.visibilityState !== "visible") return;
      // Nothing to rescue when no backoff is running.
      if (retryTimer === null) return;
      // A hidden tab is a silent one: the laptop sleeps, the socket dies, and
      // the ladder has been climbing for minutes toward a ceiling the operator
      // will never wait out. Coming back to the tab is the operator saying
      // "I am here now", so the delay is cancelled rather than served.
      cancelRetry();
      // The counter is deliberately NOT reset: a tab that flaps between hidden
      // and visible all shift must still terminate, and this wake-up is a bonus
      // attempt, not a fresh outage.
      void openOnce();
    };
    visibility.addEventListener("visibilitychange", onVisible);
  }

  // ── First connection ───────────────────────────────────────────────────────

  setStatus("connecting");
  await openOnce(granted);

  return {
    subscribe(callRef: string) {
      const ref = normaliseRefs([callRef])[0];
      if (!ref) return;
      // Remembered even with no socket: the next `joinAll` re-joins it.
      watched.add(ref);
      socket?.emit("join", `case:${orgId}:${ref}`);
    },
    close() {
      // Idempotent, and cheap to be so: React calls a cleanup on every Strict
      // double-invoke and on every remount, so `close()` must be safe to call
      // twice and safe to call while a backoff timer is armed.
      if (closed) return;
      closed = true;
      // Bumped BEFORE the awaits are cancelled so any handshake still in flight
      // sees a different generation and bails.
      generation += 1;
      cancelRetry();
      if (onVisible && visibility) visibility.removeEventListener("visibilitychange", onVisible);
      onVisible = null;
      disposeSocket();
    },
  };
}
