/**
 * UNIT — the outbound timeout contract (src/lib/failures/timeouts.ts) and the
 * database failure matrix (src/lib/failures/db-failures.ts).
 *
 * Both modules claim the same two properties, and both are load-bearing:
 *
 *   · **A deadline is real.** A budget that is not enforced is not a budget.
 *     `withTimeout` must reject a call slower than its budget and must NOT
 *     reject one that finishes inside it, and a promise that already lost the
 *     race must never resolve late and overwrite the typed failure.
 *   · **Every produced failure is PUBLISHABLE.** `scanFailure()` returning `[]`
 *     is the only assertion here that would notice a raw driver string — a
 *     Postgres error message, a row id, a constraint name — reaching a caller.
 *     The error objects below are the REALISTIC shapes (Prisma's `meta.target`
 *     compound names, the driver's `Key (orgId)=(org_9f2c…)` foreign-key text,
 *     node socket codes), because a leak gate fed placeholders proves nothing.
 *
 * The database matrix is driven entirely by synthetic errors: no connection is
 * opened, no clock is read unless one is injected. That is the module's own
 * contract ("takes the error as DATA"), and it is why the whole matrix can be
 * proven without breaking a real database.
 *
 * ── KNOWN GAP (timeouts.ts: withTimeout) ─────────────────────────────────────
 * `withTimeout` does NOT cancel the work it abandons. `call()` is invoked with
 * no arguments and returns a promise the module has no handle on, so when the
 * budget expires the underlying fetch/query keeps running against a vendor we
 * have already given up on. `budgetSignal()` exists for exactly this and must be
 * plumbed by the caller; the timeout tests below assert the abandonment as
 * current behaviour and name the gap rather than pretending it is not there.
 *
 * ── KNOWN GAP (timeouts.ts: envelopeForTimeout) ──────────────────────────────
 * The assignment for this file asks the timeout to surface as `statement_timeout`.
 * It does not: `envelopeForTimeout` publishes `dependency_unavailable`. Both are
 * 503 + Retry-After + retryable, so no caller can act differently — but the
 * codes are different rows of the discipline table, and `statement_timeout` is
 * the code `db-failures.handleStatementTimeout` uses for the same condition. The
 * tests assert what the module does (`dependency_unavailable`); see the report.
 *
 * ── KNOWN GAP (timeouts.ts: budgetSignal) ───────────────────────────────────
 * `withTimeout` rejects a non-positive or non-finite budget loudly;
 * `budgetSignal` performs no validation at all, so a negative or `NaN` budget is
 * handed to `setTimeout`, which clamps it to 0 and aborts immediately. That fails
 * CLOSED (an immediate abort, never an unbounded one), so it is not a security
 * hole, but it is undocumented and inconsistent with its sibling. Asserted as
 * observed.
 *
 * ── KNOWN GAP (db-failures.ts: P2015) ───────────────────────────────────────
 * `PRISMA.DEPENDENT_OPERATION_FAILED` ("P2015") is declared in the code table but
 * appears in neither `PRISMA_TO_PG` nor `PRISMA_TO_KIND`, so it classifies as
 * `unknown` and lands on the `internal_bug` 500 default. Arguably correct — the
 * real cause is the failed operation underneath, which surfaces on its own — but
 * the table reads as a closed set and is not one. Asserted as observed.
 *
 * ── KNOWN GAP (db-failures.ts: transactionBackoffMs) ────────────────────────
 * `rand()` is called TWICE per computation: once for the `Number.isFinite` guard
 * and once for the clamp. With the default `Math.random` the two draws differ and
 * the discarded one is harmless, but an injected stateful PRNG advances twice per
 * backoff. Asserted as observed below so a future single-call refactor is a
 * deliberate change rather than an accident.
 */
import { describe, expect, test, vi } from "bun:test";
import {
  FORBIDDEN_STATUSES,
  scanFailure,
  type Failure,
  type FailureCode,
} from "@/lib/failures/envelope";
import {
  REAL_TIMERS,
  TIMEOUT_EDGES,
  DependencyTimeoutError,
  TimeoutBudgetError,
  assertTimeoutTree,
  budgetFor,
  budgetSignal,
  deriveChildTimeout,
  envelopeForTimeout,
  withTimeout,
  type DeriveOptions,
  type InjectableTimers,
  type TimeoutEdge,
} from "@/lib/failures/timeouts";
import {
  DEFAULT_SHED_RETRY_AFTER_SEC,
  DEFAULT_TIMEOUT_RETRY_AFTER_SEC,
  MAX_TX_RETRIES,
  NEVER_SACRIFICED,
  PG,
  PRISMA,
  STORAGE_PRESSURE_ALERT_PCT,
  TX_RETRY_BASE_BACKOFF_MS,
  STORAGE_PRESSURE_CRITICAL_PCT,
  WRITE_CLASSES,
  DbTimeoutError,
  admitIntervention,
  admitWrite,
  classifyDatabaseError,
  evaluatePrimaryHealth,
  evaluateReplicaLag,
  evaluateStoragePressure,
  fieldOf,
  fieldsOf,
  handlePoolExhausted,
  handleReferenceViolation,
  handleStatementTimeout,
  handleTransactionConflict,
  handleUniqueViolation,
  isRetryableTransactionConflict,
  prismaCodeOf,
  rateLimitedByCaller,
  runTransactionWithRetry,
  sqlstateOf,
  transactionBackoffMs,
  withTimeoutBudget,
  type DatabaseFailureKind,
  type PrimaryHealthDecision,
  type StoragePressureDecision,
  type WriteClass,
} from "@/lib/failures/db-failures";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * A raw `pg` error: SQLSTATE on `code`, driver text on `message`. This is the
 * shape the classification matrix is written against, so every SQLSTATE row in
 * the tests below is built here.
 */
function pgError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { code, message, meta: {}, ...extra };
}

/** A Prisma error: `P####` on `code`, driver detail under `meta`. */
function prismaError(code: string, message: string, meta: Record<string, unknown> = {}) {
  return { name: "PrismaClientKnownRequestError", code, message, meta };
}

/** The driver's own foreign-key text, values and all — the worst realistic input. */
const FK_DRIVER_MESSAGE =
  'update or insert on table "Case" violates foreign key constraint "Case_orgId_fkey"\n' +
  'DETAIL: Key (orgId)=(org_9f2c4a17e0b34d55) is not present in table "Case".';

/** Prisma's compound-target message, backticks and all. */
const UNIQUE_PRISMA_MESSAGE = "Unique constraint failed on the fields: (`idemKey`,`orgId`)";

/**
 * A clock the test drives by hand, so every budget assertion is exact and no
 * test waits on wall time. Handles are numeric so `clearTimeout` can be checked
 * without the module ever seeing a real timer id.
 */
function manualTimers() {
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  const cleared: number[] = [];
  let nextId = 1;
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const id = nextId;
        nextId += 1;
        scheduled.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (handle: unknown): void => {
        if (typeof handle !== "number") return;
        if (scheduled.delete(handle)) cleared.push(handle);
      },
    } satisfies InjectableTimers,
    /** The budgets still armed, in the order they were armed. */
    armedMs: (): number[] => [...scheduled.values()].map((entry) => entry.ms),
    armedCount: (): number => scheduled.size,
    clearedCount: (): number => cleared.length,
    /**
     * Expire everything currently armed. The entries stay in the map so the
     * module's own `clearTimeout` is what disarms them — that is the
     * behaviour under test, so the fixture must not do it first.
     */
    fire: (): void => {
      for (const entry of [...scheduled.values()]) entry.fn();
    },
  };
}

/** A promise that never settles, with an observable "did it finish" flag. */
function forever<T>() {
  const state = { settled: false };
  const promise = new Promise<T>(() => {}).finally(() => {
    state.settled = true;
  });
  return { promise, state };
}

/** The typed timeout the module declares, as an envelope to publish. */
function publishable(failure: Failure): Failure {
  expect(scanFailure(failure)).toEqual([]);
  expect(FORBIDDEN_STATUSES).not.toContain(failure.status);
  return failure;
}

// ═══ timeouts.ts — deriving a child budget ═════════════════════════════════════

describe("deriveChildTimeout — the invariant is enforced, not documented", () => {
  const VALID: { parent: number; opts: DeriveOptions; expected: number }[] = [
    // No options: half the parent, floored.
    { parent: 1_000, opts: {}, expected: 500 },
    { parent: 30_000, opts: {}, expected: 15_000 },
    // Odd parents floor, and 3 ms still leaves a legal 1 ms child.
    { parent: 999, opts: {}, expected: 499 },
    { parent: 3, opts: {}, expected: 1 },
    { parent: 2, opts: {}, expected: 1 },
    // `reserveMs` states the caller's slack outright.
    { parent: 30_000, opts: { reserveMs: 22_000 }, expected: 8_000 },
    { parent: 5_000, opts: { reserveMs: 2_000 }, expected: 3_000 },
    { parent: 101, opts: { reserveMs: 1 }, expected: 100 },
    // `ratio` takes a share of the parent.
    { parent: 30_000, opts: { ratio: 0.25 }, expected: 7_500 },
    { parent: 1_000, opts: { ratio: 0.001 }, expected: 1 },
    // A fractional ratio still yields a whole millisecond.
    { parent: 1_001, opts: { ratio: 0.5 }, expected: 500 },
    // `minMs` floors a degenerate reserve.
    { parent: 10, opts: { reserveMs: 9 }, expected: 1 },
    { parent: 50, opts: { reserveMs: 49, minMs: 5 }, expected: 5 },
  ];

  test.each(VALID)("parent $parent $opts → $expected ms", ({ parent, opts, expected }) => {
    const child = deriveChildTimeout(parent, opts);
    expect(child).toBe(expected);
    // The three properties the module promises for every value it returns.
    expect(Number.isInteger(child)).toBe(true);
    expect(child).toBeGreaterThanOrEqual(1);
    expect(child).toBeLessThan(parent);
  });

  test("the whole declared budget tree derives without throwing", () => {
    for (const edge of TIMEOUT_EDGES) {
      const derived = deriveChildTimeout(edge.parentMs, { reserveMs: edge.reserveMs });
      expect(derived).toBe(edge.childMs);
    }
  });

  const REJECTED: { label: string; parent: number; opts: DeriveOptions }[] = [
    { label: "zero parent", parent: 0, opts: {} },
    { label: "negative parent", parent: -5_000, opts: {} },
    { label: "1 ms parent has no room for a child", parent: 1, opts: {} },
    { label: "NaN parent", parent: Number.NaN, opts: {} },
    { label: "Infinity parent", parent: Number.POSITIVE_INFINITY, opts: {} },
    { label: "minMs below 1", parent: 1_000, opts: { minMs: 0 } },
    { label: "fractional minMs", parent: 1_000, opts: { minMs: 0.5 } },
    { label: "negative minMs", parent: 1_000, opts: { minMs: -1 } },
    { label: "NaN minMs", parent: 1_000, opts: { minMs: Number.NaN } },
    { label: "infinite minMs", parent: 1_000, opts: { minMs: Number.POSITIVE_INFINITY } },
    { label: "negative reserve", parent: 1_000, opts: { reserveMs: -1 } },
    { label: "NaN reserve", parent: 1_000, opts: { reserveMs: Number.NaN } },
    { label: "infinite reserve", parent: 1_000, opts: { reserveMs: Number.POSITIVE_INFINITY } },
    // These two are legal to WRITE and illegal to RETURN: they derive a
    // child equal to the parent, which the invariant check refuses.
    {
      label: "zero reserve derives a child equal to the parent",
      parent: 1_000,
      opts: { reserveMs: 0 },
    },
    { label: "ratio of 1 derives a child equal to the parent", parent: 1_000, opts: { ratio: 1 } },
    { label: "zero ratio", parent: 1_000, opts: { ratio: 0 } },
    { label: "ratio above 1", parent: 1_000, opts: { ratio: 1.5 } },
    { label: "negative ratio", parent: 1_000, opts: { ratio: -0.5 } },
    { label: "NaN ratio", parent: 1_000, opts: { ratio: Number.NaN } },
  ];

  test.each(REJECTED)("rejects $label rather than returning a bad budget", (row) => {
    // A misconfigured budget must be loud at boot, not discovered during an
    // incident — so every one of these throws instead of returning a number.
    expect(() => deriveChildTimeout(row.parent, row.opts)).toThrow(TimeoutBudgetError);
  });

  test("minMs may not push the child back up to the parent", () => {
    // The floor is applied BEFORE the invariant check, so an over-large
    // minMs is caught rather than returned as a non-shorter budget.
    expect(() => deriveChildTimeout(10, { minMs: 10 })).toThrow(TimeoutBudgetError);
    expect(() => deriveChildTimeout(10, { minMs: 11 })).toThrow(TimeoutBudgetError);
    // One below the parent is still legal.
    expect(deriveChildTimeout(10, { minMs: 9 })).toBe(9);
  });

  test("the thrown error names the budget that broke, not just the message", () => {
    let thrown: unknown;
    try {
      deriveChildTimeout(1_000, { ratio: 2 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TimeoutBudgetError);
    if (!(thrown instanceof TimeoutBudgetError)) return;
    expect(thrown.parentMs).toBe(1_000);
    expect(thrown.requestedMs).toBe(2);
    expect(thrown.name).toBe("TimeoutBudgetError");
  });
});

// ═══ timeouts.ts — the declared budget tree ════════════════════════════════════

describe("assertTimeoutTree — the declared tree is a description, not a wish", () => {
  test("the shipped tree has no violations", () => {
    expect(assertTimeoutTree()).toEqual([]);
  });

  test("every declared edge is internally consistent", () => {
    for (const edge of TIMEOUT_EDGES) {
      // childMs is parentMs minus the stated slack — not a number typed
      // twice and hoped about.
      expect(edge.childMs).toBe(edge.parentMs - edge.reserveMs);
      expect(edge.childMs).toBeGreaterThan(0);
      expect(edge.reserveMs).toBeGreaterThan(0);
      expect(edge.source.length).toBeGreaterThan(0);
      expect(edge.why.length).toBeGreaterThan(0);
      expect(edge.parent.length).toBeGreaterThan(0);
      expect(edge.child.length).toBeGreaterThan(0);
    }
  });

  test("no two edges claim the same child, so a budget is never ambiguous", () => {
    const children = TIMEOUT_EDGES.map((edge) => edge.child);
    expect(children.length).toBe(new Set(children).size);
  });

  test("a parent budget is declared once and every child hangs off a real parent", () => {
    const parentBudgets = new Map<string, number>();
    for (const edge of TIMEOUT_EDGES) {
      const previous = parentBudgets.get(edge.parent);
      // A parent that appears twice with different budgets is exactly the
      // ambiguity the audit is meant to refuse.
      expect(previous === undefined || previous === edge.parentMs).toBe(true);
      parentBudgets.set(edge.parent, edge.parentMs);
    }
    expect(parentBudgets.size).toBeGreaterThan(1);
  });

  const edge = (over: Partial<TimeoutEdge>): TimeoutEdge => ({
    parent: "voice_pipeline.turn",
    parentMs: 30_000,
    child: "voice_pipeline.llm_turn",
    childMs: 8_000,
    reserveMs: 22_000,
    source: "declared here",
    why: "test",
    ...over,
  });

  test("a child that is not shorter than its parent is reported", () => {
    // An edge whose child outruns its caller is caught twice over: the child
    // is not shorter, AND it cannot be the value its reserve derives. A
    // reserve of 0 or less makes the second reason "unknown_parent" instead,
    // because no budget can be derived from it at all.
    expect(assertTimeoutTree([edge({ childMs: 31_000, reserveMs: 1_000 })])).toEqual([
      { child: "voice_pipeline.llm_turn", reason: "not_shorter_than_parent" },
      { child: "voice_pipeline.llm_turn", reason: "not_derived_from_reserve" },
    ]);
    expect(assertTimeoutTree([edge({ childMs: 31_000, reserveMs: 0 })])).toEqual([
      { child: "voice_pipeline.llm_turn", reason: "not_shorter_than_parent" },
      { child: "voice_pipeline.llm_turn", reason: "unknown_parent" },
    ]);
  });

  test("a child that does not match its declared reserve is reported", () => {
    // 8_000 is the value the code actually uses; claim 9_000 against the same
    // 22_000 reserve and the two can no longer both be true.
    const violations = assertTimeoutTree([edge({ childMs: 9_000 })]);
    expect(violations).toEqual([
      { child: "voice_pipeline.llm_turn", reason: "not_derived_from_reserve" },
    ]);
  });

  test("two different budgets for one child are reported as a duplicate", () => {
    const violations = assertTimeoutTree([
      edge({ parentMs: 1_000, childMs: 500, reserveMs: 500 }),
      edge({ parentMs: 2_000, childMs: 900, reserveMs: 1_100 }),
    ]);
    expect(violations).toEqual([
      { child: "voice_pipeline.llm_turn", reason: "duplicate_child_budget" },
    ]);
  });

  test("the same child at the same budget twice is not a violation", () => {
    const repeated = edge({});
    expect(assertTimeoutTree([repeated, { ...repeated }])).toEqual([]);
  });

  test("a parent with no derivable budget is reported, not skipped", () => {
    // 1 ms cannot host a child, so the audit flags it instead of trusting it.
    const violations = assertTimeoutTree([edge({ parentMs: 1, childMs: 0, reserveMs: 1 })]);
    expect(violations).toEqual([{ child: "voice_pipeline.llm_turn", reason: "unknown_parent" }]);
  });

  test("violations are sorted by child so a diff is stable across runs", () => {
    const violations = assertTimeoutTree([
      edge({ child: "z.child", childMs: 9_000 }),
      edge({ child: "a.child", childMs: 9_000 }),
    ]);
    expect(violations).toEqual([
      { child: "a.child", reason: "not_derived_from_reserve" },
      { child: "z.child", reason: "not_derived_from_reserve" },
    ]);
  });
});

describe("budgetFor", () => {
  test("returns the declared budget for every declared child", () => {
    for (const declared of TIMEOUT_EDGES) {
      expect(budgetFor(declared.child)).toBe(declared.childMs);
    }
  });

  test("an undeclared dependency throws rather than defaulting to a guess", () => {
    // A silent default would let a new outbound call inherit no deadline at
    // all, which is the exact failure this module exists to prevent.
    expect(() => budgetFor("not.declared.anywhere")).toThrow(TimeoutBudgetError);
  });
});

// ═══ timeouts.ts — the deadline is enforced ════════════════════════════════════

describe("withTimeout — a call slower than its budget is refused", () => {
  test("a call that never finishes rejects with the typed timeout", async () => {
    const clock = manualTimers();
    const pending = withTimeout("elevenlabs.tts", 8_000, () => forever<string>().promise, {
      timers: clock.timers,
    });
    // Exactly one timer, armed for exactly the declared budget.
    expect(clock.armedMs()).toEqual([8_000]);

    clock.fire();
    let thrown: unknown;
    try {
      await pending;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DependencyTimeoutError);
    if (!(thrown instanceof DependencyTimeoutError)) return;
    // The error carries the dependency and the budget and nothing else: no
    // host, no URL, no driver text.
    expect(thrown.dependency).toBe("elevenlabs.tts");
    expect(thrown.budgetMs).toBe(8_000);
    expect(thrown.name).toBe("DependencyTimeoutError");
    expect(Object.keys(thrown).sort()).toEqual(["budgetMs", "dependency", "name"]);
  });

  test("a call that finishes inside its budget resolves untouched", async () => {
    const clock = manualTimers();
    const value = await withTimeout("elevenlabs.tts", 25_000, async () => ({ bytes: 12 }), {
      timers: clock.timers,
    });
    expect(value).toEqual({ bytes: 12 });
  });

  test("the timer is disarmed once the call wins, so nothing fires into the void", async () => {
    const clock = manualTimers();
    await withTimeout("elevenlabs.tts", 25_000, async () => "done", { timers: clock.timers });
    // An armed timer that later fires rejects a race nobody is listening to,
    // which surfaces in the server process as an unhandled rejection.
    expect(clock.armedCount()).toBe(0);
    expect(clock.clearedCount()).toBe(1);
  });

  test("the timer is disarmed on the timeout branch too", async () => {
    const clock = manualTimers();
    const pending = withTimeout("vendor", 100, () => forever<string>().promise, {
      timers: clock.timers,
    });
    clock.fire();
    await expect(pending).rejects.toBeInstanceOf(DependencyTimeoutError);
    expect(clock.clearedCount()).toBe(1);
  });

  test("a call that resolves AFTER the budget never overwrites the timeout", async () => {
    const clock = manualTimers();
    let release: (value: string) => void = () => {};
    const late = new Promise<string>((resolve) => {
      release = resolve;
    });
    const pending = withTimeout("vendor", 100, () => late, { timers: clock.timers });
    clock.fire();
    const first = await pending.then(
      () => "resolved",
      (err: unknown) => err,
    );
    expect(first).toBeInstanceOf(DependencyTimeoutError);

    release("the answer nobody is waiting for");
    await Promise.resolve();
    await Promise.resolve();
    // A promise that has settled cannot change its answer.
    const second = await pending.then(
      () => "resolved",
      (err: unknown) => err,
    );
    expect(second).toBe(first);
  });

  test("KNOWN GAP: the abandoned call is not cancelled", async () => {
    const clock = manualTimers();
    const inner = forever<string>();
    const pending = withTimeout("vendor", 100, () => inner.promise, { timers: clock.timers });
    clock.fire();
    await expect(pending).rejects.toBeInstanceOf(DependencyTimeoutError);
    // `withTimeout` has no handle on the in-flight promise, so the work keeps
    // running — and keeps its connection — after the caller has been answered.
    // Cancellation is `budgetSignal`'s job and the caller must plumb it.
    expect(inner.state.settled).toBe(false);
  });

  test("a caller's own rejection propagates unchanged", async () => {
    const clock = manualTimers();
    const boom = new RangeError("the vendor rejected the payload");
    await expect(
      withTimeout(
        "vendor",
        100,
        async () => {
          throw boom;
        },
        { timers: clock.timers },
      ),
    ).rejects.toBe(boom);
    expect(clock.clearedCount()).toBe(1);
  });

  test("KNOWN GAP: an inner AbortError that loses the race never reaches the caller", async () => {
    const clock = manualTimers();
    let rejectInner: (err: unknown) => void = () => {};
    const inner = new Promise<string>((_resolve, reject) => {
      rejectInner = reject;
    });
    const pending = withTimeout("vendor", 100, () => inner, { timers: clock.timers });
    clock.fire();
    await expect(pending).rejects.toBeInstanceOf(DependencyTimeoutError);

    // The abort that arrives afterwards is swallowed: the typed failure is
    // what the caller sees, never a raw AbortError.
    rejectInner(new DOMException("The operation was aborted.", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();
    await expect(pending).rejects.toBeInstanceOf(DependencyTimeoutError);
  });

  test("KNOWN GAP: an inner AbortError BEFORE the budget is passed through raw", async () => {
    const clock = manualTimers();
    const abort = new DOMException("The operation was aborted.", "AbortError");
    await expect(
      withTimeout(
        "vendor",
        100,
        async () => {
          throw abort;
        },
        { timers: clock.timers },
      ),
    ).rejects.toBe(abort);
    // `withTimeout` types the TIMEOUT, not every abort. An upstream signal
    // that aborts early still reaches the caller as a raw AbortError, so a
    // route that only handles DependencyTimeoutError leaks it as a 500.
  });

  const BAD_BUDGETS: { label: string; budget: number }[] = [
    { label: "zero", budget: 0 },
    { label: "negative", budget: -1 },
    { label: "large negative", budget: -Number.MAX_SAFE_INTEGER },
    { label: "NaN", budget: Number.NaN },
    { label: "Infinity", budget: Number.POSITIVE_INFINITY },
    { label: "-Infinity", budget: Number.NEGATIVE_INFINITY },
  ];

  test.each(BAD_BUDGETS)("a $label budget is refused before the call runs", async (row) => {
    const clock = manualTimers();
    let called = false;
    await expect(
      withTimeout(
        "vendor",
        row.budget,
        async () => {
          called = true;
          return "unreachable";
        },
        { timers: clock.timers },
      ),
    ).rejects.toBeInstanceOf(TimeoutBudgetError);
    expect(called).toBe(false);
    expect(clock.armedCount()).toBe(0);
  });

  test("KNOWN GAP: an absurdly large budget is accepted with no ceiling", async () => {
    const clock = manualTimers();
    let release: (value: string) => void = () => {};
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const pending = withTimeout("vendor", Number.MAX_SAFE_INTEGER, () => held, {
      timers: clock.timers,
    });
    // No upper bound is applied to a caller-supplied budget: ~285 000 years
    // is armed verbatim. TIMEOUT_EDGES is what bounds real calls;
    // `withTimeout` itself will not.
    expect(clock.armedMs()).toEqual([Number.MAX_SAFE_INTEGER]);
    release("ok");
    await expect(pending).resolves.toBe("ok");
  });
});

describe("REAL_TIMERS", () => {
  test("the default timer pair arms and disarms under the test clock", () => {
    vi.useFakeTimers();
    try {
      let fired = false;
      const handle = REAL_TIMERS.setTimeout(() => {
        fired = true;
      }, 25_000);
      vi.advanceTimersByTime(24_999);
      expect(fired).toBe(false);
      vi.advanceTimersByTime(1);
      expect(fired).toBe(true);
      // Clearing a handle that has already fired must be harmless: the timer pair
      // is used from a `finally`, which cannot know which branch it is in.
      REAL_TIMERS.clearTimeout(handle);

      let cancelled = false;
      const doomed = REAL_TIMERS.setTimeout(() => {
        cancelled = true;
      }, 60_000);
      REAL_TIMERS.clearTimeout(doomed);
      vi.advanceTimersByTime(120_000);
      expect(cancelled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("withTimeout falls back to the real timer pair when none is injected", async () => {
    vi.useFakeTimers();
    try {
      const slow = withTimeout("vendor", 100, () => forever<string>().promise);
      vi.advanceTimersByTime(99);
      vi.advanceTimersByTime(1);
      await expect(slow).rejects.toBeInstanceOf(DependencyTimeoutError);

      const quick = withTimeout("vendor", 100, async () => "fast");
      await expect(quick).resolves.toBe("fast");
      // The quick call disarmed its own timer, so nothing is left to fire.
      vi.advanceTimersByTime(1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═══ timeouts.ts — the abort signal that actually stops the work ═══════════════

describe("budgetSignal — the outbound call is cancelled, not just abandoned", () => {
  test("a fresh signal is not aborted", () => {
    vi.useFakeTimers();
    try {
      const { signal } = budgetSignal(1_000);
      expect(signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the signal fires exactly at the budget", () => {
    vi.useFakeTimers();
    try {
      const { signal } = budgetSignal(1_000);
      vi.advanceTimersByTime(999);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("dispose stops the timer, so a finished call is never aborted later", () => {
    vi.useFakeTimers();
    try {
      const { signal, dispose } = budgetSignal(1_000);
      dispose();
      vi.advanceTimersByTime(10_000);
      // Aborting the signal after the call completed would make a caller
      // reading `signal.reason` see a failure for work that succeeded.
      expect(signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an already-aborted parent aborts the child immediately", () => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController();
      parent.abort();
      const { signal } = budgetSignal(60_000, parent.signal);
      // Without this link the outbound fetch would outlive the request that
      // is already gone.
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a parent that aborts later aborts the child", () => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController();
      const { signal } = budgetSignal(60_000, parent.signal);
      expect(signal.aborted).toBe(false);
      parent.abort();
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("dispose detaches the parent listener, so an aborted request leaks nothing", () => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController();
      const { signal, dispose } = budgetSignal(60_000, parent.signal);
      dispose();
      parent.abort();
      // The listener is registered `once`, but removing it explicitly is
      // what keeps a long-lived parent from retaining a finished call.
      expect(signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("KNOWN GAP: a degenerate budget is accepted instead of refused", () => {
    vi.useFakeTimers();
    try {
      // `withTimeout` throws a TimeoutBudgetError for this same budget. Here
      // it goes straight to `setTimeout`, which clamps it to zero, so the
      // signal aborts on the first tick. It fails CLOSED — an instant abort,
      // never an unbounded one — so this is an inconsistency with its sibling
      // rather than a hole, but a mistyped budget gets no diagnosis at all.
      const { signal } = budgetSignal(0);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(0);
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═══ timeouts.ts — the published form of a timeout ═════════════════════════════

describe("envelopeForTimeout", () => {
  test("a DependencyTimeoutError becomes a 503 with a Retry-After", () => {
    const failure = publishable(
      envelopeForTimeout(new DependencyTimeoutError("elevenlabs.tts", 8_000), 5) ?? neverNull(),
    );
    // KNOWN GAP: the assignment asked for `statement_timeout` here. The module
    // publishes `dependency_unavailable`. Both rows are 503 + Retry-After +
    // retryable, so no caller can branch differently — but the code differs
    // from `db-failures.handleStatementTimeout`, which uses `statement_timeout`
    // for the same condition.
    expect(failure.body.code).toBe("dependency_unavailable");
    expect(failure.status).toBe(503);
    expect(failure.body.retryable).toBe(true);
    expect(failure.retryAfterSec).toBe(5);
    expect(failure.headers["Retry-After"]).toBe("5");
  });

  test("the published detail names the budget and nothing else", () => {
    const failure = envelopeForTimeout(
      new DependencyTimeoutError("twilio.dial.internal-voice", 15_000),
      5,
    );
    if (failure === null) throw new Error("expected a failure");
    expect(failure.detail).toBe("Budget of 15000 ms expired.");
    // The dependency name is a routing label, and a dependency name is
    // sometimes a hostname — so it is deliberately absent from the body.
    expect(failure.body.message).not.toContain("twilio");
    expect(failure.body.message).not.toContain("dial");
  });

  const CLAMPED: { label: string; asked: number; expected: number }[] = [
    { label: "a zero Retry-After becomes one second", asked: 0, expected: 1 },
    { label: "a negative Retry-After becomes one second", asked: -30, expected: 1 },
    { label: "a fractional Retry-After rounds", asked: 2.4, expected: 2 },
    { label: "an hour is the ceiling", asked: 99_999, expected: 3_600 },
  ];

  test.each(CLAMPED)("$label", ({ asked, expected }) => {
    const failure = envelopeForTimeout(new DependencyTimeoutError("vendor", 1_000), asked);
    if (failure === null) throw new Error("expected a failure");
    expect(failure.retryAfterSec).toBe(expected);
    expect(failure.headers["Retry-After"]).toBe(String(expected));
    expect(scanFailure(failure)).toEqual([]);
  });

  test("an unrepresentable Retry-After falls back to one second, not to none", () => {
    const failure = envelopeForTimeout(new DependencyTimeoutError("vendor", 1_000), Number.NaN);
    if (failure === null) throw new Error("expected a failure");
    // A 503 with no Retry-After reads to a client as "not now, maybe later".
    expect(failure.headers["Retry-After"]).toBe("1");
  });

  const NOT_A_TIMEOUT: { label: string; thrown: unknown }[] = [
    { label: "a plain Error", thrown: new Error("socket hang up") },
    { label: "a RangeError", thrown: new RangeError("budgetMs must be positive") },
    { label: "a DOMException AbortError", thrown: new DOMException("aborted", "AbortError") },
    { label: "a bare string", thrown: "connection reset" },
    { label: "null", thrown: null },
    { label: "undefined", thrown: undefined },
    { label: "a plain object", thrown: { code: "P1001" } },
  ];

  test.each(NOT_A_TIMEOUT)("$label is not published as a timeout", ({ thrown }) => {
    // The function is a filter, not a converter: anything that is not the
    // typed timeout must return null so the caller can decide what it was.
    expect(envelopeForTimeout(thrown, 5)).toBeNull();
  });
});

/** Fails the test with a clear message where a `Failure | null` is required. */
function neverNull(): never {
  throw new Error("expected a Failure, got null");
}

// ═══ db-failures.ts — reading an error without touching it ═════════════════════

describe("sqlstateOf / prismaCodeOf — one reader for every layer", () => {
  const RESOLVED: {
    label: string;
    err: unknown;
    sqlstate: string | null;
    prisma: string | null;
  }[] = [
    // A raw pg error: the SQLSTATE IS the code.
    { label: "23505", err: pgError("23505", "duplicate key"), sqlstate: "23505", prisma: null },
    { label: "40P01", err: pgError("40P01", "deadlock"), sqlstate: "40P01", prisma: null },
    {
      label: "a lower-case sqlstate is normalised",
      err: pgError("  23503 ", "fk"),
      sqlstate: "23503",
      prisma: null,
    },
    // Prisma hides the SQLSTATE, so its codes are resolved through the table.
    {
      label: "P2002",
      err: prismaError("P2002", ""),
      sqlstate: PG.UNIQUE_VIOLATION,
      prisma: "P2002",
    },
    {
      label: "P2003",
      err: prismaError("P2003", ""),
      sqlstate: PG.FOREIGN_KEY_VIOLATION,
      prisma: "P2003",
    },
    {
      label: "P2034",
      err: prismaError("P2034", ""),
      sqlstate: PG.DEADLOCK_DETECTED,
      prisma: "P2034",
    },
    {
      label: "P2024",
      err: prismaError("P2024", ""),
      sqlstate: PG.TOO_MANY_CONNECTIONS,
      prisma: "P2024",
    },
    { label: "P2028", err: prismaError("P2028", ""), sqlstate: PG.QUERY_CANCELED, prisma: "P2028" },
    {
      label: "P1001",
      err: prismaError("P1001", ""),
      sqlstate: PG.CONNECTION_FAILURE,
      prisma: "P1001",
    },
    // P2025 has a kind but no SQLSTATE of its own: a missing row is a 404, not
    // a driver state, so `sqlstate` is honestly null.
    { label: "P2025", err: prismaError("P2025", ""), sqlstate: null, prisma: "P2025" },
    // Node socket codes have no SQLSTATE, so they resolve to connection_failure.
    {
      label: "ECONNREFUSED",
      err: pgError("ECONNREFUSED", ""),
      sqlstate: PG.CONNECTION_FAILURE,
      prisma: null,
    },
    {
      label: "ETIMEDOUT",
      err: pgError("etimedout", ""),
      sqlstate: PG.CONNECTION_FAILURE,
      prisma: null,
    },
    {
      label: "EAI_AGAIN",
      err: pgError("EAI_AGAIN", ""),
      sqlstate: PG.CONNECTION_FAILURE,
      prisma: null,
    },
  ];

  test.each(RESOLVED)("resolves $label", ({ err, sqlstate, prisma }) => {
    expect(sqlstateOf(err)).toBe(sqlstate);
    expect(prismaCodeOf(err)).toBe(prisma);
  });

  const UNREADABLE: { label: string; err: unknown }[] = [
    { label: "null", err: null },
    { label: "undefined", err: undefined },
    { label: "a bare string", err: "connection reset" },
    { label: "a number", err: 42 },
    { label: "an object with no code", err: { message: "boom" } },
    { label: "a non-string code", err: { code: 23505 } },
    { label: "a blank code", err: { code: "   " } },
    { label: "a six-character code", err: { code: "235051" } },
  ];

  test.each(UNREADABLE)("$label yields no sqlstate and no prisma code", ({ err }) => {
    expect(sqlstateOf(err)).toBeNull();
    expect(prismaCodeOf(err)).toBeNull();
  });

  test("an unmapped Prisma code is read as Prisma but not invented into a SQLSTATE", () => {
    // A `P####` code is Prisma's, not a SQLSTATE: P0001-style PL/pgSQL raises
    // and Prisma's own codes are indistinguishable here, so the code is
    // reported and the SQLSTATE is honestly null rather than guessed.
    const err = { code: "P9999" };
    expect(prismaCodeOf(err)).toBe("P9999");
    expect(sqlstateOf(err)).toBeNull();
  });
});

describe("fieldsOf / fieldOf — the value never crosses the boundary", () => {
  test("Prisma's compound constraint name resolves to the field", () => {
    const err = prismaError(PRISMA.UNIQUE_CONSTRAINT, UNIQUE_PRISMA_MESSAGE, {
      target: ["idemKey", "orgId"],
    });
    // `UsageLedger_orgId_idemKey_key` → idemKey, `Case_orgId_fkey` → orgId.
    expect(fieldsOf(err)).toEqual(["idemKey", "orgId"]);
    expect(fieldOf(err)).toBe("idemKey");
  });

  test("a bare field name and a comma list both normalise", () => {
    expect(fieldsOf(prismaError("P2002", "", { target: "orgId" }))).toEqual(["orgId"]);
    expect(fieldsOf(pgError("23505", "", { meta: { target: "orgId, caseRef" } }))).toEqual([
      "caseRef",
      "orgId",
    ]);
  });

  test("the driver's foreign-key text yields the column and drops the value", () => {
    const err = pgError(PG.FOREIGN_KEY_VIOLATION, FK_DRIVER_MESSAGE);
    expect(fieldsOf(err)).toEqual(["orgId"]);
    expect(fieldOf(err)).toBe("orgId");
    // The value on the right of the `=` is another organisation's identifier
    // and the table is our schema; neither may be extracted.
    for (const field of fieldsOf(err)) {
      expect(field).not.toContain("org_9f2c");
      expect(field).not.toContain("Case");
    }
  });

  test("a generated FK constraint name resolves to its column", () => {
    const err = pgError(
      PG.FOREIGN_KEY_VIOLATION,
      'violates foreign key constraint "Case_orgId_fkey"',
    );
    expect(fieldOf(err)).toBe("orgId");
  });

  test("an error with nothing to extract yields no fields rather than a guess", () => {
    expect(fieldsOf(pgError("23505", "duplicate key value"))).toEqual([]);
    expect(fieldOf(pgError("23505", "duplicate key value"))).toBeNull();
    expect(fieldOf(null)).toBeNull();
    expect(fieldsOf("a bare string")).toEqual([]);
  });

  test("fields are de-duplicated and sorted, so two names never appear twice", () => {
    const err = prismaError("P2002", UNIQUE_PRISMA_MESSAGE, {
      target: ["orgId", "idemKey", "orgId"],
    });
    expect(fieldsOf(err)).toEqual(["idemKey", "orgId"]);
  });
});

// ═══ db-failures.ts — the classification matrix ═══════════════════════════════

describe("classifyDatabaseError — the whole matrix, one row at a time", () => {
  const MATRIX: {
    label: string;
    err: unknown;
    kind: DatabaseFailureKind;
    sqlstate: string | null;
    driver: "postgres" | "prisma" | "node" | "unknown";
  }[] = [
    // ── the Prisma vocabulary ──
    {
      label: "P2024 pool timeout",
      err: prismaError("P2024", ""),
      kind: "pool_exhausted",
      sqlstate: PG.TOO_MANY_CONNECTIONS,
      driver: "prisma",
    },
    {
      label: "P1001 cannot reach the server",
      err: prismaError("P1001", ""),
      kind: "primary_unreachable",
      sqlstate: PG.CONNECTION_FAILURE,
      driver: "prisma",
    },
    {
      label: "P2002 unique",
      err: prismaError("P2002", "", { target: ["idemKey"] }),
      kind: "unique_violation",
      sqlstate: PG.UNIQUE_VIOLATION,
      driver: "prisma",
    },
    {
      label: "P2003 foreign key",
      err: prismaError("P2003", "", { field_name: "orgId" }),
      kind: "foreign_key_violation",
      sqlstate: PG.FOREIGN_KEY_VIOLATION,
      driver: "prisma",
    },
    {
      label: "P2034 transaction conflict",
      err: prismaError("P2034", ""),
      kind: "deadlock",
      sqlstate: PG.DEADLOCK_DETECTED,
      driver: "prisma",
    },
    {
      label: "P2028 operation timeout",
      err: prismaError("P2028", ""),
      kind: "statement_timeout",
      sqlstate: PG.QUERY_CANCELED,
      driver: "prisma",
    },
    {
      label: "P2025 not found",
      err: prismaError("P2025", ""),
      kind: "record_not_found",
      sqlstate: null,
      driver: "prisma",
    },
    // ── raw SQLSTATEs ──
    {
      label: "53300 too many connections",
      err: pgError("53300", ""),
      kind: "pool_exhausted",
      sqlstate: "53300",
      driver: "postgres",
    },
    {
      label: "57014 query canceled",
      err: pgError("57014", ""),
      kind: "statement_timeout",
      sqlstate: "57014",
      driver: "postgres",
    },
    {
      label: "55P03 lock not available",
      err: pgError("55P03", ""),
      kind: "statement_timeout",
      sqlstate: "55P03",
      driver: "postgres",
    },
    {
      label: "40P01 deadlock",
      err: pgError("40P01", ""),
      kind: "deadlock",
      sqlstate: "40P01",
      driver: "postgres",
    },
    {
      label: "40001 serialization failure",
      err: pgError("40001", ""),
      kind: "serialization_failure",
      sqlstate: "40001",
      driver: "postgres",
    },
    {
      label: "23505 unique",
      err: pgError("23505", ""),
      kind: "unique_violation",
      sqlstate: "23505",
      driver: "postgres",
    },
    {
      label: "23503 foreign key",
      err: pgError("23503", FK_DRIVER_MESSAGE),
      kind: "foreign_key_violation",
      sqlstate: "23503",
      driver: "postgres",
    },
    {
      label: "23514 check",
      err: pgError("23514", ""),
      kind: "check_violation",
      sqlstate: "23514",
      driver: "postgres",
    },
    {
      label: "08006 connection failure",
      err: pgError("08006", ""),
      kind: "primary_unreachable",
      sqlstate: "08006",
      driver: "postgres",
    },
    {
      label: "08003 connection does not exist",
      err: pgError("08003", ""),
      kind: "primary_unreachable",
      sqlstate: "08003",
      driver: "postgres",
    },
    {
      label: "08001 connection refused",
      err: pgError("08001", ""),
      kind: "primary_unreachable",
      sqlstate: "08001",
      driver: "postgres",
    },
    {
      label: "57P03 cannot connect now",
      err: pgError("57P03", ""),
      kind: "primary_unreachable",
      sqlstate: "57P03",
      driver: "postgres",
    },
    {
      label: "57P01 admin shutdown",
      err: pgError("57P01", ""),
      kind: "primary_unreachable",
      sqlstate: "57P01",
      driver: "postgres",
    },
    {
      label: "53100 disk full",
      err: pgError("53100", ""),
      kind: "storage_full",
      sqlstate: "53100",
      driver: "postgres",
    },
    {
      label: "53200 out of memory",
      err: pgError("53200", ""),
      kind: "storage_full",
      sqlstate: "53200",
      driver: "postgres",
    },
    // ── node socket codes ──
    {
      label: "ECONNREFUSED",
      err: pgError("ECONNREFUSED", ""),
      kind: "primary_unreachable",
      sqlstate: PG.CONNECTION_FAILURE,
      driver: "node",
    },
    {
      label: "EPIPE",
      err: pgError("EPIPE", ""),
      kind: "primary_unreachable",
      sqlstate: PG.CONNECTION_FAILURE,
      driver: "node",
    },
    {
      label: "ENOTFOUND",
      err: pgError("ENOTFOUND", ""),
      kind: "primary_unreachable",
      sqlstate: PG.CONNECTION_FAILURE,
      driver: "node",
    },
  ];

  test.each(MATRIX)("$label → $kind", ({ err, kind, sqlstate, driver }) => {
    const classification = classifyDatabaseError(err);
    expect(classification.kind).toBe(kind);
    expect(classification.sqlstate).toBe(sqlstate);
    expect(classification.driver).toBe(driver);
  });

  test("only the two row-violating kinds carry fields", () => {
    // A pool error names no column, and reporting one would be a guess.
    expect(classifyDatabaseError(pgError("53300", "")).fields).toEqual([]);
    expect(classifyDatabaseError(prismaError("P2002", "", { target: ["idemKey"] })).fields).toEqual(
      ["idemKey"],
    );
    expect(classifyDatabaseError(pgError("23503", FK_DRIVER_MESSAGE)).fields).toEqual(["orgId"]);
  });

  const NON_DATABASE: { label: string; thrown: unknown }[] = [
    { label: "null", thrown: null },
    { label: "undefined", thrown: undefined },
    { label: "a bare string", thrown: "unique constraint failed" },
    { label: "a number", thrown: 500 },
    { label: "a boolean", thrown: true },
    { label: "a function", thrown: () => undefined },
  ];

  test.each(NON_DATABASE)(
    "$thrown is not a database error, and classifying it does not throw",
    ({ thrown }) => {
      expect(classifyDatabaseError(thrown)).toEqual({
        kind: "not_a_database_error",
        sqlstate: null,
        fields: [],
        driver: "unknown",
      });
    },
  );

  const UNRECOGNISED: { label: string; thrown: unknown }[] = [
    { label: "an Error with an unfamiliar code", thrown: new Error("driver exploded") },
    {
      label: "a Prisma code the matrix does not know",
      thrown: prismaError("P2015", "dependent operation failed"),
    },
    { label: "an unfamiliar SQLSTATE", thrown: pgError("XX000", "internal error") },
    { label: "a bare object", thrown: {} },
    { label: "a code that is not a string", thrown: { code: 42, message: "weird" } },
  ];

  test.each(UNRECOGNISED)(
    "$label falls through to unknown rather than being forced into a row",
    ({ thrown }) => {
      // `unknown` is the ONLY row that reaches the 500 default, so a mistake
      // here is visible as a 500 rather than as a mislabelled 409.
      expect(classifyDatabaseError(thrown).kind).toBe("unknown");
    },
  );

  test("KNOWN GAP: P2015 is declared but unmapped, so it lands on unknown", () => {
    expect(PRISMA.DEPENDENT_OPERATION_FAILED).toBe("P2015");
    // The code table reads as a closed set and is not one: P2015 appears in
    // neither mapping table, so it is reported as a bug on our side.
    expect(classifyDatabaseError(prismaError(PRISMA.DEPENDENT_OPERATION_FAILED, "")).kind).toBe(
      "unknown",
    );
  });
});

describe("isRetryableTransactionConflict", () => {
  test("only the two conflict kinds may be replayed", () => {
    // Replaying a unique violation cannot succeed, and replaying a pool
    // exhaustion would queue behind the pool we just refused to wait on.
    for (const kind of ["deadlock", "serialization_failure"] as const) {
      expect(isRetryableTransactionConflict(kind)).toBe(true);
    }
    for (const kind of [
      "pool_exhausted",
      "statement_timeout",
      "unique_violation",
      "foreign_key_violation",
      "check_violation",
      "record_not_found",
      "primary_unreachable",
      "storage_full",
      "not_a_database_error",
      "unknown",
    ] as const) {
      expect(isRetryableTransactionConflict(kind)).toBe(false);
    }
  });
});

// ═══ db-failures.ts — row: pool exhausted ═════════════════════════════════════

describe("handlePoolExhausted — shed, never queue behind a connection", () => {
  test("P2024 sheds with a 503 and a Retry-After", () => {
    const decision = handlePoolExhausted({ err: prismaError(PRISMA.POOL_TIMEOUT, "") });
    expect(decision.action).toBe("shed");
    expect(decision.queuedBehindConnection).toBe(false);
    expect(decision.maxWaitMsRecommended).toBe(0);
    expect(decision.retryAfterSec).toBe(DEFAULT_SHED_RETRY_AFTER_SEC);
    expect(decision.sqlstate).toBe(PG.TOO_MANY_CONNECTIONS);
    expect(publishable(decision.failure).status).toBe(503);
    expect(decision.failure.body.code).toBe("db_capacity_shed");
    expect(decision.failure.headers["Retry-After"]).toBe(String(DEFAULT_SHED_RETRY_AFTER_SEC));
  });

  test("a caller-supplied Retry-After is honoured", () => {
    const decision = handlePoolExhausted({ err: pgError("53300", ""), retryAfterSec: 30 });
    expect(decision.retryAfterSec).toBe(30);
    expect(decision.failure.headers["Retry-After"]).toBe("30");
    expect(scanFailure(decision.failure)).toEqual([]);
  });

  test("the handler does not care what the error was — it is the row that decides", () => {
    // A caller that misfiles an error into this row gets the shed, because
    // the declaration is about the decision, not about the diagnosis.
    const decision = handlePoolExhausted({ err: null });
    expect(decision.action).toBe("shed");
    expect(decision.sqlstate).toBeNull();
    expect(scanFailure(decision.failure)).toEqual([]);
  });
});

// ═══ db-failures.ts — row: statement timeout ══════════════════════════════════

describe("handleStatementTimeout — typed timeout, never a hanging request", () => {
  test("P2028 abandons with a 503 statement_timeout and a Retry-After", () => {
    const decision = handleStatementTimeout({
      err: prismaError(PRISMA.OPERATION_TIMEOUT, "Timed out fetching a new connection"),
    });
    expect(decision.action).toBe("abandon");
    expect(decision.abandoned).toBe(true);
    expect(decision.sqlstate).toBe(PG.QUERY_CANCELED);
    // The exact code and status a caller can act on.
    expect(decision.failure.body.code).toBe("statement_timeout");
    expect(decision.failure.status).toBe(503);
    expect(decision.failure.body.retryable).toBe(true);
    expect(decision.failure.headers["Retry-After"]).toBe(String(DEFAULT_TIMEOUT_RETRY_AFTER_SEC));
    expect(scanFailure(decision.failure)).toEqual([]);
  });

  test("elapsedMs defaults to the budget when nothing measured it", () => {
    const decision = handleStatementTimeout({ err: pgError("57014", ""), budgetMs: 3_000 });
    expect(decision.budgetMs).toBe(3_000);
    expect(decision.elapsedMs).toBe(3_000);

    const measured = handleStatementTimeout({
      err: pgError("57014", ""),
      budgetMs: 3_000,
      elapsedMs: 2_950,
    });
    expect(measured.elapsedMs).toBe(2_950);
  });

  test("a real driver timeout message is publishable", () => {
    const decision = handleStatementTimeout({
      err: pgError(
        "57014",
        "canceling statement due to statement timeout\nnode_modules/@prisma/…/query.ts:412:15",
      ),
      budgetMs: 3_000,
    });
    expect(decision.failure.body.code).toBe("statement_timeout");
    // A stack frame or a node_modules path in the published message is the
    // exact leak this gate exists to catch.
    expect(scanFailure(decision.failure)).toEqual([]);
  });
});

describe("withTimeoutBudget — the proactive half of the timeout row", () => {
  test("a call inside its budget resolves and disarms its timer", async () => {
    const clock = manualTimers();
    let release: (value: string) => void = () => {};
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const pending = withTimeoutBudget(() => held, 3_000, { timers: clock.timers });
    expect(clock.armedMs()).toEqual([3_000]);
    release("row");
    await expect(pending).resolves.toBe("row");
    expect(clock.armedCount()).toBe(0);
    expect(clock.clearedCount()).toBe(1);
  });

  test("a call that overruns rejects with the typed DbTimeoutError", async () => {
    const clock = manualTimers();
    const pending = withTimeoutBudget(() => forever<string>().promise, 3_000, {
      timers: clock.timers,
    });
    clock.fire();
    let thrown: unknown;
    try {
      await pending;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DbTimeoutError);
    if (!(thrown instanceof DbTimeoutError)) return;
    expect(thrown.budgetMs).toBe(3_000);
    expect(thrown.sqlstate).toBeNull();
    // The typed error carries no driver detail, so it is safe to publish.
    expect(Object.keys(thrown).sort()).toEqual(["budgetMs", "name", "sqlstate"]);
  });

  test("a DbTimeoutError feeds the statement-timeout row publishably", () => {
    const decision = handleStatementTimeout({
      err: new DbTimeoutError(3_000),
      budgetMs: 3_000,
    });
    expect(decision.failure.body.code).toBe("statement_timeout");
    expect(scanFailure(decision.failure)).toEqual([]);
  });

  const BAD: { label: string; budget: number }[] = [
    { label: "zero", budget: 0 },
    { label: "negative", budget: -1 },
    { label: "NaN", budget: Number.NaN },
    { label: "Infinity", budget: Number.POSITIVE_INFINITY },
  ];

  test.each(BAD)("a $label budget is refused with a RangeError", (row) => {
    const clock = manualTimers();
    expect(() => withTimeoutBudget(async () => "x", row.budget, { timers: clock.timers })).toThrow(
      RangeError,
    );
    expect(clock.armedCount()).toBe(0);
  });
});

// ═══ db-failures.ts — rows: deadlock and serialisation ════════════════════════

describe("transactionBackoffMs", () => {
  test("the ladder is exponential and jittered inside [50%, 100%] of the ceiling", () => {
    const base = TX_RETRY_BASE_BACKOFF_MS;
    for (let retry = 1; retry <= 6; retry += 1) {
      const ceiling = base * Math.pow(2, retry - 1);
      const low = transactionBackoffMs(retry, () => 0, base);
      const high = transactionBackoffMs(retry, () => 1, base);
      expect(low).toBe(Math.round(ceiling * 0.5));
      expect(high).toBe(Math.round(ceiling));
      // The jitter window is the whole point: a herd that all retries at
      // the same instant is the failure the jitter exists to prevent.
      expect(low).toBeGreaterThanOrEqual(Math.round(ceiling * 0.5));
      expect(high).toBeLessThanOrEqual(Math.round(ceiling));
    }
  });

  test("each rung is at least as long as the one before it", () => {
    const rand = () => 0.5;
    const ladder = [1, 2, 3, 4].map((n) => transactionBackoffMs(n, rand, 25));
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i] ?? 0).toBeGreaterThan(ladder[i - 1] ?? 0);
    }
  });

  test("retry numbers below 1 are treated as the first retry", () => {
    const first = transactionBackoffMs(1, () => 0.5);
    expect(transactionBackoffMs(0, () => 0.5)).toBe(first);
    expect(transactionBackoffMs(-5, () => 0.5)).toBe(first);
  });

  const OUT_OF_RANGE: { label: string; rand: () => number; expectedFactor: number }[] = [
    { label: "a negative draw clamps to the bottom", rand: () => -3, expectedFactor: 0.5 },
    { label: "a draw above 1 clamps to the top", rand: () => 7, expectedFactor: 1 },
    { label: "a NaN draw falls back to the middle", rand: () => Number.NaN, expectedFactor: 0.75 },
    {
      label: "an Infinity draw falls back to the middle",
      rand: () => Number.POSITIVE_INFINITY,
      expectedFactor: 0.75,
    },
  ];

  test.each(OUT_OF_RANGE)("$label", ({ rand, expectedFactor }) => {
    expect(transactionBackoffMs(1, rand, 100)).toBe(Math.round(100 * expectedFactor));
  });

  test("KNOWN GAP: rand is drawn twice per computation", () => {
    let calls = 0;
    transactionBackoffMs(1, () => {
      calls += 1;
      return 0.5;
    });
    // The finiteness guard consumes one draw and the clamp consumes another.
    // Harmless with Math.random; with a stateful PRNG the ladder advances
    // twice per rung.
    expect(calls).toBe(2);
  });
});

describe("handleTransactionConflict", () => {
  test("a deadlock asks for a retry and publishes nothing yet", () => {
    const decision = handleTransactionConflict({ err: pgError("40P01", "deadlock detected") });
    expect(decision.action).toBe("retry");
    expect(decision.kind).toBe("deadlock");
    expect(decision.failure).toBeNull();
    expect(decision.sqlstate).toBe("40P01");
  });

  test("a serialisation failure asks for a retry", () => {
    const decision = handleTransactionConflict({ err: pgError("40001", "") });
    expect(decision.action).toBe("retry");
    expect(decision.kind).toBe("serialization_failure");
  });

  test("Prisma's P2034 is a retry, not a 500", () => {
    const decision = handleTransactionConflict({
      err: prismaError(PRISMA.TRANSACTION_CONFLICT, ""),
    });
    expect(decision.action).toBe("retry");
    expect(decision.kind).toBe("deadlock");
  });

  const NOT_RETRIED: { label: string; err: unknown }[] = [
    { label: "a unique violation", err: prismaError(PRISMA.UNIQUE_CONSTRAINT, "") },
    { label: "pool exhaustion", err: prismaError(PRISMA.POOL_TIMEOUT, "") },
    { label: "a statement timeout", err: prismaError(PRISMA.OPERATION_TIMEOUT, "") },
    { label: "an unknown error", err: new Error("driver exploded") },
    { label: "a non-error throw", err: "nope" },
  ];

  test.each(NOT_RETRIED)("$label is not replayed", ({ err }) => {
    const decision = handleTransactionConflict({ err });
    expect(decision.action).toBe("fail");
    expect(decision.kind).toBe("not_retryable");
  });
});

// ═══ db-failures.ts — the retry ladder ════════════════════════════════════════

describe("runTransactionWithRetry", () => {
  const noSleep = async (): Promise<void> => {};
  const half = (): number => 0.5;

  test("a first-attempt success never sleeps and never retries", async () => {
    let attempts = 0;
    const outcome = await runTransactionWithRetry(
      async (attempt) => {
        attempts += 1;
        return `attempt ${attempt}`;
      },
      { sleep: noSleep, rand: half },
    );
    expect(outcome).toEqual({
      ok: true,
      value: "attempt 1",
      attempts: 1,
      retriedOn: [],
      backoffsMs: [],
    });
    expect(attempts).toBe(1);
  });

  test("a deadlock is retried up to three times, then reported as contended", async () => {
    const slept: number[] = [];
    const outcome = await runTransactionWithRetry(
      async () => {
        throw pgError("40P01", "deadlock detected");
      },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
        rand: half,
        requestId: "svreq_retry",
      },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Three RETRIES after the initial attempt: four attempts in total.
    expect(outcome.attempts).toBe(MAX_TX_RETRIES + 1);
    expect(outcome.retriedOn).toEqual(["40P01", "40P01", "40P01"]);
    expect(outcome.backoffsMs).toEqual([19, 38, 75]);
    expect(slept).toEqual(outcome.backoffsMs);
    // The database is healthy; this transaction simply keeps losing, so the
    // caller is told 409 retryable — not 503 and certainly not 500.
    expect(publishable(outcome.failure).status).toBe(409);
    expect(outcome.failure.body.code).toBe("transaction_contended");
    expect(outcome.failure.body.retryable).toBe(true);
    expect(outcome.failure.headers["Retry-After"]).toBeUndefined();
    expect(outcome.kind).toBe("deadlock");
  });

  test("a transaction that recovers mid-ladder returns its value and stops", async () => {
    const outcome = await runTransactionWithRetry(
      async (attempt) => {
        if (attempt < 3) throw pgError("40001", "");
        return "committed";
      },
      { sleep: noSleep, rand: half },
    );
    expect(outcome).toEqual({
      ok: true,
      value: "committed",
      attempts: 3,
      retriedOn: ["40001", "40001"],
      backoffsMs: [19, 38],
    });
  });

  test("a non-retryable error fails on the first attempt with no backoff", async () => {
    let attempts = 0;
    const outcome = await runTransactionWithRetry(
      async () => {
        attempts += 1;
        throw prismaError(PRISMA.UNIQUE_CONSTRAINT, UNIQUE_PRISMA_MESSAGE);
      },
      { sleep: noSleep, rand: half },
    );
    expect(attempts).toBe(1);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.retriedOn).toEqual([]);
    expect(outcome.backoffsMs).toEqual([]);
    expect(outcome.failure.status).toBe(409);
    expect(outcome.failure.body.code).toBe("unique_conflict");
  });

  test("retries: 0 gives exactly one attempt", async () => {
    const outcome = await runTransactionWithRetry(
      async () => {
        throw pgError("40P01", "");
      },
      { sleep: noSleep, rand: half, retries: 0 },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.failure.body.code).toBe("transaction_contended");
  });

  test("onRetry is told what is being retried, before the sleep", async () => {
    const seen: {
      retryNumber: number;
      sqlstate: string | null;
      kind: DatabaseFailureKind;
      delayMs: number;
    }[] = [];
    await runTransactionWithRetry(
      async (attempt) => {
        if (attempt === 1) throw pgError("40P01", "");
        return "ok";
      },
      {
        sleep: noSleep,
        rand: half,
        onRetry: (info) => seen.push(info),
      },
    );
    expect(seen).toEqual([{ retryNumber: 1, sqlstate: "40P01", kind: "deadlock", delayMs: 19 }]);
  });

  test("a failure with no sqlstate is journalled by its kind", () => {
    return (async () => {
      const outcome = await runTransactionWithRetry(
        async (attempt) => {
          if (attempt === 1) throw prismaError(PRISMA.TRANSACTION_CONFLICT, "");
          return "ok";
        },
        { sleep: noSleep, rand: half },
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.retriedOn).toEqual([PG.DEADLOCK_DETECTED]);
    })();
  });
});

// ═══ db-failures.ts — the kind → failure mapping ══════════════════════════════

describe("the failure each database kind produces", () => {
  /**
   * Driven through `runTransactionWithRetry({ retries: 0 })`, which is the only
   * public path to the mapping table. One attempt, no backoff, no database.
   */
  async function failureFor(thrown: unknown): Promise<Failure> {
    const outcome = await runTransactionWithRetry(
      async () => {
        throw thrown;
      },
      { retries: 0, sleep: async () => {}, rand: () => 0.5 },
    );
    if (outcome.ok) throw new Error("expected the transaction to fail");
    return outcome.failure;
  }

  const MAPPING: {
    label: string;
    thrown: unknown;
    code: FailureCode;
    status: number;
    kind: DatabaseFailureKind;
  }[] = [
    {
      label: "P2002 unique → 409, never a 500",
      thrown: prismaError(PRISMA.UNIQUE_CONSTRAINT, UNIQUE_PRISMA_MESSAGE),
      code: "unique_conflict",
      status: 409,
      kind: "unique_violation",
    },
    {
      label: "P2003 foreign key → 409",
      thrown: prismaError(PRISMA.FOREIGN_KEY_CONSTRAINT, ""),
      code: "reference_conflict",
      status: 409,
      kind: "foreign_key_violation",
    },
    {
      label: "P2025 not found → 404, not a 500",
      thrown: prismaError(PRISMA.RECORD_NOT_FOUND, ""),
      code: "not_found",
      status: 404,
      kind: "record_not_found",
    },
    {
      label: "P2034 conflict → 409 retryable",
      thrown: prismaError(PRISMA.TRANSACTION_CONFLICT, ""),
      code: "transaction_contended",
      status: 409,
      kind: "deadlock",
    },
    {
      label: "P2024 pool timeout → 503",
      thrown: prismaError(PRISMA.POOL_TIMEOUT, ""),
      code: "db_capacity_shed",
      status: 503,
      kind: "pool_exhausted",
    },
    {
      label: "P2028 operation timeout → 503",
      thrown: prismaError(PRISMA.OPERATION_TIMEOUT, ""),
      code: "statement_timeout",
      status: 503,
      kind: "statement_timeout",
    },
    {
      label: "P1001 unreachable → 503 dependency, not 500",
      thrown: prismaError(
        PRISMA.CANNOT_REACH_SERVER,
        "Can't reach database server at `db.internal:5432`",
      ),
      code: "dependency_unavailable",
      status: 503,
      kind: "primary_unreachable",
    },
    {
      label: "23505 unique → 409",
      thrown: pgError(
        PG.UNIQUE_VIOLATION,
        'duplicate key value violates unique constraint "UsageLedger_idemKey_key"',
      ),
      code: "unique_conflict",
      status: 409,
      kind: "unique_violation",
    },
    {
      label: "23503 foreign key → 409",
      thrown: pgError(PG.FOREIGN_KEY_VIOLATION, FK_DRIVER_MESSAGE),
      code: "reference_conflict",
      status: 409,
      kind: "foreign_key_violation",
    },
    {
      label: "23514 check → 422",
      thrown: pgError(PG.CHECK_VIOLATION, 'violates check constraint "Case_status_check"'),
      code: "semantically_invalid",
      status: 422,
      kind: "check_violation",
    },
    {
      label: "40P01 deadlock → 409 retryable",
      thrown: pgError(PG.DEADLOCK_DETECTED, "deadlock detected"),
      code: "transaction_contended",
      status: 409,
      kind: "deadlock",
    },
    {
      label: "40001 serialisation → 409 retryable",
      thrown: pgError(PG.SERIALIZATION_FAILURE, ""),
      code: "transaction_contended",
      status: 409,
      kind: "serialization_failure",
    },
    {
      label: "53300 pool exhausted → 503",
      thrown: pgError(PG.TOO_MANY_CONNECTIONS, "sorry, too many clients already"),
      code: "db_capacity_shed",
      status: 503,
      kind: "pool_exhausted",
    },
    {
      label: "57014 canceled → 503",
      thrown: pgError(PG.QUERY_CANCELED, "canceling statement due to statement timeout"),
      code: "statement_timeout",
      status: 503,
      kind: "statement_timeout",
    },
    {
      label: "ECONNREFUSED → 503",
      thrown: pgError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.7:5432"),
      code: "dependency_unavailable",
      status: 503,
      kind: "primary_unreachable",
    },
    {
      label: "53100 disk full → 503",
      thrown: pgError(PG.DISK_FULL, "could not extend file: No space left on device"),
      code: "db_capacity_shed",
      status: 503,
      kind: "storage_full",
    },
    // ── the 500 row, and only the 500 row ──
    {
      label: "an unrecognised code → 500 internal_bug",
      thrown: pgError("XX000", "internal error"),
      code: "internal_bug",
      status: 500,
      kind: "unknown",
    },
    {
      label: "a bare Error → 500 internal_bug",
      thrown: new Error("the driver gave up"),
      code: "internal_bug",
      status: 500,
      kind: "unknown",
    },
    {
      label: "a non-Error throw → 500, never a crash",
      thrown: "unique constraint failed on the fields: (`idemKey`)",
      code: "internal_bug",
      status: 500,
      kind: "not_a_database_error",
    },
    {
      label: "null → 500, never a crash",
      thrown: null,
      code: "internal_bug",
      status: 500,
      kind: "not_a_database_error",
    },
    {
      label: "undefined → 500, never a crash",
      thrown: undefined,
      code: "internal_bug",
      status: 500,
      kind: "not_a_database_error",
    },
  ];

  test.each(MAPPING)("$label", async ({ thrown, code, status }) => {
    const failure = publishable(await failureFor(thrown));
    expect(failure.body.code).toBe(code);
    expect(failure.status).toBe(status);
    expect(status).not.toBe(200);
  });

  test("the classified kind matches the mapping that was taken", async () => {
    for (const row of MAPPING) {
      const outcome = await runTransactionWithRetry(
        async () => {
          throw row.thrown;
        },
        { retries: 0, sleep: async () => {}, rand: () => 0.5 },
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.kind).toBe(row.kind);
    }
  });

  test("every 503 carries a Retry-After and every 4xx does not", async () => {
    // A 503 with no Retry-After reads to a client as "not now, maybe later";
    // a 409 with one invites a caller to loop on a decision that will not
    // change. The discipline table is the contract.
    for (const row of MAPPING) {
      const failure = await failureFor(row.thrown);
      const retryAfter = failure.headers["Retry-After"];
      if (failure.status === 503) expect(retryAfter).toBeDefined();
      else expect(retryAfter).toBeUndefined();
    }
  });

  test("a connection-level failure is a 503 dependency, never a 500", async () => {
    // Telling the caller "internal error" for a database that is simply not
    // there is what turns a failover into a page.
    for (const code of [PRISMA.CANNOT_REACH_SERVER, PG.CONNECTION_FAILURE, PG.ADMIN_SHUTDOWN]) {
      const failure = await failureFor(prismaError(code, ""));
      expect(failure.status).toBe(503);
      expect(failure.body.code).toBe("dependency_unavailable");
    }
  });

  test("the 500 row is reached ONLY by unknown and not_a_database_error", async () => {
    const fiveHundreds: DatabaseFailureKind[] = [];
    for (const row of MAPPING) {
      const failure = await failureFor(row.thrown);
      if (failure.status === 500) fiveHundreds.push(row.kind);
    }
    expect([...new Set(fiveHundreds)].sort()).toEqual(["not_a_database_error", "unknown"]);
  });
});

// ═══ db-failures.ts — row: unique violation ═══════════════════════════════════

describe("handleUniqueViolation", () => {
  test("with no idempotency store it is a typed 409, never a 500", async () => {
    const decision = await handleUniqueViolation({
      err: prismaError(PRISMA.UNIQUE_CONSTRAINT, UNIQUE_PRISMA_MESSAGE, {
        target: ["idemKey", "orgId"],
      }),
    });
    expect(decision.action).toBe("conflict");
    expect(decision.replay).toBeNull();
    expect(decision.fields).toEqual(["idemKey", "orgId"]);
    expect(decision.sqlstate).toBe(PG.UNIQUE_VIOLATION);
    expect(publishable(decision.failure ?? neverNull()).status).toBe(409);
    expect(decision.failure?.body.code).toBe("unique_conflict");
  });

  test("a stored 2xx answer is replayed verbatim and nothing is published", async () => {
    const seen: string[][] = [];
    const body = { decisionId: "dec_1", state: "intercepted" };
    const decision = await handleUniqueViolation({
      err: prismaError(PRISMA.UNIQUE_CONSTRAINT, UNIQUE_PRISMA_MESSAGE, {
        target: ["idemKey"],
      }),
      lookupIdempotent: async (fields) => {
        seen.push(fields);
        return { status: 200, body };
      },
    });
    expect(decision.action).toBe("replay_idempotent");
    expect(decision.failure).toBeNull();
    expect(decision.replay).toEqual({ status: 200, body });
    // The lookup is handed the normalised field names, not the raw target.
    expect(seen).toEqual([["idemKey", "orgId"]]);
  });

  test("a stored answer that was itself a failure is not replayed", async () => {
    // Replaying a 500 forever would hand one customer an unreviewable error
    // for as long as the idempotency row survives.
    const decision = await handleUniqueViolation({
      err: prismaError(PRISMA.UNIQUE_CONSTRAINT, ""),
      lookupIdempotent: async () => ({ status: 500, body: { message: "boom" } }),
    });
    expect(decision.action).toBe("conflict");
    expect(decision.replay).toBeNull();
    expect(decision.failure?.status).toBe(409);
  });

  test("a miss in the idempotency store falls through to the conflict", async () => {
    const decision = await handleUniqueViolation({
      err: prismaError(PRISMA.UNIQUE_CONSTRAINT, ""),
      lookupIdempotent: async () => null,
    });
    expect(decision.action).toBe("conflict");
    expect(decision.failure?.body.code).toBe("unique_conflict");
  });
});

// ═══ db-failures.ts — row: foreign-key violation ═════════════════════════════

describe("handleReferenceViolation — the field crosses, the value does not", () => {
  test("Prisma's meta.field_name names the field", () => {
    const decision = handleReferenceViolation({
      err: prismaError(PRISMA.FOREIGN_KEY_CONSTRAINT, "", { field_name: "orgId" }),
    });
    expect(decision.action).toBe("conflict");
    expect(decision.field).toBe("orgId");
    expect(decision.sqlstate).toBe(PG.FOREIGN_KEY_VIOLATION);
    expect(decision.failure.status).toBe(409);
    expect(decision.failure.body.code).toBe("reference_conflict");
    expect(decision.failure.detail).toContain("orgId");
    expect(scanFailure(decision.failure)).toEqual([]);
  });

  test("the driver's row id and table name never reach the failure", () => {
    const decision = handleReferenceViolation({
      err: pgError(PG.FOREIGN_KEY_VIOLATION, FK_DRIVER_MESSAGE),
    });
    expect(decision.field).toBe("orgId");
    // `org_9f2c4a17e0b34d55` is another organisation's identifier and
    // `"Case"` is our schema. Only the column name is allowed out.
    const published = `${decision.failure.body.message} ${decision.failure.detail} ${JSON.stringify(decision.failure.headers)}`;
    expect(published).not.toContain("org_9f2c");
    expect(published).not.toContain("Case");
    expect(scanFailure(decision.failure)).toEqual([]);
  });

  test("a field that cannot be made safe is reported as null, not guessed", () => {
    // 80 characters is inside `fieldsOf`'s reach but outside
    // `assertFieldName`'s 63-character limit, so this exercises the catch.
    const decision = handleReferenceViolation({
      err: pgError(PG.FOREIGN_KEY_VIOLATION, "", { meta: { target: "x".repeat(80) } }),
    });
    expect(decision.field).toBeNull();
    expect(decision.failure.detail).toBe("");
    expect(decision.failure.body.message).toBe(
      "A referenced record is missing or not visible to this organisation.",
    );
    expect(scanFailure(decision.failure)).toEqual([]);
  });

  test("an error with nothing extractable still names no field", () => {
    const decision = handleReferenceViolation({
      err: pgError(PG.FOREIGN_KEY_VIOLATION, "fk failed"),
    });
    expect(decision.field).toBeNull();
    expect(scanFailure(decision.failure)).toEqual([]);
  });
});

// ═══ db-failures.ts — row: primary unreachable ═══════════════════════════════

describe("evaluatePrimaryHealth / admitIntervention", () => {
  test("up allows everything and publishes nothing", () => {
    const health = evaluatePrimaryHealth({ mode: "up" });
    expect(health).toEqual({
      mode: "up",
      readsAllowed: true,
      writesAllowed: true,
      interventionsAllowed: true,
      failure: null,
      fallback: null,
      reason: "primary_reachable",
    });
    expect(admitIntervention(health)).toEqual({ admitted: true, failure: null });
  });

  test("read_only serves reads and refuses the intervention", () => {
    const health = evaluatePrimaryHealth({ mode: "read_only", requestId: "svreq_ro" });
    expect(health.readsAllowed).toBe(true);
    expect(health.writesAllowed).toBe(false);
    // Accepting a risk signal we cannot durably record is the one thing a
    // fraud platform must never do: the bank is told we intervened.
    expect(health.interventionsAllowed).toBe(false);
    expect(health.fallback).toBe("sms");
    expect(health.reason).toBe("read_only_degraded");
    const failure = publishable(health.failure ?? neverNull());
    expect(failure.body.code).toBe("intervention_refused_degraded");
    expect(failure.status).toBe(409);
    // Deliberately not retryable: an automatic retry is refused again for the
    // same reason while the fraud continues, so the caller must escalate.
    expect(failure.body.retryable).toBe(false);
    expect(failure.headers["Retry-After"]).toBeUndefined();
    expect(admitIntervention(health)).toEqual({ admitted: false, failure: health.failure });
  });

  test("the refusal names the asynchronous channel a human should use", () => {
    const sms = evaluatePrimaryHealth({ mode: "read_only" });
    expect(sms.failure?.body.message).toContain("sms");
    const push = evaluatePrimaryHealth({ mode: "read_only", fallback: "app_push" });
    expect(push.failure?.body.message).toContain("app_push");
    expect(scanFailure(push.failure ?? neverNull())).toEqual([]);
  });

  test("down refuses everything with a 503 dependency", () => {
    const health = evaluatePrimaryHealth({ mode: "down", requestId: "svreq_down" });
    expect(health.readsAllowed).toBe(false);
    expect(health.writesAllowed).toBe(false);
    expect(health.interventionsAllowed).toBe(false);
    const failure = publishable(health.failure ?? neverNull());
    expect(failure.body.code).toBe("dependency_unavailable");
    expect(failure.status).toBe(503);
    expect(failure.headers["Retry-After"]).toBe(String(DEFAULT_SHED_RETRY_AFTER_SEC));
  });

  test("the gate refuses on interventionsAllowed, not on the presence of a failure", () => {
    const gate = (health: PrimaryHealthDecision): boolean => admitIntervention(health).admitted;
    expect(gate(evaluatePrimaryHealth({ mode: "up" }))).toBe(true);
    expect(gate(evaluatePrimaryHealth({ mode: "read_only" }))).toBe(false);
    expect(gate(evaluatePrimaryHealth({ mode: "down" }))).toBe(false);
  });
});

// ═══ db-failures.ts — row: replica lag ═══════════════════════════════════════

describe("evaluateReplicaLag", () => {
  test("a fresh replica is read from, with no banner", () => {
    expect(evaluateReplicaLag({ lagMs: 0 })).toEqual({
      lagMs: 0,
      thresholdMs: 2_000,
      stale: false,
      readFrom: "replica",
      failedBack: false,
      banner: null,
    });
  });

  test("lag exactly at the threshold is not yet stale", () => {
    expect(evaluateReplicaLag({ lagMs: 2_000 }).stale).toBe(false);
    expect(evaluateReplicaLag({ lagMs: 2_000.1 }).stale).toBe(true);
  });

  test("fail_back moves the read to the primary and reports no banner", () => {
    const decision = evaluateReplicaLag({ lagMs: 9_000 });
    expect(decision).toEqual({
      lagMs: 9_000,
      thresholdMs: 2_000,
      stale: true,
      readFrom: "primary",
      failedBack: true,
      banner: null,
    });
  });

  test("banner mode keeps the read and declares the staleness", () => {
    const decision = evaluateReplicaLag({ lagMs: 9_000, mode: "banner" });
    expect(decision.readFrom).toBe("replica");
    expect(decision.failedBack).toBe(false);
    expect(decision.banner).toEqual({ reason: "replica_lag", lagMs: 9_000, thresholdMs: 2_000 });
  });

  test("neither mode returns an error: a stale read is still a read", () => {
    // Failing closed on the console is how an operator ends up staring at a
    // blank screen during an incident.
    for (const mode of ["fail_back", "banner"] as const) {
      for (const lagMs of [0, 2_000, 9_000]) {
        expect(evaluateReplicaLag({ lagMs, mode })).not.toHaveProperty("failure");
      }
    }
  });

  const SANITISED: { label: string; lagMs: number; expected: number }[] = [
    { label: "a negative lag is clamped to zero", lagMs: -5_000, expected: 0 },
    { label: "NaN is treated as no lag", lagMs: Number.NaN, expected: 0 },
    { label: "Infinity is treated as no lag", lagMs: Number.POSITIVE_INFINITY, expected: 0 },
  ];

  test.each(SANITISED)("$label", ({ lagMs, expected }) => {
    const decision = evaluateReplicaLag({ lagMs });
    expect(decision.lagMs).toBe(expected);
    expect(decision.stale).toBe(false);
  });

  test("a caller-supplied threshold is honoured", () => {
    const decision = evaluateReplicaLag({ lagMs: 400, thresholdMs: 100 });
    expect(decision.stale).toBe(true);
    expect(decision.thresholdMs).toBe(100);
  });
});

// ═══ db-failures.ts — row: disk / WAL pressure ═══════════════════════════════

describe("evaluateStoragePressure / admitWrite", () => {
  const quiet = { alert: undefined, requestId: "svreq_disk" };

  test("a quiet volume admits every write and publishes nothing", () => {
    const decision = evaluateStoragePressure({ diskUsedPct: 10, walUsedPct: 20, ...quiet });
    expect(decision.level).toBe("normal");
    expect(decision.peakUsedPct).toBe(20);
    expect(decision.shouldAlert).toBe(false);
    expect(decision.alerts).toEqual([]);
    expect(decision.failure).toBeNull();
    expect(decision.admitted).toEqual([...WRITE_CLASSES]);
    expect(decision.auditChainAdmitted).toBe(true);
  });

  test("the threshold is inclusive: exactly 70% already alerts", () => {
    expect(evaluateStoragePressure({ diskUsedPct: 69, walUsedPct: 69 }).level).toBe("normal");
    expect(evaluateStoragePressure({ diskUsedPct: 70, walUsedPct: 10 }).level).toBe("elevated");
  });

  test("the alert sink fires once, naming the level and both offenders", () => {
    const fired: { level: string; peakUsedPct: number; alerts: string[] }[] = [];
    const decision = evaluateStoragePressure({
      diskUsedPct: 72,
      walUsedPct: 81,
      alert: (alert) => fired.push(alert),
    });
    expect(decision.level).toBe("elevated");
    expect(decision.peakUsedPct).toBe(81);
    expect(decision.alerts).toEqual(["data_volume_at_72pct", "wal_at_81pct"]);
    expect(fired).toEqual([
      { level: "elevated", peakUsedPct: 81, alerts: ["data_volume_at_72pct", "wal_at_81pct"] },
    ]);
    expect(scanFailure(decision.failure ?? neverNull())).toEqual([]);
  });

  test("no alert is paged below the threshold", () => {
    let paged = 0;
    evaluateStoragePressure({
      diskUsedPct: 20,
      walUsedPct: 30,
      alert: () => {
        paged += 1;
      },
    });
    expect(paged).toBe(0);
  });

  test("critical sheds writes with a 503, and the audit chain is still admitted", () => {
    const decision = evaluateStoragePressure({
      diskUsedPct: 95,
      walUsedPct: 99,
      requestId: "svreq_crit",
    });
    expect(decision.level).toBe("critical");
    const failure = publishable(decision.failure ?? neverNull());
    expect(failure.body.code).toBe("db_capacity_shed");
    expect(failure.status).toBe(503);
    expect(failure.headers["Retry-After"]).toBe(String(DEFAULT_SHED_RETRY_AFTER_SEC));
    // Index 0 is the audit chain and index 0 it stays: a full disk is a
    // reason to stop exporting, not a reason to lose the evidence.
    expect(decision.refused).toEqual(["read_model_rebuild", "bulk_export"]);
    expect(decision.admitted[0]).toBe("audit_chain");
    expect(decision.auditChainAdmitted).toBe(true);
    expect(NEVER_SACRIFICED).toEqual(["audit_chain"]);
    for (const cls of WRITE_CLASSES) {
      expect(admitWrite(decision, cls)).toBe(!decision.refused.includes(cls));
    }
  });

  test("the audit chain is admitted at every pressure level", () => {
    for (const [disk, wal] of [
      [10, 10],
      [70, 70],
      [90, 90],
      [100, 100],
    ] as const) {
      const decision: StoragePressureDecision = evaluateStoragePressure({
        diskUsedPct: disk,
        walUsedPct: wal,
      });
      expect(decision.refused).not.toContain("audit_chain");
      expect(admitWrite(decision, "audit_chain" as WriteClass)).toBe(true);
    }
  });

  test("elevated pressure still admits every write class", () => {
    const decision = evaluateStoragePressure({ diskUsedPct: 75, walUsedPct: 10 });
    expect(decision.level).toBe("elevated");
    // Only the critical level refuses anything: shedding at 75% would stop
    // the case transition that matters most.
    expect(decision.refused).toEqual([]);
    expect(decision.admitted).toEqual([...WRITE_CLASSES]);
  });

  const CLAMPED: { label: string; disk: number; expected: number }[] = [
    { label: "a negative percentage reads as 0", disk: -5, expected: 0 },
    { label: "NaN reads as 0", disk: Number.NaN, expected: 0 },
    { label: "a percentage above 100 reads as 100", disk: 150, expected: 100 },
  ];

  test.each(CLAMPED)("$label", ({ disk, expected }) => {
    expect(evaluateStoragePressure({ diskUsedPct: disk, walUsedPct: 0 }).diskUsedPct).toBe(
      expected,
    );
  });

  test("the thresholds are overridable per deployment", () => {
    const decision = evaluateStoragePressure({
      diskUsedPct: 50,
      walUsedPct: 50,
      thresholdPct: 40,
      criticalPct: 45,
    });
    expect(decision.level).toBe("critical");
    expect(decision.thresholdPct).toBe(40);
    expect(STORAGE_PRESSURE_ALERT_PCT).toBe(70);
    expect(STORAGE_PRESSURE_CRITICAL_PCT).toBe(90);
  });
});

// ═══ db-failures.ts — row: caller-side rate limit ═════════════════════════════

describe("rateLimitedByCaller", () => {
  test("a caller quota is a 429 with the caller's own Retry-After", () => {
    const failure = publishable(rateLimitedByCaller(30, "svreq_rate"));
    expect(failure.status).toBe(429);
    expect(failure.body.code).toBe("rate_limited");
    expect(failure.body.retryable).toBe(true);
    expect(failure.headers["Retry-After"]).toBe("30");
    expect(failure.body.requestId).toBe("svreq_rate");
  });

  test("the Retry-After is clamped exactly as every other failure is", () => {
    expect(rateLimitedByCaller(0).headers["Retry-After"]).toBe("1");
    expect(rateLimitedByCaller(99_999).headers["Retry-After"]).toBe("3600");
  });
});

// ═══ the leak gate: everything both modules produce is publishable ════════════

describe("every failure these modules produce is publishable", () => {
  const ALL: { label: string; failure: Failure }[] = [
    {
      label: "withTimeout",
      failure:
        envelopeForTimeout(new DependencyTimeoutError("elevenlabs.tts", 8_000), 5) ?? neverNull(),
    },
    {
      label: "handlePoolExhausted",
      failure: handlePoolExhausted({ err: prismaError(PRISMA.POOL_TIMEOUT, "") }).failure,
    },
    {
      label: "handleStatementTimeout",
      failure: handleStatementTimeout({
        err: pgError("57014", "canceling statement due to statement timeout"),
      }).failure,
    },
    {
      label: "handleReferenceViolation",
      failure: handleReferenceViolation({
        err: pgError(PG.FOREIGN_KEY_VIOLATION, FK_DRIVER_MESSAGE),
      }).failure,
    },
    {
      label: "evaluatePrimaryHealth read_only",
      failure: evaluatePrimaryHealth({ mode: "read_only" }).failure ?? neverNull(),
    },
    {
      label: "evaluatePrimaryHealth down",
      failure: evaluatePrimaryHealth({ mode: "down" }).failure ?? neverNull(),
    },
    {
      label: "evaluateStoragePressure elevated",
      failure: evaluateStoragePressure({ diskUsedPct: 75, walUsedPct: 75 }).failure ?? neverNull(),
    },
    {
      label: "evaluateStoragePressure critical",
      failure: evaluateStoragePressure({ diskUsedPct: 99, walUsedPct: 99 }).failure ?? neverNull(),
    },
    { label: "rateLimitedByCaller", failure: rateLimitedByCaller(30) },
  ];

  test("the static sweep finds no leak in any of them", () => {
    // This is the assertion the whole file exists for: a raw driver string in
    // a published failure is the defect, and `scanFailure` is what notices.
    for (const entry of ALL) {
      expect({ label: entry.label, leaks: scanFailure(entry.failure) }).toEqual({
        label: entry.label,
        leaks: [],
      });
    }
  });

  test("no failure is a status this module refuses to emit", () => {
    for (const entry of ALL) {
      expect(FORBIDDEN_STATUSES).not.toContain(entry.failure.status);
    }
  });

  test("the asynchronous producers are publishable too", async () => {
    const unique = await handleUniqueViolation({
      err: prismaError(PRISMA.UNIQUE_CONSTRAINT, UNIQUE_PRISMA_MESSAGE, {
        target: ["idemKey", "orgId"],
      }),
    });
    const conflicted = await runTransactionWithRetry(
      async () => {
        throw pgError(
          PG.UNIQUE_VIOLATION,
          'duplicate key value violates unique constraint "UsageLedger_idemKey_key"',
        );
      },
      { retries: 0, sleep: async () => {}, rand: () => 0.5 },
    );
    const contended = await runTransactionWithRetry(
      async () => {
        throw pgError(PG.DEADLOCK_DETECTED, "deadlock detected");
      },
      { retries: 0, sleep: async () => {}, rand: () => 0.5 },
    );
    expect(conflicted.ok).toBe(false);
    expect(contended.ok).toBe(false);
    if (conflicted.ok || contended.ok) return;

    // The driver text that produced each of these names a constraint we own
    // and a column we published; none of it may appear in the response.
    const dynamic: { label: string; failure: Failure }[] = [
      { label: "handleUniqueViolation conflict", failure: unique.failure ?? neverNull() },
      { label: "runTransactionWithRetry unique", failure: conflicted.failure },
      { label: "runTransactionWithRetry deadlock", failure: contended.failure },
    ];
    for (const entry of dynamic) {
      expect({ label: entry.label, leaks: scanFailure(entry.failure) }).toEqual({
        label: entry.label,
        leaks: [],
      });
    }
  });
});
