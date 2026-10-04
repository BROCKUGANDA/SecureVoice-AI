import "server-only";
/**
 * Tamper-evident audit chain for call records. Every agent turn + TTS + ASR
 * appends one row with chainHash = sha256(prevHash || canonicalRow). Any
 * later modification to a row breaks the chain at that point onward, which
 * `verifyChain()` detects and reports with the exact broken row id.
 *
 * Why a hash chain rather than just timestamps:
 *   - A timestamp can be edited after the fact; a hash chain cannot — you'd
 *     have to recompute every subsequent hash, which the database constraints
 *     (chainHash @unique) make detectable.
 *   - CBUAE Consumer Protection + UAE PDPL both expect an immutable record of
 *     AI-driven customer interaction; a hash-chained log is the standard
 *     evidence-of-record mechanism.
 *
 * Storage: lives in `AuditLog` (Prisma) — see prisma/schema.prisma.
 */

import { createHash } from "node:crypto";
import { dbAudit } from "@/lib/db";
import { notifyRealtime } from "@/lib/realtime";

const GENESIS_HASH = "0".repeat(64); // SHA-256 of empty; anchors the chain

export type AuditEntry = {
  callRef: string;
  action: "tts" | "asr" | "agent" | "freeze" | "handoff" | "consent";
  intent?: string;
  callerId?: string;
  redactedText?: string;
  meta?: Record<string, unknown>;
  orgId?: string; // organization scoping — sealed into the chain like any other field
};

/** Cap + sanitize an untrusted caller-supplied key. Prevents oversized or
 *  control-character-laden refs from entering the chain (and the DB unique index). */
function safeKey(v: string | undefined, max: number): string | undefined {
  if (!v) return undefined;
  return v.replace(/[^\w.:-]/g, "").slice(0, max) || undefined;
}

function sanitize(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    callRef: safeKey(entry.callRef, 64) ?? "SV-UNKNOWN",
    action: entry.action,
    intent: safeKey(entry.intent, 40),
    callerId: safeKey(entry.callerId, 64),
    redactedText: entry.redactedText?.slice(0, 500),
    orgId: safeKey(entry.orgId, 64),
  };
}

function canonical(row: AuditEntry & { prevHash: string }): string {
  // Deterministic JSON: sort keys so hash stays stable across process restarts.
  // NOTE: meta must be a real object here, not a JSON-stringified string, so
  // append() and verifyChain() canonicalize the same bytes. We serialize the
  // object representation; storage as a string is the DB layer's concern.
  return JSON.stringify(row, Object.keys(row).sort());
}

function chainHash(prev: string, row: AuditEntry): string {
  return createHash("sha256")
    .update(prev)
    .update("\n")
    .update(canonical({ ...row, prevHash: prev }))
    .digest("hex");
}

/**
 * Per-callRef append mutex. append() is read-last-hash → compute → create;
 * two concurrent appends for the SAME callRef could otherwise read the same
 * prevHash and fork the chain. Serializing them per callRef (single-node
 * deployment) removes the race without a DB round-trip per insert. The map is
 * bounded + swept so an attacker cycling refs cannot grow it unboundedly.
 */
const CHAIN_LOCKS = new Map<string, Promise<unknown>>();
const CHAIN_LOCKS_MAX = 5_000;
const CHAIN_LOCKS_SWEEP_EVERY = 256;
let lockCalls = 0;

/** Track settled state on a WeakSet so we never mutate the promise object. */
const settledLocks = new WeakSet<Promise<unknown>>();

async function withChainLock<T>(callRef: string, fn: () => Promise<T>): Promise<T> {
  // Periodic sweep: drop settled locks so the map stays bounded.
  if (++lockCalls >= CHAIN_LOCKS_SWEEP_EVERY) {
    lockCalls = 0;
    if (CHAIN_LOCKS.size > CHAIN_LOCKS_MAX) {
      for (const [k, p] of CHAIN_LOCKS) {
        if (settledLocks.has(p)) CHAIN_LOCKS.delete(k);
      }
      // Still over cap (sustained unique-ref flood), drop the oldest half.
      if (CHAIN_LOCKS.size > CHAIN_LOCKS_MAX) {
        const sorted = [...CHAIN_LOCKS.keys()];
        for (let i = 0; i < Math.ceil(sorted.length / 2); i++) {
          // `i < ceil(len/2)` is at most `len`, so the index always exists.
          const oldest = sorted[i]!;
          CHAIN_LOCKS.delete(oldest);
        }
      }
    }
  }

  const prev = CHAIN_LOCKS.get(callRef) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tracked = run.finally(() => {
    settledLocks.add(tracked);
  });
  CHAIN_LOCKS.set(callRef, tracked);
  return run;
}

/** Append a new entry to the audit chain (serialized per callRef). */
export async function append(
  entry: AuditEntry,
  opts?: { fast?: boolean },
): Promise<{ id: string; chainHash: string }> {
  const clean = sanitize(entry);
  // Concurrency limiter: fire-and-forget appends must never starve the hot
  // path (the combined idempotency+consent check) of a pool connection. At
  // most MAX_CONCURRENT_APPENDS run at once; the rest queue. This bounds the
  // audit chain's share of the pool so the synchronous path always gets a
  // connection within the latency budget.
  await acquireAppendSlot();
  try {
    return await appendInner(clean, opts?.fast ?? false);
  } finally {
    releaseAppendSlot();
  }
}

const MAX_CONCURRENT_APPENDS = 5;
let activeAppends = 0;
const appendQueue: (() => void)[] = [];

function acquireAppendSlot(): Promise<void> {
  if (activeAppends < MAX_CONCURRENT_APPENDS) {
    activeAppends++;
    return Promise.resolve();
  }
  return new Promise((resolve) => appendQueue.push(resolve));
}

function releaseAppendSlot(): void {
  activeAppends--;
  const next = appendQueue.shift();
  if (next) {
    activeAppends++;
    next();
  }
}

async function appendInner(
  clean: AuditEntry,
  fast: boolean,
): Promise<{ id: string; chainHash: string }> {
  const row = await withChainLock(clean.callRef, async () => {
    if (fast) {
      // Fast path: no $transaction. For fire-and-forget appends where the
      // callRef is unique per request (e.g. a fraud case), there is no
      // cross-writer contention on the chain head — the in-process lock above
      // serialises same-ref appends, and different refs never collide. This
      // avoids the dedicated connection a $transaction requires, which is the
      // difference between a 200 ms append and a 5 s timeout against a remote
      // pooler under burst load.
      const last = await dbAudit.auditLog.findFirst({
        where: { callRef: clean.callRef },
        orderBy: { createdAt: "desc" },
        select: { chainHash: true },
      });
      const prevHash = last?.chainHash ?? GENESIS_HASH;
      const canonicalMeta = clean.meta ? canonicalizeNested(clean.meta) : undefined;
      const hash = chainHash(prevHash, {
        ...clean,
        meta: canonicalMeta as unknown as Record<string, unknown> | undefined,
      });
      return dbAudit.auditLog.create({
        data: {
          callRef: clean.callRef,
          action: clean.action,
          intent: clean.intent,
          callerId: clean.callerId,
          redactedText: clean.redactedText,
          meta: canonicalMeta,
          orgId: clean.orgId,
          prevHash,
          chainHash: hash,
        },
        select: { id: true, chainHash: true },
      });
    }
    // The read-then-write is intrinsic to a hash chain (each row commits the
    // previous row's hash), but it does NOT need two separate transactions.
    // Running both statements in ONE transaction is both cheaper and strictly
    // safer: the chain head can never be read outside the write that extends
    // it. Measured 6 -> 4 round trips against a remote PgBouncer, which is the
    // dominant cost of a tool call (see docs/SUBMISSION.md, tool-call latency).
    return dbAudit.$transaction(async (tx) => {
      // DB-level chain lock: serialize appends per callRef across ALL writers,
      // not just this process. The in-process mutex above is only a fast path —
      // a second replica (or worker) would otherwise read the same prevHash and
      // fork the chain, which verifyChain() then reports as tampering.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${clean.callRef}))`;
      const last = await tx.auditLog.findFirst({
        where: { callRef: clean.callRef },
        orderBy: { createdAt: "desc" },
        select: { chainHash: true },
      });
      const prevHash = last?.chainHash ?? GENESIS_HASH;
      // Compute the canonical form of meta ONCE — sort nested keys — then use the
      // SAME bytes for hashing AND storage. verifyChain() reads meta verbatim and
      // passes it through, so the chain stays consistent across writes and reads.
      const canonicalMeta = clean.meta ? canonicalizeNested(clean.meta) : undefined;
      const hash = chainHash(prevHash, {
        ...clean,
        meta: canonicalMeta as unknown as Record<string, unknown> | undefined,
      });
      return tx.auditLog.create({
        data: {
          callRef: clean.callRef,
          action: clean.action,
          intent: clean.intent,
          callerId: clean.callerId,
          redactedText: clean.redactedText,
          meta: canonicalMeta,
          orgId: clean.orgId,
          prevHash,
          chainHash: hash,
        },
        select: { id: true, chainHash: true },
      });
    });
  });

  // Push to the Command Center AFTER the chain write has committed, and outside
  // the transaction: a websocket fan-out must not be able to hold a database
  // transaction open, lengthen the write, or fail it. notifyRealtime() never
  // rejects — if the realtime service is down the console falls back to SSE and
  // this record is unaffected.
  void notifyRealtime({
    orgId: clean.orgId,
    callRef: clean.callRef,
    payload: {
      id: row.id,
      action: clean.action,
      intent: clean.intent ?? null,
      chainHash: row.chainHash,
      ts: new Date().toISOString(),
    },
  });

  return row;
}

/** Recursively sort keys at every depth. */
function canonicalizeNested(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalizeNested).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeNested(obj[k])).join(",") + "}"
  );
}

export type ChainVerification =
  | { ok: true; rows: number }
  | { ok: false; brokenAt: string; expected: string; actual: string; rows: number };

/**
 * Walk a call's audit chain by FOLLOWING the prev-hash links (genesis → each
 * child), not by createdAt order — two rows can share a millisecond timestamp,
 * which makes timestamp-ordered verification ambiguous. Also detects a fork
 * (two rows claiming the same prevHash) and orphaned rows that hang off no
 * link in the chain.
 */
export async function verifyChain(
  callRef: string,
  orgId: string | null | undefined,
): Promise<ChainVerification> {
  const rows = await dbAudit.auditLog.findMany({
    where: { callRef, ...(orgId ? { orgId } : { OR: [{ orgId: null }, { orgId: "default" }] }) },
  });
  // index rows by the prev-hash they claim to extend
  const byPrev = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.prevHash ?? GENESIS_HASH;
    const bucket = byPrev.get(key);
    if (bucket) bucket.push(row);
    else byPrev.set(key, [row]);
  }

  let prev = GENESIS_HASH;
  const visited = new Set<string>();
  for (;;) {
    const candidates = byPrev.get(prev);
    if (!candidates || candidates.length === 0) break;
    if (candidates.length > 1) {
      // fork: two rows extend the same link - the chain is ambiguous/broken.
      // `length > 1` proves index 1 exists.
      const fork = candidates[1]!;
      return {
        ok: false,
        brokenAt: fork.id,
        expected: fork.prevHash ?? GENESIS_HASH,
        actual: fork.chainHash,
        rows: rows.length,
      };
    }
    // The two guards above leave exactly one candidate, so index 0 exists.
    const row = candidates[0]!;
    // The `meta` column is stored as a JSON STRING (per append() above). We
    // canonicalize it back as that same string so the hash matches. If we
    // JSON.parse(row.meta) and let the serializer re-stringify, the bytes
    // change (escaping, whitespace, key order) and every chain link breaks.
    const expected = chainHash(prev, {
      callRef: row.callRef,
      action: row.action as AuditEntry["action"],
      intent: row.intent ?? undefined,
      callerId: row.callerId ?? undefined,
      redactedText: row.redactedText ?? undefined,
      meta: (row.meta ?? undefined) as unknown as Record<string, unknown> | undefined,
      orgId: (row as { orgId?: string | null }).orgId ?? undefined,
    });
    if (row.chainHash !== expected) {
      return { ok: false, brokenAt: row.id, expected, actual: row.chainHash, rows: rows.length };
    }
    prev = row.chainHash;
    visited.add(row.id);
  }

  if (visited.size !== rows.length) {
    // rows exist that no chain link reaches (planted/spliced record)
    const orphan = rows.find((r) => !visited.has(r.id));
    return {
      ok: false,
      // Reaching here with `visited.size !== rows.length` proves `rows` is
      // non-empty, so the fallback index exists.
      brokenAt: orphan?.id ?? rows[0]!.id,
      expected: prev,
      actual: "orphaned row",
      rows: rows.length,
    };
  }
  return { ok: true, rows: rows.length };
}
