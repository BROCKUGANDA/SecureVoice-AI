import "server-only";
/**
 * Crypto-shredding: a per-case data key, sealed payloads, and right-to-erasure
 * that survives an immutable audit log. WP-15.
 *
 * ── The tension this file exists to resolve ────────────────────────────────
 * A bank's DPO will ask the obvious question: "you keep a hash-chained,
 * append-only audit log forever — how can you honour a right to erasure?"
 * There are three ways to answer, and two of them are wrong:
 *
 *   WRONG  Delete or edit the audit rows. `AuditLog` rows are the chain's
 *          payload AND its links: `chainHash = sha256(prevHash ‖ canonicalRow)`
 *          where canonicalRow contains redactedText and meta. Mutating any
 *          chained field breaks every later link, so `verifyChain()` reports
 *          the break — and "repairing" it by recomputing the hashes is worse:
 *          a rewritten chain is indistinguishable from an untouched one, which
 *          is exactly the property the chain exists to provide. Erasure that
 *          buys privacy by destroying evidence is not erasure, it is a cover-up.
 *
 *   WRONG  Keep the plaintext because the log demands immutability. The log
 *          only commits to hashes *of* what was already written, and what is
 *          written is redacted at write time (`src/lib/redact.ts`). The chain is
 *          not a reason to keep personal data.
 *
 *   RIGHT  Two rules together, and they do not conflict:
 *            1. The audit chain never stores personal data in the first place —
 *               every audit row is PII-free by construction (I-10). Erasure
 *               therefore never has to touch a chained field.
 *            2. The one place personal data MUST survive for a while — the
 *               sealed case payload — is stored as CIPHERTEXT under a per-case
 *               data key. Erasure destroys the key. The ciphertext is inert,
 *               unrecoverable, and provably so: the key was random, per-case,
 *                   and derived from nothing else.
 *               The ciphertext row itself is chained, so it is not deleted; it
 *               becomes noise. That is the reconciliation, and it is a
 *               property of the data model rather than a promise.
 *
 * `eraseCase()` only ever APPENDS to the chain (`privacy_erasure_v1`) and only
 * ever mutates `Case` columns that no hash covers. Invariant I-6 — the chain
 * verifies from genesis after erasure — is asserted by
 * `tests/privacy/privacy.test.ts`, including a byte-level proof that every
 * pre-existing chained row is untouched.
 *
 * ── Why the erasure record is the interesting witness ─────────────────────
 * `erasedAt` and a NULL `dataKeyEnc` live in the same row the key lived in, so
 * a restored backup would resurrect the key. The appended `privacy_erasure_v1`
 * row does not: it lives in a different, append-only structure and commits to
 * the fact that the key was destroyed. That is why erasure is append-first and
 * never a silent update.
 *
 * ── Key hierarchy ─────────────────────────────────────────────────────────
 *   MASTER KEY   env PRIVACY_MASTER_KEY → AES-256-GCM KEK. Required, never
 *                defaulted: a published fallback would make every sealed
 *                payload decryptable from a database dump alone. Losing this
 *                key shreds every case (fail-closed, by design). Rotating it
 *                needs a re-wrap pass, which is NOT implemented here (see the
 *                WP-15 hand-off note).
 *   DATA KEY     32 random bytes per case, wrapped by the master key and stored
 *                in `Case.dataKeyEnc`. Never shared between cases, never derived
 *                from anything, so destroying one case's key is provably
 *                incapable of affecting another case.
 *   PAYLOAD      AES-256-GCM under the data key, with the caseRef bound in as
 *                additional authenticated data — a ciphertext lifted from one
 *                case cannot be replayed into another.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { append } from "@/lib/audit-chain";

// ── Envelope + policy constants ──────────────────────────────────────────────

/** The only environment variable this module reads. There is no fallback. */
export const MASTER_KEY_ENV = "PRIVACY_MASTER_KEY";

/** Wrapped data-key envelope prefix (versioned so a future KEK scheme can coexist). */
export const KEY_ENVELOPE_PREFIX = "svk1";
/** Sealed-payload envelope prefix. */
export const PAYLOAD_ENVELOPE_PREFIX = "svp1";

export const ALGORITHM = "AES-256-GCM" as const;

const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
/** Fixed salt: the passphrase branch is stretched with scrypt; the salt is a
 *  domain separator, not a secret (it is not attacker-chosen input). */
const KDF_SALT = "sv-privacy-kek-v1";
/** Passphrase stretching cost — one-off per process, memoised below. */
const KDF_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
/** A refusal, not a truncation: a sealed payload larger than this is a bug or an
 *  attack, and silently dropping part of a transcript would be worse than failing. */
export const MAX_SEALED_PAYLOAD_BYTES = 256 * 1024;

/** Audit intents this module appends. Named so retention and tests can find them. */
export const AUDIT_INTENT_SEALED = "payload_sealed_v1";
export const AUDIT_INTENT_ERASED = "privacy_erasure_v1";
export const AUDIT_INTENT_CASE_DELETED = "case_record_deleted_v1";

/**
 * `Case` columns that can hold personal data. Erasure clears ALL of them in one
 * transaction — a partial erasure is not erasure.
 */
export const CASE_PAYLOAD_COLUMNS = [
  "transcriptRedacted",
  "evaluationResults",
  "dataCollectionResults",
] as const;

export type CasePayloadColumn = (typeof CASE_PAYLOAD_COLUMNS)[number];

/**
 * Every `AuditLog` column is covered here because the honest statement is
 * stronger than the hashed set: `id`/`createdAt` are not in the canonical form,
 * but rewriting either still corrupts the ordering the chain walk relies on.
 * `src/lib/privacy/retention.ts` refuses retention mutations against this list.
 */
export const CHAIN_PROTECTED_COLUMNS = [
  "id",
  "callRef",
  "action",
  "intent",
  "callerId",
  "redactedText",
  "meta",
  "prevHash",
  "chainHash",
  "orgId",
  "createdAt",
] as const;

// ── Errors ────────────────────────────────────────────────────────────────────

/** The master key is not configured. Fail closed and say exactly which var. */
export class MasterKeyUnavailableError extends Error {
  constructor() {
    super(
      `${MASTER_KEY_ENV} is not set. Per-case data keys are wrapped by it, and there is deliberately no default: ` +
        `a fallback key would make every sealed payload decryptable from a database dump. ` +
        `Set ${MASTER_KEY_ENV} to 32 bytes as 64 hex chars, 32 bytes base64, or a passphrase (scrypt-stretched).`,
    );
    this.name = "MasterKeyUnavailableError";
  }
}

export class CaseNotFoundError extends Error {
  constructor(public readonly caseRef: string) {
    super(`Case not found: ${caseRef}`);
    this.name = "CaseNotFoundError";
  }
}

/** Base class: the payload cannot be produced. Callers must not fall back to a guess. */
export class PayloadUnavailableError extends Error {
  constructor(
    public readonly caseRef: string,
    message: string,
  ) {
    super(`${caseRef}: ${message}`);
    this.name = "PayloadUnavailableError";
  }
}

/** The key is gone — this is the normal, correct outcome after erasure. */
export class CaseErasedError extends PayloadUnavailableError {
  constructor(caseRef: string) {
    super(
      caseRef,
      "erased — the per-case data key was destroyed, so the ciphertext cannot be decrypted. " +
        "This is the intended state after eraseCase(), not a failure.",
    );
    this.name = "CaseErasedError";
  }
}

export class PayloadNotSealedError extends PayloadUnavailableError {
  constructor(caseRef: string) {
    super(
      caseRef,
      "no sealed payload exists for this case (sealCasePayload has not run, or the case holds no payload)",
    );
    this.name = "PayloadNotSealedError";
  }
}

export class PayloadUndecryptableError extends PayloadUnavailableError {
  constructor(caseRef: string, message: string) {
    super(caseRef, `ciphertext could not be decrypted: ${message}`);
    this.name = "PayloadUndecryptableError";
  }
}

export class PayloadTooLargeError extends Error {
  constructor(
    public readonly caseRef: string,
    public readonly bytes: number,
  ) {
    super(
      `Refusing to seal ${bytes} bytes for ${caseRef}: the limit is ${MAX_SEALED_PAYLOAD_BYTES}. ` +
        `A sealed payload is one audit row, and an unbounded one is a denial-of-service vector against the chain.`,
    );
    this.name = "PayloadTooLargeError";
  }
}

// ── Master key ───────────────────────────────────────────────────────────────

let cachedMaster: { raw: string; key: Buffer } | null = null;

/** True when a master key is configured. Never exposes the key itself. */
export function masterKeyConfigured(): boolean {
  return Boolean(process.env[MASTER_KEY_ENV]?.trim());
}

function decodeMasterKey(raw: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === DATA_KEY_BYTES) return decoded;
  }
  return scryptSync(raw, KDF_SALT, DATA_KEY_BYTES, KDF_OPTIONS);
}

/**
 * Resolve the key-encryption key. Memoised per raw value so a passphrase is
 * stretched once per process, not once per case.
 */
export function masterKey(): Buffer {
  const raw = process.env[MASTER_KEY_ENV]?.trim();
  if (!raw) throw new MasterKeyUnavailableError();
  if (cachedMaster && cachedMaster.raw === raw) return cachedMaster.key;
  const key = decodeMasterKey(raw);
  cachedMaster = { raw, key };
  return key;
}

/**
 * A non-reversible identifier for the loaded master key. Lets an operator
 * confirm WHICH key a process is using (after a rotation) without ever
 * logging the key or deriving anything from it.
 */
export function masterKeyFingerprint(): string {
  return createHash("sha256").update(masterKey()).digest("hex").slice(0, 16);
}

// ── AEAD primitives ──────────────────────────────────────────────────────────

type Envelope = { iv: string; tag: string; ct: string };
type RawEnvelope = { iv: Buffer; tag: Buffer; ct: Buffer };

function packEnvelope(prefix: string, raw: RawEnvelope): string {
  return [
    prefix,
    raw.iv.toString("base64"),
    raw.tag.toString("base64"),
    raw.ct.toString("base64"),
  ].join(".");
}

function parseEnvelope(value: string, prefix: string): Envelope {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== prefix) {
    throw new Error(`malformed ${prefix} envelope`);
  }
  const [, iv, tag, ct] = parts;
  if (!iv || !tag || !ct) throw new Error(`malformed ${prefix} envelope`);
  return { iv, tag, ct };
}

function seal(key: Buffer, aad: string, plaintext: Buffer): RawEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function open(key: Buffer, aad: string, envelope: Envelope): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]);
}

/** The data key is bound to its case: a wrapped key cannot be moved between cases. */
const keyWrapAad = (caseRef: string): string => `${KEY_ENVELOPE_PREFIX}|${caseRef}`;
/** The payload is bound to its case: a ciphertext cannot be replayed into another case. */
const payloadAad = (caseRef: string): string => `${PAYLOAD_ENVELOPE_PREFIX}|${caseRef}`;

/** Overwrite a key buffer in place. Node cannot promise the GC never copied it,
 *  so this is best-effort hygiene, not a guarantee — the real destruction is the
 *  UPDATE below that removes the only durable copy. */
function zeroize(buffer: Buffer | null | undefined): void {
  buffer?.fill(0);
}

/** Non-reversible, non-secret-dependent identifier for a stored wrapped key.
 *  Two cases with different fingerprints cannot share a key, because the wrap
 *  uses a fresh random IV per case. */
export function keyFingerprintOf(wrapped: string | null): string | null {
  if (!wrapped) return null;
  return createHash("sha256").update(`sv-key-fp:${wrapped}`).digest("hex").slice(0, 16);
}

/** True when two wrapped keys are the identical key material. Constant-time. */
export function sameWrappedKey(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ── Per-case data key ────────────────────────────────────────────────────────

export type CaseKey = { caseRef: string; fingerprint: string; created: boolean };

type WrappedCaseKey = { caseRef: string; wrapped: string; fingerprint: string; created: boolean };

/**
 * Return the case's wrapped data key, creating and storing it on first use.
 *
 * Race-safe without a lock: the UPDATE is conditional on the column still being
 * NULL, so the loser of a race re-reads and adopts the winner's key. A second
 * key for one case would be a silent key fork (payload sealed under a key that
 * nobody can look up), so this must never fall back to "just make another one".
 */
async function loadOrCreateWrappedKey(caseRef: string): Promise<WrappedCaseKey> {
  const existing = await db.case.findUnique({
    where: { caseRef },
    select: { dataKeyEnc: true, erasedAt: true },
  });
  if (!existing) throw new CaseNotFoundError(caseRef);
  if (existing.erasedAt) throw new CaseErasedError(caseRef);
  if (existing.dataKeyEnc) {
    return {
      caseRef,
      wrapped: existing.dataKeyEnc,
      fingerprint: keyFingerprintOf(existing.dataKeyEnc)!,
      created: false,
    };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    // The hierarchy: a fresh random DATA key, wrapped by the MASTER key. Never
    // a key derived from another key — a derivation would let one broken case
    // key take its neighbours with it.
    const kek = masterKey();
    const dataKey = randomBytes(DATA_KEY_BYTES);
    let wrapped: string;
    try {
      wrapped = packEnvelope(KEY_ENVELOPE_PREFIX, seal(kek, keyWrapAad(caseRef), dataKey));
    } finally {
      zeroize(dataKey);
    }
    const claimed = await db.case.updateMany({
      where: { caseRef, dataKeyEnc: null, erasedAt: null },
      data: { dataKeyEnc: wrapped },
    });
    if (claimed.count === 1) {
      return { caseRef, wrapped, fingerprint: keyFingerprintOf(wrapped)!, created: true };
    }
    const current = await db.case.findUnique({
      where: { caseRef },
      select: { dataKeyEnc: true, erasedAt: true },
    });
    if (current?.erasedAt) throw new CaseErasedError(caseRef);
    if (current?.dataKeyEnc) {
      return {
        caseRef,
        wrapped: current.dataKeyEnc,
        fingerprint: keyFingerprintOf(current.dataKeyEnc)!,
        created: false,
      };
    }
  }
  throw new Error(
    `Could not establish a data key for ${caseRef} after 3 attempts (concurrent writers?)`,
  );
}

/** The public form: a fingerprint, never key material. */
export async function ensureCaseKey(caseRef: string): Promise<CaseKey> {
  const { fingerprint, created } = await loadOrCreateWrappedKey(caseRef);
  return { caseRef, fingerprint, created };
}

/** Unwrap a case's data key. Returns null when there is no wrapped key. */
export function unwrapCaseKey(wrapped: string | null, caseRef: string): Buffer | null {
  if (!wrapped) return null;
  const envelope = parseEnvelope(wrapped, KEY_ENVELOPE_PREFIX);
  return open(masterKey(), keyWrapAad(caseRef), envelope);
}

// ── Sealed payload (stored in the chain as ciphertext) ───────────────────────

export type SealInput = {
  /** Redacted transcript text, or null when the case has none. */
  transcript?: string | null;
  /** Analysis / evaluation payload, or null. */
  analysis?: unknown;
};

export type SealOptions = {
  /**
   * Also null the `Case` plaintext columns. Ordering matters: the ciphertext is
   * appended FIRST, so a crash between the two leaves the plaintext in place
   * (privacy-safe) instead of dropping the only copy.
   */
  clearPlaintext?: boolean;
  /** Short, PII-free provenance label sealed into the row (e.g. "post_call_ingest"). */
  reason?: string;
};

export type SealResult = {
  caseRef: string;
  /** The appended chain row that now holds the ciphertext. */
  rowId: string;
  chainHash: string;
  fingerprint: string;
  bytes: number;
  sealedAt: string;
  clearedColumns: string[];
};

type EnvelopeMeta = {
  version: string;
  alg: string;
  caseRef: string;
  bytes: number;
  sealedAt: string;
  reason: string;
  iv: string;
  tag: string;
  ct: string;
};

/**
 * Seal a case's payload under its per-case data key and append the ciphertext to
 * the chain.
 *
 * The ciphertext row is chain-resident on purpose. It cannot be deleted without
 * rewriting the chain, so retention shreds the KEY instead (see retention.ts) —
 * at which point the row is inert. What the row does still prove is that a
 * ciphertext existed, that it was never swapped (the hash covers it), and when.
 */
export async function sealCasePayload(
  caseRef: string,
  input: SealInput,
  opts: SealOptions = {},
): Promise<SealResult> {
  const row = await db.case.findUnique({
    where: { caseRef },
    select: { orgId: true, erasedAt: true },
  });
  if (!row) throw new CaseNotFoundError(caseRef);
  if (row.erasedAt) throw new CaseErasedError(caseRef);

  const plaintext = Buffer.from(
    JSON.stringify({
      transcript: input.transcript ?? null,
      analysis: input.analysis ?? null,
    }),
    "utf8",
  );
  if (plaintext.byteLength > MAX_SEALED_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(caseRef, plaintext.byteLength);
  }

  const key = await loadOrCreateWrappedKey(caseRef);
  const dataKey = unwrapCaseKey(key.wrapped, caseRef);
  if (!dataKey) throw new CaseErasedError(caseRef);

  const byteLength = plaintext.byteLength;
  let envelope: Envelope;
  try {
    const raw = seal(dataKey, payloadAad(caseRef), plaintext);
    envelope = {
      iv: raw.iv.toString("base64"),
      tag: raw.tag.toString("base64"),
      ct: raw.ct.toString("base64"),
    };
  } finally {
    zeroize(dataKey);
    zeroize(plaintext);
  }

  const sealedAt = new Date().toISOString();
  const reason = (opts.reason ?? "manual").slice(0, 64);
  const meta: EnvelopeMeta = {
    version: PAYLOAD_ENVELOPE_PREFIX,
    alg: ALGORITHM,
    caseRef,
    bytes: byteLength,
    sealedAt,
    reason,
    iv: envelope.iv,
    tag: envelope.tag,
    ct: envelope.ct,
  };

  const appended = await append(
    {
      callRef: caseRef,
      action: "agent",
      intent: AUDIT_INTENT_SEALED,
      // No PII, ever: this field is stored in the immutable chain.
      redactedText: `sealed payload (${byteLength} bytes)`,
      meta: meta as unknown as Record<string, unknown>,
      orgId: row.orgId ?? undefined,
    },
    { fast: true },
  );

  const clearedColumns = opts.clearPlaintext
    ? await db.$transaction((tx) => clearPayloadColumns(tx, caseRef))
    : [];

  return {
    caseRef,
    rowId: appended.id,
    chainHash: appended.chainHash,
    fingerprint: key.fingerprint,
    bytes: byteLength,
    sealedAt,
    clearedColumns,
  };
}

function parseEnvelopeMeta(meta: string | null): EnvelopeMeta | null {
  if (!meta) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<EnvelopeMeta>;
  if (
    candidate.version !== PAYLOAD_ENVELOPE_PREFIX ||
    typeof candidate.iv !== "string" ||
    typeof candidate.tag !== "string" ||
    typeof candidate.ct !== "string" ||
    typeof candidate.bytes !== "number"
  ) {
    return null;
  }
  return candidate as EnvelopeMeta;
}

/** The chain row holding the newest sealed ciphertext for a case, if any. */
export async function sealedRowFor(caseRef: string) {
  return db.auditLog.findFirst({
    where: { callRef: caseRef, action: "agent", intent: AUDIT_INTENT_SEALED },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export type SealedPayload = {
  caseRef: string;
  rowId: string;
  sealedAt: string | null;
  reason: string | null;
  bytes: number | null;
  transcript: string | null;
  analysis: unknown;
  fingerprint: string | null;
};

/**
 * Read back a sealed payload.
 *
 * Throws `CaseErasedError` after erasure. It does NOT return an empty string or
 * a placeholder: a caller that cannot distinguish "erased" from "empty" is a
 * caller that will eventually report erased evidence as if it existed.
 */
export async function readCasePayload(caseRef: string): Promise<SealedPayload> {
  const row = await db.case.findUnique({
    where: { caseRef },
    select: { dataKeyEnc: true, erasedAt: true },
  });
  if (!row) throw new CaseNotFoundError(caseRef);
  if (row.erasedAt || !row.dataKeyEnc) throw new CaseErasedError(caseRef);

  const sealed = await sealedRowFor(caseRef);
  const meta = parseEnvelopeMeta(sealed?.meta ?? null);
  if (!sealed || !meta) throw new PayloadNotSealedError(caseRef);

  const dataKey = unwrapCaseKey(row.dataKeyEnc, caseRef);
  if (!dataKey) throw new CaseErasedError(caseRef);
  let plaintext: Buffer;
  try {
    plaintext = open(dataKey, payloadAad(caseRef), {
      iv: meta.iv,
      tag: meta.tag,
      ct: meta.ct,
    });
  } catch (error) {
    throw new PayloadUndecryptableError(
      caseRef,
      error instanceof Error ? error.message : "authentication tag mismatch",
    );
  } finally {
    zeroize(dataKey);
  }

  let decoded: { transcript: string | null; analysis: unknown };
  try {
    decoded = JSON.parse(plaintext.toString("utf8")) as {
      transcript: string | null;
      analysis: unknown;
    };
  } finally {
    zeroize(plaintext);
  }
  return {
    caseRef,
    rowId: sealed.id,
    sealedAt: meta.sealedAt ?? null,
    reason: meta.reason ?? null,
    bytes: meta.bytes ?? null,
    transcript: decoded.transcript ?? null,
    analysis: decoded.analysis ?? null,
    fingerprint: keyFingerprintOf(row.dataKeyEnc),
  };
}

// ── Erasure ──────────────────────────────────────────────────────────────────

export type ErasureOptions = {
  /** PII-free reason recorded in the witness row (e.g. "dsr_request", "retention"). */
  reason?: string;
  /** Operator or system identity that asked. Truncated; never free text. */
  requestedBy?: string;
  /** Optional policy reference, e.g. "UAE PDPL Art. 27". Recorded verbatim. */
  legalBasis?: string;
};

export type ErasureResult = {
  caseRef: string;
  alreadyErased: boolean;
  erasedAt: string | null;
  clearedColumns: string[];
  keyDestroyed: boolean;
  ciphertextRows: number;
  chainEvent:
    { rowId: string; chainHash: string } | { rowId: null; chainHash: null; error: string };
};

/** Null every payload column that actually held data, reporting which. */
async function clearPayloadColumns(
  tx: Prisma.TransactionClient,
  caseRef: string,
): Promise<string[]> {
  const cleared: string[] = [];
  for (const column of CASE_PAYLOAD_COLUMNS) {
    // One conditional UPDATE per column: Prisma cannot report which of them held
    // data, and "we cleared 3 columns" when only 1 had data is a false receipt.
    const result = await tx.case.updateMany({
      where: { caseRef, [column]: { not: null } },
      data: { [column]: null },
    });
    if (result.count > 0) cleared.push(column);
  }
  return cleared;
}

async function countSealedRows(callRef: string): Promise<number> {
  return db.auditLog.count({ where: { callRef, action: "agent", intent: AUDIT_INTENT_SEALED } });
}

/**
 * Destroy the per-case data key and clear the plaintext columns. Appends the
 * erasure to the chain; never mutates a chained field (invariant I-6).
 *
 * Ordering, and why:
 *   1. Read the wrapped key and zero our in-process copy.
 *   2. In ONE transaction: `dataKeyEnc = NULL`, `erasedAt = now`, payload
 *      columns = NULL. After this commit the key exists nowhere durable, which
 *      is the point — there is nothing left to roll back, so a failure in step
 *      3 must not undo it.
 *   3. Append `privacy_erasure_v1`. Best-effort by design: the witness row is
 *      evidence, the destruction is the obligation. A witness that failed to
 *      write is logged and reported, never retried by hiding the erasure.
 */
export async function eraseCase(
  caseRef: string,
  opts: ErasureOptions = {},
): Promise<ErasureResult> {
  const row = await db.case.findUnique({ where: { caseRef } });
  if (!row) throw new CaseNotFoundError(caseRef);
  if (row.erasedAt) {
    return {
      caseRef,
      alreadyErased: true,
      erasedAt: row.erasedAt.toISOString(),
      clearedColumns: [],
      keyDestroyed: false,
      ciphertextRows: await countSealedRows(caseRef),
      chainEvent: {
        rowId: null,
        chainHash: null,
        error: "already erased; no second witness appended",
      },
    };
  }

  // Best effort in-memory hygiene. The durable destruction is the transaction.
  try {
    zeroize(unwrapCaseKey(row.dataKeyEnc, caseRef));
  } catch (error) {
    console.error(
      `[privacy] could not unwrap the data key for ${caseRef} while erasing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const erasedAt = new Date();
  const ciphertextRows = await countSealedRows(caseRef);
  const clearedColumns = await db.$transaction(async (tx) => {
    const cleared = await clearPayloadColumns(tx, caseRef);
    await tx.case.update({
      where: { caseRef },
      data: {
        dataKeyEnc: null,
        erasedAt,
        transcriptRedacted: null,
        evaluationResults: null,
        dataCollectionResults: null,
      },
      select: { id: true },
    });
    return cleared;
  });

  let chainEvent: ErasureResult["chainEvent"];
  try {
    const appended = await append(
      {
        callRef: caseRef,
        action: "agent",
        intent: AUDIT_INTENT_ERASED,
        redactedText: "data key destroyed",
        meta: {
          caseRef,
          keyDestroyed: true,
          clearedColumns,
          ciphertextRows,
          sealedAt: erasedAt.toISOString(),
          reason: (opts.reason ?? "unspecified").slice(0, 64),
          requestedBy: (opts.requestedBy ?? "system").slice(0, 64),
          legalBasis: (opts.legalBasis ?? "unspecified").slice(0, 64),
        },
        orgId: row.orgId ?? undefined,
      },
      { fast: true },
    );
    chainEvent = { rowId: appended.id, chainHash: appended.chainHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[privacy] erasure witness row failed for ${caseRef}: ${message}`);
    chainEvent = { rowId: null, chainHash: null, error: message };
  }

  return {
    caseRef,
    alreadyErased: false,
    erasedAt: erasedAt.toISOString(),
    clearedColumns,
    keyDestroyed: true,
    ciphertextRows,
    chainEvent,
  };
}

/**
 * Delete the case record itself once its retention window has closed.
 *
 * The chain is untouched: this removes a `Case` row, which no hash covers, and
 * the case's audit rows keep verifying on their own. Any payload or key is
 * shredded first so the ciphertext left in the chain is already inert.
 */
export async function deleteCaseRecord(
  caseRef: string,
  opts: ErasureOptions = {},
): Promise<{
  caseRef: string;
  clearedColumns: string[];
  keyDestroyed: boolean;
}> {
  const row = await db.case.findUnique({ where: { caseRef } });
  if (!row) throw new CaseNotFoundError(caseRef);

  const outcome = await db.$transaction(async (tx) => {
    const cleared = await clearPayloadColumns(tx, caseRef);
    const hadKey = Boolean(row.dataKeyEnc);
    await tx.case.update({
      where: { caseRef },
      data: {
        dataKeyEnc: null,
        erasedAt: row.erasedAt ?? new Date(),
        transcriptRedacted: null,
        evaluationResults: null,
        dataCollectionResults: null,
      },
      select: { id: true },
    });
    await tx.case.delete({ where: { caseRef }, select: { id: true } });
    return { cleared, hadKey };
  });

  try {
    await append(
      {
        callRef: caseRef,
        action: "agent",
        intent: AUDIT_INTENT_CASE_DELETED,
        redactedText: "case record deleted",
        meta: {
          caseRef,
          reason: (opts.reason ?? "retention").slice(0, 64),
          requestedBy: (opts.requestedBy ?? "retention-sweeper").slice(0, 64),
          legalBasis: (opts.legalBasis ?? "unspecified").slice(0, 64),
          clearedColumns: outcome.cleared,
          keyDestroyed: outcome.hadKey,
        },
        orgId: row.orgId ?? undefined,
      },
      { fast: true },
    );
  } catch (error) {
    console.error(
      `[privacy] case-record deletion witness failed for ${caseRef}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { caseRef, clearedColumns: outcome.cleared, keyDestroyed: outcome.hadKey };
}

// ── Read-only state ──────────────────────────────────────────────────────────

export type CasePrivacyState = {
  caseRef: string;
  exists: boolean;
  sealed: boolean;
  erased: boolean;
  erasedAt: string | null;
  fingerprint: string | null;
  ciphertextRows: number;
  plaintextColumns: Partial<Record<CasePayloadColumn, boolean>>;
};

/** What a DSR handler needs to answer "what do you still hold about me?". */
export async function casePrivacyState(caseRef: string): Promise<CasePrivacyState> {
  const row = await db.case.findUnique({ where: { caseRef } });
  const ciphertextRows = await countSealedRows(caseRef);
  if (!row) {
    // No `Case` row means no key EXISTS — so any ciphertext still in the chain is
    // unrecoverable by construction. Reporting `sealed: false` here would be the
    // dangerous answer: a DSR handler would tell the data subject nothing was
    // ever retained while an inert ciphertext row sits in the log forever.
    return {
      caseRef,
      exists: false,
      sealed: ciphertextRows > 0,
      erased: true,
      erasedAt: null,
      fingerprint: null,
      ciphertextRows,
      plaintextColumns: {},
    };
  }
  const sealed = ciphertextRows > 0;
  return {
    caseRef,
    exists: true,
    sealed,
    erased: Boolean(row.erasedAt) || !row.dataKeyEnc,
    erasedAt: row.erasedAt?.toISOString() ?? null,
    fingerprint: keyFingerprintOf(row.dataKeyEnc),
    ciphertextRows,
    plaintextColumns: {
      transcriptRedacted: row.transcriptRedacted !== null,
      evaluationResults: row.evaluationResults !== null,
      dataCollectionResults: row.dataCollectionResults !== null,
    },
  };
}
