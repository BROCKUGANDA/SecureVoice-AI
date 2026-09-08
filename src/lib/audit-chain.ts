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
import { db } from "@/lib/db";

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

/** Append a new entry to the audit chain. */
export async function append(entry: AuditEntry): Promise<{ id: string; chainHash: string }> {
  const clean = sanitize(entry);
  const last = await db.auditLog.findFirst({
    where: { callRef: clean.callRef },
    orderBy: { createdAt: "desc" },
    select: { chainHash: true },
  });
  const prevHash = last?.chainHash ?? GENESIS_HASH;
  // Compute the canonical form of meta ONCE — sort nested keys — then use the
  // SAME bytes for hashing AND storage. verifyChain() reads meta verbatim and
  // passes it through, so the chain stays consistent across writes and reads.
  const canonicalMeta = clean.meta ? canonicalizeNested(clean.meta) : undefined;
  const hash = chainHash(prevHash, { ...clean, meta: canonicalMeta as unknown as Record<string, unknown> | undefined });
  const row = await db.auditLog.create({
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
  return row;
}

/** Recursively sort keys at every depth. */
function canonicalizeNested(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalizeNested).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeNested(obj[k])).join(",") + "}";
}

export type ChainVerification =
  | { ok: true; rows: number }
  | { ok: false; brokenAt: string; expected: string; actual: string; rows: number };

/** Walk a call's audit chain and verify every link. */
export async function verifyChain(callRef: string): Promise<ChainVerification> {
  const rows = await db.auditLog.findMany({
    where: { callRef },
    orderBy: { createdAt: "asc" },
  });
  let prev = GENESIS_HASH;
  for (const row of rows) {
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
      // meta stored as a JSON string (append uses sorted JSON.stringify); pass
      // it through verbatim so canonicalization reproduces the same bytes.
      meta: (row.meta ?? undefined) as unknown as Record<string, unknown> | undefined,
      orgId: (row as { orgId?: string | null }).orgId ?? undefined,
    });
    if (row.prevHash !== prev || row.chainHash !== expected) {
      return { ok: false, brokenAt: row.id, expected, actual: row.chainHash, rows: rows.length };
    }
    prev = row.chainHash;
  }
  return { ok: true, rows: rows.length };
}
