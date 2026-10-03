import "server-only";
/**
 * The database failure matrix (WP-21), one handler per row, each declared in the
 * module docstring below and each PURE.
 *
 * ── The matrix ───────────────────────────────────────────────────────────────
 *
 *   | Condition                | Declared behaviour                                             |
 *   |--------------------------|----------------------------------------------------------------|
 *   | Pool exhausted           | Shed with 503 + Retry-After; never queue behind a connection    |
 *   | Statement timeout        | Typed timeout; the request is abandoned, never hangs            |
 *   | Deadlock (40P01)         | Retry the transaction up to three times, with jitter            |
 *   | Serialisation (40001)    | Same retry path                                                  |
 *   | Unique violation (23505) | Idempotency replay, else a typed 409 — never a 500              |
 *   | Foreign key (23503)      | 409 naming the field                                            |
 *   | Primary unreachable      | Read-only degraded mode: reads served, interventions REFUSED     |
 *   | Replica lag              | Fail reads back to primary, or carry a staleness banner          |
 *   | Disk / WAL above 70%     | Alert, and the audit chain is never the write that fails         |
 *
 * ── Why "pure, injectable" ───────────────────────────────────────────────────
 *
 * Every handler takes the error as DATA. Nothing here opens a connection, reads
 * a clock (unless given one) or waits on anything (unless given a `sleep`), so
 * the whole matrix is driven by a synthetic error in `tests/chaos/chaos.test.ts`
 * and the gate never has to break a real database to prove a behaviour. Where a
 * behaviour needs a side effect — a retry, an idempotency lookup, an alert — the
 * side effect is an injected function the test supplies and counts.
 *
 * ── Why "refuse interventions" is the interesting row ─────────────────────────
 *
 * A fraud platform that loses its primary and keeps accepting risk signals has
 * done the one thing it must never do: it has told a bank it intervened, when
 * it cannot prove it did. Under `read_only` this module answers reads and
 * refuses writes with a typed 409 that names the channel a human should use
 * instead. The refusal is not an error path bolted on at the end — it is the
 * default of `evaluatePrimaryHealth({ mode: "read_only" })`.
 */

import {
  assertFieldName,
  interventionRefused,
  makeFailure,
  rateLimited,
  shedLoad,
  statementTimeout,
  transactionContended,
  uniqueConflict,
  type Failure,
} from "./envelope";

// ── Codes ─────────────────────────────────────────────────────────────────────

/** SQLSTATE classes the matrix keys on. */
export const PG = {
  /** unique_violation */
  UNIQUE_VIOLATION: "23505",
  /** foreign_key_violation */
  FOREIGN_KEY_VIOLATION: "23503",
  /** check_violation — a domain rule, i.e. a 422 rather than a 409. */
  CHECK_VIOLATION: "23514",
  /** deadlock_detected */
  DEADLOCK_DETECTED: "40P01",
  /** serialization_failure */
  SERIALIZATION_FAILURE: "40001",
  /** query_canceled — this is what statement_timeout fires as. */
  QUERY_CANCELED: "57014",
  /** too_many_connections */
  TOO_MANY_CONNECTIONS: "53300",
  /** cannot_connect_now — the server is shutting down / starting up. */
  CANNOT_CONNECT_NOW: "57P03",
  /** admin_shutdown */
  ADMIN_SHUTDOWN: "57P01",
  /** connection_failure */
  CONNECTION_FAILURE: "08006",
  /** connection_does_not_exist */
  CONNECTION_DOES_NOT_EXIST: "08003",
  /** cannot_connect_now, node-level equivalent */
  CONNECTION_REFUSED: "08001",
  /** lock_not_available — statement_timeout on a lock wait. */
  LOCK_NOT_AVAILABLE: "55P03",
  /** disk_full */
  DISK_FULL: "53100",
  /** out_of_memory */
  OUT_OF_MEMORY: "53200",
} as const;

/**
 * Prisma's own codes. Prisma wraps the SQLSTATE and does not always expose it,
 * so each of these is mapped onto the SQLSTATE it stands for. `P2034` is
 * notable: Prisma raises it for "transaction failed or conflicted", which is
 * exactly our retry row.
 */
export const PRISMA = {
  /** Timed out fetching a new connection from the connection pool. */
  POOL_TIMEOUT: "P2024",
  /** Can't reach database server. */
  CANNOT_REACH_SERVER: "P1001",
  /** Unique constraint failed. */
  UNIQUE_CONSTRAINT: "P2002",
  /** Foreign key constraint failed. */
  FOREIGN_KEY_CONSTRAINT: "P2003",
  /** Transaction failed or conflicted. */
  TRANSACTION_CONFLICT: "P2034",
  /** Timed out fetching a new connection / operation timed out. */
  OPERATION_TIMEOUT: "P2028",
  /** An operation failed because it depends on one or more failed operations. */
  DEPENDENT_OPERATION_FAILED: "P2015",
  /** The requested record does not exist. */
  RECORD_NOT_FOUND: "P2025",
} as const;

const PRISMA_TO_PG: Record<string, string> = {
  [PRISMA.POOL_TIMEOUT]: PG.TOO_MANY_CONNECTIONS,
  [PRISMA.CANNOT_REACH_SERVER]: PG.CONNECTION_FAILURE,
  [PRISMA.UNIQUE_CONSTRAINT]: PG.UNIQUE_VIOLATION,
  [PRISMA.FOREIGN_KEY_CONSTRAINT]: PG.FOREIGN_KEY_VIOLATION,
  [PRISMA.TRANSACTION_CONFLICT]: PG.DEADLOCK_DETECTED,
  [PRISMA.OPERATION_TIMEOUT]: PG.QUERY_CANCELED,
};

/**
 * The same mapping expressed as failure kinds.
 *
 * This is consulted BEFORE the SQLSTATE switch, because a Prisma code and a
 * SQLSTATE of the same five characters are indistinguishable on the wire — a
 * `P2034` is "transaction conflicted" to Prisma and nothing at all to Postgres.
 * Resolving it here means no handler has to know which client produced its
 * input, and an unmapped Prisma code falls through to `unknown` rather than
 * being read as a SQLSTATE it is not.
 */
const PRISMA_TO_KIND: Record<string, DatabaseFailureKind> = {
  [PRISMA.POOL_TIMEOUT]: "pool_exhausted",
  [PRISMA.CANNOT_REACH_SERVER]: "primary_unreachable",
  [PRISMA.UNIQUE_CONSTRAINT]: "unique_violation",
  [PRISMA.FOREIGN_KEY_CONSTRAINT]: "foreign_key_violation",
  [PRISMA.TRANSACTION_CONFLICT]: "deadlock",
  [PRISMA.OPERATION_TIMEOUT]: "statement_timeout",
  [PRISMA.RECORD_NOT_FOUND]: "record_not_found",
};

/** Node/driver-level codes with no SQLSTATE. */
const NODE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
]);

/** The timeout that applies when a caller does not name one. */
export const DEFAULT_SHED_RETRY_AFTER_SEC = 2;
/** A lock-wait timeout is a timeout, not a conflict, and says so. */
export const DEFAULT_TIMEOUT_RETRY_AFTER_SEC = 5;

// ── Reading an error without touching it ──────────────────────────────────────

export type DbErrorLike = {
  code?: unknown;
  message?: unknown;
  meta?: unknown;
  name?: unknown;
};

/**
 * The SQLSTATE behind an error, whatever layer it was wrapped in.
 *
 * Prisma puts a `P####` code on `error.code` and hides the SQLSTATE; a raw `pg`
 * error puts the SQLSTATE on `error.code`. Both are read here, once, so no
 * handler has to know which client produced its input.
 */
export function sqlstateOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as DbErrorLike;
  const raw = typeof e.code === "string" ? e.code.trim().toUpperCase() : "";
  if (raw === "") return null;
  if (NODE_NETWORK_CODES.has(raw)) return PG.CONNECTION_FAILURE;
  // A `P####` code is Prisma's, not a SQLSTATE: P0001-style PL/pgSQL raise
  // codes and Prisma's P2034 are indistinguishable here, so we resolve the
  // Prisma ones we know and report nothing for the rest rather than inventing
  // a SQLSTATE.
  if (/^P\d{4}$/.test(raw)) return PRISMA_TO_PG[raw] ?? null;
  if (/^[0-9A-Z]{5}$/.test(raw)) return raw;
  return null;
}

/** The Prisma client code on an error, or null when it did not come from Prisma. */
export function prismaCodeOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as DbErrorLike).code;
  return typeof code === "string" && /^P\d{4}$/.test(code.trim().toUpperCase())
    ? code.trim().toUpperCase()
    : null;
}

function metaOf(err: unknown): Record<string, unknown> {
  if (typeof err !== "object" || err === null) return {};
  const meta = (err as DbErrorLike).meta;
  return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
}

function messageOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const m = (err as DbErrorLike).message;
  return typeof m === "string" ? m : "";
}

/**
 * Quoted identifier candidates, in the order we trust them: an explicit meta
 * field, then the driver's constraint name.
 */
function constraintCandidates(err: unknown): string[] {
  const meta = metaOf(err);
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
  };
  push(meta.constraint);
  push(meta.constraint_name);
  push(meta.field_name);
  const name = (err as { name?: unknown } | null)?.name;
  if (typeof name === "string" && /constraint/i.test(name)) push(name);
  const msg = messageOf(err);
  const quoted = /constraint\s+"([^"]+)"/i.exec(msg);
  if (quoted) push(quoted[1]);
  const onTable = /on\s+table\s+"([^"]+)"/i.exec(msg);
  if (onTable) push(onTable[1]);
  return out;
}

/**
 * Suffixes a generated constraint name ends in. Prisma emits
 * `Model_field_key`, `Model_fieldA_fieldB_key` and `Model_field_fkey`; a driver
 * or a hand-written migration can emit `…_idx` and `…_pkey`.
 */
const CONSTRAINT_SUFFIXES = new Set(["key", "pkey", "fkey", "idx", "index", "uniq", "unique"]);

/**
 * Normalise one column-list token to a bare field name.
 *
 * Three shapes arrive in the wild and all three are accepted: a bare
 * `"idemKey"`, a Prisma compound name `"UsageLedger_orgId_idemKey_key"`, and a
 * generated FK constraint name `"Case_orgId_fkey"`. The middle segment is the
 * field in both compound forms once the constraint suffix is dropped.
 */
function normaliseFieldToken(token: string): string | null {
  const cleaned = token.replace(/[()"'`\s]/g, "");
  if (cleaned === "") return null;
  if (!/^[A-Za-z_][\w]*$/.test(cleaned)) return null;
  const segments = cleaned.split("_");
  if (
    segments.length >= 2 &&
    CONSTRAINT_SUFFIXES.has(segments[segments.length - 1]!.toLowerCase())
  ) {
    // `Case_orgId_fkey` -> [Case, orgId] -> orgId.
    // `UsageLedger_orgId_idemKey_key` -> [.., idemKey] -> idemKey.
    return segments[segments.length - 2]!;
  }
  return cleaned;
}

/**
 * Field names implicated by a violation. Prisma's `meta.target` is
 * `string[]`, a bare `"field"`, or a Prisma-style compound name — all three
 * shapes appear, so all three are normalised to bare field names.
 */
export function fieldsOf(err: unknown): string[] {
  const meta = metaOf(err);
  const out = new Set<string>();
  const push = (v: unknown): void => {
    if (typeof v === "string") {
      for (const part of v.split(",")) {
        const field = normaliseFieldToken(part);
        if (field) out.add(field);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) push(item);
    }
  };
  push(meta.target);
  push(meta.fields);
  push(meta.field_name);

  const msg = messageOf(err);
  const fields = /fields?:\s*\(([^)]*)\)/i.exec(msg);
  if (fields) push(fields[1]);
  // `Key (orgId, caseRef)=(...) is not present in table "Case"` — take the
  // COLUMN LIST only. The values on the right of the `=` are never captured.
  const key = /\bkey\s*\(([^)]*)\)/i.exec(msg);
  if (key) push(key[1]);
  const fk = /foreign key constraint\s+"?([A-Za-z0-9_]+)"?/i.exec(msg);
  if (fk) push(fk[1]);
  return [...out].sort();
}

/**
 * The single FIELD a foreign-key violation implicates. Prisma reports it in
 * `meta.field_name`; the driver only offers a column list and a value, so we
 * take the first column and drop the value on the floor.
 */
export function fieldOf(err: unknown): string | null {
  const meta = metaOf(err);
  const direct = meta.field_name;
  if (typeof direct === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(direct.trim()))
    return direct.trim();
  const all = fieldsOf(err);
  return all.length > 0 ? all[0]! : null;
}

// ── Classification ────────────────────────────────────────────────────────────

export type DatabaseFailureKind =
  | "pool_exhausted"
  | "statement_timeout"
  | "deadlock"
  | "serialization_failure"
  | "unique_violation"
  | "foreign_key_violation"
  | "check_violation"
  | "record_not_found"
  | "primary_unreachable"
  | "storage_full"
  | "not_a_database_error"
  | "unknown";

export type DatabaseClassification = {
  kind: DatabaseFailureKind;
  /** The SQLSTATE we resolved, or null when the layer did not expose one. */
  sqlstate: string | null;
  /** Field names implicated by the violation. Empty for non-row errors. */
  fields: string[];
  /** Driver class, when it helps a human reading the log. Never published. */
  driver: "postgres" | "prisma" | "node" | "unknown";
};

/**
 * Pure classification. Every handler in this module dispatches on the result,
 * so the mapping is stated once and asserted once.
 */
export function classifyDatabaseError(err: unknown): DatabaseClassification {
  const prismaCode = prismaCodeOf(err);
  const sqlstate = sqlstateOf(err);
  const rawCode =
    typeof (err as DbErrorLike | null)?.code === "string"
      ? ((err as DbErrorLike).code as string).toUpperCase()
      : "";
  const driver: DatabaseClassification["driver"] = prismaCode
    ? "prisma"
    : NODE_NETWORK_CODES.has(rawCode)
      ? "node"
      : sqlstate
        ? "postgres"
        : "unknown";

  // 1. Prisma's own vocabulary wins, because it is the layer that hides the
  //    SQLSTATE.
  if (prismaCode && PRISMA_TO_KIND[prismaCode]) {
    const kind = PRISMA_TO_KIND[prismaCode]!;
    return {
      kind,
      sqlstate,
      fields: kind === "unique_violation" || kind === "foreign_key_violation" ? fieldsOf(err) : [],
      driver,
    };
  }

  // 2. Otherwise a raw SQLSTATE.
  const fields = (): string[] => fieldsOf(err);

  switch (sqlstate) {
    case PG.TOO_MANY_CONNECTIONS:
      return { kind: "pool_exhausted", sqlstate, fields: [], driver };
    case PG.QUERY_CANCELED:
    case PG.LOCK_NOT_AVAILABLE:
      // `statement_timeout` cancels the statement, which is indistinguishable
      // from a client-side cancel at the SQLSTATE level. Both are a timeout:
      // neither may become a hanging request.
      return { kind: "statement_timeout", sqlstate, fields: [], driver };
    case PG.DEADLOCK_DETECTED:
      return { kind: "deadlock", sqlstate, fields: [], driver };
    case PG.SERIALIZATION_FAILURE:
      return { kind: "serialization_failure", sqlstate, fields: [], driver };
    case PG.UNIQUE_VIOLATION:
      return { kind: "unique_violation", sqlstate, fields: fields(), driver };
    case PG.FOREIGN_KEY_VIOLATION:
      return { kind: "foreign_key_violation", sqlstate, fields: fields(), driver };
    case PG.CHECK_VIOLATION:
      return { kind: "check_violation", sqlstate, fields: fields(), driver };
    case PG.CONNECTION_FAILURE:
    case PG.CONNECTION_DOES_NOT_EXIST:
    case PG.CONNECTION_REFUSED:
    case PG.CANNOT_CONNECT_NOW:
    case PG.ADMIN_SHUTDOWN:
      return { kind: "primary_unreachable", sqlstate, fields: [], driver };
    case PG.DISK_FULL:
    case PG.OUT_OF_MEMORY:
      return { kind: "storage_full", sqlstate, fields: [], driver };
    default:
      break;
  }

  if (
    err instanceof Error ||
    (typeof err === "object" && err !== null && typeof messageOf(err) === "string")
  ) {
    return { kind: "unknown", sqlstate, fields: [], driver };
  }
  if (err === null || err === undefined || typeof err !== "object") {
    return { kind: "not_a_database_error", sqlstate: null, fields: [], driver: "unknown" };
  }
  return { kind: "unknown", sqlstate, fields: [], driver };
}

/** Only these two are safe to replay: neither one can leave partial state. */
export function isRetryableTransactionConflict(kind: DatabaseFailureKind): boolean {
  return kind === "deadlock" || kind === "serialization_failure";
}

// ── Row: pool exhausted ───────────────────────────────────────────────────────

export type PoolExhaustedDecision = {
  action: "shed";
  failure: Failure;
  retryAfterSec: number;
  /**
   * Always `false`, and the type says so. The declared behaviour is "do not
   * queue indefinitely behind a connection" — a caller that wants to wait must
   * opt in elsewhere with its own budget, not by accident here.
   */
  queuedBehindConnection: false;
  sqlstate: string | null;
  /** Hard ceiling the handler is willing to recommend waiting for, in ms. */
  maxWaitMsRecommended: 0;
};

/**
 * Pool exhausted → shed.
 *
 * The tempting behaviour is to wait for a connection to free up. It is wrong
 * here: the request is already inside its latency budget, a request that waits
 * for a connection returns whatever the connection was doing, and the whole
 * point of a co-located pool is that waiting on it cannot help. So we shed with
 * a Retry-After the client can honour.
 */
export function handlePoolExhausted(input: {
  err: unknown;
  requestId?: string | null;
  retryAfterSec?: number;
}): PoolExhaustedDecision {
  const classification = classifyDatabaseError(input.err);
  const retryAfterSec = input.retryAfterSec ?? DEFAULT_SHED_RETRY_AFTER_SEC;
  return {
    action: "shed",
    failure: shedLoad(retryAfterSec, { requestId: input.requestId }),
    retryAfterSec,
    queuedBehindConnection: false,
    sqlstate: classification.sqlstate,
    maxWaitMsRecommended: 0,
  };
}

// ── Row: statement timeout ────────────────────────────────────────────────────

export type StatementTimeoutDecision = {
  action: "abandon";
  failure: Failure;
  /** Always true: the budget is spent and the work is abandoned, not awaited. */
  abandoned: true;
  elapsedMs: number;
  budgetMs: number;
  sqlstate: string | null;
};

/**
 * Statement timeout → typed timeout, never a hanging request.
 *
 * `handleStatementTimeout` is the reactive half (a driver already told us it
 * gave up). `withTimeoutBudget` is the proactive half and is what actually
 * guarantees the promise: it races the call against a timer and returns a
 * typed timeout, so a hung query cannot pin a request open.
 */
export function handleStatementTimeout(input: {
  err: unknown;
  requestId?: string | null;
  budgetMs?: number;
  elapsedMs?: number;
  retryAfterSec?: number;
}): StatementTimeoutDecision {
  const classification = classifyDatabaseError(input.err);
  const budgetMs = input.budgetMs ?? 0;
  const retryAfterSec = input.retryAfterSec ?? DEFAULT_TIMEOUT_RETRY_AFTER_SEC;
  return {
    action: "abandon",
    failure: statementTimeout(retryAfterSec, { requestId: input.requestId }),
    abandoned: true,
    elapsedMs: input.elapsedMs ?? budgetMs,
    budgetMs,
    sqlstate: classification.sqlstate,
  };
}

/** The typed error `withTimeoutBudget` produces. Carries no driver detail. */
export class DbTimeoutError extends Error {
  readonly budgetMs: number;
  readonly sqlstate: string | null;
  constructor(budgetMs: number, sqlstate: string | null = null) {
    super(`database call exceeded its ${budgetMs} ms budget`);
    this.name = "DbTimeoutError";
    this.budgetMs = budgetMs;
    this.sqlstate = sqlstate;
  }
}

/**
 * Race a database call against its budget. Resolves, or rejects with
 * `DbTimeoutError` — it never leaves the caller awaiting forever.
 *
 * `timers` is injectable so the gate can drive both branches without wall
 * clock; the default uses the real thing.
 */
export async function withTimeoutBudget<T>(
  fn: () => Promise<T>,
  budgetMs: number,
  opts: {
    timers?: {
      setTimeout: (fn: () => void, ms: number) => unknown;
      clearTimeout: (h: unknown) => void;
    };
  } = {},
): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0)
    throw new RangeError("budgetMs must be positive");
  const timers = opts.timers ?? {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let handle: unknown;
  const expiry = new Promise<never>((_, reject) => {
    handle = timers.setTimeout(() => reject(new DbTimeoutError(budgetMs)), budgetMs);
  });
  try {
    return await Promise.race([fn(), expiry]);
  } finally {
    timers.clearTimeout(handle);
  }
}

// ── Rows: deadlock and serialisation failure ──────────────────────────────────

/**
 * "Retry the transaction up to three times" — three RETRIES after the initial
 * attempt, so a transaction that always deadlocks is attempted four times and
 * the fourth failure is what the caller sees. Named explicitly because 3 vs 4
 * is exactly the kind of ambiguity that gets discovered during an incident.
 */
export const MAX_TX_RETRIES = 3;
/** Base of the exponential backoff between retries, in ms. */
export const TX_RETRY_BASE_BACKOFF_MS = 25;
/** Jitter is a multiplier in [1 - JITTER, 1] so a thundering herd de-synchronises. */
export const TX_RETRY_JITTER = 0.5;

/**
 * Jittered backoff for retry number `retryNumber` (1-based).
 * Deterministic given `rand`, which is how the gate asserts it.
 */
export function transactionBackoffMs(
  retryNumber: number,
  rand: () => number = Math.random,
  baseMs: number = TX_RETRY_BASE_BACKOFF_MS,
): number {
  const exponent = Math.max(0, retryNumber - 1);
  const ceiling = baseMs * Math.pow(2, exponent);
  const r = Number.isFinite(rand()) ? Math.min(Math.max(rand(), 0), 1) : 0.5;
  return Math.round(ceiling * (1 - TX_RETRY_JITTER + TX_RETRY_JITTER * r));
}

export type TransactionConflictDecision = {
  action: "retry" | "fail";
  /** Null when `action` is "retry": the caller has nothing to publish yet. */
  failure: Failure | null;
  sqlstate: string | null;
  kind: "deadlock" | "serialization_failure" | "not_retryable";
};

/** Classify one conflict and say whether the runner should try again. */
export function handleTransactionConflict(input: {
  err: unknown;
  requestId?: string | null;
}): TransactionConflictDecision {
  const classification = classifyDatabaseError(input.err);
  if (!isRetryableTransactionConflict(classification.kind)) {
    return {
      action: "fail",
      failure: null,
      sqlstate: classification.sqlstate,
      kind: "not_retryable",
    };
  }
  const kind = classification.kind === "deadlock" ? "deadlock" : "serialization_failure";
  return { action: "retry", failure: null, sqlstate: classification.sqlstate, kind };
}

export type TransactionOutcome<T> =
  | { ok: true; value: T; attempts: number; retriedOn: string[]; backoffsMs: number[] }
  | {
      ok: false;
      failure: Failure;
      attempts: number;
      retriedOn: string[];
      backoffsMs: number[];
      kind: DatabaseFailureKind;
    };

export type TransactionRunnerOptions = {
  /** Retries after the first attempt. Defaults to `MAX_TX_RETRIES`. */
  retries?: number;
  /** Injected so the ladder costs no wall clock in the gate. */
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  baseBackoffMs?: number;
  requestId?: string | null;
  /** Observability hook. Called once per retry, before the sleep. */
  onRetry?: (info: {
    retryNumber: number;
    sqlstate: string | null;
    kind: DatabaseFailureKind;
    delayMs: number;
  }) => void;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The retry path both conflict rows share.
 *
 * Only deadlocks and serialisation failures are replayed. A unique violation or
 * a pool exhaustion is NOT retried here: replaying it either cannot succeed or
 * would queue behind the exhausted pool, which is the thing we just refused to
 * do. That asymmetry is asserted by the gate.
 */
export async function runTransactionWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: TransactionRunnerOptions = {},
): Promise<TransactionOutcome<T>> {
  const retries = opts.retries ?? MAX_TX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  const rand = opts.rand ?? Math.random;
  const baseBackoffMs = opts.baseBackoffMs ?? TX_RETRY_BASE_BACKOFF_MS;

  const retriedOn: string[] = [];
  const backoffsMs: number[] = [];
  let attempts = 0;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    attempts = attempt;
    try {
      const value = await fn(attempt);
      return { ok: true, value, attempts, retriedOn, backoffsMs };
    } catch (err) {
      const classification = classifyDatabaseError(err);
      const decision = handleTransactionConflict({ err, requestId: opts.requestId });

      if (decision.action !== "retry" || attempt === retries + 1) {
        const failure = isRetryableTransactionConflict(classification.kind)
          ? // Survived the full ladder: the data is fine, this transaction
            // simply keeps losing. 409 + retryable, not a 503 (the database
            // is healthy) and certainly not a 500.
            transactionContended({ requestId: opts.requestId })
          : failureForKind(classification.kind, err, opts.requestId ?? null);
        return { ok: false, failure, attempts, retriedOn, backoffsMs, kind: classification.kind };
      }

      const delayMs = transactionBackoffMs(attempt, rand, baseBackoffMs);
      retriedOn.push(classification.sqlstate ?? classification.kind);
      backoffsMs.push(delayMs);
      opts.onRetry?.({
        retryNumber: attempt,
        sqlstate: classification.sqlstate,
        kind: classification.kind,
        delayMs,
      });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop always returns on the final attempt.
  throw new Error("runTransactionWithRetry: loop exited without a result");
}

/**
 * Typed failures for the non-retryable rows that can still reach a caller.
 *
 * The `default` arm is the only path in this module that produces a 500, and it
 * is reached only for `unknown` — a driver error this matrix does not
 * recognise, which is a genuine bug on our side and is logged as one.
 */
function failureForKind(
  kind: DatabaseFailureKind,
  err: unknown,
  requestId: string | null,
): Failure {
  switch (kind) {
    case "pool_exhausted":
      return handlePoolExhausted({ err, requestId }).failure;
    case "statement_timeout":
      return handleStatementTimeout({ err, requestId }).failure;
    case "unique_violation":
      return uniqueConflict({ requestId });
    case "foreign_key_violation":
      return makeFailure("reference_conflict", { requestId });
    case "check_violation":
      return makeFailure("semantically_invalid", { requestId });
    case "record_not_found":
      // Prisma raises P2025 for a missing row. A missing row is a 404; letting
      // it fall through to the `default` arm would be a 500 for "not there".
      return makeFailure("not_found", { requestId });
    case "primary_unreachable":
      return makeFailure("dependency_unavailable", {
        requestId,
        retryAfterSec: DEFAULT_SHED_RETRY_AFTER_SEC,
      });
    case "storage_full":
      return (
        evaluateStoragePressure({ diskUsedPct: 99, walUsedPct: 99, requestId }).failure ??
        makeFailure("dependency_unavailable", {
          requestId,
          retryAfterSec: DEFAULT_SHED_RETRY_AFTER_SEC,
        })
      );
    default:
      return makeFailure("internal_bug", { requestId });
  }
}

// ── Row: unique violation ─────────────────────────────────────────────────────

export type IdempotentReplay = {
  status: number;
  /** The stored response. Replayed verbatim; it is our own prior body. */
  body: unknown;
};

export type UniqueViolationDecision = {
  action: "replay_idempotent" | "conflict";
  /** Null on the replay path: the caller sends `replay`, not a failure. */
  failure: Failure | null;
  replay: IdempotentReplay | null;
  fields: string[];
  sqlstate: string | null;
};

/**
 * Unique violation (23505) → the idempotency response, or a typed 409.
 *
 * Never a 500. The reasoning: a 23505 means the row we wanted to write is
 * already there, which is either (a) a replay of a request we already answered,
 * in which case the stored answer is the correct response, or (b) two distinct
 * requests colliding on a natural key, which is a conflict the caller can
 * resolve. Neither is a fault in our code, so neither may be dressed as one.
 *
 * `lookupIdempotent` is injected: the caller supplies whatever idempotency
 * store it uses, and the gate counts the lookups to prove the replay path is
 * taken when a stored answer exists.
 */
export async function handleUniqueViolation(input: {
  err: unknown;
  requestId?: string | null;
  lookupIdempotent?: (fields: string[]) => Promise<IdempotentReplay | null>;
}): Promise<UniqueViolationDecision> {
  const classification = classifyDatabaseError(input.err);
  const fields = classification.fields;

  if (input.lookupIdempotent) {
    const replay = await input.lookupIdempotent(fields);
    if (replay && replay.status >= 200 && replay.status < 300) {
      return {
        action: "replay_idempotent",
        failure: null,
        replay,
        fields,
        sqlstate: classification.sqlstate,
      };
    }
  }

  return {
    action: "conflict",
    failure: uniqueConflict({ requestId: input.requestId }),
    replay: null,
    fields,
    sqlstate: classification.sqlstate,
  };
}

// ── Row: foreign-key violation ────────────────────────────────────────────────

export type ReferenceViolationDecision = {
  action: "conflict";
  failure: Failure;
  /** The field, and only the field. */
  field: string | null;
  sqlstate: string | null;
};

/**
 * Foreign-key violation (23503) → 409 naming the field.
 *
 * The driver message is `Key (orgId)=(org_9f2c…) is not present in table
 * "Case"`. The value is another organisation's identifier and the table is our
 * schema; neither crosses the boundary. Only the column name does — and if no
 * safe column name can be extracted, the field is reported as `null` rather
 * than guessing.
 */
export function handleReferenceViolation(input: {
  err: unknown;
  requestId?: string | null;
}): ReferenceViolationDecision {
  const classification = classifyDatabaseError(input.err);
  const extracted = fieldOf(input.err);
  let field: string | null = null;
  if (extracted !== null) {
    try {
      field = assertFieldName(extracted);
    } catch {
      field = null;
    }
  }
  const failure =
    field === null
      ? makeFailure("reference_conflict", { requestId: input.requestId })
      : makeFailure("reference_conflict", {
          requestId: input.requestId,
          detail: `Unusable field: ${field}.`,
        });
  return { action: "conflict", failure, field, sqlstate: classification.sqlstate };
}

// ── Row: primary unreachable ──────────────────────────────────────────────────

export type PrimaryMode = "up" | "read_only" | "down";

export type PrimaryHealthDecision = {
  mode: PrimaryMode;
  /** Console reads, the audit chain, the outbox: still served. */
  readsAllowed: boolean;
  writesAllowed: boolean;
  /**
   * The row that matters. False in `read_only` and `down`. Accepting a risk
   * signal we cannot durably record is the worst outcome available to a fraud
   * platform: the bank is told we intervened and we cannot prove it.
   */
  interventionsAllowed: boolean;
  failure: Failure | null;
  fallback: "sms" | "app_push" | null;
  reason: string;
};

/**
 * What the platform may do when the primary is unreachable.
 *
 * `read_only` serves reads and refuses writes. The refusal is a typed 409 that
 * names the asynchronous channel a human should use, and it is `retryable:
 * false` on purpose: an automatic retry would be refused again for the same
 * reason while the fraud continues, so the caller must escalate rather than
 * loop.
 */
export function evaluatePrimaryHealth(input: {
  mode: PrimaryMode;
  requestId?: string | null;
  fallback?: "sms" | "app_push";
  /** Set when the mode was derived from a driver error, for the log only. */
  sqlstate?: string | null;
}): PrimaryHealthDecision {
  const fallback = input.fallback ?? "sms";

  if (input.mode === "up") {
    return {
      mode: "up",
      readsAllowed: true,
      writesAllowed: true,
      interventionsAllowed: true,
      failure: null,
      fallback: null,
      reason: "primary_reachable",
    };
  }

  if (input.mode === "down") {
    return {
      mode: "down",
      readsAllowed: false,
      writesAllowed: false,
      interventionsAllowed: false,
      failure: makeFailure("dependency_unavailable", {
        requestId: input.requestId,
        retryAfterSec: DEFAULT_SHED_RETRY_AFTER_SEC,
      }),
      fallback,
      reason: "primary_unreachable",
    };
  }

  return {
    mode: "read_only",
    readsAllowed: true,
    writesAllowed: false,
    interventionsAllowed: false,
    failure: interventionRefused(`Contact the customer by ${fallback} instead.`, {
      requestId: input.requestId,
    }),
    fallback,
    reason: "read_only_degraded",
  };
}

/**
 * Gate one intervention attempt. Returns the decision, and the caller MUST NOT
 * attempt a write when `interventionsAllowed` is false — which is why this
 * returns a boolean rather than a failure the caller may ignore.
 */
export function admitIntervention(health: PrimaryHealthDecision): {
  admitted: boolean;
  failure: Failure | null;
} {
  return {
    admitted: health.interventionsAllowed,
    failure: health.interventionsAllowed ? null : health.failure,
  };
}

// ── Row: replica lag ──────────────────────────────────────────────────────────

/** Reads older than this are not shown without a staleness banner. */
export const DEFAULT_REPLICA_LAG_THRESHOLD_MS = 2_000;

export type ReplicaLagMode = "fail_back" | "banner";

export type ReplicaLagDecision = {
  lagMs: number;
  thresholdMs: number;
  /** Whether the number we were given exceeds what a caller may be shown. */
  stale: boolean;
  readFrom: "replica" | "primary";
  /** True when the decision actually moved the read off the replica. */
  failedBack: boolean;
  banner: { reason: "replica_lag"; lagMs: number; thresholdMs: number } | null;
};

/**
 * Replica lag past the threshold → either fail reads back to the primary or
 * carry a staleness banner, per the deployment's declared `mode`.
 *
 * Neither option returns an error: a stale read is still a read, and failing
 * closed on the console is how an operator ends up staring at a blank screen
 * during an incident. What must never happen is showing a stale number with no
 * indication that it is stale.
 */
export function evaluateReplicaLag(input: {
  lagMs: number;
  thresholdMs?: number;
  mode?: ReplicaLagMode;
}): ReplicaLagDecision {
  const thresholdMs = input.thresholdMs ?? DEFAULT_REPLICA_LAG_THRESHOLD_MS;
  const mode = input.mode ?? "fail_back";
  const lagMs = Number.isFinite(input.lagMs) ? Math.max(0, input.lagMs) : 0;
  const stale = lagMs > thresholdMs;

  if (!stale) {
    return {
      lagMs,
      thresholdMs,
      stale: false,
      readFrom: "replica",
      failedBack: false,
      banner: null,
    };
  }
  if (mode === "banner") {
    return {
      lagMs,
      thresholdMs,
      stale: true,
      readFrom: "replica",
      failedBack: false,
      banner: { reason: "replica_lag", lagMs, thresholdMs },
    };
  }
  return { lagMs, thresholdMs, stale: true, readFrom: "primary", failedBack: true, banner: null };
}

// ── Row: disk / WAL above 70% ─────────────────────────────────────────────────

/** Above this percentage of the volume we alert. */
export const STORAGE_PRESSURE_ALERT_PCT = 70;
/** Above this we stop admitting non-essential writes. */
export const STORAGE_PRESSURE_CRITICAL_PCT = 90;

/**
 * Write classes, in the order they are admitted when the volume is tight.
 *
 * Index 0 is the audit chain and index 0 it stays: the declared behaviour is
 * "the audit chain must never be the write that fails". A full disk is a
 * reason to stop exporting and stop rebuilding read models — not a reason to
 * lose the evidence of what we did.
 */
export const WRITE_CLASSES = [
  "audit_chain",
  "case_state_transition",
  "outbox_enqueue",
  "idempotency_claim",
  "read_model_rebuild",
  "bulk_export",
] as const;
export type WriteClass = (typeof WRITE_CLASSES)[number];

/** Classes we stop admitting under pressure, most expendable first. */
export const WRITE_CLASSES_SACRIFICED = ["bulk_export", "read_model_rebuild"] as const;

/**
 * The audit chain is never sacrificed, at any pressure level. Stated as data so
 * the gate asserts it rather than reading it in a comment.
 */
export const NEVER_SACRIFICED: readonly WriteClass[] = ["audit_chain"];

export type StoragePressureLevel = "normal" | "elevated" | "critical";

export type StoragePressureDecision = {
  level: StoragePressureLevel;
  diskUsedPct: number;
  walUsedPct: number;
  /** The greater of the two, which is what the alert quotes. */
  peakUsedPct: number;
  thresholdPct: number;
  shouldAlert: boolean;
  alerts: string[];
  admitted: WriteClass[];
  refused: WriteClass[];
  priority: readonly WriteClass[];
  /** Always true. Exposed so the gate can assert it as a value. */
  auditChainAdmitted: true;
};

export type StorageAlertSink = (alert: {
  level: StoragePressureLevel;
  peakUsedPct: number;
  alerts: string[];
}) => void;

function clampPct(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * Disk or WAL above 70% → alert, and admit writes with the audit chain first.
 *
 * `alert` is injected so the gate can count alerts without paging anybody. The
 * admission decision is computed purely and returned, so the caller cannot
 * admit a refused class by accident: it has to filter through `admitted`.
 */
export function evaluateStoragePressure(input: {
  diskUsedPct: number;
  walUsedPct: number;
  alert?: StorageAlertSink;
  thresholdPct?: number;
  criticalPct?: number;
  requestId?: string | null;
}): StoragePressureDecision & { failure: Failure | null } {
  const thresholdPct = input.thresholdPct ?? STORAGE_PRESSURE_ALERT_PCT;
  const criticalPct = input.criticalPct ?? STORAGE_PRESSURE_CRITICAL_PCT;
  const diskUsedPct = clampPct(input.diskUsedPct);
  const walUsedPct = clampPct(input.walUsedPct);
  const peakUsedPct = Math.max(diskUsedPct, walUsedPct);

  const level: StoragePressureLevel =
    peakUsedPct >= criticalPct ? "critical" : peakUsedPct >= thresholdPct ? "elevated" : "normal";

  const shouldAlert = level !== "normal";
  const alerts: string[] = [];
  if (diskUsedPct >= thresholdPct) alerts.push(`data_volume_at_${Math.round(diskUsedPct)}pct`);
  if (walUsedPct >= thresholdPct) alerts.push(`wal_at_${Math.round(walUsedPct)}pct`);

  // The audit chain is admitted first at every level, including critical. The
  // only classes refused under pressure are the ones we declared expendable.
  const refused = new Set<WriteClass>(level === "critical" ? [...WRITE_CLASSES_SACRIFICED] : []);
  for (const cls of NEVER_SACRIFICED) refused.delete(cls);

  const admitted = WRITE_CLASSES.filter((cls) => !refused.has(cls));

  if (shouldAlert) input.alert?.({ level, peakUsedPct, alerts });

  return {
    level,
    diskUsedPct,
    walUsedPct,
    peakUsedPct,
    thresholdPct,
    shouldAlert,
    alerts,
    admitted,
    refused: WRITE_CLASSES.filter((cls) => refused.has(cls)),
    priority: WRITE_CLASSES,
    auditChainAdmitted: true,
    // Above the threshold we shed writes rather than pretend the volume is fine.
    // The audit chain is still admitted: shedding it is not on the table.
    failure: shouldAlert
      ? shedLoad(DEFAULT_SHED_RETRY_AFTER_SEC, {
          requestId: input.requestId,
          detail: `Storage pressure at ${Math.round(peakUsedPct)} percent.`,
        })
      : null,
  };
}

/** May this write class be admitted under this decision? */
export function admitWrite(decision: StoragePressureDecision, cls: WriteClass): boolean {
  return decision.admitted.includes(cls);
}

// ── Row: caller-side rate limit ───────────────────────────────────────────────

/**
 * A caller quota (as opposed to our own capacity) is a 429 with Retry-After —
 * the same discipline as a shed 503, kept separate because the remediation is
 * the caller's. Included here so the module owns every database-adjacent
 * refusal a route can produce.
 */
export function rateLimitedByCaller(retryAfterSec: number, requestId?: string | null): Failure {
  return rateLimited(retryAfterSec, { requestId });
}
