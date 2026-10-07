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
 * is fetched before every connect. A grant is never cached.
 */

import { io, type Socket } from "socket.io-client";

export type RealtimeStatus = "connecting" | "live" | "unavailable";

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

/** Must match SOCKET_PATH in mini-services/realtime/src/constants.ts. */
const SOCKET_PATH = "/realtime";
/** Give up on the push path for this session if a grant does not arrive. */
const TOKEN_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_REALTIME_TOKEN_TIMEOUT_MS) || 4_000;
const CONNECT_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_REALTIME_CONNECT_TIMEOUT_MS) || 6_000;
/** Cap on case subscriptions per socket (mirrors the server's channel cap). */
const MAX_CHANNELS = 50;

export type RealtimeOptions = {
  /** Case refs the operator is watching; each becomes a channel subscription. */
  callRefs: string[];
  /** Called for every activity event on a joined channel. */
  onActivity?: (activity: CaseActivity, channel: string) => void;
  /** Called when a channel's watcher roster changes. */
  onPresence?: (update: PresenceUpdate) => void;
  /** Status transitions, so the UI can show live vs. degraded. */
  onStatus?: (status: RealtimeStatus) => void;
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
  const { onActivity, onPresence, onStatus } = opts;
  const setStatus = onStatus ?? (() => {});
  const refs = normaliseRefs(opts.callRefs);

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
  const tokenTimer = setTimeout(() => tokenAbort.abort(), TOKEN_TIMEOUT_MS);

  let granted: Grant | null = null;
  try {
    granted = await fetchGrant(refs, tokenAbort.signal);
  } catch {
    granted = null;
  } finally {
    clearTimeout(tokenTimer);
  }

  if (!granted) {
    setStatus("unavailable");
    return null;
  }

  setStatus("connecting");

  // Same-origin: the reverse proxy routes this path to the realtime service, so
  // the browser never needs to know that service's host or port.
  const socket: Socket = io({
    path: SOCKET_PATH,
    auth: { token: granted.token },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 3,
    reconnectionDelay: 1_000,
    timeout: CONNECT_TIMEOUT_MS,
    forceNew: true,
  });

  let closed = false;
  const orgId = granted.orgId;

  const joinAll = () => {
    for (const ref of refs) socket.emit("join", `case:${orgId}:${ref}`);
  };

  socket.on("connect", () => {
    joinAll();
    setStatus("live");

    // A reconnect re-presents the ORIGINAL grant, which has expired by then, so
    // refresh it. The current connection stays up regardless — if the refresh
    // fails, the server simply rejects the next reconnect attempt.
    void (async () => {
      try {
        const fresh = await fetchGrant(refs, new AbortController().signal);
        if (fresh && !closed) socket.auth = { token: fresh.token };
      } catch {
        /* keep the live socket; nothing to do until the next reconnect */
      }
    })();
  });

  socket.on("connect_error", () => {
    if (!closed) setStatus("unavailable");
  });

  socket.on("activity", (msg: { channel: string; event?: { kind: string; payload?: unknown } }) => {
    if (msg.event?.kind !== "activity") return;
    onActivity?.(msg.event.payload as CaseActivity, msg.channel);
  });

  socket.on("presence", (msg: PresenceUpdate) => onPresence?.(msg));

  return {
    subscribe(callRef: string) {
      const ref = normaliseRefs([callRef])[0];
      if (!ref) return;
      socket.emit("join", `case:${orgId}:${ref}`);
    },
    close() {
      closed = true;
      socket.removeAllListeners();
      socket.close();
    },
  };
}
