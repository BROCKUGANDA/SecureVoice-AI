/**
 * UNIT — the WP-19 scale layer: `src/lib/scale/capacity.ts` and
 * `src/lib/scale/queue.ts`.
 *
 * Neither module is a data structure with an obvious contract, so the header
 * states what each one actually IS, because writing tests against the wrong
 * mental model is worse than writing none:
 *
 *   · `scale/capacity.ts` is a CAPACITY PROJECTION, not an admission controller.
 *     `projectCapacity()` takes a card volume and a flag rate and returns the
 *     concurrent calls that volume implies at its peak, compared against three
 *     vendor ceilings. It never admits or refuses a case — `src/lib/capacity.ts`
 *     does that, and that file has its own suite. What this file decides is
 *     which number a bank is shown, so the properties pinned below are about
 *     the ARITHMETIC and the LABELLING: monotonicity in demand and in headroom,
 *     the exact side of every threshold, and what a degenerate input does to a
 *     figure somebody will quote.
 *   · `scale/queue.ts` is NOT an in-memory queue. It is raw SQL over a
 *     `dial_job` table, so FIFO order, claim eligibility and exactly-once are
 *     enforced by Postgres, not by JavaScript. The testable contract is
 *     therefore the module's own arithmetic (the retry ladder, the limits, the
 *     clamps) and the DRAINER's decisions (`drainDialQueue`), which is ordinary
 *     control flow: which counter each outcome lands in, when the handler is
 *     forbidden to run, and whether a job can be handed to two workers.
 *
 * The database is replaced at the port seam (`@/lib/db`'s four raw methods) by a
 * small in-memory table that implements the semantics the module's SQL declares.
 * That is the seam the module's own doc comment nominates ("a queue is only
 * testable at full strength if the vendor can be replaced without touching the
 * queue"), and it is why the claim ORDER is read out of the SQL rather than
 * hard-coded here: if someone flips `ORDER BY priority DESC` to ASC, the fake
 * reorders and the priority assertion below fails for the right reason.
 *
 * â”€â”€ KNOWN GAP (bug, not asserted as correct) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * `projectCapacity` does not guard its own denominators, so a degenerate input
 * can put `NaN`/`Infinity` in a decision field or — worse — read as NOT
 * oversubscribed. Three concrete instances, all at
 * `src/lib/scale/capacity.ts:388-416` / `:578-582`, all reproduced by the
 * "degenerate configuration" tests below, which pin CURRENT behaviour:
 *
 *   1. `cardsPerMonth: NaN` (or `0` with `peakWindowMinutes: 0`, so the
 *      averaging window is 0 h) makes every `ceilingRatios` entry NaN.
 *      `oversubscribed` is `worst.ratio > 1`, and `NaN > 1` is false, so the
 *      verdict renders "Within every vendor ceiling" — the model fails toward
 *      ADMITTING on an input it cannot compute. `bandAtPeak` is likewise
 *      "NORMAL" because every `>=` comparison against NaN is false.
 *   2. `fromNumbers: 0` divides by zero: `ceilingRatios
 *      .twilioCallsPerSecondPerNumber` is `Infinity` and
 *      `requiredHourlyBillingCeilingMinor` can be `NaN`. `fromNumbersRequired`
 *      IS guarded (`Math.max(1, ¦)`, line 388) but the ratio at line 581 is not.
 *   3. Negative inputs (`flagRate`, `cardsPerMonth`, `meanCallSeconds`,
 *      `fromNumbers`) produce negative ratios, so `oversubscribed` is false and
 *      the model again reports headroom it does not have.
 *
 * The vendor-ceiling guards DO exist and are pinned as guards: a malformed env
 * override falls back to the default (`capacity.ts:182-189`), the gate's
 * ceiling is `Math.max(1, ¦)` (`:720`), the claim limit is `Math.max(1, ¦)`
 * (`queue.ts:286`), the retry ladder clamps its index (`queue.ts:148`), and
 * `voiceCoverageOfPeak` has an explicit `requiredConcurrent > 0` branch
 * (`capacity.ts:427`). The gaps are the arithmetic inside `projectCapacity`,
 * which trusts its caller.
 *
 * Two more, both in the queue layer and both marked where they are pinned:
 * `Math.max(1, NaN)` is NaN, so a NaN gate ceiling rejects every caller
 * including the first (`capacity.ts:720` — the safe direction, but the floor
 * was clearly meant to catch it); and a FRACTIONAL retry count skips the
 * ladder's array lookup to its `?? last-element` fallback, so `retries = 1.5`
 * waits 600 s where `retries = 1` waits 30 s (`queue.ts:147-150`).
 *
 * â”€â”€ KNOWN GAP (accounting, deliberate) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * When `completeDialJob` returns false — the row was settled by somebody else
 * between the claim and the completion — `drainDialQueue` increments NO counter:
 * not `done`, and not `lost`. `lost` is reserved for the `SETTLED` branch of
 * `failDialJob` (`queue.ts:651-653`). The totals still reconcile (claimed ==
 * done + retried + dead + lost + skipped), so this is an observability gap, not
 * a leak, and it is pinned below as current behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CEILING_ENV_VARS,
  HOURS_PER_MONTH,
  MAX_THROTTLE_ATTEMPTS,
  MEAN_CALL_SECONDS,
  VendorCeilingExhaustedError,
  VendorConcurrencyGate,
  ceilingInputs,
  isThrottle,
  projectCapacity,
  throttleBackoffMs,
  vendorCeiling,
  vendorCeilings,
  withElevenLabsCeiling,
  type CapacityModelInput,
} from "@/lib/scale/capacity";
import {
  DEFAULT_LEASE_MS,
  DIAL_JOB_STATES,
  DIAL_RETRY_LADDER_MS,
  MAX_DIAL_ATTEMPTS,
  MIGRATION_HINT,
  claimDialJobs,
  completeDialJob,
  dialJobBackoffMs,
  dialJobById,
  drainDialQueue,
  enqueueDialJob,
  failDialJob,
  outstandingJobs,
  queueDepth,
  reapExpiredLeases,
  renewClaim,
  replayDeadDialJob,
  type DialJob,
  type DialJobState,
} from "@/lib/scale/queue";

/** Vendor plan ceilings this suite is written against (see the file header). */
const EL_PLAN = 4; // ELEVENLABS_TIER_CONCURRENCY.free
const EL_BURST = EL_PLAN * 3; // ELEVENLABS_BURST_CEILING
const TWILIO_CPS = 2;
const TWILIO_CONCURRENCY = 10;

/**
 * Cards/month that make the steady-state model land on exactly `conc`
 * concurrent calls. Derived, not looked up: interventions = cards Ã— flagRate,
 * Ã· 730 h, Ã— peakMultiple, Ã· 3600, Ã— meanCallSeconds.
 */
const cardsForConcurrency = (conc: number, flagRate = 0.0035, peakMultiple = 8): number =>
  (conc * HOURS_PER_MONTH * 3600) / (flagRate * peakMultiple * MEAN_CALL_SECONDS);

const STEADY: CapacityModelInput = { cardsPerMonth: 100_000, flagRate: 0.0035 };

// â”€â”€ The in-memory `dial_job` table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type StoredRow = {
  id: string;
  case_id: string;
  case_ref: string;
  org_id: string | null;
  attempt_no: number;
  retries: number;
  state: DialJobState;
  priority: number;
  payload: string;
  available_at: number;
  lease_expires_at: number | null;
  claimed_by: string | null;
  last_error: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

type RawCall = { sql: string; params: unknown[] };

function asJob(r: StoredRow): DialJob {
  return {
    ...r,
    available_at: new Date(r.available_at),
    lease_expires_at: r.lease_expires_at === null ? null : new Date(r.lease_expires_at),
    completed_at: r.completed_at === null ? null : new Date(r.completed_at),
    created_at: new Date(r.created_at),
    updated_at: new Date(r.updated_at),
  };
}

/**
 * The subset of `dial_job`'s semantics that `queue.ts` relies on, transcribed
 * from the module's own SQL. Everything is driven by an injected clock so lease
 * expiry is exact rather than approximate.
 */
class FakeDialJobTable {
  readonly calls: RawCall[] = [];
  private readonly rows: StoredRow[] = [];
  private seq = 0;
  now = 1_700_000_000_000;

  advance(ms: number): void {
    this.now += ms;
  }

  /** Insert honouring `ON CONFLICT ("case_id","attempt_no") DO NOTHING`. */
  insert(
    id: string,
    caseId: string,
    caseRef: string,
    orgId: string | null,
    attemptNo: number,
    priority: number,
    payload: string,
    availableInMs: number,
  ): StoredRow | null {
    if (this.rows.some((r) => r.case_id === caseId && r.attempt_no === attemptNo)) return null;
    const row: StoredRow = {
      id,
      case_id: caseId,
      case_ref: caseRef,
      org_id: orgId,
      attempt_no: attemptNo,
      retries: 0,
      state: "PENDING",
      priority,
      payload,
      available_at: this.now + availableInMs,
      lease_expires_at: null,
      claimed_by: null,
      last_error: null,
      completed_at: null,
      created_at: this.now + this.seq++,
      updated_at: this.now,
    };
    this.rows.push(row);
    return row;
  }

  find(id: string): StoredRow | undefined {
    return this.rows.find((r) => r.id === id);
  }

  /** The conflict-probe key: `ON CONFLICT ("case_id","attempt_no")`. */
  findByCase(caseId: string, attemptNo: number): StoredRow | undefined {
    return this.rows.find((r) => r.case_id === caseId && r.attempt_no === attemptNo);
  }

  /** `FOR UPDATE SKIP LOCKED` + the re-asserted claim predicate. */
  claim(workerId: string, leaseMs: number, limit: number): StoredRow[] {
    const claimed = this.rows
      .filter(
        (r) =>
          (r.state === "PENDING" && r.available_at <= this.now) ||
          (r.state === "CLAIMED" && r.lease_expires_at !== null && r.lease_expires_at < this.now),
      )
      .sort(
        (a, b) =>
          b.priority - a.priority || a.available_at - b.available_at || a.created_at - b.created_at,
      )
      .slice(0, limit);
    for (const r of claimed) {
      r.state = "CLAIMED";
      r.claimed_by = workerId;
      r.lease_expires_at = this.now + leaseMs;
      r.updated_at = this.now;
    }
    return claimed;
  }

  complete(id: string): number {
    const r = this.find(id);
    if (!r || r.state !== "CLAIMED") return 0;
    r.state = "DONE";
    r.completed_at = this.now;
    r.last_error = null;
    r.claimed_by = null;
    r.lease_expires_at = null;
    r.updated_at = this.now;
    return 1;
  }

  incrementRetries(id: string, error: string): number | null {
    const r = this.find(id);
    if (!r || r.state !== "CLAIMED") return null;
    r.retries += 1;
    r.last_error = error;
    r.updated_at = this.now;
    return r.retries;
  }

  markDead(id: string): number {
    const r = this.find(id);
    if (!r) return 0;
    r.state = "DEAD";
    r.completed_at = this.now;
    r.claimed_by = null;
    r.lease_expires_at = null;
    r.updated_at = this.now;
    return 1;
  }

  reschedule(id: string, backoffMs: number): number {
    const r = this.find(id);
    if (!r) return 0;
    r.state = "PENDING";
    r.available_at = this.now + backoffMs;
    r.claimed_by = null;
    r.lease_expires_at = null;
    r.updated_at = this.now;
    return 1;
  }

  reap(): number {
    let n = 0;
    for (const r of this.rows) {
      if (r.state === "CLAIMED" && r.lease_expires_at !== null && r.lease_expires_at < this.now) {
        r.state = "PENDING";
        r.claimed_by = null;
        r.lease_expires_at = null;
        n++;
      }
    }
    return n;
  }

  replay(id: string): number {
    const r = this.find(id);
    if (!r || r.state !== "DEAD") return 0;
    r.state = "PENDING";
    r.available_at = this.now;
    r.last_error = null;
    r.completed_at = null;
    r.claimed_by = null;
    r.lease_expires_at = null;
    r.updated_at = this.now;
    return 1;
  }

  renew(id: string, workerId: string, leaseMs: number): StoredRow[] {
    const r = this.find(id);
    if (!r || r.state !== "CLAIMED" || r.claimed_by !== workerId) return [];
    r.lease_expires_at = this.now + leaseMs;
    r.updated_at = this.now;
    return [r];
  }

  depth(): Record<DialJobState, number> {
    const counts: Record<DialJobState, number> = { PENDING: 0, CLAIMED: 0, DONE: 0, DEAD: 0 };
    for (const r of this.rows) counts[r.state] += 1;
    return counts;
  }

  /** Everything the raw delegates were asked, for predicate assertions. */
  sqlMatching(fragment: string): RawCall[] {
    return this.calls.filter((c) => c.sql.includes(fragment));
  }
}

const RAW_METHODS = ["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"] as const;
type RawMethod = (typeof RAW_METHODS)[number];

let table: FakeDialJobTable;
let saved: Map<RawMethod, PropertyDescriptor | undefined>;

function record(sql: string, params: unknown[]): void {
  table.calls.push({ sql, params });
}

/**
 * Join a tagged template (`db.$queryRaw\`¦\``) back into SQL text + params so the
 * fake can dispatch on the same statement the module really sends.
 */
function untag(strings: TemplateStringsArray, values: unknown[]): RawCall {
  return { sql: strings.join("?"), params: values };
}

function installFake(table_: FakeDialJobTable): void {
  table = table_;

  Object.defineProperty(db, "$queryRawUnsafe", {
    configurable: true,
    writable: true,
    value: async (sql: string, ...params: unknown[]): Promise<unknown[]> => {
      record(sql, params);
      if (sql.includes("FOR UPDATE SKIP LOCKED")) {
        const [workerId, leaseMs, boundLimit] = params as [string, number, number | undefined];
        // The claim limit is INLINED into the statement, so the fake reads it the
        // way Postgres does — from the SQL text. Falling back to a bound third
        // parameter keeps this honest if the statement ever goes back to `$n`.
        const inline = /LIMIT\s+(\d+)/i.exec(sql);
        const limit = inline ? Number(inline[1]) : boundLimit;
        // Yield before the pop so two drains genuinely INTERLEAVE and
        // contend for the same rows, the way two workers contend for
        // SKIP LOCKED. The pop itself stays synchronous, which is what
        // makes the hand-off exclusive.
        await Promise.resolve();
        return table.claim(workerId, leaseMs, limit).map(asJob);
      }
      if (sql.includes("RETURNING id") && sql.includes("claimed_by")) {
        const [id, workerId, leaseMs] = params as [string, string, number];
        return table.renew(id, workerId, leaseMs).map(asJob);
      }
      if (sql.includes("RETURNING id, attempt_no, retries, state")) {
        const [id, caseId, caseRef, orgId, attemptNo, priority, payload, availableInMs] =
          params as [string, string, string, string | null, number, number, string, number];
        const row = table.insert(
          id,
          caseId,
          caseRef,
          orgId,
          attemptNo,
          priority,
          payload,
          availableInMs,
        );
        return row ? [row] : [];
      }
      const [id] = params as [string];
      const row = table.find(id);
      return row ? [asJob(row)] : [];
    },
  });

  Object.defineProperty(db, "$queryRaw", {
    configurable: true,
    writable: true,
    value: (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const { sql, params } = untag(strings, values);
      record(sql, params);
      if (sql.includes("count(*)::int AS n")) {
        const counts = table.depth();
        return Promise.resolve(
          (Object.entries(counts) as [DialJobState, number][]).map(([state, n]) => ({ state, n })),
        );
      }
      if (sql.includes("RETURNING retries")) {
        // `SET ¦ last_error = $1 ¦ WHERE id = $2`: error first, id second.
        const [error, id] = params as [string, string];
        const retries = table.incrementRetries(id, error);
        return Promise.resolve(retries === null ? [] : [{ retries }]);
      }
      if (sql.includes("SELECT state, retries")) {
        const [id] = params as [string];
        const row = table.find(id);
        return Promise.resolve(row ? [{ state: row.state, retries: row.retries }] : []);
      }
      const [caseId, attemptNo] = params as [string, number];
      const row = table.findByCase(caseId, attemptNo);
      return Promise.resolve(
        row
          ? [{ id: row.id, attempt_no: row.attempt_no, retries: row.retries, state: row.state }]
          : [],
      );
    },
  });

  Object.defineProperty(db, "$executeRawUnsafe", {
    configurable: true,
    writable: true,
    value: (sql: string, ...params: unknown[]): Promise<number> => {
      record(sql, params);
      const [backoffMs, id] = params as [number, string];
      return Promise.resolve(table.reschedule(id, backoffMs));
    },
  });

  Object.defineProperty(db, "$executeRaw", {
    configurable: true,
    writable: true,
    value: (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      const { sql, params } = untag(strings, values);
      record(sql, params);
      const [id] = params as [string];
      if (sql.includes("SET state = 'DONE'")) return Promise.resolve(table.complete(id));
      if (sql.includes("SET state = 'DEAD'")) return Promise.resolve(table.markDead(id));
      if (sql.includes("completed_at = NULL")) return Promise.resolve(table.replay(id));
      return Promise.resolve(table.reap());
    },
  });
}

beforeEach(() => {
  saved = new Map(RAW_METHODS.map((m) => [m, Object.getOwnPropertyDescriptor(db, m)]));
  installFake(new FakeDialJobTable());
});

afterEach(() => {
  for (const m of RAW_METHODS) {
    const original = saved.get(m);
    if (original) Object.defineProperty(db, m, original);
    else Reflect.deleteProperty(db, m);
  }
});

/** Enqueue + return the job id, for tests that do not care about the id. */
async function seed(input: {
  caseId: string;
  caseRef?: string;
  attemptNo?: number;
  priority?: number;
  availableInMs?: number;
}): Promise<string> {
  const res = await enqueueDialJob({
    caseId: input.caseId,
    caseRef: input.caseRef ?? `ref-${input.caseId}`,
    attemptNo: input.attemptNo,
    priority: input.priority,
    availableInMs: input.availableInMs,
  });
  return res.id;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// scale/capacity.ts — the projection
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

describe("projectCapacity — the worked example, hand-computed", () => {
  // 100,000 cards Ã— 0.35% = 350 interventions per month.
  //   mean/hour  = 350 Ã· 730        = 0.4794520547945205
  //   peak/hour  = Ã— 8              = 3.835616438356164
  //   peak/second= Ã· 3600           = 0.00106544901065449
  //   concurrent = Ã— 180 s (Little's law)
  //              = 0.1917808219178082
  // Cost: in an hour at peak, talk-minutes = concurrent calls, so
  //   0.1917808219178082 Ã— $0.08/min = $0.015342465753424657
  //   billing ceiling = ceil($0.0153¦ Ã— 100) = 2 minor units.
  test("every step matches the arithmetic the module documents", () => {
    const m = projectCapacity(STEADY);
    expect(m.interventionsPerMonth).toBe(350);
    expect(m.averagingWindowHours).toBe(HOURS_PER_MONTH);
    expect(m.peakWindowMinutes).toBeNull();
    expect(m.meanInterventionsPerHour).toBe(350 / 730);
    expect(m.peakInterventionsPerHour).toBe((350 / 730) * 8);
    expect(m.peakInterventionsPerSecond).toBe((350 / 730) * 8 * (1 / 3600));
    expect(m.requiredConcurrentCalls).toBe((350 / 730) * 8 * (1 / 3600) * MEAN_CALL_SECONDS);
    expect(m.costAtPeak.usdPerHour).toBeCloseTo(m.requiredConcurrentCalls * 0.08, 12);
    expect(m.costAtPeak.requiredHourlyBillingCeilingMinor).toBe(2);
    expect(m.costAtPeak.carrierIncluded).toBe(false);
    expect(m.costAtPeak.breakdown.carrierUsd).toBe(0);
  });

  test("the step ledger names each step and repeats the headline numbers", () => {
    const m = projectCapacity(STEADY);
    const byId = new Map(m.steps.map((s) => [s.id, s.value]));
    expect([...byId.keys()]).toEqual([
      "interventions_per_month",
      "mean_per_hour",
      "peak_per_hour",
      "peak_per_second",
      "required_concurrent",
      "from_numbers_required",
    ]);
    expect(byId.get("interventions_per_month")).toBe(m.interventionsPerMonth);
    expect(byId.get("mean_per_hour")).toBe(m.meanInterventionsPerHour);
    expect(byId.get("peak_per_hour")).toBe(m.peakInterventionsPerHour);
    expect(byId.get("peak_per_second")).toBe(m.peakInterventionsPerSecond);
    expect(byId.get("required_concurrent")).toBe(m.requiredConcurrentCalls);
    expect(byId.get("from_numbers_required")).toBe(m.fromNumbersRequired);
  });

  test("concurrency is invariant under time compression — the whole point", () => {
    // The same 350 interventions, delivered in 40 minutes instead of
    // averaged over 730 hours. 350 Ã· (40/60) = 525/hour, Ã— 1 (the campaign
    // IS the peak) Ã· 3600 Ã— 180 = 26.25 concurrent calls — 137Ã— the steady
    // state. Nothing about the burst is cheaper; only the clock moved.
    const burst = projectCapacity({
      cardsPerMonth: 100_000,
      flagRate: 0.0035,
      peakWindowMinutes: 40,
      peakMultiple: 1,
    });
    expect(burst.averagingWindowHours).toBeCloseTo(2 / 3, 12);
    expect(burst.meanInterventionsPerHour).toBe(525);
    expect(burst.peakInterventionsPerHour).toBe(525);
    expect(burst.requiredConcurrentCalls).toBeCloseTo(26.25, 9);
    expect(burst.costAtPeak.usdPerPeakBurstMinutes).toBe(40);
    // 4 in-plan at $0.08 + 22.25 over-plan at $0.16 = $3.88/hour.
    expect(burst.costAtPeak.breakdown.withinPlanConcurrent).toBe(EL_PLAN);
    expect(burst.costAtPeak.breakdown.overPlanBurstConcurrent).toBeCloseTo(22.25, 9);
    expect(burst.costAtPeak.usdPerHour).toBeCloseTo(3.88, 9);
    expect(burst.costAtPeak.usdPerPeakBurst).toBeCloseTo((3.88 * 40) / 60, 9);
    expect(burst.costAtPeak.requiredHourlyBillingCeilingMinor).toBe(388);
    // Steady state over the same month needs 2 minor units of headroom.
    expect(projectCapacity(STEADY).costAtPeak.requiredHourlyBillingCeilingMinor).toBeLessThan(388);
  });

  test("a carrier rate above zero switches the cost from a floor to an estimate", () => {
    const excluded = projectCapacity(STEADY);
    const included = projectCapacity({ ...STEADY, carrierUsdPerMinute: 0.02 });
    expect(excluded.costAtPeak.carrierIncluded).toBe(false);
    expect(excluded.costAtPeak.confidence).toBe("extrapolated");
    expect(included.costAtPeak.carrierIncluded).toBe(true);
    expect(included.costAtPeak.confidence).toBe("calibrated");
    expect(included.costAtPeak.breakdown.carrierUsd).toBeCloseTo(0.1917808219178082 * 0.02, 12);
    // The voice figure is unchanged by the carrier rate: it is a floor either way.
    expect(included.costAtPeak.breakdown.conversationalAiUsd).toBe(
      excluded.costAtPeak.breakdown.conversationalAiUsd,
    );
    expect(included.inputs.carrierUsdPerMinute.value).toBe(0.02);
  });
});

describe("projectCapacity — thresholds are enforced on both sides", () => {
  test("oversubscribed is STRICTLY greater than the ceiling: at the ceiling passes, one over fails", () => {
    const atCeiling = projectCapacity({
      cardsPerMonth: cardsForConcurrency(EL_PLAN),
      flagRate: 0.0035,
    });
    expect(atCeiling.requiredConcurrentCalls).toBeCloseTo(EL_PLAN, 9);
    expect(atCeiling.ceilingRatios.elevenLabsConcurrentSessions).toBeCloseTo(1, 9);
    expect(atCeiling.bindingConstraint.oversubscribed).toBe(false);
    expect(atCeiling.bindingConstraint.name).toBe("elevenLabsConcurrentSessions");
    expect(atCeiling.verdict[2]).toContain("Within every vendor ceiling");

    const justOver = projectCapacity({
      cardsPerMonth: cardsForConcurrency(EL_PLAN * 1.001),
      flagRate: 0.0035,
    });
    expect(justOver.ceilingRatios.elevenLabsConcurrentSessions).toBeGreaterThan(1);
    expect(justOver.bindingConstraint.oversubscribed).toBe(true);
    expect(justOver.verdict[2]).toContain("OVERSUBSCRIBED");
  });

  test("the admission band gates are inclusive: just under passes, exactly at escalates", () => {
    // CONSTRAINED at 12 Ã— 0.7 = 8.4, SHED at 12 Ã— 0.95 = 11.4.
    const bandAt = (conc: number) =>
      projectCapacity({ cardsPerMonth: cardsForConcurrency(conc), flagRate: 0.0035 }).bandAtPeak;
    expect(bandAt(8.4 - 0.01)).toBe("NORMAL");
    expect(bandAt(8.4)).toBe("CONSTRAINED");
    expect(bandAt(11.4 - 0.01)).toBe("CONSTRAINED");
    expect(bandAt(11.4)).toBe("SHED");
    const gates = projectCapacity(STEADY).bandGates;
    expect(gates.burstCeiling).toBe(EL_BURST);
    expect(gates.constrainedAt).toBeCloseTo(8.4, 9);
    expect(gates.shedAt).toBeCloseTo(11.4, 9);
  });

  test("voice coverage is 1 at and below the burst ceiling, and falls above it", () => {
    // burstCeiling Ã· requiredConcurrent, clamped at 1.
    const coverageAt = (conc: number) =>
      projectCapacity({ cardsPerMonth: cardsForConcurrency(conc), flagRate: 0.0035 })
        .voiceCoverageOfPeak;
    expect(coverageAt(EL_BURST)).toBe(1);
    expect(coverageAt(EL_BURST * 2)).toBe(0.5);
    expect(coverageAt(1)).toBe(1);
  });

  test("the binding constraint is the WORST ratio, whichever ceiling that turns out to be", () => {
    // `vendorCeiling` reads the env at CALL time, so the conversational-AI
    // plan can be lifted for one case without touching the module. Each
    // case is built so a DIFFERENT ceiling is the worst one, and the
    // assertion is generic: the named constraint is always the argmax and
    // `oversubscribed` is always `maxRatio > 1`.
    const worstOf = (input: CapacityModelInput) => {
      const m = projectCapacity(input);
      const max = Math.max(...Object.values(m.ceilingRatios));
      expect(m.bindingConstraint.ratio).toBeCloseTo(max, 12);
      expect(m.bindingConstraint.oversubscribed).toBe(max > 1);
      return m.bindingConstraint.name;
    };
    // Conversational-AI concurrency: the plan default is the free tier, so
    // an ordinary institution is oversubscribed on it before anything else.
    expect(worstOf({ cardsPerMonth: 100_000, flagRate: 0.0035 })).toBe(
      "elevenLabsConcurrentSessions",
    );
    // Carrier account concurrency: with a 400-session plan, 20 calls of talk
    // against a 10-call account is the worst ratio. This ceiling does NOT
    // improve by buying numbers, which is why it is worth naming.
    process.env.ELEVENLABS_MAX_CONCURRENT = "400";
    expect(
      worstOf({
        cardsPerMonth: cardsForConcurrency(TWILIO_CONCURRENCY * 2),
        flagRate: 0.0035,
      }),
    ).toBe("twilioAccountConcurrency");
    // Per-number CPS is the LAST ceiling to bind, and it takes an
    // implausibly short call to get there: CPS Ã· account-concurrency is
    // 10 Ã· (2 Ã— fromNumbers Ã— talkSeconds), which is below 1 for any call
    // longer than 5 s at one number. At 4 s of talk it finally binds.
    expect(
      worstOf({
        cardsPerMonth: 1_000_000,
        flagRate: 0.0035,
        meanCallSeconds: 4,
        fromNumbers: 1,
      }),
    ).toBe("twilioCallsPerSecondPerNumber");
    expect(
      worstOf({
        cardsPerMonth: 1_000_000,
        flagRate: 0.0035,
        meanCallSeconds: MEAN_CALL_SECONDS,
        fromNumbers: 1,
      }),
    ).toBe("twilioAccountConcurrency");
    delete process.env.ELEVENLABS_MAX_CONCURRENT;
  });
});

describe("projectCapacity — capacity math is monotonic", () => {
  test("more demand never yields less work and never improves a ratio", () => {
    let previousConc = -1;
    let previousRatio = -1;
    let previousCoverage = 2;
    let previousBilling = -1;
    for (const cards of [1_000, 10_000, 100_000, 1_000_000, 2_000_000, 4_000_000, 8_000_000]) {
      const m = projectCapacity({ cardsPerMonth: cards, flagRate: 0.0035 });
      expect(m.requiredConcurrentCalls).toBeGreaterThan(previousConc);
      expect(m.ceilingRatios.elevenLabsConcurrentSessions).toBeGreaterThan(previousRatio);
      expect(m.ceilingRatios.twilioAccountConcurrency).toBeGreaterThan(previousRatio / 4);
      expect(m.voiceCoverageOfPeak).toBeLessThanOrEqual(previousCoverage);
      expect(m.costAtPeak.requiredHourlyBillingCeilingMinor).toBeGreaterThanOrEqual(
        previousBilling,
      );
      previousConc = m.requiredConcurrentCalls;
      previousRatio = m.ceilingRatios.elevenLabsConcurrentSessions;
      previousCoverage = m.voiceCoverageOfPeak;
      previousBilling = m.costAtPeak.requiredHourlyBillingCeilingMinor;
    }
  });

  test("more from-numbers is pure headroom: it lowers only the per-number ratio", () => {
    const base = projectCapacity(STEADY);
    for (const fromNumbers of [1, 2, 4, 8, 16]) {
      const m = projectCapacity({ ...STEADY, fromNumbers });
      expect(m.inputs.fromNumbers.value).toBe(fromNumbers);
      expect(m.ceilingRatios.twilioCallsPerSecondPerNumber).toBeCloseTo(
        base.ceilingRatios.twilioCallsPerSecondPerNumber / fromNumbers,
        12,
      );
      // Every other ceiling is unaffected: concurrency is an ACCOUNT limit.
      expect(m.ceilingRatios.elevenLabsConcurrentSessions).toBe(
        base.ceilingRatios.elevenLabsConcurrentSessions,
      );
      expect(m.ceilingRatios.twilioAccountConcurrency).toBe(
        base.ceilingRatios.twilioAccountConcurrency,
      );
      expect(m.bindingConstraint.ratio).toBeLessThanOrEqual(base.bindingConstraint.ratio);
      expect(m.voiceCoverageOfPeak).toBe(base.voiceCoverageOfPeak);
    }
  });

  test("more talk time never reduces the concurrency the model demands", () => {
    let previous = -1;
    for (const seconds of [30, 60, 180, 600, 1800]) {
      const m = projectCapacity({ ...STEADY, meanCallSeconds: seconds });
      expect(m.requiredConcurrentCalls).toBeGreaterThan(previous);
      previous = m.requiredConcurrentCalls;
    }
  });

  test("from_numbers_required is a whole number, and never fewer than one", () => {
    // ceil(peakPerSecond Ã· 2 cps), floored at 1 — so a quiet platform still
    // needs one number to place any call at all.
    expect(projectCapacity(STEADY).fromNumbersRequired).toBe(1);
    expect(projectCapacity({ cardsPerMonth: 0, flagRate: 0 }).fromNumbersRequired).toBe(1);
    expect(
      projectCapacity({ cardsPerMonth: 1e9, flagRate: 0.0035 }).fromNumbersRequired,
    ).toBeGreaterThan(1);
    for (const cards of [1_000, 100_000, 1_000_000, 1e8]) {
      const m = projectCapacity({ cardsPerMonth: cards, flagRate: 0.0035 });
      expect(Number.isInteger(m.fromNumbersRequired)).toBe(true);
      expect(m.fromNumbersRequired).toBeGreaterThanOrEqual(1);
      expect(m.fromNumbersRequired).toBe(
        Math.max(1, Math.ceil(m.peakInterventionsPerSecond / TWILIO_CPS)),
      );
    }
  });
});

describe("projectCapacity — degenerate configuration", () => {
  // See the file header: these pin CURRENT behaviour, which fails toward
  // ADMITTING on negative and NaN inputs. Do not "fix" a failing test here
  // without changing src/lib/scale/capacity.ts first.

  test("a NaN volume fails toward ADMITTING (reported bug)", () => {
    const m = projectCapacity({ cardsPerMonth: Number.NaN, flagRate: 0.0035 });
    expect(m.requiredConcurrentCalls).toBeNaN();
    expect(m.ceilingRatios.elevenLabsConcurrentSessions).toBeNaN();
    expect(m.ceilingRatios.twilioAccountConcurrency).toBeNaN();
    expect(m.ceilingRatios.twilioCallsPerSecondPerNumber).toBeNaN();
    // `NaN > 1` is false, so the model reports headroom it does not have.
    expect(m.bindingConstraint.oversubscribed).toBe(false);
    expect(m.verdict[2]).toContain("Within every vendor ceiling");
    // `NaN >= 8.4` is false too, so a broken input reads as NORMAL.
    expect(m.bandAtPeak).toBe("NORMAL");
    expect(m.costAtPeak.requiredHourlyBillingCeilingMinor).toBeNaN();
  });

  test("a zero averaging window fails toward REFUSING but with Infinity in it (reported bug)", () => {
    const m = projectCapacity({ cardsPerMonth: 100_000, flagRate: 0.0035, peakWindowMinutes: 0 });
    expect(m.averagingWindowHours).toBe(0);
    expect(m.requiredConcurrentCalls).toBe(Infinity);
    expect(m.ceilingRatios.elevenLabsConcurrentSessions).toBe(Infinity);
    expect(m.bindingConstraint.oversubscribed).toBe(true);
    expect(m.bandAtPeak).toBe("SHED");
    expect(m.fromNumbersRequired).toBe(Infinity);
  });

  test("zero from-numbers divides by zero in the ratio but is floored in from_numbers_required", () => {
    const m = projectCapacity({ ...STEADY, fromNumbers: 0 });
    // `Math.max(1, ¦)` protects the reported number¦
    expect(m.fromNumbersRequired).toBe(1);
    // ¦but not the ratio, which is a decision field.
    expect(m.ceilingRatios.twilioCallsPerSecondPerNumber).toBe(Infinity);
    expect(m.bindingConstraint.name).toBe("twilioCallsPerSecondPerNumber");
    expect(m.bindingConstraint.oversubscribed).toBe(true);
  });

  test("negative inputs fail toward ADMITTING (reported bug)", () => {
    for (const input of [
      { ...STEADY, flagRate: -1 },
      { ...STEADY, cardsPerMonth: -100_000 },
      { ...STEADY, meanCallSeconds: -MEAN_CALL_SECONDS },
      { ...STEADY, fromNumbers: -2 },
    ]) {
      const m = projectCapacity(input);
      expect(m.bindingConstraint.oversubscribed).toBe(false);
      expect(m.verdict[2]).toContain("Within every vendor ceiling");
      expect(m.bandAtPeak).toBe("NORMAL");
      expect(m.voiceCoverageOfPeak).toBe(1);
    }
  });

  test("genuinely zero demand admits, and never divides by zero in the coverage field", () => {
    const m = projectCapacity({ cardsPerMonth: 0, flagRate: 0 });
    expect(m.interventionsPerMonth).toBe(0);
    expect(m.requiredConcurrentCalls).toBe(0);
    expect(m.ceilingRatios.elevenLabsConcurrentSessions).toBe(0);
    expect(m.bindingConstraint.oversubscribed).toBe(false);
    // The explicit `> 0` branch: 12 Ã· 0 would be Infinity here.
    expect(m.voiceCoverageOfPeak).toBe(1);
    expect(m.costAtPeak.requiredHourlyBillingCeilingMinor).toBe(0);
    expect(m.bandAtPeak).toBe("NORMAL");
  });
});

describe("vendorCeiling — the env override is read at call time and fails safe", () => {
  const KEYS = [
    "ELEVENLABS_MAX_CONCURRENT",
    "TWILIO_CPS_PER_FROM_NUMBER",
    "TWILIO_MAX_CONCURRENT_CALLS",
  ];

  test("every ceiling names the env var it reads and ships a conservative default", () => {
    expect(Object.values(CEILING_ENV_VARS).sort()).toEqual([...KEYS].sort());
    for (const name of KEYS) delete process.env[name];
    const all = vendorCeilings();
    expect(all.map((c) => c.name)).toEqual([
      "elevenLabsConcurrentSessions",
      "twilioCallsPerSecondPerNumber",
      "twilioAccountConcurrency",
    ]);
    expect(all.map((c) => c.value)).toEqual([EL_PLAN, TWILIO_CPS, TWILIO_CONCURRENCY]);
    expect(all.every((c) => c.checkedOn === "2026-10-02")).toBe(true);
    expect(all.every((c) => c.basis === "published-vendor-limit")).toBe(true);
  });

  test("a well-formed override wins, and is floored to a whole call", () => {
    process.env.ELEVENLABS_MAX_CONCURRENT = "20";
    expect(vendorCeiling("elevenLabsConcurrentSessions").value).toBe(20);
    process.env.ELEVENLABS_MAX_CONCURRENT = "20.9";
    expect(vendorCeiling("elevenLabsConcurrentSessions").value).toBe(20);
  });

  test("a malformed or non-positive override falls back to the DEFAULT and says so", () => {
    for (const raw of ["0", "-1", "abc", "1e400", "   "]) {
      process.env.ELEVENLABS_MAX_CONCURRENT = raw;
      const c = vendorCeiling("elevenLabsConcurrentSessions");
      expect(c.value).toBe(EL_PLAN);
      if (raw.trim() !== "") {
        // The note names the variable and the value that was rejected, so
        // a typo'd ceiling can never read as "unlimited".
        expect(c.note).toContain("ELEVENLABS_MAX_CONCURRENT");
        expect(c.note).toContain(`is not a positive number`);
      }
    }
    delete process.env.ELEVENLABS_MAX_CONCURRENT;
  });

  test("an override raised mid-process takes effect on the next call", () => {
    delete process.env.TWILIO_MAX_CONCURRENT_CALLS;
    expect(vendorCeiling("twilioAccountConcurrency").value).toBe(TWILIO_CONCURRENCY);
    process.env.TWILIO_MAX_CONCURRENT_CALLS = "40";
    expect(vendorCeiling("twilioAccountConcurrency").value).toBe(40);
    // ¦and the projection moves with it, because it reads the ceiling per call.
    expect(projectCapacity(STEADY).ceilingRatios.twilioAccountConcurrency).toBeCloseTo(
      0.1917808219178082 / 40,
      12,
    );
    delete process.env.TWILIO_MAX_CONCURRENT_CALLS;
  });

  test("ceilingInputs reports the DEFAULTS, not the current environment", () => {
    process.env.TWILIO_CPS_PER_FROM_NUMBER = "9";
    const inputs = ceilingInputs();
    expect(inputs.twilioCallsPerSecondPerNumber.value).toBe(TWILIO_CPS);
    expect(inputs.twilioCallsPerSecondPerNumber.confidence).toBe("calibrated");
    expect(vendorCeiling("twilioCallsPerSecondPerNumber").value).toBe(9);
    delete process.env.TWILIO_CPS_PER_FROM_NUMBER;
  });
});

describe("VendorConcurrencyGate — a bounded, FIFO, per-process semaphore", () => {
  test("a zero or negative ceiling is floored at one so the caller can never deadlock", async () => {
    for (const raw of [0, -5]) {
      expect(new VendorConcurrencyGate(() => raw).ceiling()).toBe(1);
    }
    expect(new VendorConcurrencyGate(() => 3).ceiling()).toBe(3);
  });

  test("a NaN ceiling admits NOTHING and fails toward degrading (reported gap)", async () => {
    // `Math.max(1, NaN)` is NaN, not 1, so `active < NaN` is false and even
    // the first caller queues and times out. Degrading is the safe direction,
    // but the floor was clearly meant to catch this case too.
    const gate = new VendorConcurrencyGate(() => Number.NaN);
    expect(gate.ceiling()).toBeNaN();
    await expect(gate.acquire(1)).rejects.toBeInstanceOf(VendorCeilingExhaustedError);
    expect(gate.stats().inFlight).toBe(0);
    expect(gate.stats().granted).toBe(0);
  });

  test("slots are granted up to the ceiling and then queue, not overflow", async () => {
    const gate = new VendorConcurrencyGate(() => 2);
    await gate.acquire(0);
    await gate.acquire(0);
    expect(gate.stats().inFlight).toBe(2);
    expect(gate.stats().granted).toBe(2);
    // Third caller cannot proceed at zero wait: it must time out, not be
    // admitted over the ceiling.
    await expect(gate.acquire(1)).rejects.toBeInstanceOf(VendorCeilingExhaustedError);
    expect(gate.stats().inFlight).toBe(2);
    expect(gate.stats().waiters).toBe(0);
  });

  test("a timed-out acquire names the ceiling it could not get past", async () => {
    const gate = new VendorConcurrencyGate(() => 1);
    await gate.acquire(0);
    const err = (await gate.acquire(5).catch((e: unknown) => e)) as VendorCeilingExhaustedError;
    expect(err).toBeInstanceOf(VendorCeilingExhaustedError);
    expect(err.name).toBe("VendorCeilingExhaustedError");
    expect(err.inFlight).toBe(1);
    expect(err.ceiling).toBe(1);
    expect(err.waitedMs).toBe(5);
    expect(gate.exhausted).toBe(1);
    expect(gate.stats().timeouts).toBe(1);
  });

  test("waiters are served longest-waiting-first, and a released slot is handed on", async () => {
    const gate = new VendorConcurrencyGate(() => 1);
    await gate.acquire(0);
    const order: number[] = [];
    const waiting = [1, 2, 3].map((n) =>
      gate.acquire(1000).then(() => {
        order.push(n);
      }),
    );
    expect(gate.stats().waiters).toBe(3);
    // One release frees exactly one slot, so the queue drains one at a time.
    gate.release();
    expect(gate.stats().waiters).toBe(2);
    gate.release();
    gate.release();
    await Promise.all(waiting);
    expect(order).toEqual([1, 2, 3]);
    expect(gate.stats().inFlight).toBe(1);
    expect(gate.stats().granted).toBe(4);
    expect(gate.stats().waiters).toBe(0);
  });

  test("a waiter that gave up is skipped, not served late", async () => {
    const gate = new VendorConcurrencyGate(() => 1);
    await gate.acquire(0);
    const early = gate.acquire(1).catch(() => "gave-up" as const);
    const late = gate.acquire(1000).then(() => "served" as const);
    await early;
    gate.release();
    expect(await late).toBe("served");
    expect(gate.stats().inFlight).toBe(1);
    expect(gate.stats().timeouts).toBe(1);
    expect(gate.stats().waiters).toBe(0);
  });

  test("release never drives the counter below zero", async () => {
    const gate = new VendorConcurrencyGate(() => 2);
    gate.release();
    gate.release();
    expect(gate.stats().inFlight).toBe(0);
    await gate.acquire(0);
    expect(gate.stats().inFlight).toBe(1);
  });

  test("a ceiling lowered mid-flight is honoured on the next grant", async () => {
    let ceiling = 4;
    const gate = new VendorConcurrencyGate(() => ceiling);
    await gate.acquire(0);
    await gate.acquire(0);
    expect(gate.stats().inFlight).toBe(2);
    ceiling = 1;
    expect(gate.stats().ceiling).toBe(1);
    await expect(gate.acquire(1)).rejects.toBeInstanceOf(VendorCeilingExhaustedError);
    gate.release();
    gate.release();
    expect(gate.stats().inFlight).toBe(0);
  });
});

describe("throttleBackoffMs — equal jitter with a hard cap", () => {
  test("half the delay is fixed, half is random, and the floor is base/2", () => {
    // attempt 1 → exponential = 250, half = 125: [125, 250].
    expect(throttleBackoffMs(1, () => 0)).toBe(125);
    expect(throttleBackoffMs(1, () => 0.5)).toBe(188);
    expect(throttleBackoffMs(1, () => 1)).toBe(250);
    for (let i = 0; i < 50; i++) {
      const ms = throttleBackoffMs(1);
      expect(ms).toBeGreaterThanOrEqual(125);
      expect(ms).toBeLessThanOrEqual(250);
    }
  });

  test("the exponential rung doubles, and saturates at maxMs", () => {
    expect(throttleBackoffMs(1, () => 0.5)).toBe(188); // 250/2 rounded
    expect(throttleBackoffMs(2, () => 0.5)).toBe(375); // 500/2
    expect(throttleBackoffMs(3, () => 0.5)).toBe(750); // 1000/2
    expect(throttleBackoffMs(4, () => 0.5)).toBe(1500); // 2000/2
    expect(throttleBackoffMs(10, () => 1)).toBe(BACKOFF_MAX_MS);
    expect(throttleBackoffMs(1_000, () => 1)).toBe(BACKOFF_MAX_MS);
  });

  test("an attempt below one is floored, so there is never a sub-base rung", () => {
    for (const attempt of [0, -1, -999, 0.4]) {
      expect(throttleBackoffMs(attempt, () => 0.5)).toBe(throttleBackoffMs(1, () => 0.5));
    }
  });

  test("an explicit base and cap are honoured", () => {
    // base 1000: rungs 1000, 2000, 4000, ¦ halved for the fixed component.
    expect(throttleBackoffMs(1, () => 0.5, 1000, 100_000)).toBe(750);
    expect(throttleBackoffMs(4, () => 0.5, 1000, 100_000)).toBe(6000);
    // 1000 Ã— 2^8 = 256_000 saturates at the 100_000 cap → [50_000, 100_000].
    expect(throttleBackoffMs(9, () => 0.5, 1000, 100_000)).toBe(75_000);
    expect(throttleBackoffMs(9, () => 0, 1000, 100_000)).toBe(50_000);
    expect(throttleBackoffMs(9, () => 1, 1000, 100_000)).toBe(100_000);
  });
});

describe("isThrottle", () => {
  test("recognises a throttle from a status, a statusCode, a code, or the message", () => {
    expect(isThrottle({ status: 429 })).toBe(true);
    expect(isThrottle({ statusCode: 429 })).toBe(true);
    expect(isThrottle({ code: 429 })).toBe(true);
    expect(isThrottle({ message: "429 Too Many Requests" })).toBe(true);
    expect(isThrottle({ message: "rate limit exceeded" })).toBe(true);
    expect(isThrottle({ message: "concurrency limit reached" })).toBe(true);
  });

  test("does not mistake an ordinary failure for a throttle", () => {
    expect(isThrottle({ status: 500 })).toBe(false);
    expect(isThrottle({ statusCode: 400, message: "bad request" })).toBe(false);
    expect(isThrottle({ message: "connection reset" })).toBe(false);
    // A non-object is not an error path the caller can classify.
    expect(isThrottle(null)).toBe(false);
    expect(isThrottle("429")).toBe(false);
    expect(isThrottle(undefined)).toBe(false);
  });
});

describe("withElevenLabsCeiling — retry, degrade, and release before sleeping", () => {
  const sleepCalls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleepCalls.push(ms);
  };

  beforeEach(() => {
    sleepCalls.length = 0;
  });

  test("a successful first attempt takes no retry and no gate wait", async () => {
    const gate = new VendorConcurrencyGate(() => 2);
    const res = await withElevenLabsCeiling({
      call: async () => "ok",
      gate,
      sleep,
    });
    expect(res).toEqual({ value: "ok", attempts: 1, throttles: 0, waitedMs: 0, gateTimeouts: 0 });
    expect(sleepCalls).toEqual([]);
    expect(gate.stats().inFlight).toBe(0);
  });

  test("429s are retried up to maxAttempts and the wait is reported separately", async () => {
    const gate = new VendorConcurrencyGate(() => 2);
    const throttles: number[] = [];
    const res = await withElevenLabsCeiling({
      call: async (attempt) => {
        if (attempt < 3)
          // eslint-disable-next-line no-throw-literal -- a plain object rejection is the shape the retry classifier is being tested against
          throw { status: 429 };
        return attempt;
      },
      gate,
      sleep,
      rand: () => 0.5,
      onThrottle: (info) => throttles.push(info.delayMs),
    });
    expect(res.value).toBe(3);
    expect(res.attempts).toBe(3);
    expect(res.throttles).toBe(2);
    expect(res.waitedMs).toBe(188 + 375);
    expect(throttles).toEqual([188, 375]);
  });

  test("the slot is RELEASED before the backoff sleep, so a throttle is not self-inflicted", async () => {
    const gate = new VendorConcurrencyGate(() => 1);
    let inFlightWhenSlept = -1;
    await withElevenLabsCeiling({
      call: async (attempt) => {
        if (attempt === 1)
          // eslint-disable-next-line no-throw-literal -- a plain object rejection is the shape the retry classifier is being tested against
          throw { status: 429 };
        return "ok";
      },
      gate,
      sleep: async () => {
        inFlightWhenSlept = gate.stats().inFlight;
      },
    });
    expect(inFlightWhenSlept).toBe(0);
  });

  test("a non-throttle error is not retried — it would fail the same way twice", async () => {
    const gate = new VendorConcurrencyGate(() => 2);
    let calls = 0;
    await expect(
      withElevenLabsCeiling({
        call: async () => {
          calls++;
          throw new Error("socket hang up");
        },
        gate,
        sleep,
      }),
    ).rejects.toThrow("socket hang up");
    expect(calls).toBe(1);
    expect(gate.stats().inFlight).toBe(0);
  });

  test("throttling on the last attempt rethrows rather than sleeping once more", async () => {
    const gate = new VendorConcurrencyGate(() => 2);
    let calls = 0;
    await expect(
      withElevenLabsCeiling({
        call: async () => {
          calls++;
          // eslint-disable-next-line no-throw-literal -- a plain object rejection is the shape the retry classifier is being tested against
          throw { status: 429 };
        },
        gate,
        maxAttempts: MAX_THROTTLE_ATTEMPTS,
        sleep,
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(MAX_THROTTLE_ATTEMPTS);
    expect(sleepCalls).toHaveLength(MAX_THROTTLE_ATTEMPTS - 1);
    expect(gate.stats().inFlight).toBe(0);
  });

  test("a gate that cannot get a slot degrades with a typed error, not a hang", async () => {
    const gate = new VendorConcurrencyGate(() => 1);
    await gate.acquire(0);
    const seen: VendorCeilingExhaustedError[] = [];
    let calls = 0;
    await expect(
      withElevenLabsCeiling({
        call: async () => {
          calls++;
          return "unreachable";
        },
        gate,
        maxWaitMs: 1,
        sleep,
        onGateTimeout: (err) => seen.push(err),
      }),
    ).rejects.toBeInstanceOf(VendorCeilingExhaustedError);
    expect(calls).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.ceiling).toBe(1);
  });

  test("maxAttempts is floored at one, so the caller always makes an attempt", async () => {
    const gate = new VendorConcurrencyGate(() => 2);
    let calls = 0;
    await withElevenLabsCeiling({
      call: async () => {
        calls++;
        return "ok";
      },
      gate,
      maxAttempts: 0,
      sleep,
    });
    expect(calls).toBe(1);
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// scale/queue.ts — the durable dial queue
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

describe("dialJobBackoffMs — the bounded retry ladder", () => {
  test("rungs are the declared ladder, and the jitter band is Â±20%", () => {
    expect([...DIAL_RETRY_LADDER_MS]).toEqual([30_000, 120_000, 600_000]);
    expect(MAX_DIAL_ATTEMPTS).toBe(3);
    expect(dialJobBackoffMs(1, () => 0.5)).toBe(30_000);
    expect(dialJobBackoffMs(2, () => 0.5)).toBe(120_000);
    expect(dialJobBackoffMs(3, () => 0.5)).toBe(600_000);
    expect(dialJobBackoffMs(1, () => 0)).toBe(24_000);
    expect(dialJobBackoffMs(1, () => 1)).toBe(36_000);
  });

  test("the ladder index is clamped at both ends", () => {
    // Below the first rung there is nothing to accelerate, so it stays at 30s¦
    expect(dialJobBackoffMs(0, () => 0.5)).toBe(30_000);
    expect(dialJobBackoffMs(-10, () => 0.5)).toBe(30_000);
    // ¦and past the last rung it saturates at the longest delay, which is
    // what stops an undiallable number being retried for ever.
    expect(dialJobBackoffMs(4, () => 0.5)).toBe(600_000);
    expect(dialJobBackoffMs(99, () => 0.5)).toBe(600_000);
  });

  test("a FRACTIONAL retry count skips to the LAST rung (reported bug)", () => {
    // `Math.min(1.5, 3) - 1` is 0.5, which is not an array index, so the
    // `?? last-element` fallback fires: 1.5 → 600s where 1 → 30s and 2 →
    // 120s. Retries is always an integer in the database, so this is only
    // reachable by a caller, but a 20Ã— jump is a surprising direction.
    expect(dialJobBackoffMs(1.5, () => 0.5)).toBe(600_000);
    expect(dialJobBackoffMs(2.5, () => 0.5)).toBe(600_000);
    expect(dialJobBackoffMs(Number.NaN, () => 0.5)).toBe(600_000);
  });

  test("every rung stays inside its own Â±20% band", () => {
    for (const retries of [1, 2, 3]) {
      const base = DIAL_RETRY_LADDER_MS[Math.min(retries, 3) - 1]!;
      expect(dialJobBackoffMs(retries, () => 0)).toBe(Math.round(base * 0.8));
      expect(dialJobBackoffMs(retries, () => 1)).toBe(Math.round(base * 1.2));
      for (let i = 0; i < 50; i++) {
        const ms = dialJobBackoffMs(retries);
        expect(ms).toBeGreaterThanOrEqual(Math.round(base * 0.8));
        expect(ms).toBeLessThanOrEqual(Math.round(base * 1.2));
      }
    }
  });
});

describe("enqueueDialJob — idempotent on (case_id, attempt_no)", () => {
  test("the first write creates the row and reports PENDING", async () => {
    const res = await enqueueDialJob({ caseId: "case-1", caseRef: "SV-1" });
    expect(res.created).toBe(true);
    expect(res.state).toBe("PENDING");
    expect(res.retries).toBe(0);
    const job = await dialJobById(res.id);
    expect(job?.case_id).toBe("case-1");
    expect(job?.case_ref).toBe("SV-1");
    expect(job?.org_id).toBeNull();
    expect(job?.priority).toBe(0);
    expect(job?.payload).toBe("{}");
    expect(job?.claimed_by).toBeNull();
    expect(job?.lease_expires_at).toBeNull();
  });

  test("a replayed signal reports the EXISTING row and changes nothing", async () => {
    const first = await enqueueDialJob({ caseId: "case-2", caseRef: "SV-2", priority: 7 });
    const second = await enqueueDialJob({ caseId: "case-2", caseRef: "SV-2", priority: -99 });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.state).toBe("PENDING");
    // The do-nothing path must not have reset priority, retries or the id.
    const job = await dialJobById(first.id);
    expect(job?.priority).toBe(7);
    expect(job?.retries).toBe(0);
    expect(table.calls.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(0);
  });

  test("a claimed row survives a replayed signal — a re-dial is the failure mode", async () => {
    const enqueued = await enqueueDialJob({ caseId: "case-3", caseRef: "SV-3" });
    await claimDialJobs({ workerId: "w1", limit: 1 });
    const replay = await enqueueDialJob({ caseId: "case-3", caseRef: "SV-3" });
    expect(replay.created).toBe(false);
    expect(replay.state).toBe("CLAIMED");
    const job = await dialJobById(enqueued.id);
    expect(job?.claimed_by).toBe("w1");
  });

  test("attempt_no is part of the identity, so a retry is a new row", async () => {
    const first = await enqueueDialJob({ caseId: "case-4", caseRef: "SV-4", attemptNo: 1 });
    const second = await enqueueDialJob({ caseId: "case-4", caseRef: "SV-4", attemptNo: 2 });
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(await queueDepth()).toMatchObject({ pending: 2, total: 2 });
  });

  test("the identity is missing before the database is touched", async () => {
    await expect(enqueueDialJob({ caseId: "", caseRef: "SV" })).rejects.toBeInstanceOf(TypeError);
    await expect(enqueueDialJob({ caseId: "c", caseRef: "" })).rejects.toBeInstanceOf(TypeError);
    expect(table.calls).toHaveLength(0);
  });

  test("attemptNo must be a positive integer", async () => {
    for (const attemptNo of [0, -1, 1.5, Number.NaN]) {
      await expect(
        enqueueDialJob({ caseId: "c", caseRef: "SV", attemptNo }),
      ).rejects.toBeInstanceOf(RangeError);
    }
    expect(table.calls).toHaveLength(0);
  });

  test("a negative delay is clamped to due-now rather than made unclaimable", async () => {
    const res = await enqueueDialJob({
      caseId: "case-5",
      caseRef: "SV-5",
      availableInMs: -10_000,
    });
    const job = await dialJobById(res.id);
    expect(job?.available_at.getTime()).toBe(table.now);
    expect(await claimDialJobs({ workerId: "w1", limit: 1 })).toHaveLength(1);
  });
});

describe("claimDialJobs — eligibility, ordering, and the limit", () => {
  test("an empty queue returns an empty array, never a throw and never undefined", async () => {
    const claimed = await claimDialJobs({ workerId: "w1" });
    expect(claimed).toEqual([]);
    expect(await outstandingJobs()).toBe(0);
  });

  test("a job that is not due yet is not claimable", async () => {
    const id = await seed({ caseId: "c1", availableInMs: 30_000 });
    expect(await claimDialJobs({ workerId: "w1" })).toEqual([]);
    table.advance(30_000);
    expect((await claimDialJobs({ workerId: "w1" })).map((j) => j.id)).toEqual([id]);
  });

  test("higher priority is claimed first; equal priority falls back to arrival order", async () => {
    const low = await seed({ caseId: "c1", priority: 1 });
    const high = await seed({ caseId: "c2", priority: 9 });
    const mid = await seed({ caseId: "c3", priority: 5 });
    const equal = await seed({ caseId: "c4", priority: 9 });
    const claimed = (await claimDialJobs({ workerId: "w1", limit: 10 })).map((j) => j.id);
    // priority DESC, then created_at ASC among equals.
    expect(claimed).toEqual([high, equal, mid, low]);
    expect(low).not.toBe(high);
  });

  test("the claim limit is floored at one and truncated, and defaults to 10", async () => {
    for (let i = 0; i < 12; i++) await seed({ caseId: `c${i}` });
    const limitOf = async (limit?: number) => {
      // Age every lease out so the whole queue is claimable again, which
      // is the same reclamation a real worker would get from the clock.
      table.advance(DEFAULT_LEASE_MS + 1);
      return (await claimDialJobs({ workerId: "w1", limit })).length;
    };
    expect(await limitOf()).toBe(10);
    expect(await limitOf(3)).toBe(3);
    expect(await limitOf(3.9)).toBe(3);
    expect(await limitOf(11)).toBe(11);
    // Zero and negative limits would otherwise claim NOTHING and stall the
    // drainer forever; the floor turns them into a one-row claim.
    expect(await limitOf(0)).toBe(1);
    expect(await limitOf(-5)).toBe(1);
    expect(await limitOf(0.4)).toBe(1);
  });

  test("a negative lease is clamped to zero and the default is one minute", async () => {
    const id = await seed({ caseId: "c1" });
    await claimDialJobs({ workerId: "w1", limit: 1, leaseMs: -1000 });
    const job = await dialJobById(id);
    expect(job?.lease_expires_at?.getTime()).toBe(table.now);
    // Expired at once, so the very next claim reclaims it.
    table.advance(1);
    expect((await claimDialJobs({ workerId: "w2", limit: 1 })).map((j) => j.claimed_by)).toEqual([
      "w2",
    ]);
    expect(DEFAULT_LEASE_MS).toBe(60_000);
  });

  test("an expired lease makes a CLAIMED row claimable again — no sweeper needed", async () => {
    const id = await seed({ caseId: "c1" });
    const first = await claimDialJobs({ workerId: "w1", limit: 1, leaseMs: 1000 });
    expect(first[0]?.claimed_by).toBe("w1");
    expect(await claimDialJobs({ workerId: "w2", limit: 1, leaseMs: 1000 })).toEqual([]);
    table.advance(1001);
    const reclaimed = await claimDialJobs({ workerId: "w2", limit: 1, leaseMs: 1000 });
    expect(reclaimed.map((j) => j.id)).toEqual([id]);
    expect(reclaimed[0]?.claimed_by).toBe("w2");
  });

  test("the claim predicate is re-asserted on the update target, not just the candidate list", async () => {
    // The module's doc comment records the measured failure this prevents:
    // 8 workers produced ~41,000 claims for 300 jobs because the snapshot
    // alone was treated as a claim. Both halves of the predicate must
    // therefore appear on the UPDATE, not only in the candidate SELECT.
    await seed({ caseId: "c1" });
    await claimDialJobs({ workerId: "w1", limit: 1 });
    const sql = table.sqlMatching("FOR UPDATE SKIP LOCKED")[0]?.sql ?? "";
    expect(sql).not.toBe("");
    const targetWhere = sql.slice(sql.indexOf("WHERE j.id = claimed.id"));
    expect(targetWhere).toContain("j.state = 'PENDING' AND j.available_at <= now()");
    expect(targetWhere).toContain("j.state = 'CLAIMED'");
    expect(targetWhere).toContain("j.lease_expires_at < now()");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    // The candidate ORDER is the claim policy: expected-loss descending,
    // then earliest due, then FIFO by creation.
    expect(sql).toContain("ORDER BY priority DESC, available_at ASC, created_at ASC");
  });
});

describe("renewClaim — the exactly-once gate", () => {
  test("the owner extends its own lease", async () => {
    const id = await seed({ caseId: "c1" });
    await claimDialJobs({ workerId: "w1", limit: 1, leaseMs: 1000 });
    expect(await renewClaim(id, "w1", 5000)).toBe(true);
    expect((await dialJobById(id))?.lease_expires_at?.getTime()).toBe(table.now + 5000);
  });

  test("a worker that lost the race is told NOT to place the call", async () => {
    const id = await seed({ caseId: "c1" });
    await claimDialJobs({ workerId: "w1", limit: 1, leaseMs: 1000 });
    expect(await renewClaim(id, "w2", 5000)).toBe(false);
    expect(await renewClaim(id, "w1")).toBe(true);
    expect(DEFAULT_LEASE_MS).toBe(60_000);
  });

  test("an unknown job cannot be claimed into ownership", async () => {
    expect(await renewClaim("no-such-job", "w1")).toBe(false);
    expect(await completeDialJob("no-such-job")).toBe(false);
    expect(await dialJobById("no-such-job")).toBeNull();
  });

  test("a PENDING row is not owned by anyone, so renew refuses it", async () => {
    const id = await seed({ caseId: "c1" });
    expect(await renewClaim(id, "w1")).toBe(false);
  });
});

describe("completeDialJob — idempotent, and it never resurrects a dead letter", () => {
  test("a claimed row completes once", async () => {
    const id = await seed({ caseId: "c1" });
    await claimDialJobs({ workerId: "w1", limit: 1 });
    expect(await completeDialJob(id)).toBe(true);
    const job = await dialJobById(id);
    expect(job?.state).toBe("DONE");
    expect(job?.completed_at).not.toBeNull();
    expect(job?.claimed_by).toBeNull();
    expect(job?.lease_expires_at).toBeNull();
  });

  test("a second completion is a no-op, not a resurrection", async () => {
    const id = await seed({ caseId: "c1" });
    await claimDialJobs({ workerId: "w1", limit: 1 });
    expect(await completeDialJob(id)).toBe(true);
    expect(await completeDialJob(id)).toBe(false);
    expect((await dialJobById(id))?.state).toBe("DONE");
  });

  test("a row that was never claimed cannot be completed", async () => {
    const id = await seed({ caseId: "c1" });
    expect(await completeDialJob(id)).toBe(false);
    expect((await dialJobById(id))?.state).toBe("PENDING");
  });
});

describe("failDialJob — the bounded ladder", () => {
  async function claimOne(caseId: string): Promise<string> {
    const id = await seed({ caseId });
    await claimDialJobs({ workerId: "w1", limit: 1 });
    return id;
  }

  test("retries climb to DEAD on the MAX_DIAL_ATTEMPTS-th failure", async () => {
    // `rand` is pinned to the top of the jitter band, so the ladder is
    // exactly 36 s, 144 s, then DEAD — and the backoff is applied to the
    // injected clock, not to wall time.
    const rand = () => 1;
    const id = await claimOne("c1");
    expect(await failDialJob({ id, error: "no answer", rand })).toEqual({
      outcome: "RETRY",
      retries: 1,
      nextAttemptAt: null,
    });
    table.advance(36_000);
    await claimDialJobs({ workerId: "w1", limit: 1 });
    expect(await failDialJob({ id, error: "no answer", rand })).toEqual({
      outcome: "RETRY",
      retries: 2,
      nextAttemptAt: null,
    });
    table.advance(144_000);
    await claimDialJobs({ workerId: "w1", limit: 1 });
    expect(await failDialJob({ id, error: "no answer", rand })).toEqual({
      outcome: "DEAD",
      retries: 3,
      nextAttemptAt: null,
    });
    expect((await dialJobById(id))?.state).toBe("DEAD");
    // DEAD is terminal for the worker: the row stops owing the customer a call.
    table.advance(600_001);
    expect(await claimDialJobs({ workerId: "w1", limit: 1 })).toEqual([]);
    expect(await outstandingJobs()).toBe(0);
  });

  test("a non-retryable failure dead-letters immediately", async () => {
    const id = await claimOne("c1");
    expect(await failDialJob({ id, error: "invalid number", dead: true })).toMatchObject({
      outcome: "DEAD",
      retries: 1,
    });
  });

  test("a row this worker does not own is SETTLED, never thrown", async () => {
    const id = await seed({ caseId: "c1" });
    const out = await failDialJob({ id, error: "late failure" });
    expect(out).toEqual({ outcome: "SETTLED", retries: 0, nextAttemptAt: null, state: "PENDING" });
    // A DEAD row reports what is actually there, so a duplicated failure
    // cannot push it back onto the ladder.
    const dead = await seed({ caseId: "c2", attemptNo: 2 });
    table.find(dead)!.state = "DEAD";
    expect(await failDialJob({ id: dead, error: "again" })).toEqual({
      outcome: "SETTLED",
      retries: 0,
      nextAttemptAt: null,
      state: "DEAD",
    });
  });

  test("a vanished row is SETTLED with a null state rather than guessed", async () => {
    expect(await failDialJob({ id: "gone", error: "x" })).toEqual({
      outcome: "SETTLED",
      retries: 0,
      nextAttemptAt: null,
      state: null,
    });
  });

  test("the backoff is applied to the DATABASE clock, so nextAttemptAt stays null", async () => {
    const id = await claimOne("c1");
    await failDialJob({ id, error: "no answer", rand: () => 0.5 });
    const job = await dialJobById(id);
    expect(job?.state).toBe("PENDING");
    expect(job?.available_at.getTime()).toBe(table.now + 30_000);
    expect(job?.claimed_by).toBeNull();
    expect(job?.lease_expires_at).toBeNull();
    // Not due until the backoff elapses.
    expect(await claimDialJobs({ workerId: "w1" })).toEqual([]);
  });

  test("maxAttempts is floored at one, so a misconfigured cap still terminates", async () => {
    const id = await claimOne("c1");
    expect(await failDialJob({ id, error: "x", maxAttempts: 0 })).toMatchObject({
      outcome: "DEAD",
      retries: 1,
    });
  });

  test("last_error is truncated to 500 characters so a vendor dump cannot bloat the row", async () => {
    const id = await claimOne("c1");
    await failDialJob({ id, error: "E".repeat(900) });
    expect((await dialJobById(id))?.last_error).toHaveLength(500);
  });
});

describe("queue depth, reaping and replay", () => {
  test("queue_depth is pending + claimed: everything that still owes a contact", async () => {
    await seed({ caseId: "a" });
    await seed({ caseId: "b" });
    await seed({ caseId: "c", availableInMs: 60_000 });
    expect(await queueDepth()).toEqual({ pending: 3, claimed: 0, done: 0, dead: 0, total: 3 });
    expect(await outstandingJobs()).toBe(3);
    await claimDialJobs({ workerId: "w1", limit: 1 });
    const depth = await queueDepth();
    expect(depth.pending).toBe(2);
    expect(depth.claimed).toBe(1);
    expect(depth.total).toBe(3);
    // A delayed row is PENDING but not claimable — the backlog is real.
    expect(await outstandingJobs()).toBe(3);
  });

  test("terminal states leave outstanding work", async () => {
    const id = await seed({ caseId: "a" });
    await claimDialJobs({ workerId: "w1", limit: 1 });
    await completeDialJob(id);
    expect(await queueDepth()).toEqual({ pending: 0, claimed: 0, done: 1, dead: 0, total: 1 });
    expect(await outstandingJobs()).toBe(0);
  });

  test("reaping is optional but idempotent, and it only touches expired leases", async () => {
    await seed({ caseId: "a" });
    await seed({ caseId: "b" });
    await claimDialJobs({ workerId: "w1", limit: 2, leaseMs: 1000 });
    expect(await reapExpiredLeases()).toBe(0);
    table.advance(1001);
    expect(await reapExpiredLeases()).toBe(2);
    expect(await reapExpiredLeases()).toBe(0);
    expect((await queueDepth()).pending).toBe(2);
  });

  test("replay is operator-only: DEAD rows go back to PENDING, anything else is refused", async () => {
    const id = await seed({ caseId: "a" });
    expect(await replayDeadDialJob(id)).toEqual({ ok: false, reason: "not_dead" });
    await claimDialJobs({ workerId: "w1", limit: 1 });
    await failDialJob({ id, error: "no answer", dead: true });
    expect(await replayDeadDialJob(id)).toEqual({ ok: true });
    const job = await dialJobById(id);
    expect(job?.state).toBe("PENDING");
    expect(job?.last_error).toBeNull();
    expect(job?.completed_at).toBeNull();
    // The ladder is untouched by a replay: retries stays where it dead-lettered.
    expect(job?.retries).toBe(1);
  });
});

describe("drainDialQueue — the accounting contract", () => {
  test("an empty queue drains to all zeros and never calls the handler", async () => {
    let calls = 0;
    const out = await drainDialQueue({
      workerId: "w1",
      handler: async () => {
        calls++;
        return { ok: true };
      },
    });
    expect(out).toEqual({
      claimed: 0,
      done: 0,
      retried: 0,
      dead: 0,
      crashed: 0,
      lost: 0,
      skipped: 0,
    });
    expect(calls).toBe(0);
  });

  test("FIFO within a batch: jobs are dialled in the order they were claimed", async () => {
    const ids: string[] = [];
    for (const caseId of ["a", "b", "c", "d"]) ids.push(await seed({ caseId }));
    const handled: string[] = [];
    const out = await drainDialQueue({
      workerId: "w1",
      handler: async (job) => {
        handled.push(job.id);
        return { ok: true };
      },
    });
    expect(handled).toEqual(ids);
    expect(out).toMatchObject({
      claimed: 4,
      done: 4,
      retried: 0,
      dead: 0,
      crashed: 0,
      lost: 0,
      skipped: 0,
    });
    expect(await outstandingJobs()).toBe(0);
  });

  test("the counters always reconcile: claimed = done + retried + dead + lost + skipped", async () => {
    await seed({ caseId: "a" });
    await seed({ caseId: "b" });
    await seed({ caseId: "c" });
    await seed({ caseId: "d" });
    let n = 0;
    const out = await drainDialQueue({
      workerId: "w1",
      handler: async () => {
        n++;
        if (n === 1) return { ok: true };
        if (n === 2) return { ok: false, error: "busy", retryable: true };
        if (n === 3) return { ok: false, error: "invalid", retryable: false };
        throw new Error("handler bug");
      },
    });
    expect(out).toEqual({
      claimed: 4,
      done: 1,
      // Both the "busy" failure and the crashed handler climb the ladder.
      retried: 2,
      dead: 1,
      crashed: 1,
      lost: 0,
      skipped: 0,
    });
    expect(out.claimed).toBe(out.done + out.retried + out.dead + out.lost + out.skipped);
  });

  test("a handler that throws is settled and counted separately, not hidden in retries", async () => {
    await seed({ caseId: "a" });
    const out = await drainDialQueue({
      workerId: "w1",
      handler: async () => {
        throw new Error("kaboom");
      },
    });
    expect(out).toMatchObject({ claimed: 1, crashed: 1, retried: 1, done: 0 });
    // Settled on the retry ladder, not left holding the lease.
    const job = await dialJobById((await queueRows())[0]!.id);
    expect(job?.state).toBe("PENDING");
    expect(job?.last_error).toBe("handler crashed: kaboom");
  });

  test("a non-Error throwable is stringified, not lost", async () => {
    await seed({ caseId: "a" });
    const out = await drainDialQueue({
      workerId: "w1",
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      handler: async () => {
        // eslint-disable-next-line no-throw-literal -- a non-Error throw is the case under test: the worker must treat it as a crash, not as success
        throw "a string";
      },
    });
    expect(out).toMatchObject({ crashed: 1, retried: 1 });
    expect((await dialJobById((await queueRows())[0]!.id))?.last_error).toBe(
      "handler crashed: a string",
    );
  });

  test("beforeHandler is the exactly-once gate: a refusal skips the dial entirely", async () => {
    const id = await seed({ caseId: "a" });
    let handlerCalls = 0;
    const out = await drainDialQueue({
      workerId: "w1",
      handler: async () => {
        handlerCalls++;
        return { ok: true };
      },
      beforeHandler: async () => false,
    });
    expect(out).toMatchObject({ claimed: 1, skipped: 1, done: 0, retried: 0, dead: 0 });
    expect(handlerCalls).toBe(0);
    // Releasing it would be wrong: the row keeps its lease, because this
    // worker no longer owns it.
    expect((await dialJobById(id))?.state).toBe("CLAIMED");
  });

  test("a lease lost to another worker mid-drain stops the second dial", async () => {
    const id = await seed({ caseId: "a" });
    let handlerCalls = 0;
    let stolenBy = "";
    const out = await drainDialQueue({
      workerId: "w1",
      leaseMs: 1000,
      handler: async () => {
        handlerCalls++;
        return { ok: true };
      },
      // Ownership re-checked at the last point before the irreversible call.
      beforeHandler: async (job) => {
        table.advance(1001);
        const stolen = await claimDialJobs({ workerId: "w2", limit: 1, leaseMs: 60_000 });
        stolenBy = stolen[0]?.claimed_by ?? "";
        return renewClaim(job.id, "w1", 60_000);
      },
    });
    expect(out).toMatchObject({ claimed: 1, skipped: 1, done: 0 });
    expect(handlerCalls).toBe(0);
    expect(stolenBy).toBe("w2");
    // The row belongs to w2 now; w1 neither completed nor rescheduled it.
    const job = await dialJobById(id);
    expect(job?.state).toBe("CLAIMED");
    expect(job?.claimed_by).toBe("w2");
  });

  test("a failure settled by somebody else is counted as lost, never thrown", async () => {
    const id = await seed({ caseId: "a" });
    const out = await drainDialQueue({
      workerId: "w1",
      handler: async () => {
        // Another worker completed it while we were on the vendor call.
        await completeDialJob(id);
        return { ok: false, error: "no answer" };
      },
    });
    expect(out).toMatchObject({ claimed: 1, retried: 0, dead: 0, lost: 1, crashed: 0 });
  });

  test("a completion that loses the row is counted nowhere (documented gap)", async () => {
    const id = await seed({ caseId: "a" });
    const out = await drainDialQueue({
      workerId: "w1",
      handler: async () => {
        await completeDialJob(id);
        return { ok: true };
      },
    });
    // `lost` is reserved for the SETTLED branch of failDialJob, so a lost
    // completion leaves no trace in the counters beyond `claimed`.
    expect(out).toEqual({
      claimed: 1,
      done: 0,
      retried: 0,
      dead: 0,
      crashed: 0,
      lost: 0,
      skipped: 0,
    });
  });

  test("three concurrent drains partition the queue: no job is handled twice", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await seed({ caseId: `c${i}` }));
    const handledBy = new Map<string, string[]>();
    const drain = (workerId: string) =>
      drainDialQueue({
        workerId,
        limit: 6,
        handler: async (job) => {
          const list = handledBy.get(job.id) ?? [];
          list.push(workerId);
          handledBy.set(job.id, list);
          return { ok: true };
        },
      });
    // The fake's claim yields before it pops, so all three drains are in
    // flight against the same table before any of them takes a row — the
    // property under test, not an accident of scheduling.
    const results = await Promise.all([drain("w1"), drain("w2"), drain("w3")]);

    const totalClaimed = results.reduce((n, r) => n + r.claimed, 0);
    expect(totalClaimed).toBe(ids.length);
    expect(results.reduce((n, r) => n + r.done, 0)).toBe(ids.length);
    for (const id of ids) expect(handledBy.get(id)).toHaveLength(1);
    // No worker ever sees a row another worker took, and nothing is lost.
    expect(results.reduce((n, r) => n + r.lost + r.skipped + r.dead + r.retried, 0)).toBe(0);
    expect(await outstandingJobs()).toBe(0);
    // `FOR UPDATE SKIP LOCKED` hands the whole locked set to the first
    // worker that arrives, so the split need not be even — only disjoint.
    const perWorker = new Map<string, number>();
    for (const list of handledBy.values()) {
      const worker = list[0]!;
      perWorker.set(worker, (perWorker.get(worker) ?? 0) + 1);
    }
    expect([...perWorker.values()].reduce((a, b) => a + b, 0)).toBe(ids.length);
  });

  test("concurrent drains of a single-row queue give it to exactly one worker", async () => {
    await seed({ caseId: "only" });
    const handled: string[] = [];
    const drain = (workerId: string) =>
      drainDialQueue({
        workerId,
        limit: 10,
        handler: async () => {
          handled.push(workerId);
          return { ok: true };
        },
      });
    const [a, b] = await Promise.all([drain("w1"), drain("w2")]);
    expect(handled).toHaveLength(1);
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.done + b.done).toBe(1);
  });

  test("the ladder terminates a permanently undiallable number", async () => {
    await seed({ caseId: "a" });
    let claims = 0;
    for (let i = 0; i < 10; i++) {
      const out = await drainDialQueue({
        workerId: "w1",
        handler: async () => {
          claims++;
          return { ok: false, error: "permanently undiallable" };
        },
      });
      if (out.dead > 0) break;
      // Let the backoff elapse; the ladder is 30s, 120s, 600s.
      table.advance(600_001);
    }
    expect(claims).toBe(MAX_DIAL_ATTEMPTS);
    expect((await queueDepth()).dead).toBe(1);
  });

  test("maxAttempts is threaded through, so a load test does not need the env", async () => {
    await seed({ caseId: "a" });
    let claims = 0;
    const handler = async () => {
      claims++;
      return { ok: false, error: "nope" };
    };
    expect((await drainDialQueue({ workerId: "w1", handler })).retried).toBe(1);
    table.advance(600_001);
    expect((await drainDialQueue({ workerId: "w1", handler, maxAttempts: 2 })).dead).toBe(1);
    expect(claims).toBe(2);
  });

  test("the injected clock, not the module's, decides when a job is due", async () => {
    await seed({ caseId: "a" });
    await drainDialQueue({
      workerId: "w1",
      handler: async () => ({ ok: false, error: "busy" }),
      rand: () => 1,
    });
    // rand() = 1 → the top of the jitter band: 30s Ã— 1.2 = 36s.
    expect((await dialJobById((await queueRows())[0]!.id))?.available_at.getTime()).toBe(
      table.now + 36_000,
    );
    expect(await claimDialJobs({ workerId: "w1" })).toEqual([]);
    table.advance(36_000);
    expect(await claimDialJobs({ workerId: "w1" })).toHaveLength(1);
  });
});

/** Every row currently in the fake table, for post-conditions. */
async function queueRows(): Promise<DialJob[]> {
  const ids = [...table.calls]
    .filter((c) => c.sql.includes("RETURNING id, attempt_no"))
    .map((c) => c.params[0])
    .filter((v): v is string => typeof v === "string");
  const jobs = await Promise.all(ids.map((id) => dialJobById(id)));
  return jobs.filter((j): j is DialJob => j !== null);
}

describe("dial_job vocabulary and migration diagnostics", () => {
  test("the state set is the closed state machine the drainer moves through", async () => {
    expect([...DIAL_JOB_STATES]).toEqual(["PENDING", "CLAIMED", "DONE", "DEAD"]);
    const id = await seed({ caseId: "a" });
    // DEAD is terminal for the worker: only an operator replays it.
    await claimDialJobs({ workerId: "w1", limit: 1 });
    await failDialJob({ id, error: "x", dead: true });
    table.advance(600_001);
    expect(await claimDialJobs({ workerId: "w1" })).toEqual([]);
    expect(await replayDeadDialJob(id)).toEqual({ ok: true });
  });

  test("a missing table is reported as a migration problem, not as a fault", async () => {
    const missing: unknown = { code: "P2021", message: "table does not exist" };
    for (const method of [
      "$queryRawUnsafe",
      "$queryRaw",
      "$executeRaw",
      "$executeRawUnsafe",
    ] as const) {
      Object.defineProperty(db, method, {
        configurable: true,
        writable: true,
        value: () => Promise.reject(missing),
      });
    }
    const err = (await enqueueDialJob({ caseId: "c", caseRef: "SV" }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(MIGRATION_HINT);
    expect(err.message).toContain("while enqueueDialJob");
    expect(err.cause).toBe(missing);
  });

  test("the message-only shape of a missing table is recognised too", async () => {
    const missing: unknown = new Error('relation "dial_job" does not exist');
    Object.defineProperty(db, "$queryRawUnsafe", {
      configurable: true,
      writable: true,
      value: () => Promise.reject(missing),
    });
    const err = (await claimDialJobs({ workerId: "w1" }).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain(MIGRATION_HINT);
    expect(err.message).toContain("while claimDialJobs");
  });

  test("a real database fault is re-thrown unchanged, never relabelled", async () => {
    const fault: unknown = Object.assign(new Error("connection terminated"), { code: "P1001" });
    Object.defineProperty(db, "$queryRawUnsafe", {
      configurable: true,
      writable: true,
      value: () => Promise.reject(fault),
    });
    await expect(claimDialJobs({ workerId: "w1" })).rejects.toBe(fault as Error);
  });
});
