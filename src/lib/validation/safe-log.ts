/**
 * Structured logging that a newline in user input cannot turn into a forged log
 * line (WP-22).
 *
 * Log injection is not a theoretical finding. A merchant name of
 * `"Cafe\n[audit] action=card_freeze approved_by=root"` writes TWO lines into a
 * plain-text log. Everything downstream of that log — grep, a SIEM rule, a
 * human skimming at 3am, a compliance export a regulator reads — now contains a
 * record that our application never emitted. Log integrity is evidence
 * integrity once a case is disputed, and this is a fraud platform.
 *
 * The design makes the attack structurally impossible rather than filtered:
 *
 *   1. LOG MESSAGE AND DATA ARE SEPARATE. `safeLog(level, msg, fields)` takes a
 *      static message template and a fields object. There is no third argument
 *      for "the user's string", so the ergonomic path is to put user data in a
 *      field where it gets sanitised. Concatenating user input into a message
 *      is not a supported usage, because it is not expressible as one.
 *   2. EVERY STRING IS STRIPPED OF LINE TERMINATORS AND CONTROL CHARACTERS.
 *      That includes U+2028 and U+2029 — `JSON.stringify` does NOT escape
 *      those, and several log viewers and JavaScript consumers treat them as
 *      newlines, so escaping alone is not enough.
 *   3. THE OUTPUT IS ONE LINE BY CONSTRUCTION. `renderLogLine` serialises to
 *      JSON, in which a newline is `\n` — two characters, not a line break —
 *      and then applies a final defensive pass that folds any residual CR/LF.
 *      One call in, one physical line out.
 *
 * Values are also redacted with `@/lib/redact` before they are written, so a
 * PAN or IBP typed into a "notes" field does not become a durable copy in the
 * log aggregator.
 */

import { transcript as redactText } from "@/lib/redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  msg: string;
  ts: string;
  fields: Record<string, unknown>;
}

export interface LogLimits {
  /** Maximum entries in a field object or array. Default 20. */
  maxEntries?: number;
  /** Maximum characters in a single string value. Default 512. */
  maxStringLength?: number;
  /** Maximum container nesting depth. Default 4. */
  maxDepth?: number;
}

/**
 * Defaults, typed as `number` rather than as literal types so the `max*`
 * parameters below stay overridable with any caller-supplied number.
 */
export const LOG_LIMITS: Required<LogLimits> & { maxMessages: number } = {
  maxEntries: 20,
  maxStringLength: 512,
  maxDepth: 4,
  maxMessages: 200,
};

/**
 * Everything that can terminate a line in a text log, in any consumer. A run
 * of them collapses to ONE space so "a\r\nb" reads as "a b" rather than "a  b".
 */
const LINE_BREAKS_RE = /[\r\n\u2028\u2029\u0085\u000B\u000C]+/g;
/** Remaining C0/C1 controls, plus the invisible reordering set. */
const CONTROLS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
/** Keys that must never appear in a sanitised object. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Strip every character that could end or disguise a line in a log sink. */
export function sanitiseLogString(input: string, maxLength = LOG_LIMITS.maxStringLength): string {
  let out = input.replace(LINE_BREAKS_RE, " ").replace(CONTROLS_RE, "");
  if (out.length > maxLength) out = out.slice(0, maxLength);
  return out;
}

/**
 * Recursively make a value safe to log: bounded depth, bounded collection size,
 * bounded strings, PII redacted. Anything that cannot be represented safely
 * becomes an explicit marker rather than being dropped silently, so a reader
 * can tell "the field was absent" from "the field was a function".
 */
export function sanitiseLogValue(value: unknown, depth = 0, limits: LogLimits = {}): unknown {
  const maxEntries = limits.maxEntries ?? LOG_LIMITS.maxEntries;
  const maxStringLength = limits.maxStringLength ?? LOG_LIMITS.maxStringLength;
  const maxDepth = limits.maxDepth ?? LOG_LIMITS.maxDepth;

  if (value === null || value === undefined) return null;
  if (depth > maxDepth) return "[max depth]";

  switch (typeof value) {
    case "string":
      return sanitiseLogString(redactText(value), maxStringLength);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
    case "function":
      return "[unserialisable]";
    default:
      break;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : "[invalid date]";
  }
  if (value instanceof Error) {
    // The message can quote a provider, database or tool error that carries a
    // PAN, transcript fragment or credential; redact it like any other string
    // before it becomes a durable log copy.
    return sanitiseLogString(redactText(`${value.name}: ${value.message}`), maxStringLength);
  }

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, maxEntries)
      .map((item) => sanitiseLogValue(item, depth + 1, limits));
    if (value.length > maxEntries) kept.push(`[+${value.length - maxEntries} more]`);
    return kept;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return sanitiseLogString(String(value), maxStringLength);
  }

  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (n >= maxEntries) {
      out["[truncated]"] = true;
      break;
    }
    out[sanitiseLogString(key, 64)] = sanitiseLogValue(child, depth + 1, limits);
    n += 1;
  }
  return out;
}

/** Sanitise a field bag. Field names are sanitised too — they come from code, but a mapping key does not. */
export function sanitiseLogFields(
  fields: Record<string, unknown> | undefined,
  limits: LogLimits = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    out[sanitiseLogString(key, 64)] = sanitiseLogValue(value, 0, limits);
  }
  return out;
}

/**
 * Render a record as exactly one physical line.
 *
 * `JSON.stringify` already escapes CR and LF inside strings, so this is one
 * line by construction. The trailing replace is a belt-and-braces pass for a
 * value that reached the sink through some path this function did not model —
 * cheap, and it makes the invariant unconditional.
 */
export function renderLogLine(record: LogRecord): string {
  const line = JSON.stringify(record);
  return line.replace(LINE_BREAKS_RE, " ");
}

export type LogSink = (level: LogLevel, line: string) => void;

/** Default sink: one `console.*` call per record, so the line count is preserved. */
const consoleSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

/**
 * Emit one structured log record.
 *
 * @param level   Severity.
 * @param msg     A STATIC message template — a literal or a constant, never a
 *                concatenation of request data. User data belongs in `fields`,
 *                where it is redacted, bounded and stripped of line breaks.
 * @param fields  Structured context. Sanitised; capped.
 * @param sink    Destination. Defaults to one `console.*` call per record.
 * @returns       The rendered line, so a caller can assert on it or hand it to
 *                a log store directly.
 */
export function safeLog(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
  sink: LogSink = consoleSink,
): string {
  const record: LogRecord = {
    level,
    msg: sanitiseLogString(typeof msg === "string" ? msg : String(msg)),
    ts: new Date().toISOString(),
    fields: sanitiseLogFields(fields),
  };
  const line = renderLogLine(record);
  sink(level, line);
  return line;
}

/** Convenience wrappers — the level is the only difference. */
export const logInfo = (msg: string, fields?: Record<string, unknown>, sink?: LogSink) =>
  safeLog("info", msg, fields, sink);
export const logWarn = (msg: string, fields?: Record<string, unknown>, sink?: LogSink) =>
  safeLog("warn", msg, fields, sink);
export const logError = (msg: string, fields?: Record<string, unknown>, sink?: LogSink) =>
  safeLog("error", msg, fields, sink);
