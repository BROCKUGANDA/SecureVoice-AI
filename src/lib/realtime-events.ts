/**
 * The realtime event envelope — one shape for everything the console renders.
 *
 * ## Why this exists
 *
 * The console was being driven by an untyped `payload: Record<string, unknown>`
 * with a `type` string invented independently at each producer, using three
 * different naming conventions: `case_state` (snake) from the state machine,
 * `case.queued` (dotted) from the interventions ingest, and no `type` at all from
 * the audit chain. A client therefore had to know three conventions and could
 * not be told, by the compiler, that a new event existed. "The server is the
 * source of truth and the client renders purely from events" is only true if the
 * events are a closed, typed set.
 *
 * The envelope below is that set. It is deliberately transport-agnostic: the same
 * value rides the Supabase Realtime websocket, an SSE frame, or a log line, so a
 * client cannot end up with two different notions of what an event is.
 *
 * ## The rules
 *
 *  1. **`type` is a closed union.** A new event type is a compile error at every
 *     consumer until someone handles it, which is the point.
 *  2. **`call_id` is the correlation key**, not `caseRef`. A call reference is a
 *     human-facing string (`SV-8642`); a call id is what a socket, an audio stream
 *     and a realtime channel all share. Mixing the two is how a client ends up
 *     joining a channel it never subscribed to.
 *  3. **`ts` is epoch milliseconds, produced by the server.** A client clock is
 *     not a source of truth for "when did the bank stage the freeze", and using
 *     one puts a customer's timezone between the platform and its own audit trail.
 *  4. **`data` is narrow per event type**, so `switch (e.type)` narrows `e.data`
 *     too. `audio.meter` carries a level, not a transcript; `credit.deducted`
 *     carries a balance, not a verdict.
 *
 * ## Deliberately NOT here
 *
 * `audio.meter` is declared but has no producer yet. It is declared anyway
 * because a visualiser that renders from a stream needs the event to be part of
 * the contract before anything emits it, and an unimplemented member of a union
 * fails loudly (the producer cannot compile) rather than silently.
 */

/** Epoch milliseconds. Server-produced; see rule 3 above. */
export type EventTs = number;

/** The closed set. Adding a member is a deliberate, reviewed change. */
export type SvEventType =
  /** A case moved between states. The console's status pills render from this. */
  | "state.change"
  /** Partial speech recognition, not yet final. Drives the "typing" transcript. */
  | "transcript.interim"
  /** Final speech recognition for one turn. */
  | "transcript.final"
  /** Audio level for a visualiser. Frequency only — never content. */
  | "audio.meter"
  /** The tenant wallet changed. Lets the console redraw without a refetch. */
  | "credit.deducted"
  /** A failure the client should surface rather than swallow. */
  | "error";

/** Case lifecycle, mirroring the Case state machine. */
export type SvCaseState =
  "RECEIVED" | "SCREENED" | "DIALING" | "ANSWERED" | "HELD" | "ESCALATED" | "RESOLVED" | "FAILED";

type Envelope<T extends SvEventType, D> = {
  type: T;
  /** The call this event belongs to. Empty string for org-level events. */
  call_id: string;
  ts: EventTs;
  data: D;
};

export type StateChangeEvent = Envelope<
  "state.change",
  {
    from: SvCaseState | null;
    to: SvCaseState;
    /** Human-facing reason, already redacted. Never raw transcript. */
    reason?: string;
  }
>;

export type TranscriptEvent = Envelope<
  "transcript.interim" | "transcript.final",
  {
    /** Redacted text. The raw transcript never leaves the trust boundary. */
    text: string;
    /** BCP-47 tag of the detected language, when known. */
    lang?: string;
  }
>;

export type AudioMeterEvent = Envelope<
  "audio.meter",
  {
    /** RMS-ish level, 0..1. */
    level: number;
    /** True when the frame carries speech rather than silence. */
    speaking: boolean;
  }
>;

export type CreditDeductedEvent = Envelope<
  "credit.deducted",
  {
    /** Remaining balance after the movement. Authoritative, not a delta. */
    remaining: number;
    /** Which wallet moved: the organisation's, or this operator's own. */
    scope: "org" | "user";
    /** Why. Never a raw reason string from a caller. */
    reason: string;
    /** Present when the movement was a refund of a prior claim. */
    refunded?: boolean;
  }
>;

export type ErrorEvent = Envelope<
  "error",
  {
    /** Stable, machine-readable. The prose is for a human. */
    code: string;
    message: string;
    /** Whether the client may retry the same operation. */
    retryable: boolean;
  }
>;

/** The union. `switch (e.type)` narrows `e.data` to the matching shape. */
export type SvEvent =
  StateChangeEvent | TranscriptEvent | AudioMeterEvent | CreditDeductedEvent | ErrorEvent;

const EVENT_TYPES: ReadonlySet<string> = new Set<SvEventType>([
  "state.change",
  "transcript.interim",
  "transcript.final",
  "audio.meter",
  "credit.deducted",
  "error",
]);

/**
 * Parse an untrusted frame.
 *
 * Everything arriving on a socket is untrusted input — including frames this
 * process published, once a proxy or a browser extension is in the path. The
 * check is deliberately STRUCTURAL (shape + membership) rather than a schema
 * library, because the failure mode being defended against is a malformed frame
 * crashing a console mid-incident, and a schema that throws is worse than one
 * that returns null.
 */
export function parseSvEvent(raw: unknown): SvEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.type !== "string" || !EVENT_TYPES.has(o.type)) return null;
  if (typeof o.call_id !== "string") return null;
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return null;
  if (!o.data || typeof o.data !== "object") return null;
  return raw as SvEvent;
}

/** Build one, with the server clock. The only supported way to make an event. */
export function svEvent<T extends SvEventType, D>(
  type: T,
  callId: string,
  data: D,
  now: number = Date.now(),
): Envelope<T, D> {
  return { type, call_id: callId, ts: now, data };
}
