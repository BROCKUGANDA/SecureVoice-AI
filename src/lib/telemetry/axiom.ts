import "server-only";
/**
 * Axiom log shipping — the remote sink for the structured logger (WP-22b).
 *
 * `src/lib/validation/safe-log.ts` renders one sanitised, single-line record per
 * `safeLog()` call and hands it to a sink. Its default sink is `console.*`, so a
 * deployment with no log backend still has a truthful stdout stream. This module
 * is the OTHER sink: it takes the same `LogRecord` and ships it to Axiom over the
 * official `@axiomhq/js` client, which batches in the background.
 *
 * ── Why the wiring runs through a registry, not a direct import ──────────────
 *
 * `safe-log.ts` is imported by `src/proxy.ts` (the edge middleware) and by
 * `src/lib/languages.ts`, which the browser bundle pulls in. It therefore must
 * stay free of `server-only` and of any Node-only dependency. `@axiomhq/js` is
 * both. So `safe-log.ts` exposes a dependency-free `registerLogSink()` extension
 * point and knows nothing about Axiom; `src/instrumentation.ts` — the Node-only
 * server entry — imports THIS module and registers `axiomLogSink` at boot.
 * Nothing Axiom-shaped can reach the edge or the client bundle.
 *
 * ── Three rules, the same three safe-log holds itself to ─────────────────────
 *
 *   1. **Shipping must never throw and must never block.** `axiomLogSink` is
 *      called synchronously from the log path. It hands the record to the
 *      client's queue and returns; the network write happens off-path. A log
 *      backend that can fail the request that was logging is a liability.
 *   2. **Unconfigured is a no-op, not an error.** With `AXIOM_TOKEN` unset the
 *      sink does nothing and the console sink still runs — a self-hosted box
 *      with no Axiom account boots and logs normally.
 *   3. **No credential in source.** The token is read from `process.env` only.
 *      A published token in a repository is a credential published to everyone
 *      who can read the repository.
 */

import { Axiom } from "@axiomhq/js";

import type { LogRecord, LogSink } from "@/lib/validation/safe-log";

/* ————————————————————————————————— configuration ————————————————————————————————— */

/**
 * The dataset the platform's log events land in. Matches the ingestion endpoint
 * the deployment was provisioned with (`/v1/datasets/securevoice/ingest`).
 * Override with `AXIOM_DATASET` to ship into a different dataset without a
 * rebuild.
 */
export const AXIOM_DEFAULT_DATASET = "securevoice";

export function axiomDataset(): string {
  const configured = process.env.AXIOM_DATASET?.trim();
  return configured && configured.length > 0 ? configured : AXIOM_DEFAULT_DATASET;
}

/** The API/personal token, trimmed. `null` when unset or blank. */
function axiomToken(): string | null {
  const token = process.env.AXIOM_TOKEN?.trim();
  return token && token.length > 0 ? token : null;
}

/** True when this process is configured to ship logs to Axiom. */
export function axiomConfigured(): boolean {
  return axiomToken() !== null;
}

/* ————————————————————————————————— client ————————————————————————————————— */

/**
 * Lazily-constructed shared client. Constructing it eagerly at module load would
 * allocate a batching queue (and a timer) in every process that merely imports
 * this module, including test runs with no token set.
 */
let client: Axiom | null = null;
let clientResolved = false;

function axiomClient(): Axiom | null {
  if (clientResolved) return client;
  clientResolved = true;
  const token = axiomToken();
  if (token === null) return null;
  try {
    // `url` overrides the API base (default https://api.axiom.co) so a proxy or
    // a regional endpoint is a config change, not a rebuild.
    const url = process.env.AXIOM_URL?.trim();
    client = url && url.length > 0 ? new Axiom({ token, url }) : new Axiom({ token });
  } catch (err) {
    // A malformed URL, a bad option: the process must still boot and still log
    // to stdout. The failure is counted and named, not swallowed.
    shipErrorCount += 1;
    lastError = normaliseError(err);
    client = null;
  }
  return client;
}

/* ————————————————————————————————— diagnostics ————————————————————————————————— */

export type AxiomDiagnostics = {
  /** True when AXIOM_TOKEN is set for this process. */
  configured: boolean;
  /** Dataset events are ingested into. */
  dataset: string;
  /** True once a client has actually been constructed. */
  clientReady: boolean;
  /** Events handed to the client's queue since the last reset. */
  shipped: number;
  /** Failures to hand an event over (construction or ingest). */
  shipErrors: number;
  /** The last failure, bounded. Never contains a token or customer data. */
  lastError: string | null;
};

let shippedCount = 0;
let shipErrorCount = 0;
let lastError: string | null = null;

function normaliseError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.slice(0, 200);
}

export function axiomDiagnostics(): AxiomDiagnostics {
  return {
    configured: axiomConfigured(),
    dataset: axiomDataset(),
    clientReady: client !== null,
    shipped: shippedCount,
    shipErrors: shipErrorCount,
    lastError,
  };
}

/** Test-only: drop the client and zero the counters, so a token change is seen. */
export function resetAxiomState(): void {
  client = null;
  clientResolved = false;
  shippedCount = 0;
  shipErrorCount = 0;
  lastError = null;
}

/* ————————————————————————————————— shipping ————————————————————————————————— */

/**
 * Ship one structured log record to Axiom. Fire-and-forget, total, never throws.
 *
 * The record's `fields` are spread FIRST so the transport's own control keys
 * (`level`, `msg`, `ts`, `_time`) cannot be clobbered by a field that happens to
 * share a name — the level of a log line is not something a caller-supplied
 * field should be able to rewrite. `fields` are already sanitised and redacted
 * by `safe-log` before they reach here.
 *
 * `_time` is set explicitly: it is the field Axiom orders on, and letting the
 * server's receipt time stand in for the emit time would smear an incident's
 * timeline by the batching delay.
 */
export function shipLogRecord(record: LogRecord): void {
  try {
    const c = axiomClient();
    if (c === null) return;
    c.ingest(axiomDataset(), {
      ...record.fields,
      level: record.level,
      msg: record.msg,
      ts: record.ts,
      _time: record.ts,
    });
    shippedCount += 1;
  } catch (err) {
    // The contract that matters most: a log call must not fail because the log
    // backend did. Counted so the failure is visible in `/api/status` rather
    // than silent.
    shipErrorCount += 1;
    lastError = normaliseError(err);
  }
}

/**
 * The `LogSink` registered with `safe-log` at server boot
 * (`src/instrumentation.ts`). Matches the sink signature exactly: the level and
 * rendered line are already carried inside the record, so only the record is
 * used.
 */
export const axiomLogSink: LogSink = (_level, _line, record) => {
  shipLogRecord(record);
};

/**
 * Flush every queued event. The client batches on a timer, so a process that
 * exits immediately after logging can drop the tail of its output; call this
 * before exit when the delivery guarantee matters (a deploy, a test assertion).
 *
 * Never throws — resolves even when the flush fails.
 */
export async function flushAxiom(): Promise<void> {
  const c = axiomClient();
  if (c === null) return;
  try {
    await c.flush();
  } catch (err) {
    shipErrorCount += 1;
    lastError = normaliseError(err);
  }
}
