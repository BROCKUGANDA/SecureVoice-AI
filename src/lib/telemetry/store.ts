import "server-only";
/**
 * WP-7 — durable span storage.
 *
 * ## Where spans live, and why it is a file
 *
 * `prisma/schema.prisma` is owned by another work package and adding a table
 * here would have meant either editing it or shipping spans that nothing can
 * read. So the record of truth is an append-only JSONL file:
 *
 *     evidence/latency/spans.jsonl        (override: TELEMETRY_SPAN_LOG)
 *
 * **What this costs, stated plainly.** The store is per-process local disk: it
 * is not shared between app instances, it is lost on container restart unless
 * `evidence/` is a mounted volume, it has no retention policy, and it is not
 * queryable by anything except this module and `scripts/emit-slo.ts`. It is the
 * right shape for a *local evidence log* and the wrong shape for a *metrics
 * backend*. Every artifact this module feeds therefore publishes its `path` and
 * reads back, so nobody has to guess whether a number is global or local.
 *
 * ## Why nothing here is on the request path
 *
 * `recordSpanAndPersist` appends to an in-memory queue and returns. A debounced
 * timer does the `writeFile` afterwards, off the path, with an `unref`ed timer
 * so a pending flush cannot hold the process open. A failed write increments
 * `persistErrors` and is reported in diagnostics; it is never thrown, because a
 * full disk must not stop a customer being warned about a fraudulent card.
 */

import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { env } from "../config";
import {
  parseSpanRecord,
  recordSpan,
  type SpanInput,
  type SpanRecord,
  type SpanRecorderDiagnostics,
  telemetryDiagnostics,
} from "./spans";

/** Debounce so one intervention's eight spans land in a single append. */
const FLUSH_DEBOUNCE_MS = env.telemetryFlushDebounceMs;

/** Bounded queue: a stalled disk drops the tail rather than the heap. */
const PENDING_MAX = 10_000;

/** Tail read cap — the log is append-only, so only the tail is ever interesting. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

export function spanLogPath(): string {
  const configured = process.env.TELEMETRY_SPAN_LOG;
  if (typeof configured === "string" && configured.trim().length > 0)
    return resolve(configured.trim());
  return resolve(join(process.cwd(), "evidence", "latency", "spans.jsonl"));
}

/**
 * The log path as it should appear in a COMMITTED artifact.
 *
 * An absolute path leaks the operator's home directory and username into
 * `evidence/`, which is read by bank reviewers and pasted into tickets. Paths
 * inside the working directory are published relative to it; anything outside
 * (a mounted volume, /var/log) is left absolute because a reader genuinely needs
 * it to find the file.
 */
export function spanLogDisplayPath(): string {
  const path = spanLogPath();
  const cwd = resolve(process.cwd() /*turbopackIgnore: true*/);
  if (path.length > cwd.length && path.slice(0, cwd.length).toLowerCase() === cwd.toLowerCase()) {
    const rest = path.slice(cwd.length).replace(/^[\\/]+/, "");
    if (rest.length > 0) return rest;
  }
  return path;
}

export type StoreDiagnostics = {
  path: string;
  pending: number;
  persisted: number;
  persistErrors: number;
  lastError: string | null;
};

let pending: SpanRecord[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
let persistedCount = 0;
let persistErrorCount = 0;
let lastError: string | null = null;

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushSpans();
  }, FLUSH_DEBOUNCE_MS);
  // Never keep the event loop alive for a telemetry flush.
  timer.unref?.();
}

/**
 * Write queued spans. Serialised through a promise chain so two flushes can
 * never interleave partial lines, and total: it resolves even when the disk is
 * full, because the caller is a request path that already returned.
 */
export function flushSpans(): Promise<void> {
  const run = async (): Promise<void> => {
    const batch = pending.splice(0, PENDING_MAX);
    if (batch.length === 0) return;
    try {
      const path = spanLogPath();
      await mkdir(dirname(path), { recursive: true });
      // One line per span. No pretty-printing: the file is read far more often
      // than it is read by a human, and JSON.parse per line is the fast path.
      const body = `${batch.map((r) => JSON.stringify(r)).join("\n")}\n`;
      await appendFile(path, body, "utf8");
      persistedCount += batch.length;
    } catch (err) {
      persistErrorCount += 1;
      lastError = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    }
  };
  chain = chain.then(run, run);
  return chain;
}

/**
 * Record a span and queue its durable copy. Returns exactly what `recordSpan`
 * returned (`null` for a rejected sample), so a call site can assert on it in a
 * test without a second API to learn.
 */
export function recordSpanAndPersist(input: SpanInput): SpanRecord | null {
  const record = recordSpan(input);
  if (record === null) return null;
  if (pending.length >= PENDING_MAX) {
    // Bounded on purpose. The in-memory ring still holds the record, so the live
    // panel keeps working; only the durable copy is lost, and that is counted.
    persistErrorCount += 1;
    lastError = "pending_queue_overflow";
    return record;
  }
  pending.push(record);
  schedule();
  return record;
}

/** Test/script helper: force everything out now. */
export async function flushSpansNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flushSpans();
  await chain;
}

export function storeDiagnostics(): StoreDiagnostics {
  return {
    path: spanLogPath(),
    pending: pending.length,
    persisted: persistedCount,
    persistErrors: persistErrorCount,
    lastError,
  };
}

/** Test-only: forget queue and counters. Does NOT touch the file. */
export function resetStoreState(): void {
  pending = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  persistedCount = 0;
  persistErrorCount = 0;
  lastError = null;
  chain = Promise.resolve();
}

export type SpanReadResult = {
  records: SpanRecord[];
  path: string;
  /** Lines that failed validation. Non-zero means the log was edited or cut. */
  malformedLines: number;
  /** True when the log is larger than the tail cap and older lines were skipped. */
  truncated: boolean;
  bytesRead: number;
  /** True when the log does not exist yet — no spans have ever been recorded. */
  missing: boolean;
  /** Set when the read itself failed (permissions, I/O). `records` is then []. */
  error: string | null;
};

export type ReadOptions = {
  /** Keep at most this many records (newest first, then re-sorted oldest-first). */
  limit?: number;
  /** Keep only the newest `interventions` distinct intervention ids. */
  interventions?: number;
};

/**
 * Read recorded spans back. NEVER THROWS — a missing file, an unreadable file
 * and a corrupt file all resolve to an empty result plus a reason, because a
 * report that cannot say "I read nothing" is a report that guesses.
 */
export async function readSpanRecords(options: ReadOptions = {}): Promise<SpanReadResult> {
  const path = spanLogPath();
  const base: SpanReadResult = {
    records: [],
    path,
    malformedLines: 0,
    truncated: false,
    bytesRead: 0,
    missing: false,
    error: null,
  };

  let text: string;
  let truncated = false;
  let bytesRead = 0;
  try {
    const info = await stat(path /*turbopackIgnore: true*/);
    if (!info.isFile()) return { ...base, error: "not_a_file" };
    const start = Math.max(0, info.size - MAX_READ_BYTES);
    truncated = start > 0;
    const handle = await open(path, "r" /*turbopackIgnore: true*/);
    try {
      const length = info.size - start;
      const buffer = Buffer.alloc(length);
      const { bytesRead: read } = await handle.read(buffer, 0, length, start);
      bytesRead = read;
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...base, missing: true };
    return {
      ...base,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }

  const lines = text.split("\n");
  // A tail read can begin mid-line: the first fragment is a partial record, not
  // a malformed one, and dropping it silently would undercount.
  const startIndex = truncated ? (lines[0]?.includes("}") ? 1 : 0) : 0;

  const parsed: SpanRecord[] = [];
  let malformedLines = 0;
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const record = parseSpanRecord(raw);
    if (record === null) malformedLines += 1;
    else parsed.push(record);
  }

  let records = parsed;
  if (options.interventions !== undefined && options.interventions > 0) {
    const keep = new Set<string>();
    for (let i = parsed.length - 1; i >= 0 && keep.size < options.interventions; i--) {
      const r = parsed[i];
      if (r) keep.add(r.interventionId);
    }
    records = parsed.filter((r) => keep.has(r.interventionId));
  }
  if (options.limit !== undefined && options.limit > 0 && records.length > options.limit) {
    records = records.slice(records.length - options.limit);
  }

  return { ...base, records, malformedLines, truncated, bytesRead };
}

export type RecorderAndStore = { recorder: SpanRecorderDiagnostics; store: StoreDiagnostics };

/** Everything an operator needs to know about whether the numbers are real. */
export function telemetryHealth(): RecorderAndStore {
  return { recorder: telemetryDiagnostics(), store: storeDiagnostics() };
}
