import "server-only";
/**
 * Append-only usage ledger (WP-13).
 *
 * There is deliberately **no mutable credits column** here — unlike
 * `src/lib/credits.ts`, which keeps `UserProfile.credits` and decrements it.
 * Every balance in this module is a SUM over rows, so the balance cannot drift
 * away from the events that produced it and every movement is attributable to
 * a case attempt.
 *
 * ## The five kinds and what each one means
 *
 * Callers pass a MAGNITUDE; the ledger stores the SIGNED delta, matching the
 * column contract in `prisma/schema.prisma` ("reserve/consume/topup positive,
 * release/refund negative"). A single row therefore moves four aggregates:
 *
 *   kind      stored    wallet  held   (weights applied to the stored value)
 *   topup      +N       +N      0      money received, units added
 *   refund     -N       -N      0      money returned, units removed
 *   reserve    +E        0     +E      dial-time hold taken on units
 *   release    -R        0     -R      hold dissolved (unused estimate returned)
 *   consume    +A       -A     -A      settled actual usage: hold becomes spend
 *
 *   posted    = SUM(units)                  the signed journal total
 *   wallet    = SUM(wallet weight x units)  topup - consume - refund
 *   held      = SUM(held   weight x units)  reserve - release - consume
 *   available = wallet - held                <- the number callers check
 *
 * A settled call therefore nets out exactly: topup 1000, reserve 30, consume
 * 12, release 18 => posted +1018, wallet 988, held 0, available 988.
 * Spent exactly 12.
 *
 * ## Concurrency: no oversell, ever
 *
 * `reserve()` runs inside an interactive transaction that first takes
 * `pg_advisory_xact_lock(hashtext('ledger:' || orgId))`. Every writer for one
 * organisation is therefore serialised *by the database*, not by a promise in
 * one Node process — 100 concurrent dials on one org cannot interleave their
 * read-balance / check / write. Inside that lock the insert is
 * `INSERT ... ON CONFLICT ("idemKey") DO NOTHING`, so the UNIQUE index — not
 * the retry logic — is what makes a replayed webhook idempotent. (A Prisma
 * `create` would raise P2002 and poison the open transaction, so the raw
 * conflict-clause insert is required, not stylistic.)
 *
 * ## Money
 *
 * Every amount is an INTEGER minor unit. There are no floats in this file and
 * `assertInt` refuses one at the boundary rather than rounding it silently.
 */

import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

export const LEDGER_KINDS = ["topup", "reserve", "consume", "release", "refund"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export type LedgerEntry = {
  id: string;
  orgId: string | null;
  caseRef: string | null;
  attemptNo: number;
  kind: string;
  units: number;
  reason: string | null;
  idemKey: string;
  balanceAfter: number | null;
  createdAt: Date;
};

/**
 * The sign each kind is STORED with. Callers pass a MAGNITUDE; the ledger
 * stores the signed delta, exactly as `prisma/schema.prisma` documents it:
 * "reserve/consume/topup positive, release/refund negative".
 *
 * That means `SUM("units")` is a meaningful signed journal total rather than a
 * pile of magnitudes — which is what makes invariant I-8 checkable against the
 * raw column.
 */
const STORE_SIGN: Record<LedgerKind, 1 | -1> = {
  topup: 1,
  reserve: 1,
  consume: 1,
  release: -1,
  refund: -1,
};

/** Weight of each kind's stored value in `wallet` (prepaid, money-backed value). */
const WALLET_WEIGHT: Record<LedgerKind, 1 | -1 | 0> = {
  topup: 1,
  reserve: 0,
  consume: -1,
  release: 0,
  refund: 1,
};

/** Weight of each kind's stored value in `held` (outstanding holds). */
const HELD_WEIGHT: Record<LedgerKind, 1 | -1 | 0> = {
  topup: 0,
  reserve: 1,
  consume: -1,
  release: 1,
  refund: 0,
};

/**
 * Weight in `available` — stated explicitly rather than derived so the identity
 * `available === wallet - held` is provable by inspection:
 *   topup 1-0=1 · reserve 0-1=-1 · consume -1-(-1)=0 · release 0-1=-1 · refund 1-0=1
 */
const AVAILABLE_WEIGHT: Record<LedgerKind, 1 | -1 | 0> = {
  topup: 1,
  reserve: -1,
  consume: 0,
  release: -1,
  refund: 1,
};

export type LedgerSnapshot = {
  orgId: string;
  /** Raw SUM(units) — the signed journal total. */
  posted: number;
  /** Money-backed prepaid value: topup - consume - refund. */
  wallet: number;
  /** Outstanding holds: reserve - release - consume. Never negative. */
  held: number;
  /** wallet - held. The number every caller checks; may never go negative. */
  available: number;
  rows: number;
};

export type LedgerRefusal =
  "insufficient_available" | "insufficient_hold" | "insufficient_wallet" | "unknown_kind";

export type LedgerWrite =
  | { ok: true; duplicate: boolean; entry: LedgerEntry; snapshot: LedgerSnapshot }
  | { ok: false; reason: LedgerRefusal; snapshot: LedgerSnapshot };

// ── boundaries ────────────────────────────────────────────────────────────────

/** Money and units are integers. A float here is a bug, not a rounding case. */
function assertInt(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer minor-unit value (got ${String(value)})`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} exceeds the safe integer range`);
  }
  return value;
}

function assertOrgId(orgId: string): string {
  if (typeof orgId !== "string" || orgId.trim() === "") {
    throw new TypeError("orgId is required");
  }
  return orgId.trim();
}

/**
 * Row id: a LEXICOGRAPHICALLY SORTABLE key — the post-lock timestamp, then a
 * per-process sequence, then noise.
 *
 * This is load-bearing. `reconcile()` reconstructs every row's `balanceAfter` by
 * walking rows newest-first and ordering by `(createdAt, id)`. Two writers can
 * legitimately land in the same millisecond, so `createdAt` alone is not a total
 * order — but the writers are serialised by the advisory lock, and `seq`
 * increments in lock-acquisition order, so `(createdAt, id)` reproduces the true
 * commit order exactly. A random (uuid v4) id would make the tie-break a coin
 * flip and the chain check would report a phantom break.
 */
let seq = 0;
function newLedgerId(now: Date): string {
  seq = (seq + 1) % 1_000_000;
  const t = now.getTime().toString(36).padStart(9, "0");
  const s = seq.toString(36).padStart(4, "0");
  const r = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  return `led_${t}${s}${r}`;
}

function assertKind(kind: string): LedgerKind {
  if (!(LEDGER_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`unknown ledger kind: ${kind}`);
  }
  return kind as LedgerKind;
}

/**
 * The case-scoped idempotency key: `{caseRef}:{attemptNo}:{kind}`. The UNIQUE
 * index on `idemKey` is the double-charge guarantee.
 */
export function ledgerIdemKey(caseRef: string, attemptNo: number, kind: LedgerKind): string {
  return `${caseRef}:${assertInt(attemptNo, "attemptNo")}:${kind}`;
}

/**
 * The org-scoped variant, for money movements that have no case attempt (a
 * top-up is not "for" a call). The provider event id is the dedupe token, so a
 * replayed provider webhook carrying the same event id writes exactly one row
 * even if it arrives with a fresh connection hours later.
 */
export function paymentIdemKey(orgId: string, kind: "topup" | "refund", eventId: string): string {
  return `${assertOrgId(orgId)}:0:${kind}:${eventId}`;
}

// ── aggregation ───────────────────────────────────────────────────────────────

function emptySnapshot(orgId: string): LedgerSnapshot {
  return { orgId, posted: 0, wallet: 0, held: 0, available: 0, rows: 0 };
}

function derive(orgId: string, byKind: { kind: string; units: number }[]): LedgerSnapshot {
  const snap = emptySnapshot(orgId);
  for (const row of byKind) {
    const kind = assertKind(row.kind);
    const stored = row.units; // already signed in the database
    snap.posted += stored;
    snap.wallet += WALLET_WEIGHT[kind] * stored;
    snap.held += HELD_WEIGHT[kind] * stored;
    snap.rows += 1;
  }
  snap.available = snap.wallet - snap.held;
  return snap;
}

/**
 * Append to the ledger INSIDE a caller's transaction.
 *
 * `topup()` and friends open their own transaction, so calling one from inside
 * another `$transaction` means two independent transactions: if the inner one
 * commits and the outer one rolls back, or the reverse, the credit and the row
 * that justifies it disagree. Nothing in this file can fix that on its own —
 * the caller has to hand us its transaction — so this is the seam it uses.
 *
 * The advisory lock is still taken here, so serialisation is unchanged.
 */
export async function appendInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string;
    units: number;
    eventId: string;
    reason?: string;
  },
): Promise<LedgerWrite> {
  return appendTx(tx, {
    orgId: assertOrgId(input.orgId),
    caseRef: null,
    attemptNo: 0,
    kind: "topup",
    units: assertInt(input.units, "units"),
    reason: input.reason ?? null,
    idemKey: `topup:${input.eventId}`,
  });
}

/** Same seam for refunds (a signed debit against an existing credit). */
export async function refundInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string;
    units: number;
    eventId: string;
    reason?: string;
  },
): Promise<LedgerWrite> {
  return appendTx(tx, {
    orgId: assertOrgId(input.orgId),
    caseRef: null,
    attemptNo: 0,
    kind: "refund",
    units: assertInt(input.units, "units"),
    reason: input.reason ?? null,
    idemKey: `refund:${input.eventId}`,
  });
}

/** Anything that can run a tagged SQL query: the client or a transaction. */
type Queryable = Pick<Prisma.TransactionClient, "$queryRaw">;

async function snapshotIn(tx: Queryable, orgId: string): Promise<LedgerSnapshot> {
  const rows = await tx.$queryRaw<{ kind: string; units: number }[]>`
    SELECT "kind", COALESCE(SUM("units"), 0)::int AS "units"
      FROM "UsageLedger"
     WHERE "orgId" = ${orgId}
     GROUP BY "kind"
  `;
  return derive(orgId, rows);
}

/**
 * The live balance, derived purely from the ledger (invariant I-8). No cached
 * column is consulted, so this cannot be wrong except if a row was deleted.
 */
export async function balance(orgId: string): Promise<number> {
  const snap = await snapshot(orgId);
  return snap.available;
}

/** Full aggregate view: wallet, held, available and the raw posted sum. */
export async function snapshot(orgId: string): Promise<LedgerSnapshot> {
  return snapshotIn(db, assertOrgId(orgId));
}

/** Raw SUM(units) — the journal total, no kind weighting. */
export async function ledgerSum(orgId: string): Promise<number> {
  const row = await db.$queryRaw<{ total: number }[]>`
    SELECT COALESCE(SUM("units"), 0)::int AS "total" FROM "UsageLedger" WHERE "orgId" = ${assertOrgId(orgId)}
  `;
  return row[0]?.total ?? 0;
}

// ── writes ────────────────────────────────────────────────────────────────────

type AppendInput = {
  orgId: string;
  caseRef: string | null;
  attemptNo: number;
  kind: LedgerKind;
  /** A positive MAGNITUDE. The signed delta written to the row is derived from
   *  `STORE_SIGN`; callers never pass a negative amount for a debit. */
  units: number;
  reason: string | null;
  idemKey: string;
  force?: boolean;
};

/** The guard a kind must satisfy, as a named pool + amount. */
function guardFor(input: {
  kind: LedgerKind;
  units: number;
}): { pool: "available" | "held" | "wallet"; units: number } | null {
  const n = Math.abs(input.units);
  switch (input.kind) {
    // May only hold units that are actually free. This is the no-oversell rule.
    case "reserve":
      return { pool: "available", units: n };
    // Consuming or releasing more than is held would drive `held` negative and
    // silently inflate `available` — i.e. re-open the oversell hole.
    case "consume":
    case "release":
      return { pool: "held", units: n };
    // Never refund more prepaid value than exists.
    case "refund":
      return { pool: "wallet", units: n };
    case "topup":
      return null;
  }
}

async function append(input: AppendInput): Promise<LedgerWrite> {
  // 100 concurrent reservations each need a pooled connection while they queue
  // on the advisory lock; the 2 s/5 s defaults are too tight for that.
  return db.$transaction((tx) => appendTx(tx, input), { maxWait: 30_000, timeout: 30_000 });
}

/**
 * The single writer for the ledger, parameterised by the transaction it runs
 * in. Both the standalone `topup()`/`reserve()` path and the caller-supplied
 * transaction path go through here, so there is exactly one implementation of
 * "append a movement" and no way for the two to drift.
 */
async function appendTx(tx: Prisma.TransactionClient, input: AppendInput): Promise<LedgerWrite> {
  {
    // Serialise every writer for this organisation inside the database. A
    // single-process promise chain would not survive two app instances.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ledger:${input.orgId}`}))`;

    const before = await snapshotIn(tx, input.orgId);

    // Idempotent replay short-circuits BEFORE the guard. A retried webhook
    // re-offers the exact movement that already landed; it must be answered
    // with the original result, not refused for lack of funds it never
    // needed. (Reserve-then-refill-then-retry is the shape that would
    // otherwise credit correctly but report a spurious failure.)
    const replay = await tx.usageLedger.findUnique({
      where: { idemKey: input.idemKey },
      select: {
        id: true,
        orgId: true,
        caseRef: true,
        attemptNo: true,
        kind: true,
        units: true,
        reason: true,
        idemKey: true,
        balanceAfter: true,
        createdAt: true,
      },
    });
    if (replay) {
      return { ok: true as const, duplicate: true, entry: replay, snapshot: before };
    }

    const guard = guardFor({ kind: input.kind, units: input.units });
    if (guard && !input.force) {
      const pool = before[guard.pool];
      if (pool < guard.units) {
        return {
          ok: false as const,
          reason: (guard.pool === "available"
            ? "insufficient_available"
            : guard.pool === "held"
              ? "insufficient_hold"
              : "insufficient_wallet") as LedgerRefusal,
          snapshot: before,
        };
      }
    }

    // createdAt is stamped here, AFTER the lock is held. Postgres' now() is
    // the *transaction* timestamp, which can predate a writer that already
    // serialised ahead of us; the application clock at lock-acquisition time
    // is the true commit order, which the chain check in reconcile() relies on.
    const now = new Date();
    // Callers pass a magnitude; the ledger stores the signed delta.
    const stored = STORE_SIGN[input.kind] * input.units;
    const balanceAfter = before.available + deltaAvailable(input.kind, stored);

    const inserted = await tx.$queryRaw<LedgerEntry[]>`
        INSERT INTO "UsageLedger"
          ("id", "orgId", "caseRef", "attemptNo", "kind", "units", "reason", "idemKey", "balanceAfter", "createdAt")
        VALUES (${newLedgerId(now)}, ${input.orgId}, ${input.caseRef}, ${input.attemptNo},
                ${input.kind}, ${stored}, ${input.reason}, ${input.idemKey}, ${balanceAfter}, ${now})
        ON CONFLICT ("idemKey") DO NOTHING
        RETURNING "id", "orgId", "caseRef", "attemptNo", "kind", "units", "reason", "idemKey", "balanceAfter", "createdAt"
      `;

    if (inserted.length === 1) {
      return {
        ok: true as const,
        duplicate: false,
        // `inserted.length === 1` is the guard that proves element 0 exists; the
        // assertion records that for the checker rather than adding a dead
        // branch. (Zero rows falls through to the ON CONFLICT path below.)
        entry: inserted[0]!,
        snapshot: afterSnapshot(before, input.kind, stored),
      };
    }

    // ON CONFLICT DO NOTHING fired: this exact movement already exists. The
    // unique index — not this code path — is what made it idempotent.
    const existing = await tx.usageLedger.findUnique({
      where: { idemKey: input.idemKey },
      select: {
        id: true,
        orgId: true,
        caseRef: true,
        attemptNo: true,
        kind: true,
        units: true,
        reason: true,
        idemKey: true,
        balanceAfter: true,
        createdAt: true,
      },
    });
    if (!existing) {
      // Unreachable while the row is invisible to us (a concurrent uncommitted
      // writer on the same org cannot exist — the lock serialises them).
      throw new Error("ledger: idempotency conflict but no row found");
    }
    return { ok: true as const, duplicate: true, entry: existing, snapshot: before };
  }
}

/** Change a single stored row makes to `available`. */
function deltaAvailable(kind: LedgerKind, stored: number): number {
  return AVAILABLE_WEIGHT[kind] * stored;
}

function afterSnapshot(before: LedgerSnapshot, kind: LedgerKind, stored: number): LedgerSnapshot {
  const wallet = before.wallet + WALLET_WEIGHT[kind] * stored;
  const held = before.held + HELD_WEIGHT[kind] * stored;
  return {
    orgId: before.orgId,
    posted: before.posted + stored,
    wallet,
    held,
    available: wallet - held,
    rows: before.rows + 1,
  };
}

/** Dial time: hold the estimate. Refused when it would oversell. */
export async function reserve(input: {
  orgId: string;
  caseRef: string;
  attemptNo?: number;
  unitsEstimate: number;
  reason?: string;
  force?: boolean;
}): Promise<LedgerWrite> {
  const orgId = assertOrgId(input.orgId);
  const attemptNo = input.attemptNo ?? 1;
  const units = assertInt(input.unitsEstimate, "unitsEstimate");
  if (units <= 0) throw new RangeError("unitsEstimate must be positive");
  return append({
    orgId,
    caseRef: input.caseRef,
    attemptNo,
    kind: "reserve",
    units,
    reason: input.reason ?? null,
    idemKey: ledgerIdemKey(input.caseRef, attemptNo, "reserve"),
    force: input.force,
  });
}

/** Post-call: settle the ACTUAL usage. Converts held units into spent units. */
export async function consume(input: {
  orgId: string;
  caseRef: string;
  attemptNo?: number;
  unitsActual: number;
  reason?: string;
  force?: boolean;
}): Promise<LedgerWrite> {
  const orgId = assertOrgId(input.orgId);
  const attemptNo = input.attemptNo ?? 1;
  const units = assertInt(input.unitsActual, "unitsActual");
  if (units < 0) throw new RangeError("unitsActual may not be negative");
  return append({
    orgId,
    caseRef: input.caseRef,
    attemptNo,
    kind: "consume",
    units,
    reason: input.reason ?? null,
    idemKey: ledgerIdemKey(input.caseRef, attemptNo, "consume"),
    force: input.force,
  });
}

/** Post-call: give back the unused part of the estimate. */
export async function release(input: {
  orgId: string;
  caseRef: string;
  attemptNo?: number;
  units: number;
  reason?: string;
  force?: boolean;
}): Promise<LedgerWrite> {
  const orgId = assertOrgId(input.orgId);
  const attemptNo = input.attemptNo ?? 1;
  const units = assertInt(input.units, "release.units");
  if (units < 0) throw new RangeError("release.units may not be negative");
  return append({
    orgId,
    caseRef: input.caseRef,
    attemptNo,
    kind: "release",
    units,
    reason: input.reason ?? null,
    idemKey: ledgerIdemKey(input.caseRef, attemptNo, "release"),
    force: input.force,
  });
}

/** Money in. `eventId` is the provider's event id — the dedupe token. */
export async function topup(input: {
  orgId: string;
  units: number;
  eventId: string;
  reason?: string;
}): Promise<LedgerWrite> {
  const orgId = assertOrgId(input.orgId);
  const units = assertInt(input.units, "topup.units");
  if (units <= 0) throw new RangeError("topup.units must be positive");
  return append({
    orgId,
    caseRef: null,
    attemptNo: 0,
    kind: "topup",
    units,
    reason: input.reason ?? null,
    idemKey: paymentIdemKey(orgId, "topup", input.eventId),
  });
}

/** Money out. Refused when it would refund more than was ever paid in. */
export async function refund(input: {
  orgId: string;
  units: number;
  eventId: string;
  reason?: string;
  force?: boolean;
}): Promise<LedgerWrite> {
  const orgId = assertOrgId(input.orgId);
  const units = assertInt(input.units, "refund.units");
  if (units <= 0) throw new RangeError("refund.units must be positive");
  return append({
    orgId,
    caseRef: null,
    attemptNo: 0,
    kind: "refund",
    units,
    reason: input.reason ?? null,
    idemKey: paymentIdemKey(orgId, "refund", input.eventId),
    force: input.force,
  });
}

/**
 * Settle one dial attempt end to end: consume the ACTUAL usage, then release
 * the unused remainder of the estimate. Both writes are idempotent, so a
 * retried post-call webhook produces exactly one of each.
 *
 * Returns the two writes plus the per-attempt reconciliation.
 */
export async function settleAttempt(input: {
  orgId: string;
  caseRef: string;
  attemptNo?: number;
  unitsEstimate: number;
  unitsActual: number;
  reason?: string;
  force?: boolean;
}): Promise<{
  consume: LedgerWrite;
  release: LedgerWrite;
  snapshot: LedgerSnapshot;
  remainder: number;
}> {
  const estimate = assertInt(input.unitsEstimate, "unitsEstimate");
  const actual = assertInt(input.unitsActual, "unitsActual");
  const remainder = Math.max(0, estimate - actual);
  const consumeWrite = await consume({
    orgId: input.orgId,
    caseRef: input.caseRef,
    attemptNo: input.attemptNo,
    unitsActual: actual,
    reason: input.reason,
    force: input.force,
  });
  const releaseWrite = await release({
    orgId: input.orgId,
    caseRef: input.caseRef,
    attemptNo: input.attemptNo,
    units: remainder,
    reason: input.reason ? `${input.reason}:remainder` : "unused_estimate",
    force: input.force,
  });
  return {
    consume: consumeWrite,
    release: releaseWrite,
    snapshot: releaseWrite.ok ? releaseWrite.snapshot : consumeWrite.snapshot,
    remainder,
  };
}

/**
 * Integer-only duration -> units conversion for a post-call webhook.
 * `unitsPerSecond` is an integer rate, so the product stays integral and the
 * result is rounded to an integer — no float ever reaches the ledger.
 */
export function unitsForDurationMs(durationMs: number, unitsPerSecond: number): number {
  const ms = assertInt(durationMs, "durationMs");
  const rate = assertInt(unitsPerSecond, "unitsPerSecond");
  if (ms < 0) throw new RangeError("durationMs may not be negative");
  if (rate < 0) throw new RangeError("unitsPerSecond may not be negative");
  const product = ms * rate;
  if (!Number.isSafeInteger(product)) throw new RangeError("durationMs * unitsPerSecond overflows");
  return Math.floor((product + 500) / 1000);
}

// ── reconciliation ────────────────────────────────────────────────────────────

export type Reconciliation = {
  /** Invariant id this check exists to defend. */
  invariant: "I-8";
  ok: boolean;
  snapshot: LedgerSnapshot;
  /** Raw SUM(units). */
  ledgerSum: number;
  /** The value materialised at write time (latest balanceAfter), if any. */
  materialised: number | null;
  /** materialised - snapshot.available. Zero is the whole point. */
  drift: number | null;
  chain: {
    ok: boolean;
    rows: number;
    firstDriftRowId: string | null;
    firstDriftAt: number | null;
  };
  findings: string[];
};

/**
 * Prove invariant I-8: the balance a caller would be shown equals the sum of
 * the ledger, with no materialised column in between.
 *
 * Two independent checks:
 *
 *  1. **Drift** — the `balanceAfter` stamped on the newest row (the value the
 *     system believed at write time) against the live SUM. Pass `materialised`
 *     to compare some other cached number (an admin panel total, a legacy
 *     credits column) instead.
 *
 *  2. **Chain** — walk the rows newest-first, undoing each one's contribution.
 *     Every row's stored `balanceAfter` must equal the balance implied by the
 *     rows above it. This walks backwards so it is independent of any history
 *     that predates the first row we can see.
 */
export async function reconcile(
  orgId: string,
  opts: { materialised?: number | null } = {},
): Promise<Reconciliation> {
  const findings: string[] = [];
  const org = assertOrgId(orgId);

  const rows = await db.usageLedger.findMany({
    where: { orgId: org },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, kind: true, units: true, balanceAfter: true, createdAt: true },
  });
  const derived = derive(
    org,
    rows.map((r) => ({ kind: r.kind, units: r.units })),
  );

  // ── check 1: materialised value vs the live sum ──
  let materialised: number | null = null;
  if (opts.materialised !== undefined && opts.materialised !== null) {
    materialised = assertInt(opts.materialised, "materialised");
  } else {
    const newest = rows.find((r) => r.balanceAfter !== null);
    materialised = newest?.balanceAfter ?? null;
  }
  const drift = materialised === null ? null : materialised - derived.available;
  if (drift !== null && drift !== 0) {
    findings.push(`balance drift: materialised ${materialised} vs ledger ${derived.available}`);
  }

  // ── check 2: the per-row balanceAfter chain ──
  // Walk newest-first. `running` starts at the live balance, which IS the
  // balanceAfter of the newest row — so compare FIRST, then undo that row's
  // contribution to arrive at the balance the previous row must have recorded.
  let running = derived.available;
  let chainOk = true;
  let firstDriftRowId: string | null = null;
  let firstDriftAt: number | null = null;
  for (const row of rows) {
    if (row.balanceAfter !== null && row.balanceAfter !== running) {
      chainOk = false;
      firstDriftRowId = row.id;
      firstDriftAt = row.balanceAfter - running;
      findings.push(
        `chain break at ${row.id} (${row.kind}): recorded ${row.balanceAfter}, implied ${running}`,
      );
      break;
    }
    running -= deltaAvailable(assertKind(row.kind), row.units);
  }

  if (derived.held < 0)
    findings.push(`held is negative (${derived.held}): a hold was over-released`);
  if (derived.available < 0)
    findings.push(`available is negative (${derived.available}): oversold`);

  return {
    invariant: "I-8",
    ok: drift === 0 && chainOk && derived.held >= 0 && derived.available >= 0,
    snapshot: derived,
    ledgerSum: derived.posted,
    materialised,
    drift,
    chain: { ok: chainOk, rows: rows.length, firstDriftRowId, firstDriftAt },
    findings,
  };
}

/** Per-attempt view, for a case-level audit of the reserve/consume/release trio. */
export async function caseLedger(caseRef: string): Promise<LedgerEntry[]> {
  return db.usageLedger.findMany({
    where: { caseRef },
    orderBy: [{ attemptNo: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}
