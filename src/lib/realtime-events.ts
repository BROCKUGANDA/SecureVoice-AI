/**
 * The realtime event registry: every payload this repository actually puts on
 * the wire, with the `file:line` that produces it and the `file:line` (if any)
 * that reads it.
 *
 * ## Why the previous version of this file was wrong
 *
 * It declared a union of six event types — `state.change`, `transcript.interim`,
 * `transcript.final`, `audio.meter`, `credit.deducted`, `error` — plus `svEvent()`
 * and `parseSvEvent()`. Five of the six names never appear on the wire, and neither
 * helper had a caller outside this file. The payloads the console actually receives
 * were being built inline by five producers under three *other* naming conventions:
 *
 *   · `src/lib/case-state-machine.ts` sends `{ type: "case_state", … }`
 *   · `src/app/api/v1/interventions/route.ts` sends `{ type: "case.queued", … }`
 *   · `src/lib/notifications.ts` sends `{ type: "notification", … }`
 *   · `src/lib/credits.ts` sends `{ type: "credit.deducted", … }` — the envelope shape
 *   · `src/lib/audit-chain.ts` sends **no `type` at all**
 *
 * A contract that describes nothing on the wire is worse than no contract, because
 * it makes every downstream measurement report empty with confidence: a validator
 * built from it rejects real traffic, a client written against it switches on
 * strings that never arrive, and `parseSvEvent()` — which checked membership in that
 * list — would have refused four fifths of what the platform actually publishes.
 * This file's job now is to be derived from the producers, not from an idea.
 *
 * ## What was deleted, and why that is the fix
 *
 * `state.change` (the real name is `case_state`), `transcript.interim` and
 * `transcript.final`, `audio.meter`, `error`. No producer exists for any of them.
 * The old header justified `audio.meter` by saying an unimplemented union member
 * "fails loudly (the producer cannot compile)" — it does not: nothing compiles
 * against the union, so the member simply sat there and the file's own comment had
 * to admit it. Deleting an entry nothing produces is the honest correction; inventing
 * a placeholder emitter to keep it would have made the contract lie in the other
 * direction. `svEvent()` is gone for the same reason (zero callers), and
 * `parseSvEvent()` is replaced by `parseRealtimeFrame()` below, which *is* called —
 * at the one boundary where an unreadable frame can actually reach a screen.
 *
 * ## The rules
 *
 *  1. **A type enters this registry only with a named producer.** `tests/contracts/
 *     realtime-event-registry.test.ts` re-derives the whole set from the source
 *     files: every entry's `producer.literal` must exist in its `producer.file`, and
 *     every `notifyRealtime()` call site in `src/` must send a type listed here. A
 *     type can therefore only be added by writing the emitter.
 *  2. **`consumed: false` is allowed, but it must be said.** Three of the four typed
 *     frames are published to no reader (see each entry's `consumer`). That is a
 *     real state of the system, not a thing to hide behind a hopeful type.
 *  3. **The wire shape is whatever the producer builds.** Two shapes coexist today —
 *     the `{type, call_id, ts, data}` envelope (`credit.deducted`) and flat ad-hoc
 *     objects. Each entry declares which, and `fields` is derived from the producer's
 *     own literal, so `checkRealtimePayload()` accepts real traffic instead of an
 *     ideal. Narrowing the flat frames onto the envelope is a producer-side change,
 *     and the registry is where the disagreement stays visible.
 *  4. **`ts` is not uniform and that is a documented defect, not a convention.**
 *     `credit.deducted` uses epoch milliseconds; `case.queued` and the audit-activity
 *     row use an ISO string. A client cannot compare them, so each entry names its
 *     own type rather than one union-wide claim.
 */

/** A structural predicate over one value read by dotted path from a payload. */
type FieldCheck = (value: unknown) => boolean;

const isString: FieldCheck = (v) => typeof v === "string";
const isFiniteNumber: FieldCheck = (v) => typeof v === "number" && Number.isFinite(v);
const isBoolean: FieldCheck = (v) => typeof v === "boolean";
const isObject: FieldCheck = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNullableString: FieldCheck = (v) => typeof v === "string" || v === null;
const oneOf =
  (...allowed: string[]): FieldCheck =>
  (v) =>
    typeof v === "string" && allowed.includes(v);
const optional =
  (inner: FieldCheck): FieldCheck =>
  (v) =>
    v === undefined || inner(v);

/** The typed frames. A member enters this union only with a producer (rule 1). */
export type SvEventType = "credit.deducted" | "case_state" | "case.queued" | "notification";

/** Envelope form: `{type, call_id, ts, data}`. Only `credit.deducted` uses it today. */
type Envelope<T extends SvEventType, D> = {
  type: T;
  /** The call this event belongs to. Empty string for org-level events. */
  call_id: string;
  /** Epoch milliseconds. */
  ts: number;
  data: D;
};

/** `src/lib/credits.ts` → the wallet chip. The one type both emitted and consumed. */
export type CreditDeductedEvent = Envelope<
  "credit.deducted",
  {
    /** Remaining balance after the movement. Authoritative, not a delta. */
    remaining: number;
    /** Which wallet moved: the organisation's, or this operator's own. */
    scope: "org" | "user";
    /** Why, as a stable code chosen by the producer. */
    reason: string;
    /** Present only when the movement refunded a prior claim. */
    refunded?: boolean;
  }
>;

/** `src/lib/case-state-machine.ts`. Flat, no envelope, ISO-less timestamp, no `ts` at all. */
export type CaseStateEvent = {
  type: "case_state";
  /** Human-facing case reference (`SV-8642`), NOT a call id. */
  caseRef: string;
  from: string;
  to: string;
  /** Whatever the transitioner passed through. Unvalidated by design. */
  meta: Record<string, unknown>;
};

/** `src/app/api/v1/interventions/route.ts`. Flat; `ts` here is an ISO string. */
export type CaseQueuedEvent = {
  type: "case.queued";
  caseRef: string;
  /** The literal `"QUEUED"` — the call has been accepted, not placed. */
  state: string;
  jobId: string;
  language: string;
  riskScore: number;
  ts: string;
};

/** `src/lib/notifications.ts`. Flat; the row itself is the source of truth. */
export type NotificationEvent = {
  type: "notification";
  alertType: string;
  severity: "page" | "urgent" | "info";
  title: string;
  /** The deduplicated aggregate count on the inbox row, not an event count. */
  count: number;
};

/**
 * The audit-activity row — `src/lib/audit-chain.ts`, and the ONLY frame the
 * console's live feed renders. It carries no `type` at all, which is why it is
 * declared separately rather than smuggled into `SvEventType`: inventing a type
 * string for it would put a fifth fake name in the union this file was just
 * cleared of. Its shape is `CaseActivity` in `src/lib/realtime-client.ts`, which
 * `Console.tsx` feeds into the feed rows.
 */
export type ActivityFrame = {
  id: string;
  action: string;
  intent: string | null;
  chainHash: string;
  /** ISO string — not the epoch ms the envelope uses. */
  ts: string;
};

/** Everything a client may legitimately receive on a channel. */
export type RealtimeFrame =
  CreditDeductedEvent | CaseStateEvent | CaseQueuedEvent | NotificationEvent | ActivityFrame;

export type RealtimeProducer = {
  /** `file:line` of the code that builds the payload. The gate cites it literally. */
  file: string;
  line: number;
  /** A string that MUST appear at (or within a few lines of) `file:line`. */
  literal: string;
};

export type RealtimeEventSpec = {
  type: SvEventType;
  /** Which of the two wire forms this producer actually builds (rule 3). */
  shape: "envelope" | "flat";
  producer: RealtimeProducer;
  /** `file:line` of the reader, or a `none —` note saying why there is none. */
  consumer: string;
  /** false = published, delivered to the browser, and read by nobody. */
  consumed: boolean;
  /** Required/optional fields by dotted path, taken from the producer's literal. */
  fields: Record<string, FieldCheck>;
};

export const REALTIME_EVENTS: readonly RealtimeEventSpec[] = [
  {
    type: "credit.deducted",
    shape: "envelope",
    producer: {
      file: "src/lib/credits.ts",
      line: 288,
      literal: `type: "credit.deducted"`,
    },
    consumer: "src/lib/realtime-client.ts:547 → src/components/billing/CreditWidget.tsx:230",
    consumed: true,
    fields: {
      call_id: isString,
      ts: isFiniteNumber,
      data: isObject,
      "data.remaining": isFiniteNumber,
      "data.scope": oneOf("org", "user"),
      "data.reason": isString,
      "data.refunded": optional(isBoolean),
    },
  },
  {
    type: "case_state",
    shape: "flat",
    producer: {
      file: "src/lib/case-state-machine.ts",
      line: 254,
      literal: `type: "case_state"`,
    },
    consumer:
      "none — the console reads `id/action/intent` off every non-credit frame, and this " +
      "payload has none of them; it is logged as unconsumed at the client boundary " +
      "(src/lib/realtime-client.ts) instead of rendering `SV-… · undefined`. Wiring it " +
      "needs a field-set decision in case-state-machine.ts plus a render path in Console.tsx.",
    consumed: false,
    fields: {
      caseRef: isString,
      from: isString,
      to: isString,
      meta: isObject,
    },
  },
  {
    type: "case.queued",
    shape: "flat",
    producer: {
      file: "src/app/api/v1/interventions/route.ts",
      line: 1049,
      literal: `type: "case.queued"`,
    },
    consumer:
      "none — the audit chain appends its own row for the same accept (route.ts:1019), and " +
      "the console renders that. The frame is emitted in parallel with it and read by nobody.",
    consumed: false,
    fields: {
      caseRef: isString,
      state: isString,
      jobId: isString,
      language: isString,
      riskScore: isFiniteNumber,
      ts: isString,
    },
  },
  {
    type: "notification",
    shape: "flat",
    producer: {
      file: "src/lib/notifications.ts",
      line: 129,
      literal: `type: "notification"`,
    },
    consumer:
      "none — the inbox is polled from /api/console/inbox, which is where the badge count " +
      "actually comes from. Nothing on this channel reads alertType/severity/title/count.",
    consumed: false,
    fields: {
      alertType: isString,
      severity: oneOf("page", "urgent", "info"),
      title: isString,
      count: isFiniteNumber,
    },
  },
];

/**
 * The untyped frame (see `ActivityFrame`). Kept as a sibling of the registry
 * rather than an entry in it because it has no `type` to key on — but it is
 * produced, delivered and consumed, so it belongs to the contract and the gate
 * that walks the producers has to know about it or it would flag audit-chain.ts.
 */
export const ACTIVITY_FRAME: {
  producer: RealtimeProducer;
  consumer: string;
  fields: Record<string, FieldCheck>;
} = {
  producer: {
    file: "src/lib/audit-chain.ts",
    line: 361,
    literal: "chainHash: row.chainHash",
  },
  consumer: "src/lib/realtime-client.ts:540 → src/views/Console.tsx:628",
  fields: {
    id: isString,
    action: isString,
    intent: isNullableString,
    chainHash: isString,
    ts: isString,
  },
};

/** The declared set, as data, so the gate can compare it against the tree. */
export const REALTIME_EVENT_TYPES: readonly SvEventType[] = REALTIME_EVENTS.map((e) => e.type);

const SPEC_BY_TYPE: ReadonlyMap<string, RealtimeEventSpec> = new Map(
  REALTIME_EVENTS.map((e) => [e.type, e] as const),
);

/** Read a dotted path (`data.remaining`) out of a payload without throwing. */
function readPath(payload: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, payload);
}

/** Field paths that are absent or of the wrong type. Empty means the payload conforms. */
function offendingFields(
  payload: Record<string, unknown>,
  fields: Record<string, FieldCheck>,
): string[] {
  return Object.entries(fields)
    .filter(([path, check]) => !check(readPath(payload, path)))
    .map(([path]) => path);
}

export type RealtimePayloadCheck =
  /** A payload with no `type` is the audit-activity path, not a violation here. */
  { ok: true; type: SvEventType | null } | { ok: false; reason: string };

/**
 * The EMIT-side check: does this payload name a declared type, and does it carry
 * the fields that type's producer builds?
 *
 * Called by `notifyRealtime()` (`src/lib/realtime.ts`), which refuses a typed
 * payload failing here rather than publishing a frame no client can read. It does
 * not validate the *shape* of an untyped payload — that is the receive side's job,
 * and `tests/unit/realtime-bridge.test.ts` pins that a bare `{}` still fans out.
 */
export function checkRealtimePayload(payload: Record<string, unknown>): RealtimePayloadCheck {
  const declared = payload.type;
  if (declared === undefined || declared === null) return { ok: true, type: null };
  if (typeof declared !== "string") return { ok: false, reason: "type_is_not_a_string" };
  const spec = SPEC_BY_TYPE.get(declared);
  if (!spec) return { ok: false, reason: `undeclared_type:"${declared}"` };
  const bad = offendingFields(payload, spec.fields);
  if (bad.length > 0) return { ok: false, reason: `${spec.type}_fields_invalid:${bad.join(",")}` };
  return { ok: true, type: spec.type };
}

/**
 * The RECEIVE-side parse: turn an untrusted socket frame into a `RealtimeFrame`,
 * or return null.
 *
 * Everything arriving on a socket is untrusted input — including frames this
 * process published, once a proxy or a stale browser build is in the path. The
 * check is deliberately STRUCTURAL (field membership) rather than a schema
 * library, because the failure mode being defended against is a malformed frame
 * crashing a console mid-incident, and a parser that throws is worse than one
 * that returns null.
 *
 * This replaces `parseSvEvent()`, which was never called and whose type list
 * would have rejected every frame the platform actually sends except one.
 */
export function parseRealtimeFrame(raw: unknown): RealtimeFrame | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  const check = checkRealtimePayload(payload);
  if (!check.ok) return null;
  if (check.type === null) {
    return offendingFields(payload, ACTIVITY_FRAME.fields).length === 0
      ? (payload as unknown as ActivityFrame)
      : null;
  }
  return payload as unknown as RealtimeFrame;
}
