"use client";

/**
 * Honest connection state for the console feed (WP-20).
 *
 * A dashboard that looks live while frozen is worse than one that admits it is
 * disconnected: an operator watching a fraud call trusts what the screen says.
 * Three states, and the transition to `stale` is time-based, not event-based —
 * silence is the signal.
 *
 *   live         an event arrived recently; the feed is current
 *   reconnecting  the transport dropped or errored; we are retrying
 *   stale         no event for STALE_AFTER_MS while disconnected — say so, and
 *                 say since when
 */

export const STALE_AFTER_MS = 30_000;

export type FeedEvent = "open" | "event" | "error" | "closed";

export type ConnectionState = {
  status: "live" | "reconnecting" | "stale";
  /** When the current status began (ms epoch). */
  since: number;
  /** Last time an event actually arrived (ms epoch), or null if never. */
  lastEventAt: number | null;
};

export const initialConnectionState: ConnectionState = {
  status: "reconnecting",
  since: 0,
  lastEventAt: null,
};

export function reduceConnection(
  state: ConnectionState,
  event: FeedEvent,
  now: number,
): ConnectionState {
  switch (event) {
    case "open":
      // A reconnect alone does not prove freshness — only data does. Stay
      // `reconnecting` until an event actually arrives, so the UI cannot claim
      // "live" over a stream that is connected but silent.
      return { ...state, status: "reconnecting", since: now };
    case "event":
      return { status: "live", since: now, lastEventAt: now };
    case "error":
    case "closed":
      return { ...state, status: "reconnecting", since: now };
  }
}

/** Time-driven promotion to `stale`. Call from a timer, not from an event. */
export function tickConnection(state: ConnectionState, now: number): ConnectionState {
  if (state.status !== "reconnecting") return state;
  if (now - state.since < STALE_AFTER_MS) return state;
  return { ...state, status: "stale" };
}

export function describeConnection(state: ConnectionState, now: number): string {
  if (state.status === "live") return "Live";
  if (state.status === "stale") {
    return `Stale since ${new Date(state.since).toLocaleTimeString()}`;
  }
  return now - state.since >= STALE_AFTER_MS
    ? `Reconnecting (${Math.round((now - state.since) / 1000)}s)`
    : "Reconnecting";
}
