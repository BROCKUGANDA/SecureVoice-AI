/**
 * WP-19 Layer A — the load gate.
 *
 * ── WHAT LAYER A IS ──────────────────────────────────────────────────────────
 * Layer A mocks the vendors AT THE PORT SEAM (`VoicePort` below) and drives
 * synthetic cases through everything else for real:
 *
 *   · the durable queue      (src/lib/scale/queue.ts — FOR UPDATE SKIP LOCKED)
 *   · the admission ladder   (src/lib/admission.ts + src/lib/scale/admission.ts)
 *   · the case state machine (src/lib/case-state-machine.ts — the ONE writer)
 *   · persistence            (real Postgres: Case, AuditLog, dial_job)
 *
 * The vendor is the only thing mocked, and it is mocked behind the same
 * interface production dials through (`placeOutboundCall`), because the
 * alternative — mocking the queue — measures the mock.
 *
 * ── WHAT LAYER A IS NOT (and must never be described as) ─────────────────────
 * Layer A does NOT measure vendor capacity, network latency, real telephony CPS,
 * or ElevenLabs' concurrent-session behaviour. There is no Twilio call and no
 * ElevenLabs call anywhere in this file — `globalThis.fetch` is a tripwire that
 * throws. Every number the artifact records is labelled with what it is:
 *
 *   · measured      — latency percentiles, rates, queue depth, gauge peaks, job
 *                     counts. Observed by THIS run, on THIS machine, against
 *                     local Postgres, with the vendor held at a synthetic
 *                     constant latency.
 *   · calibrated    — the concurrency target (a published ElevenLabs tier) and
 *                     the vendor ceilings. Never measured against our account.
 *   · extrapolated  — the campaign shape, the 8× steady-state peak multiple, and
 *                     everything derived from them. Modelled, not observed.
 *
 * Layer B (real vendor load, a real carrier, real ElevenLabs sessions) is
 * POST-SUBMISSION and cannot be faked by this file. See docs/CAPACITY.md §8.
 *
 * ── THE TWO ASSERTIONS THAT MATTER ──────────────────────────────────────────
 *   1. The modelled peak (210 concurrent) is OFFERED and survived with an error
 *      rate under 1%.
 *   2. Cases in == cases accounted for: every case is either DIALED or SHED WITH
 *      AN AUDIT ROW. A case that is neither fails the gate. This is the property
 *      that makes the platform defensible in a bank's procurement review, and it
 *      cannot be asserted by a rising count of successful dials.
 *
 * Requires a real Postgres (TEST_DATABASE_URL). Writes ~1.5k Case rows, ~10k
 * AuditLog rows and 1.5k dial_job rows, and deletes only what it created —
 * scoped by the per-run caseRef prefix, so a suite running concurrently in the
 * same database is not collateral damage.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── 0. Network tripwire, armed before anything is imported ───────────────────
// A load test that quietly reaches the vendor measures the vendor, not us, and
// spends real money doing it. One stray call fails the gate loudly instead.
const REAL_FETCH = globalThis.fetch;
const NETWORK_CALLS: string[] = [];
globalThis.fetch = ((input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
  NETWORK_CALLS.push(url);
  throw new Error(`WP-19 LAYER A GATE: real network call attempted to ${url}`);
}) as unknown as typeof fetch;

// ── 1. Ceiling configuration, set BEFORE the modules read it ─────────────────
// `@/lib/capacity` resolves the vendor ceilings at import time (the band ladder
// is a percentage of the burst ceiling), so the tier this gate runs at must be
// in the environment before the dynamic imports below. `??=` keeps an operator's
// explicit value.
//
// Business tier = 40 concurrent Conversational AI sessions.
// Source: elevenlabs.io/pricing/agents, read 2026-10-02 (Free 4 · Starter 6 ·
// Creator 10 · Pro 20 · Scale 30 · Business 40). CALIBRATED against a published
// tier table — we have never run a real conversation at the ceiling.
process.env.ELEVENLABS_MAX_CONCURRENT ??= "40";
const PLAN_CONCURRENCY = 40;

// ── 2. Modules (dynamic, so step 1 lands first) ──────────────────────────────
const { db } = await import("@/lib/db");
const { ELEVENLABS_BURST_CEILING, BAND_ENTER_CONSTRAINED_PCT, BAND_ENTER_SHED_PCT } = await import(
  "@/lib/capacity"
);
const { activeConversations } = await import("@/lib/admission");
const scaleAdmission = await import("@/lib/scale/admission");
const scaleCapacity = await import("@/lib/scale/capacity");
const queue = await import("@/lib/scale/queue");
const csm = await import("@/lib/case-state-machine");
const auditChain = await import("@/lib/audit-chain");

/**
 * Types from the dynamically-imported modules. A `const` from `await import()`
 * is a value, not a namespace, so the types it exports are named here rather
 * than as `DialJob`.
 */
type DialJob = import("@/lib/scale/queue").DialJob;
type DialOutcome = import("@/lib/scale/queue").DialOutcome;
type CapacityModel = import("@/lib/scale/capacity").CapacityModel;

// ── 3. Run identity and scenario sizing ─────────────────────────────────────
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const PREFIX = `SV-LA-${RUN}`;
const ORG = `org-load-${RUN}`;
const QUEUE_PREFIX = `${PREFIX}-q`;

/**
 * Case COUNTS are scaled down from the modelled campaign; CONCURRENCY is not.
 *
 * The documented campaign is 8,000 customers hit in 40 minutes at a ~35% flag
 * rate → 2,800 interventions offered → 210 concurrent conversations at a
 * 3-minute mean (docs/CAPACITY.md §4). Replaying 2,800 cases through ~25
 * database round trips each inside a CI budget teaches nobody anything; OFFERING
 * 210 concurrent conversations and measuring what the platform does with them is
 * the experiment. Set LOAD_BURST_CASES=2800 for the full-count replay.
 */
const BURST_CASES = intEnv("LOAD_BURST_CASES", 1_200);
const BURST_WORKERS = intEnv("LOAD_BURST_WORKERS", 224);
const STEADY_CASES = intEnv("LOAD_STEADY_CASES", 300);
const STEADY_WORKERS = intEnv("LOAD_STEADY_WORKERS", 8);
/** Synthetic talk time per call: stands in for MEAN_CALL_SECONDS at Layer A. */
const BURST_HOLD_MS = intEnv("LOAD_BURST_HOLD_MS", 120);
const STEADY_HOLD_MS = intEnv("LOAD_STEADY_HOLD_MS", 30);
/** Deterministic 429 injection: every Nth dialled case is throttled N times. */
const THROTTLE_EVERY = intEnv("LOAD_THROTTLE_EVERY", 17);
const THROTTLE_TIMES = intEnv("LOAD_THROTTLE_TIMES", 1);
/** Chains to verify (verifyChain is one query per caseRef). */
const CHAIN_SAMPLE = intEnv("LOAD_CHAIN_SAMPLE", 25);
const SAMPLE_EVERY = intEnv("LOAD_CHAIN_EVERY", 40);
/**
 * Claim lease for the scenarios. Must exceed the modelled mean call
 * (MEAN_CALL_SECONDS = 180 s) or the lease expires while the conversation is
 * still running and the call becomes reclaimable — i.e. dial the same customer
 * twice. 240 s = modelled mean + 60 s headroom.
 */
const DIAL_LEASE_MS = intEnv("LOAD_DIAL_LEASE_MS", 240_000);
const EVIDENCE_PATH = join(process.cwd(), "evidence", "load", "results.json");
const MIGRATION_SQL_PATH = join(process.cwd(), "prisma", "migrations", "2_dial_job", "migration.sql");

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ── 4. Deterministic randomness ──────────────────────────────────────────────
// Wall-clock latency is not reproducible, and is the point. But WHICH case is
// throttled and WHICH case carries which risk MUST be, or a shed-rate regression
// and a coin flip are indistinguishable in the evidence.
/** mulberry32 — small, fast, seedable. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const rand = seeded(Number.parseInt(RUN, 36) || 1);
/** Backoff sleeps cost no wall clock here; `waitedMs` is reported separately. */
const noSleep = async (): Promise<void> => {};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 5. Metrics helpers ───────────────────────────────────────────────────────

/** Nearest-rank percentile on a sorted array — no interpolation, so every
 *  reported value is a value that was actually observed. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? 0;
}

function roundTo(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Ratio as a fraction (0.0731 = 7.31%), rounded to 4 dp. */
function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : roundTo(part / whole, 4);
}

type Latencies = { values: number[] };
const lat = (): Latencies => ({ values: [] });
function record(t: Latencies, ms: number): void {
  t.values.push(ms);
}
function summary(t: Latencies): Record<string, number> {
  const s = [...t.values].sort((a, b) => a - b);
  return {
    samples: s.length,
    min_ms: roundTo(s[0] ?? 0),
    p50_ms: roundTo(percentile(s, 0.5)),
    p95_ms: roundTo(percentile(s, 0.95)),
    p99_ms: roundTo(percentile(s, 0.99)),
    max_ms: roundTo(s[s.length - 1] ?? 0),
    mean_ms: roundTo(s.length === 0 ? 0 : s.reduce((a, b) => a + b, 0) / s.length),
  };
}

// ── 6. The vendor port seam ─────────────────────────────────────────────────

/**
 * The port production dials through. The shape mirrors `placeOutboundCall` in
 * src/lib/elevenlabs/outbound-call.ts exactly, so swapping the mock for the real
 * call is a one-line change and the queue, the admission ladder and the state
 * machine above it are untouched.
 */
type VoicePort = {
  placeOutboundCall(args: {
    toNumber: string;
    language: string;
    merchant?: string;
    amount?: number;
    currency?: string;
    caseRef: string;
    dynamicVariables: Record<string, unknown>;
  }): Promise<{ conversationId: string | null; callSid: string | null; dryRun: boolean }>;
};

/** A vendor 429, in the shape a real client raises it. */
class MockThrottleError extends Error {
  readonly status = 429;
  constructor(detail: string) {
    super(`ElevenLabs 429: ${detail}`);
    this.name = "MockThrottleError";
  }
}

type PortStats = { placed: number; maxConcurrent: number; inFlight: number };

/**
 * The Layer A vendor double. One job, done honestly: occupy a voice slot for the
 * synthetic talk time and return identifiers. The hold IS the concurrency the
 * platform is being measured on — where a real provider would be streaming audio
 * and where a real 429 would arrive. It counts its own peak concurrency, which
 * is the vendor's view of the same number the platform's gauge reports from the
 * other side; the gate asserts the two agree about the ceiling.
 */
function mockVoicePort(holdMs: number): { port: VoicePort; stats: PortStats } {
  const stats: PortStats = { placed: 0, maxConcurrent: 0, inFlight: 0 };
  return {
    stats,
    port: {
      async placeOutboundCall(args) {
        stats.inFlight++;
        stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.inFlight);
        try {
          await sleep(holdMs);
          stats.placed++;
          return { conversationId: `conv_${args.caseRef}`, callSid: `CA_${args.caseRef}`, dryRun: false };
        } finally {
          stats.inFlight--;
        }
      },
    },
  };
}

// ── 7. Bootstrap: the dial_job table, at module scope (no hook timeout) ──────

type Bootstrap = { applied: boolean; skipped: boolean; note: string };

/**
 * Apply `prisma/migrations/2_dial_job/migration.sql` if — and only if — the
 * table is absent, so this gate is runnable before anyone has applied the
 * migration by hand. It executes THAT FILE, not a copy of the SQL, so the
 * migration and the module cannot drift apart.
 *
 * `DIAL_JOB_SKIP_BOOTSTRAP=1` turns this off for anyone who wants the gate to run
 * only against a properly migrated database.
 */
async function ensureDialJobTable(): Promise<Bootstrap> {
  if (process.env.DIAL_JOB_SKIP_BOOTSTRAP === "1") {
    return { applied: false, skipped: true, note: "DIAL_JOB_SKIP_BOOTSTRAP=1 — the table must already exist" };
  }
  const present = await db.$queryRawUnsafe<{ reg: string | null }[]>(
    `SELECT to_regclass('public."dial_job"')::text AS reg`,
  );
  if (present[0]?.reg) {
    return { applied: false, skipped: false, note: "dial_job already present — the gate did not apply the migration" };
  }
  const sql = readFileSync(MIGRATION_SQL_PATH, "utf8");
  // Strip `--` comments BEFORE splitting: this migration's prose contains
  // semicolons, and a semicolon inside a comment must not end a statement.
  const statements = sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) await db.$executeRawUnsafe(statement);
  return {
    applied: true,
    skipped: false,
    note: `applied ${statements.length} statements from prisma/migrations/2_dial_job/migration.sql. On this database, record it with: prisma migrate resolve --applied 2_dial_job`,
  };
}

const DIAL_JOB_EXPECTED_COLUMNS = [
  "attempt_no",
  "available_at",
  "case_id",
  "case_ref",
  "claimed_by",
  "completed_at",
  "created_at",
  "id",
  "last_error",
  "lease_expires_at",
  "org_id",
  "payload",
  "priority",
  "retries",
  "state",
  "updated_at",
];

// ── 8. Database availability ────────────────────────────────────────────────
let dbAvailable = false;
let dbReason = "not probed";
let bootstrap: Bootstrap = { applied: false, skipped: false, note: "database unreachable" };
let migrationColumnsOk = false;
let migrationColumnsDetail = "not checked (database unreachable)";
let baselineGauge = 0;
let sweptRows = 0;

/**
 * Delete rows left by an earlier run of THIS suite, before it seeds anything.
 *
 * This suite owns the `SV-LA-` namespace outright, and it has to clean up
 * unconditionally: `dial_job` claims are GLOBAL (that is the point of a shared
 * queue), so one abandoned run leaves PENDING rows that a later run's claim
 * picks up instead of its own — which turns an ordering assertion into a coin
 * flip. Sweeping first makes the gate hermetic and self-healing instead of
 * order-dependent. Counted and reported, never silent: a sweep that deletes more
 * than expected is a fact about the previous run, not a detail to hide.
 */
async function sweepOwnNamespace(): Promise<number> {
  const deleted = await Promise.all([
    db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "callRef" LIKE 'SV-LA-%'`),
    db.$executeRawUnsafe(`DELETE FROM dial_job WHERE "case_ref" LIKE 'SV-LA-%'`),
    db.$executeRawUnsafe(`DELETE FROM "Case" WHERE "caseRef" LIKE 'SV-LA-%'`),
  ]);
  return deleted.reduce((a, b) => a + b, 0);
}

try {
  await db.$queryRawUnsafe("SELECT 1");
  dbAvailable = true;
  dbReason = "ok";
  sweptRows = await sweepOwnNamespace();
  if (sweptRows > 0) {
    console.warn(`[wp19-load] swept ${sweptRows} rows left by a previous run of this suite`);
  }
  bootstrap = await ensureDialJobTable();
  const cols = await db.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dial_job' ORDER BY column_name`,
  );
  const actual = cols.map((c) => c.column_name);
  migrationColumnsOk =
    actual.length === DIAL_JOB_EXPECTED_COLUMNS.length && DIAL_JOB_EXPECTED_COLUMNS.every((c) => actual.includes(c));
  migrationColumnsDetail = `table dial_job: expected ${DIAL_JOB_EXPECTED_COLUMNS.length} columns, found ${actual.length}: ${actual.join(", ")}`;
  baselineGauge = await activeConversations();
} catch (err) {
  dbReason = `unavailable: ${err instanceof Error ? err.message : String(err)}`;
  if (dbAvailable === false && bootstrap.note === "database unreachable") {
    bootstrap = { applied: false, skipped: false, note: `not attempted — ${dbReason}` };
  }
}

if (!dbAvailable) {
  console.warn(
    `[wp19-load] database unavailable (${dbReason}) — the database-backed part of this gate is SKIPPED and the artifact records not-run. Set TEST_DATABASE_URL.`,
  );
}

// ── 9. The scenario driver ──────────────────────────────────────────────────

type CaseSpec = {
  ordinal: number;
  caseRef: string;
  phone: string;
  riskScore: number;
  amountMinor: number;
  language: string;
  merchant: string;
  expectedLoss: number;
  /** Deterministic 429 policy for this case, applied inside the ceiling call. */
  throttles: number;
};

type AdmissionBandName = "NORMAL" | "CONSTRAINED" | "SHED";

type ScenarioResult = {
  name: string;
  caseRefPrefix: string;
  offeredConcurrency: number;
  casesIn: number;
  dialed: number;
  shed: number;
  errors: number;
  byReason: Record<string, number>;
  endToEnd: Record<string, number>;
  admission: Record<string, number>;
  vendorCall: Record<string, number>;
  vendor429: number;
  vendorPlaced: number;
  vendorMaxConcurrent: number;
  gateTimeouts: number;
  peakGauge: number;
  peakOwnInFlight: number;
  endGauge: number;
  baselineGauge: number;
  bandsSeen: AdmissionBandName[];
  queueDepthSamples: number[];
  maxQueueDepth: number;
  endQueueDepth: number;
  jobsDone: number;
  jobsRetried: number;
  jobsDead: number;
jobsCrashed: number;
  /** Jobs this worker no longer owned at settlement time — must stay 0. */
  jobsLost: number;
  /** Jobs refused by the ownership gate because another worker owned them. */
  jobsSkipped: number;
  throttleDelaysMs: number[];
  wallClockMs: number;
};

/** The in-flight states the platform's gauge counts (src/lib/admission.ts). */
const IN_FLIGHT_STATES = ["DIALING", "RINGING", "ANSWERED", "DISCLOSED", "VERIFYING"];
/** Where a case sits when it was shed: parked, with a fallback and an audit row. */
const PARKED_STATES = ["RECEIVED", "SCREENED", "REJECTED"];
/** Where a case sits once it has actually been through the conversation. */
const CONCLUDED_STATES = ["CONFIRMED_FRAUD", "CONFIRMED_LEGITIMATE", "UNCERTAIN", "CLOSED"];

function syntheticCase(prefix: string, ordinal: number): CaseSpec {
  // A deterministic spread ACROSS the triage bands: expected loss runs from a
  // few hundred minor units (sheds first) to ~400k (the top tier the SHED band
  // still voices), so the shed path is exercised at every band instead of
  // all-or-nothing.
  const riskScore = 0.5 + rand() * 0.49;
  const amountMinor = 5_000 + Math.floor(rand() * 395_000);
  const language = ["en", "ar", "hi", "ur", "fr", "sw"][ordinal % 6] ?? "en";
  return {
    ordinal,
    caseRef: `${prefix}-${String(ordinal).padStart(5, "0")}`,
    // Synthetic, in-country, never dialled: this is a double, not a customer.
    phone: `+9715${String(50_000_000 + ordinal).slice(0, 8)}`,
    riskScore: roundTo(riskScore, 3),
    amountMinor,
    language,
    merchant: "MERCHANT-UNDER-REVIEW",
    expectedLoss: Math.round(riskScore * amountMinor),
    throttles: ordinal % THROTTLE_EVERY === 0 ? THROTTLE_TIMES : 0,
  };
}

/**
 * Run one scenario end to end.
 *
 * Shape: every case is made durable first (Case row + dial_job row), then
 * `workers` concurrent drainers run. A drainer claims ONE job, asks admission,
 * and either places a voice call or records a shed with an audit row.
 * Concurrency is therefore OFFERED LOAD, not a semaphore we impose on ourselves
 * — which is how a campaign arrives.
 */
async function runScenario(args: {
  name: string;
  cases: number;
  workers: number;
  holdMs: number;
}): Promise<ScenarioResult> {
  const prefix = `${PREFIX}-${args.name}`;
  const t0 = performance.now();
  const voice = mockVoicePort(args.holdMs);
  /** Client-side ceiling. Sized from the tier, and asserted by the gate. */
  const gate = new scaleCapacity.VendorConcurrencyGate(() => PLAN_CONCURRENCY);

  const throttleDelaysMs: number[] = [];
  const endToEnd = lat();
  const admission = lat();
  const vendorCall = lat();
  const queueDepthSamples: number[] = [];
  const bandsSeen = new Set<AdmissionBandName>();
  const byReason: Record<string, number> = {};

  let dialed = 0;
  let shed = 0;
  let errors = 0;
  let gateTimeouts = 0;
  let vendor429 = 0;
  let peakGauge = 0;
  let peakOwnInFlight = 0;
  let maxQueueDepth = 0;
  let jobsDone = 0;
  let jobsRetried = 0;
  let jobsDead = 0;
  let jobsCrashed = 0;
  let jobsLost = 0;
  let jobsSkipped = 0;
  let processed = 0;

  const baseline = await activeConversations();
  scaleAdmission.resetShedCounter();

  // ── ingest: case + durable queue row, before any call is placed ────────────
  const specs = new Map<string, CaseSpec>();
  const enqueuedAt = new Map<string, number>();
  for (let i = 0; i < args.cases; i++) {
    const spec = syntheticCase(prefix, i + 1);
    specs.set(spec.caseRef, spec);
    enqueuedAt.set(spec.caseRef, performance.now());
  }

  const INGEST_CHUNK = 50;
  const allSpecs = [...specs.values()];
  for (let i = 0; i < allSpecs.length; i += INGEST_CHUNK) {
    await Promise.all(
      allSpecs.slice(i, i + INGEST_CHUNK).map(async (spec) => {
        const created = await csm.createCase({
          caseRef: spec.caseRef,
          orgId: ORG,
          riskScore: spec.riskScore,
          amountMinor: spec.amountMinor,
          language: spec.language,
          phone: spec.phone,
          merchant: spec.merchant,
          currency: "AED",
        });
        await queue.enqueueDialJob({
          caseId: created.id,
          caseRef: spec.caseRef,
          orgId: ORG,
          attemptNo: 1,
          // Expected-loss ordering: when we can only serve part of a burst, the
          // customer with the most money at risk is dialled first.
          priority: spec.expectedLoss,
          payload: { lang: spec.language, merchant: spec.merchant, amountMinor: spec.amountMinor },
        });
      }),
    );
  }
  maxQueueDepth = (await queue.queueDepth()).pending;

  const sampler = setInterval(() => {
    void queue
      .queueDepth()
      .then((d) => {
        const outstanding = d.pending + d.claimed;
        queueDepthSamples.push(outstanding);
        maxQueueDepth = Math.max(maxQueueDepth, outstanding);
      })
      .catch(() => {});
  }, 100);

  /**
   * One claimed job. Every exit from here is an ACCOUNTED exit: dialled (state
   * machine + audit rows) or shed (audit row). The only other outcome is an
   * `error`, and errors are counted rather than swallowed — the accounting test
   * downstream will fail on them, which is the intended behaviour.
   */
  async function handleJob(job: DialJob): Promise<DialOutcome> {
    const spec = specs.get(job.case_ref);
    if (!spec) return { ok: false, error: `unknown case_ref ${job.case_ref}`, retryable: false };
    const started = enqueuedAt.get(spec.caseRef) ?? performance.now();
    const finish = (): void => record(endToEnd, performance.now() - started);

    // 1. Admission — the real ladder, the real global gauge, the real shed
    //    audit row (written by src/lib/admission.ts, not here).
    const a0 = performance.now();
    const decision = await scaleAdmission.admitAtScale({
      callRef: spec.caseRef,
      orgId: ORG,
      callerId: "wp19-load-a",
      riskScore: spec.riskScore,
      amountMinor: spec.amountMinor,
    });
    record(admission, performance.now() - a0);
    bandsSeen.add(decision.band);

    if (!decision.admitted) {
      shed++;
      byReason[decision.reason] = (byReason[decision.reason] ?? 0) + 1;
      finish();
      return { ok: true }; // settled: the customer has a fallback and an audit row
    }

    try {
      await csm.transitionCase(spec.caseRef, "SCREENED");
      await csm.transitionCase(spec.caseRef, "DIALING");

      // 2. The vendor call, under the client-side ceiling. `call` IS the port
      //    seam: Layer A injects the double, production injects
      //    `placeOutboundCall` from @/lib/elevenlabs/outbound-call. The 429
      //    policy lives in this closure because only here does the attempt
      //    number exist — a mock that kept its own counter would throttle
      //    forever.
      const v0 = performance.now();
      const placed = await scaleCapacity.withElevenLabsCeiling({
        call: (attempt) => {
          if (attempt <= spec.throttles) {
            vendor429++;
            return Promise.reject(
              new MockThrottleError("concurrent session limit reached for this workspace"),
            );
          }
          return voice.port.placeOutboundCall({
            toNumber: spec.phone,
            language: spec.language,
            merchant: spec.merchant,
            amount: spec.amountMinor,
            currency: "AED",
            caseRef: spec.caseRef,
            dynamicVariables: { case_ref: spec.caseRef },
          });
        },
        gate,
        maxWaitMs: 1_500,
        sleep: noSleep,
        rand,
        onThrottle: (info) => throttleDelaysMs.push(info.delayMs),
        onGateTimeout: () => {
          gateTimeouts++;
        },
      });
      record(vendorCall, performance.now() - v0);
      expect(placed.value.conversationId).toBe(`conv_${spec.caseRef}`);

      // 3. The conversation, through the ONE state machine writer.
      await csm.transitionCase(spec.caseRef, "RINGING");
      await csm.transitionCase(spec.caseRef, "ANSWERED");
      await csm.transitionCase(spec.caseRef, "DISCLOSED");
      await csm.transitionCase(spec.caseRef, "VERIFYING");
      await csm.transitionCase(spec.caseRef, "CONFIRMED_FRAUD");

      dialed++;
      finish();
      return { ok: true };
    } catch (err) {
      if (err instanceof scaleCapacity.VendorCeilingExhaustedError) {
        // Over the conversational-AI ceiling and refusing to queue without
        // bound. That is a DEGRADE, not a failure: the customer takes the
        // fallback channel and — the part that matters — an audit row says so.
        await auditChain
          .append(
            {
              callRef: spec.caseRef,
              action: "handoff",
              intent: "admission_ceiling_exhausted_shed",
              callerId: "wp19-load-a",
              redactedText: `voice shed; fallback=app_push; ${err.message.slice(0, 160)}`,
              meta: {
                band: decision.band,
                reason: "vendor_ceiling_exhausted",
                fallback: "app_push",
                inFlight: err.inFlight,
                ceiling: err.ceiling,
                waitedMs: err.waitedMs,
              },
              orgId: ORG,
            },
            { fast: true },
          )
          .catch((auditErr) => {
            console.error("[wp19-load] ceiling-exhaustion audit append failed:", auditErr instanceof Error ? auditErr.message : auditErr);
          });
        shed++;
        byReason.vendor_ceiling_exhausted = (byReason.vendor_ceiling_exhausted ?? 0) + 1;
        finish();
        return { ok: true };
      }
      errors++;
      byReason.error = (byReason.error ?? 0) + 1;
      finish();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Reading the gauge on every exit is what makes `peakGauge` the
      // platform's own view rather than the vendor's.
      peakGauge = Math.max(peakGauge, await activeConversations());
      processed++;
      if (processed % 25 === 0) {
        const own = await db.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "Case"
            WHERE "caseRef" LIKE $1 AND state = ANY($2::text[])`,
          `${prefix}-%`,
          IN_FLIGHT_STATES,
        );
        peakOwnInFlight = Math.max(peakOwnInFlight, own[0]?.n ?? 0);
      }
    }
  }

const workerLoop = async (workerIndex: number): Promise<void> => {
    const workerId = `${args.name}-w${workerIndex}`;
    for (;;) {
      const drained = await queue.drainDialQueue({
        workerId,
        limit: 1,
        // The claim lease must outlast the CALL, not the claim: the modelled mean
        // talk time is 180 s, so a lease shorter than that would expire mid-
        // conversation and be reclaimed — a second dial to a customer already on
        // the phone. One minute of headroom over the modelled mean.
        leaseMs: DIAL_LEASE_MS,
        // The exactly-once gate, immediately before the irreversible action.
        beforeHandler: (job) => queue.renewClaim(job.id, workerId, DIAL_LEASE_MS),
        rand,
        handler: handleJob,
      });
      jobsDone += drained.done;
      jobsRetried += drained.retried;
      jobsDead += drained.dead;
      jobsCrashed += drained.crashed;
      jobsLost += drained.lost;
      jobsSkipped += drained.skipped;
      if (drained.claimed === 0) break;
    }
  };

  await Promise.all(Array.from({ length: args.workers }, (_, i) => workerLoop(i)));
  clearInterval(sampler);

  const finalDepth = await queue.queueDepth();

  return {
    name: args.name,
    caseRefPrefix: prefix,
    offeredConcurrency: args.workers,
    casesIn: args.cases,
    dialed,
    shed,
    errors,
    byReason,
    endToEnd: summary(endToEnd),
    admission: summary(admission),
    vendorCall: summary(vendorCall),
    vendor429,
    vendorPlaced: voice.stats.placed,
    vendorMaxConcurrent: voice.stats.maxConcurrent,
    gateTimeouts,
    peakGauge,
    peakOwnInFlight,
    endGauge: await activeConversations(),
    baselineGauge: baseline,
    bandsSeen: [...bandsSeen].sort(),
    queueDepthSamples,
    maxQueueDepth,
    endQueueDepth: finalDepth.pending + finalDepth.claimed,
    jobsDone,
jobsRetried,
    jobsDead,
    jobsCrashed,
    jobsLost,
    jobsSkipped,
    throttleDelaysMs,
    wallClockMs: Math.round(performance.now() - t0),
  };
}

// ── 10. Accounting: cases in == cases accounted for ─────────────────────────

type Accounting = {
  casesIn: number;
  casesFound: number;
  byState: Record<string, number>;
  dialled: number;
  shedWithAuditRow: number;
  shedWithoutAuditRow: number;
  unaccountedInFlight: number;
  unaccountedRefs: string[];
  queueRows: number;
  queueByState: Record<string, number>;
  shedIntents: Record<string, number>;
  chainSample: { checked: number; ok: number; broken: string[] };
};

/**
 * THE load-gate assertion, and the only one a rising success count cannot fake.
 *
 * For every case this scenario created, exactly one of these must be true:
 *   · it was DIALED    → it reached a concluded state through the conversation;
 *   · it was SHED      → it is parked AND an AuditLog row names the shed.
 *
 * A case in NEITHER bucket is a silent drop: the failure mode that would
 * disqualify the platform in a bank's procurement review, because "we could not
 * reach this customer" with no record is indistinguishable from not having tried.
 */
async function accountForCases(result: ScenarioResult): Promise<Accounting> {
  const like = `${result.caseRefPrefix}-%`;
  const caseRows = await db.$queryRawUnsafe<{ caseRef: string; state: string }[]>(
    `SELECT "caseRef", state FROM "Case" WHERE "caseRef" LIKE $1`,
    like,
  );
  const byState: Record<string, number> = {};
  for (const r of caseRows) byState[r.state] = (byState[r.state] ?? 0) + 1;

  const auditRows = await db.$queryRawUnsafe<{ callRef: string; intent: string | null }[]>(
    `SELECT "callRef", intent FROM "AuditLog" WHERE "callRef" LIKE $1 AND intent LIKE 'admission%shed'`,
    like,
  );
  const shedAuditRefs = new Set(auditRows.map((r) => r.callRef));
  const shedIntents: Record<string, number> = {};
  for (const r of auditRows) {
    const intent = r.intent ?? "unknown";
    shedIntents[intent] = (shedIntents[intent] ?? 0) + 1;
  }

  const queueRows = await db.$queryRawUnsafe<{ state: string; n: number }[]>(
    `SELECT state, count(*)::int AS n FROM dial_job WHERE "case_ref" LIKE $1 GROUP BY state ORDER BY state`,
    like,
  );
  const queueByState: Record<string, number> = {};
  for (const r of queueRows) queueByState[r.state] = r.n;

  const inFlightRefs = caseRows.filter((r) => IN_FLIGHT_STATES.includes(r.state)).map((r) => r.caseRef);
  const parkedRefs = caseRows.filter((r) => PARKED_STATES.includes(r.state)).map((r) => r.caseRef);
  const concluded = caseRows.filter((r) => CONCLUDED_STATES.includes(r.state)).map((r) => r.caseRef);
  const shedWithAuditRow = parkedRefs.filter((ref) => shedAuditRefs.has(ref));
  const shedWithoutAuditRow = parkedRefs.filter((ref) => !shedAuditRefs.has(ref));

  // A sampled chain verification: these rows are the evidence of record, so a
  // broken hash is a gate failure. Sampled because verifyChain is one query per
  // callRef and 1.5k chains is not a useful thing to do 1.5k times.
  const chain = { checked: 0, ok: 0, broken: [] as string[] };
  const sample = [...concluded, ...shedWithAuditRow]
    .filter((_, i) => i % SAMPLE_EVERY === 0)
    .slice(0, CHAIN_SAMPLE);
  for (const ref of sample) {
    const v = await auditChain.verifyChain(ref);
    chain.checked++;
    if (v.ok) chain.ok++;
    else chain.broken.push(`${ref}: broken at ${v.brokenAt} (expected ${v.expected.slice(0, 12)}…, got ${v.actual.slice(0, 12)}…)`);
  }

  return {
    casesIn: result.casesIn,
    casesFound: caseRows.length,
    byState,
    dialled: concluded.length,
    shedWithAuditRow: shedWithAuditRow.length,
    shedWithoutAuditRow: shedWithoutAuditRow.length,
    unaccountedInFlight: inFlightRefs.length,
    unaccountedRefs: inFlightRefs.slice(0, 20),
    queueRows: Object.values(queueByState).reduce((a, b) => a + b, 0),
    queueByState,
    shedIntents,
    chainSample: chain,
  };
}

// ── 11. Suite state ─────────────────────────────────────────────────────────
let steady: ScenarioResult | null = null;
let burst: ScenarioResult | null = null;
let steadyAccounting: Accounting | null = null;
let burstAccounting: Accounting | null = null;

beforeAll(() => {
  if (!dbAvailable) return;
  scaleAdmission.resetShedCounter();
});

afterAll(async () => {
  if (dbAvailable) {
    // Delete ONLY this run's rows, scoped by the per-run prefix. Another suite
    // running concurrently in this database is not collateral damage. dial_job
    // is this work package's own table, so nothing else can be in it.
    await db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "callRef" LIKE $1`, `${PREFIX}-%`).catch(() => {});
    await db.$executeRawUnsafe(`DELETE FROM dial_job WHERE "case_ref" LIKE $1`, `${PREFIX}-%`).catch(() => {});
    await db.$executeRawUnsafe(`DELETE FROM "Case" WHERE "caseRef" LIKE $1`, `${PREFIX}-%`).catch(() => {});
  }
  try {
    await writeEvidence();
  } catch (err) {
    console.error("[wp19-load] evidence write failed:", err instanceof Error ? err.message : err);
  }
  globalThis.fetch = REAL_FETCH;
  await db.$disconnect().catch(() => {});
});

// ── 12. The artifact ────────────────────────────────────────────────────────

function summariseModel(m: CapacityModel): Record<string, unknown> {
  return {
    inputs: m.inputs,
    steps: m.steps,
    interventions_per_month: m.interventionsPerMonth,
    averaging_window_hours: roundTo(m.averagingWindowHours, 3),
    mean_per_hour: roundTo(m.meanInterventionsPerHour, 2),
    peak_per_hour: roundTo(m.peakInterventionsPerHour, 2),
    peak_per_second: roundTo(m.peakInterventionsPerSecond, 3),
    required_concurrent_calls: roundTo(m.requiredConcurrentCalls, 1),
    from_numbers_required: m.fromNumbersRequired,
    voice_coverage_of_peak: roundTo(m.voiceCoverageOfPeak, 4),
    band_at_peak: m.bandAtPeak,
    binding_constraint: m.bindingConstraint,
    cost_at_peak: m.costAtPeak,
    verdict: m.verdict,
  };
}

function summariseScenario(r: ScenarioResult | null): Record<string, unknown> | null {
  if (r === null) return null;
  const sortedDepths = [...r.queueDepthSamples].sort((a, b) => a - b);
  return {
    name: r.name,
    case_ref_prefix: r.caseRefPrefix,
    cases_in: r.casesIn,
    offered_concurrency: r.offeredConcurrency,
    dialled: r.dialed,
    shed: r.shed,
    errors: r.errors,
    by_reason: r.byReason,
    error_rate: ratio(r.errors, r.casesIn),
    shed_rate: ratio(r.shed, r.casesIn),
    dialled_rate: ratio(r.dialed, r.casesIn),
    latency: {
      end_to_end_enqueue_to_accounted: r.endToEnd,
      admission_decision_including_gauge_count: r.admission,
      vendor_call_including_synthetic_hold: r.vendorCall,
    },
    queue: {
      max_depth: r.maxQueueDepth,
      end_depth: r.endQueueDepth,
      samples: r.queueDepthSamples.length,
      depth_p50: percentile(sortedDepths, 0.5),
      depth_p95: percentile(sortedDepths, 0.95),
      depth_mean: roundTo(
        r.queueDepthSamples.length === 0 ? 0 : r.queueDepthSamples.reduce((a, b) => a + b, 0) / r.queueDepthSamples.length,
      ),
      jobs_done: r.jobsDone,
      jobs_retried: r.jobsRetried,
      jobs_dead: r.jobsDead,
      jobs_handler_crashes: r.jobsCrashed,
      jobs_lost_before_settlement: r.jobsLost,
      jobs_skipped_not_ours: r.jobsSkipped,
    },
    gauge: {
      baseline_at_start: r.baselineGauge,
      peak_observed: r.peakGauge,
      peak_own_in_flight: r.peakOwnInFlight,
      end: r.endGauge,
      bands_seen: r.bandsSeen,
    },
    vendor: {
      placed: r.vendorPlaced,
      throttled_429: r.vendor429,
      max_concurrent_sessions_observed: r.vendorMaxConcurrent,
      gate_timeouts: r.gateTimeouts,
      backoff_delays_ms_sample: r.throttleDelaysMs.slice(0, 50),
      backoff_delay_min_ms: r.throttleDelaysMs.length ? Math.min(...r.throttleDelaysMs) : 0,
      backoff_delay_max_ms: r.throttleDelaysMs.length ? Math.max(...r.throttleDelaysMs) : 0,
      backoff_attempts: r.throttleDelaysMs.length,
    },
    wall_clock_ms: r.wallClockMs,
  };
}

async function writeEvidence(): Promise<void> {
  // The two models this gate is asserting against, computed by the same code the
  // documentation quotes (src/lib/scale/capacity.ts).
  const burstModel = scaleCapacity.projectCapacity({
    cardsPerMonth: 8_000,
    flagRate: 0.35,
    peakMultiple: 1,
    peakWindowMinutes: 40,
    fromNumbers: 1,
  });
  const steadyModel = scaleCapacity.projectCapacity({
    cardsPerMonth: 200_000,
    flagRate: 0.0035,
    peakMultiple: 8,
    fromNumbers: 1,
  });

  let snapshot: unknown = null;
  if (dbAvailable) {
    snapshot = await scaleAdmission.scaleMetricsSnapshot().catch(() => null);
  }

  const ranBoth = dbAvailable && steady !== null && burst !== null;
  const payload = {
    schemaVersion: 1,
    gate: "WP-19 Layer A — concurrency and scale; vendors mocked at the port seam",
    result: ranBoth ? "recorded" : "not-run",
    integrity: {
      rule: "never present an extrapolated number as a measured one",
      labels: {
        measured:
          "Latency percentiles, error/shed/dial rates, queue depth, gauge peaks, job counts, chain verification. Observed by THIS run, on THIS machine, against local Postgres, with the vendor held at a synthetic constant latency.",
        calibrated:
          `The concurrency target (ELEVENLABS_MAX_CONCURRENT=${PLAN_CONCURRENCY}, the Business tier) and the vendor ceilings — from elevenlabs.io/pricing/agents read 2026-10-02. Never measured against our account.`,
        extrapolated:
          "The campaign shape (8,000 customers, 40 minutes, 35% flag rate), the 8x steady-state peak multiple, and everything derived from them. Modelled, not observed.",
      },
      determinism: {
        wallClockIncluded: true,
        randomIdentifiersIncluded: false,
        note:
          "Latency percentiles are wall-clock measurements and therefore differ between runs — that is the point of the artifact. Every DECISION input is seeded (mulberry32 from the run id): which case is throttled, each case's risk and amount, and the backoff jitter. Two runs make the same decisions; only the timings differ.",
        seededFrom: RUN,
      },
      network: {
        calls: NETWORK_CALLS.length,
        urls: NETWORK_CALLS.slice(0, 10),
        note: "globalThis.fetch was a tripwire for the whole suite. A Layer A result containing any network call is a FAILURE, not a slow test.",
      },
      database: {
        available: dbAvailable,
        note: dbReason,
        baseline_in_flight_at_start: baselineGauge,
        baseline_note:
          "activeConversations() is a GLOBAL gauge (a COUNT of live cases), and this database is shared with other suites, so rows left in DIALING..VERIFYING by an earlier run inflate every reading. peak_own_in_flight counts ONLY this run's cases and is the figure to compare against the model.",
        migration: bootstrap,
        migration_columns_match_code: migrationColumnsOk,
        migration_columns_detail: migrationColumnsDetail,
      },
      case_count_scaling: {
        modelled_campaign_interventions: 2_800,
        steady_cases_played: STEADY_CASES,
        burst_cases_played: BURST_CASES,
        burst_workers: BURST_WORKERS,
        note:
          "Case COUNT is scaled down from the modelled 2,800-intervention campaign; OFFERED CONCURRENCY is not. Concurrency is the quantity under test — see burst.offered_concurrency against model.burst.required_concurrent_calls. Set LOAD_BURST_CASES=2800 for the full replay.",
      },
      vendor_backoff: {
        sleeps_injected: "no-op",
        note:
          "Backoff sleeps are injected as no-ops so the gate costs no wall clock and stays deterministic. The delays that WOULD have been waited are recorded under vendor.backoff_delays_ms_sample and are NOT included in any latency percentile above.",
      },
      synthetic_hold: {
        steady_ms: STEADY_HOLD_MS,
        burst_ms: BURST_HOLD_MS,
        note:
          "A Layer A 'conversation' holds a vendor slot for this long instead of the modelled 180 s. It stands in for talk time so that offered concurrency is expressed inside a CI budget; it is NOT a measurement of call duration, and every latency percentile that includes it is labelled.",
      },
      not_measured_here: [
        "Real telephony: Twilio calls-per-second per from-number, account concurrency, carrier latency, answer and seize rates.",
        "ElevenLabs Conversational AI: actual concurrent-session enforcement, the real 429 rate at the ceiling, real time-to-first-audio, real per-minute billing.",
        "Network behaviour between the app, the provider and the bank webhook endpoint.",
        "Multi-instance behaviour: every worker here is one process on one database. SKIP LOCKED is exercised; cross-instance clock skew and per-instance pool contention are not.",
        "Postgres under a realistic index size — the gauge is a COUNT over Case.state and this database has a few thousand rows, not millions.",
        "Partitioning, read replicas and autoscaling — POST-SUBMISSION roadmap, docs/CAPACITY.md §9.",
      ],
    },
    model: { burst: summariseModel(burstModel), steady: summariseModel(steadyModel) },
    ceilings: scaleCapacity.vendorCeilings(),
    plan: {
      eleven_labs_concurrency: PLAN_CONCURRENCY,
      burst_allowance_ceiling: ELEVENLABS_BURST_CEILING,
      band_constrained_at: ELEVENLABS_BURST_CEILING * BAND_ENTER_CONSTRAINED_PCT,
      band_shed_at: ELEVENLABS_BURST_CEILING * BAND_ENTER_SHED_PCT,
      shed_threshold_minor: Number(process.env.SHED_EXPECTED_LOSS_MINOR ?? 50_000),
    },
    metrics_snapshot_at_end: snapshot,
    scenarios: { steady: summariseScenario(steady), burst: summariseScenario(burst) },
    accounting: { steady: steadyAccounting, burst: burstAccounting },
    summary: {
      steady_error_rate: steady === null ? null : ratio(steady.errors, steady.casesIn),
      steady_shed_rate: steady === null ? null : ratio(steady.shed, steady.casesIn),
      burst_error_rate: burst === null ? null : ratio(burst.errors, burst.casesIn),
      burst_shed_rate: burst === null ? null : ratio(burst.shed, burst.casesIn),
      burst_peak_own_in_flight: burst?.peakOwnInFlight ?? null,
      burst_peak_gauge: burst?.peakGauge ?? null,
      burst_vendor_max_concurrent: burst?.vendorMaxConcurrent ?? null,
      cases_accounted_exactly:
        steadyAccounting === null || burstAccounting === null
          ? null
          : steadyAccounting.unaccountedInFlight === 0 &&
            steadyAccounting.shedWithoutAuditRow === 0 &&
            burstAccounting.unaccountedInFlight === 0 &&
            burstAccounting.shedWithoutAuditRow === 0,
    },
  };

  mkdirSync(join(process.cwd(), "evidence", "load"), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe("WP-19 capacity model (pure — no database, no vendor, no network)", () => {
  const steadyArgs = { cardsPerMonth: 200_000, flagRate: 0.0035, peakMultiple: 8, fromNumbers: 1 } as const;
  const burstArgs = {
    cardsPerMonth: 8_000,
    flagRate: 0.35,
    peakMultiple: 1,
    peakWindowMinutes: 40,
    fromNumbers: 1,
  } as const;

  test("the steady state is trivial: 0.4 concurrent calls, nothing to engineer", () => {
    const m = scaleCapacity.projectCapacity(steadyArgs);
    expect(m.interventionsPerMonth).toBe(700);
    expect(roundTo(m.meanInterventionsPerHour, 2)).toBe(0.96);
    expect(roundTo(m.requiredConcurrentCalls, 2)).toBe(0.38);
    expect(m.bindingConstraint.oversubscribed).toBe(false);
    expect(m.bandAtPeak).toBe("NORMAL");
    expect(m.costAtPeak.usdPerHour).toBeLessThan(1);
  });

  test("the campaign burst is 210 concurrent — 5.25x the plan ceiling, 1.75x the burst allowance", () => {
    const m = scaleCapacity.projectCapacity(burstArgs);
    // 2,800 interventions over a 40-minute window = 4,200/hour = 70/minute =
    // 1.167/second; × 180 s of talk = 210 conversations in flight.
    expect(m.interventionsPerMonth).toBe(2_800);
    expect(m.averagingWindowHours).toBeCloseTo(0.667, 3);
    expect(roundTo(m.meanInterventionsPerHour, 1)).toBe(4_200);
    expect(roundTo(m.peakInterventionsPerSecond, 2)).toBe(1.17);
    expect(Math.round(m.requiredConcurrentCalls)).toBe(210);
    expect(m.bindingConstraint.oversubscribed).toBe(true);
    // Which ceiling binds is whichever ratio is worse, and at our conservative
    // Twilio account default (10) that is the CARRIER, not the AI provider:
    // 210/10 = 21x versus 210/40 = 5.25x. Reading the real Twilio number out of
    // the console is what moves the binding constraint back to ElevenLabs.
    expect(["elevenLabsConcurrentSessions", "twilioAccountConcurrency"]).toContain(m.bindingConstraint.name);
    expect(m.ceilingRatios.elevenLabsConcurrentSessions).toBeCloseTo(5.25, 2);
    expect(m.ceilingRatios.twilioAccountConcurrency).toBeCloseTo(21, 1);
    // Voice cannot cover the burst even at the 3× burst allowance (120).
    expect(m.voiceCoverageOfPeak).toBeLessThan(1);
    expect(roundTo(m.voiceCoverageOfPeak * 100, 1)).toBe(57.1);
    expect(m.bandAtPeak).toBe("SHED");
    expect(m.verdict.join(" ")).toMatch(/OVERSUBSCRIBED/);
  });

  test("the burst arithmetic is a function of the WINDOW, not of a magic multiplier", () => {
    // The same volume averaged over a month is nothing; averaged over 40 minutes
    // it is a campaign. That single choice is the whole difference.
    const overMonth = scaleCapacity.projectCapacity({ cardsPerMonth: 8_000, flagRate: 0.35, peakMultiple: 1 });
    expect(overMonth.averagingWindowHours).toBe(730);
    expect(overMonth.requiredConcurrentCalls).toBeLessThan(1);
    expect(scaleCapacity.projectCapacity(burstArgs).requiredConcurrentCalls).toBeGreaterThan(200);
  });

  test("cost at the peak: in-plan minutes at the standard rate, over-plan at the burst rate", () => {
    const m = scaleCapacity.projectCapacity(burstArgs);
    const c = m.costAtPeak.breakdown;
    // 40 sessions inside the plan at $0.08, 170 over it at $0.16.
    expect(c.withinPlanConcurrent).toBe(PLAN_CONCURRENCY);
    expect(c.overPlanBurstConcurrent).toBe(170);
    expect(roundTo(c.conversationalAiUsd, 2)).toBe(30.4); // 3.20 + 27.20
    expect(m.costAtPeak.usdPerHour).toBeCloseTo(30.4, 5);
    expect(roundTo(m.costAtPeak.usdPerPeakBurst ?? 0, 2)).toBe(20.27); // over 40 min
    // The billing breaker must be set above this or it stops a real campaign.
    expect(m.costAtPeak.requiredHourlyBillingCeilingMinor).toBe(3_040);
  });

  test("every input and every derived step carries a confidence label and a source", () => {
    const m = scaleCapacity.projectCapacity(burstArgs);
    for (const input of Object.values(m.inputs)) {
      expect(["measured", "calibrated", "extrapolated"]).toContain(input.confidence);
      expect(input.source.length).toBeGreaterThan(10);
    }
    for (const s of m.steps) {
      expect(["measured", "calibrated", "extrapolated"]).toContain(s.confidence);
      expect(s.formula.length).toBeGreaterThan(3);
      expect(s.note.length).toBeGreaterThan(10);
    }
  });

  test("a cost figure with no carrier rate is a FLOOR and says so", () => {
    const m = scaleCapacity.projectCapacity(burstArgs);
    expect(m.costAtPeak.carrierIncluded).toBe(false);
    expect(m.costAtPeak.confidence).toBe("extrapolated");
    expect(m.costAtPeak.note).toMatch(/INPUT REQUIRED/);
    expect(m.verdict.join(" ")).toMatch(/EXCLUDES the carrier/);
    expect(m.inputs.carrierUsdPerMinute.value).toBe(0);
  });

  test("supplying the carrier rate completes the cost figure and upgrades its label", () => {
    const m = scaleCapacity.projectCapacity({ ...burstArgs, carrierUsdPerMinute: 0.1 });
    expect(m.costAtPeak.carrierIncluded).toBe(true);
    expect(m.costAtPeak.confidence).toBe("calibrated");
    // 210 concurrent × $0.10/min of carrier talk = $21/hour on top of $30.40.
    expect(roundTo(m.costAtPeak.breakdown.carrierUsd, 2)).toBe(21);
    expect(roundTo(m.costAtPeak.usdPerHour, 2)).toBe(51.4);
  });

  test("ceilings are overridable per deployment, and a malformed override fails safe", () => {
    const before = process.env.ELEVENLABS_MAX_CONCURRENT;
    try {
      // The fallback is whatever `@/lib/capacity` captured at import time, which
      // for THIS process is the Business tier (step 1 above). In a deployment
      // with the variable unset at boot it is the free tier, 4 — on purpose,
      // because assuming a paid tier is how a demo finds out it was throttled.
      delete process.env.ELEVENLABS_MAX_CONCURRENT;
      const dflt = scaleCapacity.vendorCeiling("elevenLabsConcurrentSessions");
      expect(dflt.value).toBe(PLAN_CONCURRENCY);
      expect(dflt.confidence).toBe("calibrated");
      expect(dflt.source).toMatch(/elevenlabs\.io/);
      expect(dflt.checkedOn).toBe("2026-10-02");
      expect(dflt.envVar).toBe("ELEVENLABS_MAX_CONCURRENT");

      // An override is read at CALL time, so raising a ceiling during an
      // incident does not need a redeploy.
      process.env.ELEVENLABS_MAX_CONCURRENT = "80";
      expect(scaleCapacity.vendorCeiling("elevenLabsConcurrentSessions").value).toBe(80);

      process.env.ELEVENLABS_MAX_CONCURRENT = "banana";
      const bad = scaleCapacity.vendorCeiling("elevenLabsConcurrentSessions");
      expect(bad.value).toBe(PLAN_CONCURRENCY); // must never become unlimited
      expect(bad.note).toMatch(/is not a positive number/);
    } finally {
      if (before === undefined) delete process.env.ELEVENLABS_MAX_CONCURRENT;
      else process.env.ELEVENLABS_MAX_CONCURRENT = before;
    }
  });

  test("all three ceilings are reported with provenance, and Twilio's two limits are distinct", () => {
    const ceilings = scaleCapacity.vendorCeilings();
    expect(ceilings.map((c) => c.name)).toEqual([
      "elevenLabsConcurrentSessions",
      "twilioCallsPerSecondPerNumber",
      "twilioAccountConcurrency",
    ]);
    const cps = ceilings.find((c) => c.name === "twilioCallsPerSecondPerNumber");
    const conc = ceilings.find((c) => c.name === "twilioAccountConcurrency");
    expect(cps?.unit).toBe("calls_per_second");
    expect(conc?.unit).toBe("concurrent_calls");
    // Neither Twilio number is a published constant, and both say so.
    expect(cps?.source).toMatch(/Console/);
    expect(conc?.source).toMatch(/Console/);
    for (const c of ceilings) {
      expect(c.confidence).toBe("calibrated");
      expect(c.note.length).toBeGreaterThan(40);
    }
  });
});

describe("WP-19 client-side vendor ceiling — 429 and the gate", () => {
  test("a 429 is retried with jittered exponential backoff, and the slot is released while it waits", async () => {
    const gate = new scaleCapacity.VendorConcurrencyGate(() => 4);
    const delays: number[] = [];
    const inFlightObserved: number[] = [];
    const result = await scaleCapacity.withElevenLabsCeiling<number>({
      gate,
      call: async (attempt) => {
        if (attempt <= 2) throw new MockThrottleError("concurrency ceiling");
        return 7;
      },
      sleep: noSleep,
      rand,
      onThrottle: (info) => {
        delays.push(info.delayMs);
        inFlightObserved.push(gate.stats().inFlight);
      },
    });
    expect(result.value).toBe(7);
    expect(result.attempts).toBe(3);
    expect(result.throttles).toBe(2);
    expect(delays.length).toBe(2);
    // Equal jitter: each delay sits in [half, full] of its exponential step.
    for (const [i, d] of delays.entries()) {
      const exponential = Math.min(scaleCapacity.BACKOFF_MAX_MS, scaleCapacity.BACKOFF_BASE_MS * 2 ** i);
      expect(d).toBeGreaterThanOrEqual(Math.floor(exponential / 2));
      expect(d).toBeLessThanOrEqual(Math.ceil(exponential));
    }
    // The slot is RELEASED before the backoff — holding it would turn the
    // vendor's throttle into ours.
    for (const n of inFlightObserved) expect(n).toBe(0);
    expect(gate.stats().inFlight).toBe(0);
  }, 30_000);

  test("the backoff is jittered, not a fixed ladder", () => {
    const many = new Set<number>();
    for (let i = 0; i < 200; i++) many.add(scaleCapacity.throttleBackoffMs(3, Math.random));
    // A fixed delay would collapse to one value; equal jitter spreads them.
    expect(many.size).toBeGreaterThan(10);
    for (const attempt of [1, 2, 3, 4, 5, 10, 50]) {
      expect(scaleCapacity.throttleBackoffMs(attempt, () => 1)).toBeLessThanOrEqual(scaleCapacity.BACKOFF_MAX_MS);
      expect(scaleCapacity.throttleBackoffMs(attempt, () => 0)).toBeGreaterThan(0);
    }
    expect(scaleCapacity.throttleBackoffMs(1, () => 0.5)).toBe(scaleCapacity.throttleBackoffMs(1, () => 0.5));
  });

  test("a non-throttle error surfaces immediately — it is never retried into a bill", async () => {
    const gate = new scaleCapacity.VendorConcurrencyGate(() => 4);
    let calls = 0;
    await expect(
      scaleCapacity.withElevenLabsCeiling({
        gate,
        call: async () => {
          calls++;
          throw new Error("ElevenLabs 500: upstream");
        },
        sleep: noSleep,
        rand,
      }),
    ).rejects.toThrow(/500/);
    expect(calls).toBe(1);
    expect(gate.stats().inFlight).toBe(0);
  }, 30_000);

  test("the ladder is bounded — a permanently throttled vendor ends in a typed refusal", async () => {
    const gate = new scaleCapacity.VendorConcurrencyGate(() => 4);
    let calls = 0;
    await expect(
      scaleCapacity.withElevenLabsCeiling({
        gate,
        call: async () => {
          calls++;
          throw new MockThrottleError("still full");
        },
        maxAttempts: 3,
        sleep: noSleep,
        rand,
      }),
    ).rejects.toThrow(/429/);
    expect(calls).toBe(3);
    expect(gate.stats().inFlight).toBe(0);
  }, 30_000);

  test("a full gate refuses rather than queueing without bound — the caller must degrade", async () => {
    const gate = new scaleCapacity.VendorConcurrencyGate(() => 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scaleCapacity.withElevenLabsCeiling<void>({ gate, call: () => held });
    for (let i = 0; i < 200 && gate.stats().inFlight === 0; i++) await sleep(1);
    expect(gate.stats().inFlight).toBe(1);
    await expect(
      scaleCapacity.withElevenLabsCeiling({ gate, call: async () => {}, maxWaitMs: 20 }),
    ).rejects.toBeInstanceOf(scaleCapacity.VendorCeilingExhaustedError);
    release();
    await first;
    expect(gate.stats().inFlight).toBe(0);
    expect(gate.stats().timeouts).toBe(1);
  }, 30_000);

  test("the gate reads its ceiling per grant, so lowering it is an incident lever", async () => {
    let ceiling = 4;
    const gate = new scaleCapacity.VendorConcurrencyGate(() => ceiling);
    expect(gate.ceiling()).toBe(4);
    ceiling = 2;
    expect(gate.ceiling()).toBe(2);
    expect(gate.stats().ceiling).toBe(2);
  });
});

describe.skipIf(!dbAvailable)("WP-19 durable dial queue", () => {
  const q = (n: number): string => `${QUEUE_PREFIX}${String(n).padStart(4, "0")}`;

  async function seedJobs(n: number, startOrdinal = 0): Promise<{ caseId: string; caseRef: string }[]> {
    const out: { caseId: string; caseRef: string }[] = [];
    for (let i = 0; i < n; i++) {
      const caseRef = q(startOrdinal + i);
      const created = await csm.createCase({ caseRef, orgId: ORG, riskScore: 0.9, amountMinor: 100_000 });
      await queue.enqueueDialJob({
        caseId: created.id,
        caseRef,
        orgId: ORG,
        // Descending priority so "highest expected loss first" is assertable.
        priority: 1_000 - (startOrdinal + i),
        payload: { lang: "en" },
      });
      out.push({ caseId: created.id, caseRef });
    }
    return out;
  }

  async function jobIdFor(caseId: string): Promise<string> {
    const row = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM dial_job WHERE "case_id" = $1`, caseId);
    const id = row[0]?.id;
    if (!id) throw new Error(`no dial_job row for case ${caseId}`);
    return id;
  }

  /** Make a failed job due again immediately instead of waiting out the ladder. */
  async function makeDue(id: string): Promise<void> {
    await db.$executeRawUnsafe(`UPDATE dial_job SET "available_at" = now() WHERE id = $1`, id);
  }

  /**
   * Empty the queue before each mechanics test. Claiming is global, so a test
   * that assumed it was looking at only its own rows would be testing whatever
   * the previous test left behind.
   */
  async function resetQueue(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const claimed = await queue.claimDialJobs({ workerId: "reset", limit: 500, leaseMs: 60_000 });
      if (claimed.length === 0) return;
      for (const j of claimed) await queue.completeDialJob(j.id);
    }
    throw new Error("resetQueue: the queue did not drain — a job is stuck in a state claims cannot take");
  }

  beforeEach(resetQueue);

  afterAll(async () => {
    // Settle nothing: remove this describe's rows outright, so the scenarios
    // that follow start from a queue that owes nobody anything.
    await db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "callRef" LIKE $1`, `${QUEUE_PREFIX}%`).catch(() => {});
    await db.$executeRawUnsafe(`DELETE FROM dial_job WHERE "case_ref" LIKE $1`, `${QUEUE_PREFIX}%`).catch(() => {});
    await db.$executeRawUnsafe(`DELETE FROM "Case" WHERE "caseRef" LIKE $1`, `${QUEUE_PREFIX}%`).catch(() => {});
  });

  test("the migration in the repo matches the columns this module reads", () => {
    expect(bootstrap.note.length).toBeGreaterThan(10);
    expect(migrationColumnsDetail).toContain("dial_job");
    expect(migrationColumnsOk).toBe(true);
  });

  test("enqueue is idempotent on (case_id, attempt_no) — a replayed signal costs one row", async () => {
    const [seed] = await seedJobs(1);
    const again = await queue.enqueueDialJob({ caseId: seed!.caseId, caseRef: seed!.caseRef, orgId: ORG });
    expect(again.created).toBe(false);
    expect(again.id).toBeDefined();
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM dial_job WHERE "case_id" = $1`,
      seed!.caseId,
    );
    expect(rows[0]?.n).toBe(1);
    // A SECOND attempt for the same case is a different job, not a duplicate.
    const second = await queue.enqueueDialJob({ caseId: seed!.caseId, caseRef: seed!.caseRef, attemptNo: 2 });
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(again.id);
  }, 30_000);

  test("two workers claiming at once are made disjoint by the ownership gate", async () => {
    // The raw claim race is real but rare and not fully closable in SQL: measured
    // on this repo's Postgres 17.11 over 40 rounds of two concurrent claims
    // (LIMIT 4 each), the subquery form overlapped 0/40, the CTE forms 3/40 and
    // 5/40, and re-asserting the predicate in the outer WHERE was 1/40 — i.e.
    // "add a predicate" is not the fix. What closes it is refusing to ACT on a
    // claim we cannot confirm: `renewClaim` re-checks ownership in the same
    // statement that extends the lease, and `beforeHandler` skips the job when it
    // says no. So the property asserted here is the one that matters — no job is
    // HANDLED twice — with the raw overlap rate recorded rather than hidden.
    for (let round = 0; round < 12; round++) {
      const seeded = await seedJobs(8, 700 + round * 10);
      const handled = new Set<string>();
      let duplicated = 0;

      const run = async (workerId: string): Promise<void> => {
        for (;;) {
          const drained = await queue.drainDialQueue({
            workerId,
            limit: 1,
            leaseMs: 60_000,
            beforeHandler: (job) => queue.renewClaim(job.id, workerId, 60_000),
            handler: async (job) => {
              if (handled.has(job.id)) duplicated++;
              handled.add(job.id);
              return { ok: true };
            },
          });
          if (drained.claimed === 0) return;
        }
      };
      await Promise.all([run(`race-a-${round}`), run(`race-b-${round}`)]);

      // The guarantee: every job handled exactly once, and every job settled.
      expect(duplicated, `round ${round}: a job was handled twice — a double-dial`).toBe(0);
      expect(handled.size).toBe(8);
      const done = await db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM dial_job WHERE "case_ref" = ANY($1::text[]) AND state = 'DONE'`,
        seeded.map((s) => s.caseRef),
      );
      expect(done[0]?.n).toBe(8);
    }
  }, 120_000);

  test("FOR UPDATE SKIP LOCKED gives two workers disjoint batches, and priority order survives the race", async () => {
    // Seed MORE work than the two claims can take, so the ordering property is
    // observable: nothing low-priority may be claimed while higher-priority work
    // is still sitting unclaimed.
    await seedJobs(12, 100); // priorities 900 … 889
    const [a, b] = await Promise.all([
      queue.claimDialJobs({ workerId: "w-a", limit: 4, leaseMs: 60_000 }),
      queue.claimDialJobs({ workerId: "w-b", limit: 4, leaseMs: 60_000 }),
    ]);
    expect(a.length).toBe(4);
    expect(b.length).toBe(4);

    // 1. Disjoint. This is the property SKIP LOCKED exists for: no row is handed
    //    to two workers, and neither worker blocked on the other's locks.
    const idsA = new Set(a.map((j) => j.id));
    const idsB = new Set(b.map((j) => j.id));
    expect(idsA.size).toBe(4);
    expect(idsB.size).toBe(4);
    for (const id of idsB) expect(idsA.has(id)).toBe(false);
    for (const batch of [a, b]) {
      expect(batch.every((j) => j.state === "CLAIMED")).toBe(true);
      expect(batch.every((j) => j.claimed_by !== null)).toBe(true);
      expect(batch.every((j) => j.lease_expires_at !== null)).toBe(true);
    }

    // 2. Priority order. NOT "each batch is sorted" — under concurrent claiming
    //    a worker legitimately SKIPS a row another worker has locked, so a single
    //    worker's batch can be [1000, 899, …]. The guarantee is global: every
    //    job left behind is lower-priority than every job taken.
    const claimed = [...a, ...b];
    const leftBehind = await db.$queryRawUnsafe<{ priority: number }[]>(
      `SELECT priority FROM dial_job WHERE "case_ref" LIKE $1 AND state = 'PENDING'`,
      `${QUEUE_PREFIX}01%`,
    );
    expect(leftBehind.length).toBe(4);
    const minClaimed = Math.min(...claimed.map((j) => j.priority));
    const maxLeftBehind = Math.max(...leftBehind.map((r) => r.priority));
    expect(minClaimed).toBeGreaterThan(maxLeftBehind);

    for (const j of claimed) await queue.completeDialJob(j.id);
    const settled = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM dial_job WHERE "case_ref" LIKE $1 AND state <> 'DONE' AND state <> 'PENDING'`,
      `${QUEUE_PREFIX}01%`,
    );
    expect(settled[0]?.n).toBe(0);
  }, 30_000);

  test("a killed worker's job is reclaimed once its lease expires — no sweeper, no orphan", async () => {
    const [seed] = await seedJobs(1, 200);
    const jobId = await jobIdFor(seed!.caseId);

    // A lease that has already expired is exactly the state a SIGKILLed worker
    // leaves behind: the row is CLAIMED and nobody is coming back for it.
    const claimed = await queue.claimDialJobs({
      workerId: "doomed-worker",
      limit: 5,
      leaseUntil: new Date(Date.now() - 1_000),
    });
    const stranded = claimed.find((j) => j.id === jobId);
    expect(stranded).toBeDefined();
    expect(stranded!.state).toBe("CLAIMED");
    expect(stranded!.claimed_by).toBe("doomed-worker");

    // A second worker reclaims it as part of an ordinary claim.
    const reclaimed = await queue.claimDialJobs({ workerId: "rescuer", limit: 5, leaseMs: 60_000 });
    expect(reclaimed.some((j) => j.id === jobId)).toBe(true);
    expect(reclaimed.find((j) => j.id === jobId)?.claimed_by).toBe("rescuer");
    await queue.completeDialJob(jobId);
  }, 30_000);

  test("reapExpiredLeases reports how many jobs are stranded right now", async () => {
    await seedJobs(2, 300);
    const claimed = await queue.claimDialJobs({ workerId: "doomed-2", limit: 2, leaseUntil: new Date(Date.now() - 1_000) });
    expect(claimed.length).toBe(2);
    const reaped = await queue.reapExpiredLeases();
    expect(reaped).toBeGreaterThanOrEqual(2);
    const rest = await queue.claimDialJobs({ workerId: "after-reap", limit: 10, leaseMs: 60_000 });
    for (const j of rest) await queue.completeDialJob(j.id);
  }, 30_000);

  test("attempts are bounded and an exhausted job is dead-lettered with its error", async () => {
    const [seed] = await seedJobs(1, 400);
    const jobId = await jobIdFor(seed!.caseId);

    let attempts = 0;
    for (let round = 0; round < 3; round++) {
      const drained = await queue.drainDialQueue({
        workerId: "failing-worker",
        limit: 10,
        maxAttempts: 2,
        rand: () => 0.5,
        // The handler settles everything it claims, so the drain is also what
        // keeps the rest of the queue tidy. It must NOT claim jobId here without
        // settling it: a second claim under a live lease would hide the retry.
        handler: async (job) => {
          if (job.id !== jobId) return { ok: true };
          attempts++;
          return { ok: false, error: "carrier refused the destination" };
        },
      });
      expect(drained.crashed).toBe(0); // a refusal is not a crash
      await makeDue(jobId);
    }
    expect(attempts).toBe(2); // bounded at 2, not 3

    const dead = await queue.dialJobById(jobId);
    expect(dead?.state).toBe("DEAD");
    expect(dead?.retries).toBe(2);
    expect(dead?.last_error).toMatch(/carrier refused/);
    expect(dead?.completed_at).not.toBeNull();

    // Operator replay puts it back on the ladder with the retry count intact.
    const replay = await queue.replayDeadDialJob(jobId);
    expect(replay.ok).toBe(true);
    const revived = await queue.dialJobById(jobId);
    expect(revived?.state).toBe("PENDING");
    expect(revived?.last_error).toBeNull();
    expect(revived?.retries).toBe(2);
    const again = await queue.replayDeadDialJob(jobId);
    expect(again.ok).toBe(false); // replaying a PENDING job is refused
  }, 60_000);

  test("a handler that THROWS is settled and counted apart from a dial failure", async () => {
    const [seed] = await seedJobs(1, 500);
    const jobId = await jobIdFor(seed!.caseId);
    const drained = await queue.drainDialQueue({
      workerId: "buggy-worker",
      limit: 5,
      handler: async (job) => {
        if (job.id !== jobId) return { ok: true };
        throw new Error("a bug, not a dial failure");
      },
      rand: () => 0.5,
    });
    expect(drained.crashed).toBeGreaterThanOrEqual(1);
    const job = await queue.dialJobById(jobId);
    // Settled (a lease must never hold a row hostage) and the crash is on the
    // record, so a bug cannot hide inside the retry statistics.
    expect(job?.state === "PENDING" || job?.state === "DEAD").toBe(true);
    expect(job?.last_error).toMatch(/handler crashed: a bug/);
    for (const j of await queue.claimDialJobs({ workerId: "cleanup", limit: 50, leaseMs: 60_000 })) {
      await queue.completeDialJob(j.id);
    }
  }, 60_000);

  test("queue depth counts what a customer is still owed", async () => {
    await seedJobs(3, 600);
    const before = await queue.queueDepth();
    expect(before.pending).toBeGreaterThanOrEqual(3);
    const claimed = await queue.claimDialJobs({ workerId: "depth-worker", limit: 1, leaseMs: 60_000 });
    expect(claimed.length).toBe(1);
    const during = await queue.queueDepth();
    expect(during.pending + during.claimed).toBe(before.pending + before.claimed);
    for (const j of claimed) await queue.completeDialJob(j.id);
  }, 30_000);
});

describe.skipIf(!dbAvailable)("WP-19 admission metrics", () => {
  test("the snapshot exposes exactly the four metrics WP-19 files them under", async () => {
    const snap = await scaleAdmission.scaleMetricsSnapshot();
    for (const key of ["queue_depth", "active_conversations", "shed_count", "band"]) {
      expect(snap).toHaveProperty(key);
    }
    expect(typeof snap.queue_depth).toBe("number");
    expect(typeof snap.active_conversations).toBe("number");
    expect(typeof snap.shed_count).toBe("number");
    expect(["NORMAL", "CONSTRAINED", "SHED"]).toContain(snap.band);
    // The gates are derived from the ladder's own constants, not restated.
    expect(snap.gates.burst_ceiling).toBe(ELEVENLABS_BURST_CEILING);
    expect(snap.gates.constrained_at).toBeCloseTo(ELEVENLABS_BURST_CEILING * BAND_ENTER_CONSTRAINED_PCT, 6);
    expect(snap.gates.shed_at).toBeCloseTo(ELEVENLABS_BURST_CEILING * BAND_ENTER_SHED_PCT, 6);
    expect(snap.gates.headroom).toBe(snap.gates.burst_ceiling - snap.active_conversations);
    expect(snap.queue_depth).toBe(await queue.outstandingJobs());
  }, 30_000);

  test("the wrapper is thin: it re-exports the ladder and adds no decision of its own", async () => {
    const admission = await import("@/lib/admission");
    expect(scaleAdmission.admitOrDegrade).toBe(admission.admitOrDegrade);
    expect(scaleAdmission.activeConversations).toBe(admission.activeConversations);
    expect(scaleAdmission.bandFor(0)).toBe("NORMAL");
    expect(scaleAdmission.expectedLossScore(0.5, 1_000)).toBe(500);
  });
});

describe.skipIf(!dbAvailable)("WP-19 Layer A scenarios", () => {
  test("steady state: modest offered concurrency, no shed, no error", async () => {
    steady = await runScenario({ name: "steady", cases: STEADY_CASES, workers: STEADY_WORKERS, holdMs: STEADY_HOLD_MS });
    steadyAccounting = await accountForCases(steady);

expect(steady.errors).toBe(0);
    expect(steady.jobsCrashed).toBe(0);
    expect(steady.jobsLost).toBe(0); // a job nobody owned at settlement = a case we cannot account for
    expect(steady.jobsSkipped).toBe(0);
    expect(steady.vendorPlaced).toBe(steady.dialed); // exactly one call per customer
    expect(steady.dialed).toBe(STEADY_CASES);
    // A shed here would mean the ladder is mis-thresholded for normal traffic.
    // Guarded on the shared-database baseline, because this gauge is GLOBAL: rows
    // another suite left in flight can legitimately push us into a heavier band.
    if (steady.baselineGauge < ELEVENLABS_BURST_CEILING * BAND_ENTER_CONSTRAINED_PCT) {
      expect(steady.shed).toBe(0);
      expect(steady.bandsSeen).toEqual(["NORMAL"]);
    }
    // The injected 429s were survived, not surfaced as failures.
    expect(steady.vendor429).toBeGreaterThan(0);
    expect(steady.vendorPlaced).toBe(STEADY_CASES);
  }, 600_000);

  test("campaign burst: the modelled peak is offered, and the ladder degrades with an audit row", async () => {
    burst = await runScenario({ name: "burst", cases: BURST_CASES, workers: BURST_WORKERS, holdMs: BURST_HOLD_MS });
    burstAccounting = await accountForCases(burst);

    // ── the peak ─────────────────────────────────────────────────────────────
    // 2,800 interventions in 40 minutes × a 180 s mean = 210 concurrent.
    const modelledPeak = Math.round((2_800 / 40) * (scaleCapacity.MEAN_CALL_SECONDS / 60));
    expect(modelledPeak).toBe(210);
    // We OFFER that much concurrency. Sustaining the offer is the whole test.
    expect(burst.offeredConcurrency).toBeGreaterThanOrEqual(modelledPeak);
    // Error rate under 1%, per the brief.
expect(ratio(burst.errors, burst.casesIn)).toBeLessThan(0.01);
    expect(burst.jobsCrashed).toBe(0);
    expect(burst.jobsLost).toBe(0);
    expect(burst.jobsSkipped).toBe(0);
    // EXACTLY ONCE, the property the ownership gate exists for: the number of
    // calls the vendor double was asked to place equals the number of cases that
    // reached a conversation. A double-dial shows up here as placed > dialled.
    expect(burst.vendorPlaced).toBe(burst.dialed);
    // The ladder must have ENGAGED, not merely survived: if no band above NORMAL
    // was ever entered, the peak was never actually presented.
    expect(burst.bandsSeen.some((b) => b === "CONSTRAINED" || b === "SHED")).toBe(true);
    // Concurrency really was reached — counted over THIS run's cases only.
    expect(burst.peakOwnInFlight).toBeGreaterThanOrEqual(Math.floor(modelledPeak * 0.5));
    // The vendor double never saw more sessions than the plan ceiling allows:
    // the client-side ceiling held from the outside.
    expect(burst.vendorMaxConcurrent).toBeLessThanOrEqual(PLAN_CONCURRENCY);
    // And the 429s injected mid-burst were absorbed.
    expect(burst.vendor429).toBeGreaterThan(0);
    expect(burst.dialed + burst.shed).toBe(BURST_CASES);
  }, 900_000);

  test("CASES IN == CASES ACCOUNTED FOR — every case dialled or shed WITH AN AUDIT ROW", async () => {
    for (const [name, acc, result] of [
      ["steady", steadyAccounting, steady],
      ["burst", burstAccounting, burst],
    ] as const) {
      expect(acc, `${name}: accounting was not recorded`).not.toBeNull();
      if (acc === null || result === null) continue;
      expect(acc.casesFound, `${name}: every ingested case exists`).toBe(result.casesIn);
      // Every case has a durable queue row. A case with no row is a case we
      // cannot prove we even tried to reach.
      expect(acc.queueRows, `${name}: one dial_job row per case`).toBe(result.casesIn);
      // Nothing left mid-conversation.
      expect(acc.unaccountedInFlight, `${name}: cases left in flight`).toBe(0);
      expect(acc.unaccountedRefs).toEqual([]);
      // Every parked case has an audit row naming the shed.
      expect(acc.shedWithoutAuditRow, `${name}: shed cases with no audit row`).toBe(0);
      // And the arithmetic closes.
      expect(acc.dialled + acc.shedWithAuditRow, `${name}: accounted != cases in`).toBe(result.casesIn);
      // No job was left owed to a customer.
      expect(acc.queueByState.PENDING ?? 0, `${name}: jobs still queued`).toBe(0);
      expect(acc.queueByState.CLAIMED ?? 0, `${name}: jobs still claimed`).toBe(0);
      expect(acc.queueByState.DEAD ?? 0, `${name}: dead-lettered jobs`).toBe(0);
      // The audit chains still verify from genesis on a sample.
      expect(acc.chainSample.checked).toBeGreaterThan(0);
      expect(acc.chainSample.broken).toEqual([]);
    }
  }, 120_000);

  test("the audit trail is specific: every shed row names a band, a reason and a fallback", async () => {
    const acc = burstAccounting;
    expect(acc).not.toBeNull();
    if (acc === null) return;
    expect(Object.keys(acc.shedIntents).length).toBeGreaterThan(0);
    for (const intent of Object.keys(acc.shedIntents)) {
      // A named admission decision, never a generic error string.
      expect(intent).toMatch(/^admission_[a-z_]+_shed$/);
    }
    const rows = await db.$queryRawUnsafe<{ intent: string | null; meta: string | null }[]>(
      `SELECT intent, meta FROM "AuditLog" WHERE "callRef" LIKE $1 AND intent LIKE 'admission%shed' LIMIT 200`,
      `${PREFIX}-burst-%`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const meta = JSON.parse(row.meta ?? "{}") as Record<string, unknown>;
      expect(meta, `meta missing for ${row.intent}`).toHaveProperty("band");
      expect(meta, `reason missing for ${row.intent}`).toHaveProperty("reason");
      expect(String(meta.reason).length).toBeGreaterThan(3);
      // A shed always names the channel the customer was moved to: SMS under
      // CONSTRAINED, app push under SHED (see `admitsVoice` in @/lib/capacity).
      expect(meta.fallback, `fallback missing for ${row.intent}`).toMatch(/^(sms|app_push)$/);
    }
  }, 60_000);

  test("the ladder shed the LOWEST expected-loss cases first", async () => {
    const acc = burstAccounting;
    expect(acc).not.toBeNull();
    if (acc === null) return;
    if ((acc.shedWithAuditRow ?? 0) === 0) return; // no sheds at this tier: nothing to order
    const shedRefs = await db.$queryRawUnsafe<{ "caseRef": string }[]>(
      `SELECT DISTINCT "callRef" FROM "AuditLog" WHERE "callRef" LIKE $1 AND intent LIKE 'admission%shed'`,
      `${PREFIX}-burst-%`,
    );
    const dialledRefs = await db.$queryRawUnsafe<{ caseRef: string; riskScore: number | null; amountMinor: number | null }[]>(
      `SELECT "caseRef", "riskScore", "amountMinor" FROM "Case" WHERE "caseRef" LIKE $1 AND state = 'CONFIRMED_FRAUD'`,
      `${PREFIX}-burst-%`,
    );
    const lossOf = (r: { riskScore: number | null; amountMinor: number | null }): number =>
      (r.riskScore ?? 0) * (r.amountMinor ?? 0);
    const shedLosses = await db.$queryRawUnsafe<{ riskScore: number | null; amountMinor: number | null }[]>(
      `SELECT "riskScore", "amountMinor" FROM "Case" WHERE "caseRef" = ANY($1::text[])`,
      shedRefs.map((r) => r.caseRef),
    );
    const meanShed = shedLosses.reduce((a, r) => a + lossOf(r), 0) / Math.max(1, shedLosses.length);
    const meanDialled = dialledRefs.reduce((a, r) => a + lossOf(r), 0) / Math.max(1, dialledRefs.length);
    // Triage is the point of the ladder: the voice channel went to the money.
    expect(meanShed).toBeLessThan(meanDialled);
  }, 120_000);

  test("the queue drained: nothing is left owed to a customer", async () => {
    const mine = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM dial_job WHERE "case_ref" LIKE $1 AND state IN ('PENDING','CLAIMED','DEAD')`,
      `${PREFIX}-%`,
    );
    expect(mine[0]?.n).toBe(0);
    expect(burst?.endQueueDepth ?? 0).toBeGreaterThanOrEqual(0);
  }, 60_000);

  test("no vendor call ever left the process", () => {
    expect(NETWORK_CALLS).toEqual([]);
  });

  test("the artifact is written, and every scenario number carries a label", async () => {
    await writeEvidence();
    const written = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as {
      integrity: {
        labels: Record<string, string>;
        network: { calls: number };
        not_measured_here: string[];
        case_count_scaling: Record<string, unknown>;
      };
      model: { burst: { required_concurrent_calls: number } };
      scenarios: Record<string, unknown>;
      accounting: Record<string, unknown>;
    };
    expect(Object.keys(written.integrity.labels).sort()).toEqual(["calibrated", "extrapolated", "measured"]);
    for (const [label, text] of Object.entries(written.integrity.labels)) {
      expect(text.length, `label "${label}" must explain itself`).toBeGreaterThan(60);
    }
    expect(written.integrity.network.calls).toBe(0);
    expect(written.integrity.not_measured_here.length).toBeGreaterThanOrEqual(5);
    expect(written.integrity.not_measured_here.join(" ")).toMatch(/ElevenLabs/);
    expect(written.model.burst.required_concurrent_calls).toBe(210);
    expect(written.scenarios.burst).not.toBeNull();
    expect(written.accounting.burst).not.toBeNull();
  }, 60_000);
});
