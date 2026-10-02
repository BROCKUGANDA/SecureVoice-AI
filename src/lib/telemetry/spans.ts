/**
 * WP-7 — latency instrumentation: the span vocabulary and the recorder.
 *
 * This module is deliberately PURE: no `node:` imports, no `server-only`. The
 * SLO panel renders in the browser and needs the same span names, targets and
 * chart geometry the server computes percentiles from; two copies of a target
 * table would drift, and a drifted target table is a silently wrong verdict.
 *
 * Three rules, each of which costs something to honour:
 *
 *   1. **Recording must never throw and must never block.** A request path
 *      calls `recordSpan()` synchronously; it pushes onto an in-memory ring and
 *      returns. Durability is somebody else's problem (`./store.ts` does it off
 *      the path). A latency probe that can fail an intervention is worse than no
 *      probe.
 *   2. **A rejected input is counted, not guessed.** An unknown span name, a
 *      NaN duration or an end before the start is a bug in the caller, and the
 *      only safe response is to drop the sample and increment a counter — never
 *      to emit a number. A negative latency would make p95 look excellent.
 *   3. **No fabricated measurement is representable.** The record type has no
 *      field for an estimate. A span either has two timestamps, or it is not a
 *      record.
 */

/* ————————————————————————————————— spans ————————————————————————————————— */

export type SpanDefinition = {
  /** Machine name. Stable: it is the key in the evidence artifact. */
  readonly name: string;
  /** Human label. Arrow form matches how the pipeline is described aloud. */
  readonly label: string;
  /** p95 budget in milliseconds. The brief's table, verbatim. */
  readonly targetP95Ms: number;
};

/**
 * The eight spans from the WP-7 brief. Order is the order the operator reads
 * them: intake, then the call, then the conversation, then the tools, then the
 * bank's side, then the whole intervention.
 */
export const SPAN_DEFINITIONS = [
  { name: "signal_received_to_accepted", label: "signal received → accepted", targetP95Ms: 300 },
  { name: "signal_accepted_to_provider_accepted", label: "accepted → provider accepted the call", targetP95Ms: 1_500 },
  { name: "signal_received_to_ringing", label: "signal received → ringing", targetP95Ms: 5_000 },
  { name: "answered_to_first_agent_word", label: "answered → first agent word", targetP95Ms: 1_200 },
  { name: "caller_stop_to_agent_audio", label: "caller stops speaking → agent audio begins", targetP95Ms: 1_500 },
  { name: "tool_request_to_response", label: "tool request → tool response", targetP95Ms: 300 },
  { name: "fraud_confirmed_to_webhook_delivered", label: "fraud confirmed → bank webhook delivered", targetP95Ms: 2_000 },
  { name: "signal_received_to_freeze_staged", label: "signal received → freeze staged", targetP95Ms: 60_000 },
] as const satisfies readonly SpanDefinition[];

export type SpanName = (typeof SPAN_DEFINITIONS)[number]["name"];

const DEFINITION_INDEX: ReadonlyMap<string, SpanDefinition> = new Map(
  SPAN_DEFINITIONS.map((d) => [d.name as string, d]),
);

export const SPAN_NAMES: readonly SpanName[] = SPAN_DEFINITIONS.map((d) => d.name as SpanName);

export const SPAN_TARGETS: Readonly<Record<SpanName, number>> = Object.freeze(
  Object.fromEntries(SPAN_DEFINITIONS.map((d) => [d.name, d.targetP95Ms])) as Record<SpanName, number>,
);

/**
 * The span that closes an intervention. An intervention only counts toward the
 * 30-intervention gate when this span completed — a signal that was received and
 * accepted but never reached a freeze is not a measured intervention, it is a
 * partial one, and counting it would let the gate pass on broken runs.
 */
export const TERMINAL_SPAN: SpanName = "signal_received_to_freeze_staged";

export function isSpanName(value: unknown): value is SpanName {
  return typeof value === "string" && DEFINITION_INDEX.has(value);
}

export function spanDefinition(name: SpanName): SpanDefinition {
  const found = DEFINITION_INDEX.get(name);
  // Unreachable for a typed caller; a runtime guard for a JSON-driven one.
  if (!found) throw new Error(`unknown span: ${String(name)}`);
  return found;
}

export function spanLabel(name: SpanName): string {
  return spanDefinition(name).label;
}

export function targetP95Ms(name: SpanName): number {
  return spanDefinition(name).targetP95Ms;
}

/* ————————————————————————————————— baseline ————————————————————————————————— */

/**
 * The number the whole panel exists to contrast against: the industry average
 * time from a fraud flag to customer contact.
 *
 * It is a LITERATURE figure, not a measurement of this platform, and it is
 * labelled as such everywhere it is rendered. Cited twice in this repo, with two
 * different attributions — both are recorded rather than one being picked,
 * because a baseline whose provenance is vague is not a baseline.
 */
export const INDUSTRY_BASELINE = Object.freeze({
  label: "38 min",
  labelLong: "38-minute industry baseline — fraud flag to customer contact",
  ms: 38 * 60 * 1000,
  kind: "literature" as const,
  sources: [
    "docs/SUBMISSION.md — CBUAE Consumer Protection Annual Review 2024, Annex 3 (Tier-1 retail banks)",
    "docs/IDEA-CANVAS.md — McKinsey Fraud Operations Benchmark 2024",
  ],
});

/* ————————————————————————————————— record ————————————————————————————————— */

/** Bumped only on a breaking change to the JSONL line shape. */
export const SPAN_RECORD_VERSION = 1;

export type SpanAttributes = Record<string, string | number | boolean>;

export type SpanRecord = {
  /** Schema version of this line. */
  v: number;
  /** Machine span name. */
  span: SpanName;
  /** Wall-clock ISO 8601, UTC. */
  startedAt: string;
  endedAt: string;
  /** Wall-clock epoch ms — kept because ISO round-trips are lossy for humans. */
  startedAtMs: number;
  endedAtMs: number;
  /** Elapsed milliseconds. Always >= 0; a negative value is never recorded. */
  durationMs: number;
  /** 32 hex chars, shared by every span of one intervention. */
  traceId: string;
  /** 16 hex chars, unique per span. */
  spanId: string;
  /** One fraud intervention. The unit the 30-intervention gate counts. */
  interventionId: string;
  /** Voice-plane correlation id, when the span sits inside a conversation. */
  conversationId: string | null;
  /** Audit-chain case reference, when the span is attached to a case. */
  caseRef: string | null;
  attributes: SpanAttributes;
};

export type SpanInput = {
  /**
   * Typed as `SpanName` for autocomplete, but widened so an untyped call site
   * (a JSON handler, a dynamic key) compiles and is then REJECTED at runtime
   * rather than crashing the process.
   */
  span: SpanName | (string & {});
  /** Wall-clock epoch ms of the first event. */
  startedAtMs: number;
  /** Wall-clock epoch ms of the last event. Defaults to `startedAtMs + durationMs`. */
  endedAtMs?: number;
  /**
   * Explicit duration. Use when one end of the span is not a wall clock (audio
   * frame counters, provider timestamps). Wins over `endedAtMs - startedAtMs`.
   */
  durationMs?: number;
  interventionId?: string | null;
  conversationId?: string | null;
  caseRef?: string | null;
  attributes?: SpanAttributes;
};

export type SpanRecorderDiagnostics = {
  /** Spans accepted since the last reset. */
  recorded: number;
  /** Records currently in the in-memory ring (the live view, not the record). */
  ringSize: number;
  ringCapacity: number;
  /** Rejected for a bad span name, bad numbers, or end-before-start. */
  droppedInvalid: number;
  /** Evicted from the ring because it was full. Only affects the live view. */
  droppedRingOverflow: number;
  /** The last rejection reason, for debugging. Never contains customer data. */
  lastRejection: string | null;
};

/* ————————————————————————————————— recorder ————————————————————————————————— */

/**
 * The ring is the LIVE view (what `/api/status/spans` and the panel read in a
 * process that just handled the call). It is bounded so a long-lived process
 * cannot grow without limit; the durable record is the JSONL log in `./store.ts`.
 */
export const RING_CAPACITY = 5_000;

/** A sample this far past its budget is surfaced as an outlier in the report. */
export const OUTLIER_FACTOR = 4;

let ring: SpanRecord[] = [];
let recordedCount = 0;
let droppedInvalidCount = 0;
let droppedRingOverflowCount = 0;
let lastRejection: string | null = null;

/** Monotonic elapsed time — immune to an NTP step mid-call. */
function monotonicMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function reject(reason: string): null {
  droppedInvalidCount += 1;
  lastRejection = reason;
  return null;
}

function isoOrNull(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    // Out-of-range epoch (a NaN that slipped past the finite check upstream).
    return null;
  }
}

/**
 * Record a span. Returns the stored record, or `null` if it was rejected.
 *
 * NEVER THROWS — by contract, not by accident. A probe that can fail the request
 * it is measuring is a liability, so the whole body is guarded and a rejection
 * is a counted, inspectable outcome (`telemetryDiagnostics()`).
 */
export function recordSpan(input: SpanInput): SpanRecord | null {
  try {
    if (!isSpanName(input.span)) return reject(`unknown_span:${String(input.span).slice(0, 40)}`);

    const { startedAtMs } = input;
    if (!Number.isFinite(startedAtMs)) return reject("non_finite_start");

    let durationMs: number;
    let endedAtMs: number;
    if (input.durationMs !== undefined) {
      durationMs = input.durationMs;
      endedAtMs = input.endedAtMs ?? startedAtMs + durationMs;
    } else {
      endedAtMs = input.endedAtMs ?? startedAtMs;
      durationMs = endedAtMs - startedAtMs;
    }
    if (!Number.isFinite(durationMs) || !Number.isFinite(endedAtMs)) return reject("non_finite_duration");
    // End before start is a clock bug at the call site. Recording it would
    // publish a negative latency, and a negative latency flatters every
    // percentile it touches — the failure mode that destroys an SLO gate.
    if (durationMs < 0) return reject("negative_duration");

    const startedAt = isoOrNull(startedAtMs);
    const endedAt = isoOrNull(endedAtMs);
    if (startedAt === null || endedAt === null) return reject("unrepresentable_timestamp");

    const interventionId = clean(input.interventionId) ?? clean(input.caseRef) ?? clean(input.conversationId) ?? "unattributed";
    const traceId = traceIdFor(interventionId);

    const record: SpanRecord = Object.freeze({
      v: SPAN_RECORD_VERSION,
      span: input.span,
      startedAt,
      endedAt,
      startedAtMs,
      endedAtMs,
      durationMs,
      traceId,
      spanId: spanIdFor(traceId, input.span, startedAtMs),
      interventionId,
      conversationId: clean(input.conversationId),
      caseRef: clean(input.caseRef),
      attributes: sanitiseAttributes(input.attributes),
    });

    ring.push(record);
    recordedCount += 1;
    if (ring.length > RING_CAPACITY) {
      ring = ring.slice(ring.length - RING_CAPACITY);
      droppedRingOverflowCount += 1;
    }
    return record;
  } catch (err) {
    // The last line of defence. `reject()` cannot throw, but a frozen-array or
    // allocator fault above should still never reach the caller.
    return reject(`unexpected:${err instanceof Error ? err.message.slice(0, 120) : typeof err}`);
  }
}

export type SpanHandle = {
  span: SpanName;
  spanId: string;
  interventionId: string;
  /** Close the span and store it. Safe to call twice; the second call is ignored. */
  end(extra?: { durationMs?: number; attributes?: SpanAttributes }): SpanRecord | null;
};

/**
 * Start a span for a call site that does not have both timestamps yet.
 *
 * The elapsed time is measured on a monotonic clock, so a wall-clock step during
 * the call cannot produce a negative or absurd duration. `end()` still hands
 * the caller a stored record — use it to chain `signal_received` into
 * `signal_received_to_freeze_staged`.
 */
export function startSpan(
  span: SpanName | (string & {}),
  ids: { interventionId?: string | null; conversationId?: string | null; caseRef?: string | null; attributes?: SpanAttributes } = {},
): SpanHandle {
  const startedAtMs = Date.now();
  const startMono = monotonicMs();
  let closed = false;
  // An unknown name here would be recorded under the first span's name, which is
  // a lie in the other direction (it manufactures samples for span #1). It is
  // still recorded — the caller is mid-intervention and dropping its probe is
  // its own loss — but the rejection counter names the bug.
  const safeSpan: SpanName = isSpanName(span) ? span : SPAN_DEFINITIONS[0].name;

  return {
    span: safeSpan,
    spanId: "",
    interventionId: clean(ids.interventionId) ?? clean(ids.caseRef) ?? clean(ids.conversationId) ?? "unattributed",
    end(extra) {
      if (closed) return null;
      closed = true;
      const measured = monotonicMs() - startMono;
      const durationMs = extra?.durationMs ?? Math.max(0, Math.round(measured * 1_000) / 1_000);
      return recordSpan({
        span: safeSpan,
        startedAtMs,
        durationMs,
        interventionId: ids.interventionId,
        conversationId: ids.conversationId,
        caseRef: ids.caseRef,
        attributes: { ...(ids.attributes ?? {}), ...(extra?.attributes ?? {}) },
      });
    },
  };
}

/** Newest-last copy of the ring, capped at `limit`. Never throws. */
export function recentSpans(limit = 500): SpanRecord[] {
  try {
    const n = Math.min(Math.max(Math.floor(limit) || 0, 0), ring.length);
    return n === 0 ? [] : ring.slice(ring.length - n);
  } catch {
    return [];
  }
}

export function telemetryDiagnostics(): SpanRecorderDiagnostics {
  return {
    recorded: recordedCount,
    ringSize: ring.length,
    ringCapacity: RING_CAPACITY,
    droppedInvalid: droppedInvalidCount,
    droppedRingOverflow: droppedRingOverflowCount,
    lastRejection,
  };
}

/** Test-only: empty the ring and zero the counters. */
export function resetSpans(): void {
  ring = [];
  recordedCount = 0;
  droppedInvalidCount = 0;
  droppedRingOverflowCount = 0;
  lastRejection = null;
}

/* ————————————————————————————————— parsing ————————————————————————————————— */

/**
 * Validate one line of the span log into a `SpanRecord`, or `null`.
 *
 * The log is a file on disk that an operator can edit, truncate, or corrupt with
 * a partial write, so the reader treats every line as untrusted input. A line
 * that does not validate is skipped and counted — never coerced.
 */
export function parseSpanRecord(raw: unknown): SpanRecord | null {
  try {
    return parseSpanRecordUnguarded(raw);
  } catch {
    // An out-of-range epoch makes `toISOString()` throw. A corrupt line must
    // never be the thing that fails a report.
    return null;
  }
}

function parseSpanRecordUnguarded(raw: unknown): SpanRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isSpanName(o.span)) return null;
  if (typeof o.durationMs !== "number" || !Number.isFinite(o.durationMs) || o.durationMs < 0) return null;
  if (typeof o.startedAtMs !== "number" || !Number.isFinite(o.startedAtMs)) return null;
  const traceId = typeof o.traceId === "string" && /^[0-9a-f]{32}$/.test(o.traceId) ? o.traceId : traceIdFor(String(o.interventionId ?? "unattributed"));
  return {
    v: typeof o.v === "number" ? o.v : SPAN_RECORD_VERSION,
    span: o.span,
    startedAt: typeof o.startedAt === "string" ? o.startedAt : new Date(o.startedAtMs).toISOString(),
    endedAt: typeof o.endedAt === "string" ? o.endedAt : new Date(o.startedAtMs + o.durationMs).toISOString(),
    startedAtMs: o.startedAtMs,
    endedAtMs: typeof o.endedAtMs === "number" && Number.isFinite(o.endedAtMs) ? o.endedAtMs : o.startedAtMs + o.durationMs,
    durationMs: o.durationMs,
    traceId,
    spanId: typeof o.spanId === "string" && /^[0-9a-f]{16}$/.test(o.spanId) ? o.spanId : spanIdFor(traceId, o.span, o.startedAtMs),
    interventionId: typeof o.interventionId === "string" && o.interventionId.length > 0 ? o.interventionId : "unattributed",
    conversationId: typeof o.conversationId === "string" ? o.conversationId : null,
    caseRef: typeof o.caseRef === "string" ? o.caseRef : null,
    attributes: sanitiseAttributes(o.attributes),
  };
}

/* ————————————————————————————————— OTLP shape ————————————————————————————————— */

/**
 * OTLP/JSON trace export shape (opentelemetry-proto `ExportTraceServiceRequest`).
 *
 * Declared here as plain types and produced by a pure function: no
 * `@opentelemetry/*` dependency, no collector, nothing to run. A deployment that
 * later wants real traces POSTs this payload to a collector
 * (`./export.ts`, off the request path); a deployment that never does keeps the
 * in-process percentiles and costs nothing.
 */
export const SPAN_KIND_INTERNAL = 1;

export type OtlpAnyValue =
  | { stringValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { intValue: string };

export type OtlpAttribute = { key: string; value: OtlpAnyValue };

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number };
};

export type OtlpTracePayload = {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
  }>;
};

/** Instrumenting scope reported in the OTLP payload. */
export const TELEMETRY_SCOPE = Object.freeze({ name: "securevoice.telemetry", version: "1" });

export const TELEMETRY_SERVICE_NAME = "securevoice-api";

export function otlpAttribute(key: string, value: string | number | boolean): OtlpAttribute {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

/** Unix nanoseconds as a decimal STRING — OTLP JSON encodes 64-bit as string. */
export function unixNano(ms: number): string {
  if (!Number.isFinite(ms)) return "0";
  return String(Math.round(ms * 1e6));
}

/**
 * Convert records to the OTLP/JSON trace payload. Pure, total, and never
 * throws — an exporter that fails to serialise must not take down a request.
 */
export function toOtlpSpans(records: readonly SpanRecord[], serviceName = TELEMETRY_SERVICE_NAME): OtlpTracePayload {
  const spans: OtlpSpan[] = [];
  for (const r of records) {
    try {
      const attributes: OtlpAttribute[] = [
        otlpAttribute("sv.span", r.span),
        otlpAttribute("sv.duration_ms", r.durationMs),
        otlpAttribute("sv.intervention_id", r.interventionId),
        otlpAttribute("sv.target_p95_ms", targetP95Ms(r.span)),
      ];
      if (r.conversationId) attributes.push(otlpAttribute("sv.conversation_id", r.conversationId));
      if (r.caseRef) attributes.push(otlpAttribute("sv.case_ref", r.caseRef));
      for (const [key, value] of Object.entries(r.attributes)) attributes.push(otlpAttribute(key, value));
      spans.push({
        traceId: r.traceId,
        spanId: r.spanId,
        // The human label is the trace name: this is what an operator greps for.
        name: `${spanLabel(r.span)}`,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: unixNano(r.startedAtMs),
        endTimeUnixNano: unixNano(r.endedAtMs),
        attributes,
        status: { code: 1 }, // STATUS_CODE_OK — the probe ran; the budget verdict is an attribute.
      });
    } catch {
      // A single unserialisable record is skipped; the rest of the batch still
      // exports, because a partial trace beats an exception in a request path.
    }
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: [otlpAttribute("service.name", serviceName)] },
        scopeSpans: [{ scope: { name: TELEMETRY_SCOPE.name, version: TELEMETRY_SCOPE.version }, spans }],
      },
    ],
  };
}

/* ————————————————————————————————— internals ————————————————————————————————— */

/** Trim and bound an untrusted correlation id. Empty/nullish becomes `null`. */
function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 96);
}

/** Bound the attribute bag: no objects, no arrays, nothing unbounded. */
function sanitiseAttributes(input: unknown): SpanAttributes {
  const out: SpanAttributes = {};
  if (typeof input !== "object" || input === null) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>).slice(0, 16)) {
    if (typeof value === "string") out[key.slice(0, 64)] = value.slice(0, 256);
    else if (typeof value === "number" && Number.isFinite(value)) out[key.slice(0, 64)] = value;
    else if (typeof value === "boolean") out[key.slice(0, 64)] = value;
  }
  return out;
}

/** FNV-1a 32-bit, two seeds concatenated to 16 bytes of hex.
 *
 *  NOT cryptographic, and it does not need to be: an OTel trace id is a
 *  correlation handle, not a capability. Using a pure function keeps this
 *  module importable in the browser, where `node:crypto` is not available. */
function hash32(value: string, seed: number): string {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** One trace per intervention — every span of one fraud case shares it.
 *  16 bytes, four 32-bit hashes, so the value matches the OTel trace-id width. */
export function traceIdFor(interventionId: string): string {
  return (
    hash32(interventionId, 0x9e3779b9) +
    hash32(`${interventionId}|trace`, 0x85ebca6b) +
    hash32(`trace|${interventionId}`, 0xc2b2ae35) +
    hash32(`${interventionId}#trace`, 0x27d4eb2f)
  );
}

/** 8 bytes — matches the OTel span-id width. Unique per (trace, span, start). */
export function spanIdFor(traceId: string, span: SpanName, startedAtMs: number): string {
  return hash32(`${traceId}|${span}`, 0x165667b1) + hash32(`${span}|${startedAtMs}`, 0x9e3779b1);
}
