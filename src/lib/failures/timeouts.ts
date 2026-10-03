import "server-only";
/**
 * Outbound timeouts, always strictly shorter than the caller's budget (WP-21).
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * If A calls B and A's budget is 5 s, B's budget is strictly less than 5 s. Not
 * equal — equal means B is still running when A gives up, which means the work
 * continues to consume a connection while the caller has already answered. Not
 * longer — longer is the cascade: B's slowness becomes A's slowness, and A's
 * slowness becomes the request timeout that nobody can explain.
 *
 * `deriveChildTimeout` cannot return a value that violates the rule. If the
 * parent budget is too small to host the child at all it throws a
 * `TimeoutBudgetError` rather than quietly returning a number that is not
 * strictly shorter — a misconfigured budget should be loud at boot, not
 * discovered during an incident.
 *
 * ── The declared tree ─────────────────────────────────────────────────────────
 *
 * `TIMEOUT_EDGES` is the budget for each outbound call we make, with the caller
 * it is subordinate to. The numbers for the calls that already exist in the
 * codebase are the numbers already in the code, quoted with the file they come
 * from, so this module is a description of the system rather than a wish. The
 * gate asserts three things about every edge: `child < parent`, `child` equals
 * what `deriveChildTimeout` returns for the declared reserve, and no two edges
 * claim the same child with different budgets.
 *
 * ── Cascade containment ───────────────────────────────────────────────────────
 *
 * `withTimeout` is what turns "slow" into "typed". It races the call against
 * the budget and rejects with a `DependencyTimeoutError` carrying only the
 * dependency name and the budget — no host, no URL, no driver text — so the
 * caller can attach it to the breaker and shed on the right circuit.
 */

import { dependencyUnavailable, type Failure } from "./envelope";

// ── Deriving a child budget ───────────────────────────────────────────────────

/** Raised when a budget is misconfigured, and when a call would outrun its parent. */
export class TimeoutBudgetError extends Error {
  readonly parentMs: number;
  readonly requestedMs: number | null;
  constructor(message: string, parentMs: number, requestedMs: number | null = null) {
    super(message);
    this.name = "TimeoutBudgetError";
    this.parentMs = parentMs;
    this.requestedMs = requestedMs;
  }
}

/** Thrown by `withTimeout` when the budget is spent. Typed, and safe to publish. */
export class DependencyTimeoutError extends Error {
  readonly dependency: string;
  readonly budgetMs: number;
  constructor(dependency: string, budgetMs: number) {
    super(`dependency ${dependency} exceeded its ${budgetMs} ms budget`);
    this.name = "DependencyTimeoutError";
    this.dependency = dependency;
    this.budgetMs = budgetMs;
  }
}

export type DeriveOptions = {
  /** Fraction of the parent budget, applied when `reserveMs` is absent. */
  ratio?: number;
  /** Slack left for the caller: `child = parent - reserve`. */
  reserveMs?: number;
  /** Hard floor for the child. Defaults to 1 ms. */
  minMs?: number;
};

/**
 * A child budget that is guaranteed strictly shorter than its parent.
 *
 * Both formulations are supported because both are real: `ratio` for a call that
 * should take half the time the caller has, `reserveMs` for a call whose
 * duration is known and whose slack should be stated outright. Neither can
 * produce `child >= parent`.
 */
export function deriveChildTimeout(parentBudgetMs: number, opts: DeriveOptions = {}): number {
  if (!Number.isFinite(parentBudgetMs) || parentBudgetMs <= 1) {
    throw new TimeoutBudgetError("parent budget must be greater than 1 ms", parentBudgetMs);
  }
  const minMs = opts.minMs ?? 1;
  if (!Number.isFinite(minMs) || minMs < 1) {
    throw new TimeoutBudgetError("minMs must be at least 1", parentBudgetMs, minMs);
  }

  let child: number;
  if (opts.reserveMs !== undefined) {
    if (!Number.isFinite(opts.reserveMs) || opts.reserveMs < 0) {
      throw new TimeoutBudgetError(
        "reserveMs must be zero or positive",
        parentBudgetMs,
        opts.reserveMs,
      );
    }
    child = parentBudgetMs - opts.reserveMs;
  } else if (opts.ratio !== undefined) {
    if (!Number.isFinite(opts.ratio) || opts.ratio <= 0 || opts.ratio > 1) {
      throw new TimeoutBudgetError("ratio must be within (0, 1]", parentBudgetMs, opts.ratio);
    }
    child = Math.floor(parentBudgetMs * opts.ratio);
  } else {
    child = Math.floor(parentBudgetMs / 2);
  }

  child = Math.floor(child);
  if (child < minMs) child = minMs;

  // The invariant, enforced rather than documented.
  if (child >= parentBudgetMs) {
    throw new TimeoutBudgetError(
      `derived child budget ${child} ms is not shorter than the parent ${parentBudgetMs} ms`,
      parentBudgetMs,
      child,
    );
  }
  return child;
}

// ── The declared budget tree ──────────────────────────────────────────────────

export type TimeoutEdge = {
  /** The caller, by name. Its own budget is the parent. */
  parent: string;
  parentMs: number;
  /** The outbound call this edge governs. */
  child: string;
  childMs: number;
  /** Slack the caller keeps. `childMs === parentMs - reserveMs`. */
  reserveMs: number;
  /** Where this budget already lives, or why it is declared here. */
  source: string;
  why: string;
};

/**
 * Every outbound call, subordinate to the caller that is waiting on it.
 *
 * Four distinct callers, because a fraud intervention is not a 1.5 s request: a
 * realtime turn genuinely has tens of seconds, a signal ingest has seconds, and
 * a background worker has whatever it needs because nobody is waiting.
 */
export const TIMEOUT_EDGES: readonly TimeoutEdge[] = [
  // ── realtime voice turn: the window a customer is actually listening in ──
  {
    parent: "voice_pipeline.turn",
    parentMs: 30_000,
    child: "voice_pipeline.llm_turn",
    childMs: 8_000,
    reserveMs: 22_000,
    source: "src/lib/llm.ts (TIMEOUT_MS = 8_000)",
    why: "an agent turn must leave room for synthesis and playback inside the same turn window",
  },
  {
    parent: "voice_pipeline.turn",
    parentMs: 30_000,
    child: "voice_pipeline.tts",
    childMs: 25_000,
    reserveMs: 5_000,
    source: "src/lib/elevenlabs/client.ts (25_000)",
    why: "synthesis is the last thing to finish before audio is played back",
  },
  {
    parent: "voice_pipeline.turn",
    parentMs: 30_000,
    child: "voice_pipeline.telephony_dial",
    childMs: 15_000,
    reserveMs: 15_000,
    source: "src/lib/twilio.ts (15_000)",
    why: "a dial that has not been placed leaves the turn silent with nothing queued",
  },
  {
    parent: "voice_pipeline.turn",
    parentMs: 30_000,
    child: "voice_pipeline.outbound_call_api",
    childMs: 10_000,
    reserveMs: 20_000,
    source: "src/lib/elevenlabs/outbound-call.ts (10_000)",
    why: "the call request must land before the turn window closes",
  },

  // ── signal ingest: the synchronous request a bank is waiting on ──
  {
    parent: "ingest.request",
    parentMs: 5_000,
    child: "ingest.db_write",
    childMs: 3_000,
    reserveMs: 2_000,
    source: "declared here — no per-call budget exists on the ingest path",
    why: "state transition plus outbox row must commit inside the request budget",
  },
  {
    parent: "ingest.request",
    parentMs: 5_000,
    child: "ingest.audit_append",
    childMs: 2_000,
    reserveMs: 3_000,
    source: "declared here — see src/lib/audit-chain.ts MAX_CONCURRENT_APPENDS",
    why: "the chain append is bounded by its own client pool and must not inherit the request budget",
  },
  {
    parent: "ingest.request",
    parentMs: 5_000,
    child: "ingest.realtime_fanout",
    childMs: 1_500,
    reserveMs: 3_500,
    source: "src/lib/realtime.ts (TIMEOUT_MS = 1_500)",
    why: "a fan-out that has not landed in time degrades the console, never the request",
  },

  // ── outbox worker: nobody is waiting, so the budget is generous but bounded ──
  {
    parent: "outbox_worker.claim",
    parentMs: 5_000,
    child: "outbox_worker.db_update",
    childMs: 3_000,
    reserveMs: 2_000,
    source: "declared here — the claim query runs on the shared pool",
    why: "a claim must either take its rows or release them, never hang holding SKIP LOCKED leases",
  },
  {
    parent: "outbox_worker.deliver",
    parentMs: 10_000,
    child: "outbox_worker.bank_webhook",
    childMs: 8_000,
    reserveMs: 2_000,
    source: "declared here — src/lib/outbox.ts deliver() sets no timeout on its fetch",
    why: "a webhook call with no budget is the one hang the worker cannot shed around",
  },
];

export type TimeoutViolation = {
  child: string;
  reason:
    | "not_shorter_than_parent"
    | "not_derived_from_reserve"
    | "duplicate_child_budget"
    | "unknown_parent";
};

/**
 * Audit the declared tree. Returns the violations; an empty array means every
 * outbound call is strictly shorter than the caller waiting on it.
 */
export function assertTimeoutTree(
  edges: readonly TimeoutEdge[] = TIMEOUT_EDGES,
): TimeoutViolation[] {
  const violations: TimeoutViolation[] = [];
  const parentMsByName = new Map<string, number>();
  const childBudgets = new Map<string, number>();

  for (const edge of edges) {
    if (edge.childMs >= edge.parentMs) {
      violations.push({ child: edge.child, reason: "not_shorter_than_parent" });
    }
    let derived: number;
    try {
      derived = deriveChildTimeout(edge.parentMs, { reserveMs: edge.reserveMs });
    } catch {
      violations.push({ child: edge.child, reason: "unknown_parent" });
      continue;
    }
    if (derived !== edge.childMs) {
      violations.push({ child: edge.child, reason: "not_derived_from_reserve" });
    }
    const previous = childBudgets.get(edge.child);
    if (previous !== undefined && previous !== edge.childMs) {
      violations.push({ child: edge.child, reason: "duplicate_child_budget" });
    }
    childBudgets.set(edge.child, edge.childMs);
    parentMsByName.set(edge.parent, edge.parentMs);
  }
  return violations.sort((a, b) => (a.child < b.child ? -1 : a.child > b.child ? 1 : 0));
}

/** The declared budget for one outbound call. Throws if it is not declared. */
export function budgetFor(child: string, edges: readonly TimeoutEdge[] = TIMEOUT_EDGES): number {
  const edge = edges.find((e) => e.child === child);
  if (!edge) throw new TimeoutBudgetError(`no declared timeout for ${child}`, 0, null);
  return edge.childMs;
}

// ── Containing a slow dependency ──────────────────────────────────────────────

export type InjectableTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export const REAL_TIMERS: InjectableTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Race a call against its budget.
 *
 * Rejects with `DependencyTimeoutError` — never resolves late, never hangs, and
 * never rejects with the caller's own error when the budget is what expired.
 * `timers` is injectable so the gate can drive both branches with no wall clock.
 */
export async function withTimeout<T>(
  dependency: string,
  budgetMs: number,
  call: () => Promise<T>,
  opts: { timers?: InjectableTimers } = {},
): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new TimeoutBudgetError("budgetMs must be positive", budgetMs, budgetMs);
  }
  const timers = opts.timers ?? REAL_TIMERS;
  let handle: unknown;
  const expiry = new Promise<never>((_, reject) => {
    handle = timers.setTimeout(
      () => reject(new DependencyTimeoutError(dependency, budgetMs)),
      budgetMs,
    );
  });
  try {
    return await Promise.race([call(), expiry]);
  } finally {
    timers.clearTimeout(handle);
  }
}

/**
 * An abort signal that fires at the budget and dies with the parent's signal.
 *
 * Both matter: without the timer the fetch outlives the budget, and without the
 * parent link a cancelled request leaves the outbound call running against a
 * vendor we have already given up on.
 */
export function budgetSignal(
  budgetMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const onParentAbort = (): void => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** The published form of a timeout: 503 with Retry-After, never a stack. */
export function envelopeForTimeout(err: unknown, retryAfterSec: number): Failure | null {
  if (err instanceof DependencyTimeoutError) {
    return dependencyUnavailable(retryAfterSec, {
      detail: `Budget of ${err.budgetMs} ms expired.`,
    });
  }
  return null;
}
