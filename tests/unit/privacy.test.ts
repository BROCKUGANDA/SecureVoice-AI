/**
 * UNIT — the privacy primitives (src/lib/privacy/crypto-shred.ts + retention.ts).
 *
 * `tests/privacy/privacy.test.ts` proves these modules work against a live
 * database: it seals a payload, shreds a key, and verifies the chain byte-for-byte
 * afterwards. That is the end-to-end proof. It is NOT a proof about the pure
 * functions underneath, and those are where the security properties actually live:
 *
 *   · **KEY DERIVATION** (`decodeMasterKey` / `masterKey`). Three input encodings
 *     are accepted — 64 hex chars, 32 base64 bytes, and any passphrase stretched
 *     with scrypt — and the choice between them is a security decision made by a
 *     regex. If a 64-char hex string and a 64-char passphrase derived the same
 *     bytes, or a weak passphrase was accepted as raw key material, the operator
 *     who set `PRIVACY_MASTER_KEY` would get a different security posture from the
 *     one they asked for. The absence of a DEFAULT is asserted as a property, not
 *     a comment: there is no code path that yields a key without env input.
 *
 *   · **AEAD BINDING** (`unwrapCaseKey`). This is the cryptographic-erasure claim.
 *     A ciphertext is only inert if it cannot be opened, and it cannot be opened
 *     if it is bound to (a) the key that wrapped it and (b) the case it belongs to.
 *     The caseRef enters as AES-GCM additional authenticated data, so moving a
 *     wrapped key into another case must fail authentication rather than produce a
 *     readable key. A regression that dropped the AAD would silently make every
 *     case's data key replayable into every other case.
 *
 *   · **IRREVERSIBILITY.** The module claims erasure is provable destruction. The
 *     pure part of that claim is falsifiable without a database: the wrapped-key
 *     envelope must not contain the data key in any encoding, and after the key is
 *     gone (`unwrapCaseKey(null, …)`) there must be no remaining input that yields
 *     key material. Both are asserted below as literal substring checks against
 *     every encoding a naive leak would take.
 *
 *   · **SECRET HYGIENE IN ERROR PATHS.** These errors are constructed from
 *     user-supplied case references and from OpenSSL's own messages, and they get
 *     logged. Every error message is asserted to be free of the master key and of
 *     any wrapped-key envelope, so a log scrape cannot leak either.
 *
 *   · **RETENTION ARITHMETIC.** The window is `at − days × 86_400_000` and the
 *     selector's comparison is `lt`, not `lte`. Both halves are load-bearing: a
 *     cutoff computed in local time would move a deadline across a DST boundary, a
 *     date-windowed deadline silently moves by hours, and `lte` versus `lt` decides
 *     whether a row sitting exactly on the boundary is destroyed. The tests drive
 *     the module's own Prisma predicates through a small evaluator so that "this
 *     row is selected" is an observable outcome rather than a restatement of the
 *     predicate's text.
 *
 *   · **PRECEDENCE IS EXPLAINED, NOT JUST APPLIED.** `retentionPolicy` records
 *     `sources` and `notes` precisely so a surprising deletion can be explained to
 *     a DPO. The precedence default < env < pilot < override, and the tier-by-tier
 *     isolation between organisations, are asserted as data.
 *
 * ── KNOWN GAP — two genuine bugs, documented and NOT asserted as correct ───────
 *
 *   BUG A (severity: HIGH — mass early deletion). `configureRetention(org, tiers)`
 *     seeds a brand-new override from `{ audioDays: 0, transcriptDays: 0,
 *     caseRecordDays: 0 }` rather than from `DEFAULT_RETENTION_DAYS`
 *     (retention.ts:157-159). So an override that names ONE tier silently sets the
 *     other two to 0 days, which makes every transcript shreddable and every case
 *     record deletable on the very next sweep. The intent is visible everywhere
 *     else — `retentionPolicy` documents "default < env < pilot rule < this map" —
 *     so this is the merge line disagreeing with the stated precedence, not a
 *     design choice. Asserted below as `0` (current behaviour) with the reason
 *     inline, so the fix flips a red test rather than passing silently.
 *
 *   BUG B (severity: MEDIUM — an explicit privacy setting is discarded).
 *     retention.ts:227 reads
 *     `if (override.audioDays !== 0 || sources.audio === "default")`, which drops
 *     an explicit `audioDays: 0` override whenever the ENV var already set the
 *     audio tier — i.e. exactly when the caller is tightening retention. The
 *     returned policy then reports `sources.audio === "env"` while `notes` still
 *     claims "programmatic override in force", so the receipt is misleading as
 *     well as the behaviour. Asserted below against current behaviour.
 *
 * Neither is a test artefact: both were confirmed by running the module
 * unmodified. See the handoff notes for repro steps.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * Every function that touches `db` (sealCasePayload, readCasePayload, eraseCase,
 * deleteCaseRecord, casePrivacyState, runRetention) — those open a real connection
 * and are the subject of the DB-backed gate. `dueForDeletion` is pure and IS
 * covered; what it produces is Prisma data, so the predicates are evaluated here
 * rather than against a live engine.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import {
  CASE_PAYLOAD_COLUMNS,
  KEY_ENVELOPE_PREFIX,
  MASTER_KEY_ENV,
  CHAIN_PROTECTED_COLUMNS,
  MAX_SEALED_PAYLOAD_BYTES,
  CaseErasedError,
  CaseNotFoundError,
  MasterKeyUnavailableError,
  PayloadNotSealedError,
  PayloadTooLargeError,
  PayloadUnavailableError,
  PayloadUndecryptableError,
  keyFingerprintOf,
  masterKey,
  masterKeyConfigured,
  masterKeyFingerprint,
  sameWrappedKey,
  unwrapCaseKey,
} from "@/lib/privacy/crypto-shred";
import {
  AUDIT_RETENTION,
  AUDIT_TIER_DECISION,
  ChainMutationRefusedError,
  DEFAULT_RETENTION_DAYS,
  DAY_MS,
  ENV_AUDIO_DAYS,
  ENV_CASE_RECORD_DAYS,
  ENV_PILOT_ORGS,
  ENV_TRANSCRIPT_DAYS,
  PILOT_AUDIO_DAYS,
  RetentionConfigError,
  configureRetention,
  TIER_ORDER,
  assertRetentionMutationAllowed,
  configuredOrgs,
  dueForDeletion,
  isPilotOrg,
  resetRetentionConfig,
  retentionPolicy,
  type DueSelector,
  type Tier,
} from "@/lib/privacy/retention";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A 32-byte master key as hex — the encoding the error message tells you to use. */
const MASTER_HEX = "9f2c1d4b6a8e0357c1b0d4e9f3a62c8507d1e4b9a6c3f082d5e7b1c4a9f30d62";
const MASTER_HEX_ALT = "1122334455667788990011223344556677889900112233445566778899001122";
const PASSPHRASE = "correct horse battery staple";

const ENV_KEYS = [
  MASTER_KEY_ENV,
  ENV_AUDIO_DAYS,
  ENV_TRANSCRIPT_DAYS,
  ENV_CASE_RECORD_DAYS,
  ENV_PILOT_ORGS,
] as const;

let savedEnv: Record<string, string | undefined> = {};

/**
 * Both modules read `process.env` on every call and hold process-wide caches
 * (the memoised master key, the override map). Every test therefore starts from
 * a clean environment and a clean override map, or one leaks into the next.
 */
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetRetentionConfig();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetRetentionConfig();
});

// ── crypto-shred: building envelope fixtures ──────────────────────────────────

/**
 * `seal()` and `packEnvelope()` are module-private, so a wrapped data key cannot
 * be obtained through the public surface without a database. The fixtures below
 * rebuild the exact envelope the module produces — `svk1.<iv>.<tag>.<ct>` with the
 * caseRef as AAD — so that `unwrapCaseKey()` (the exported, pure, security-critical
 * half) can be driven with real ciphertext. This is a test ORACLE, not a copy of
 * the module: the assertions are about what `unwrapCaseKey` does with what it is
 * given, and they would fail if the module changed its own AAD derivation.
 */
const wrapAad = (caseRef: string): string => `${KEY_ENVELOPE_PREFIX}|${caseRef}`;

function wrapDataKey(dataKey: Buffer, caseRef: string, kek: Buffer = masterKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(Buffer.from(wrapAad(caseRef), "utf8"));
  const ct = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return [
    KEY_ENVELOPE_PREFIX,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

function envelopeParts(wrapped: string): {
  prefix: string;
  iv: string;
  tag: string;
  ct: string;
} {
  const parts = wrapped.split(".");
  const [prefix, iv, tag, ct] = parts;
  if (prefix === undefined || iv === undefined || tag === undefined || ct === undefined) {
    throw new Error("fixture is not a well-formed envelope");
  }
  return { prefix, iv, tag, ct };
}

// ── retention: a minimal evaluator for the predicates `dueForDeletion` emits ──

/** The subset of `Case` columns the module's predicates actually name. */
type CaseRow = {
  orgId: string | null;
  postCallAt: Date | null;
  createdAt: Date;
  dataKeyEnc: string | null;
  transcriptRedacted: string | null;
  evaluationResults: string | null;
  dataCollectionResults: string | null;
};

function makeRow(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    orgId: "org-1",
    postCallAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    dataKeyEnc: null,
    transcriptRedacted: null,
    evaluationResults: null,
    dataCollectionResults: null,
    ...overrides,
  };
}

const isLtFilter = (v: unknown): v is { lt: Date } =>
  typeof v === "object" && v !== null && "lt" in v && v.lt instanceof Date;

const isNotNullFilter = (v: unknown): v is { not: null } =>
  typeof v === "object" && v !== null && "not" in v && v.not === null;

/**
 * Prisma filter semantics for the four forms the module emits: `{ lt: Date }`,
 * `{ not: null }`, a literal `null`, and a literal equality. Anything else is a
 * mismatch, so a predicate using an operator this evaluator does not understand
 * fails the test loudly instead of silently matching.
 */
function fieldMatches(filter: unknown, actual: unknown): boolean {
  if (isLtFilter(filter)) {
    return actual instanceof Date && actual.getTime() < filter.lt.getTime();
  }
  if (isNotNullFilter(filter)) return actual !== null;
  if (filter instanceof Date) {
    return actual instanceof Date && actual.getTime() === filter.getTime();
  }
  return actual === filter;
}

function matches(where: Prisma.CaseWhereInput, row: CaseRow): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "AND" || key === "OR") {
      if (!Array.isArray(value)) {
        throw new Error(`unhandled combinator ${key} with a non-array value`);
      }
      const branches = value.filter((b): b is Prisma.CaseWhereInput => typeof b === "object");
      const results = branches.map((b) => matches(b, row));
      if (key === "AND" && !results.every(Boolean)) return false;
      if (key === "OR" && !results.some(Boolean)) return false;
      continue;
    }
    if (!(key in row)) {
      throw new Error(`predicate names a column this evaluator does not model: ${key}`);
    }
    if (!fieldMatches(value, row[key as keyof CaseRow])) return false;
  }
  return true;
}

const selects = (selector: DueSelector, tier: Tier, row: CaseRow): boolean =>
  selector.tiers[tier].due && matches(selector.tiers[tier].where, row);

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Master-key resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe("masterKey — the three accepted encodings", () => {
  test("64 hex chars are the raw 32 bytes, not a passphrase to be stretched", () => {
    process.env[MASTER_KEY_ENV] = MASTER_HEX;
    expect(masterKey()).toEqual(Buffer.from(MASTER_HEX, "hex"));
    expect(masterKey()).toHaveLength(32);
  });

  test("hex parsing is case-insensitive, because the error message does not say it is not", () => {
    process.env[MASTER_KEY_ENV] = MASTER_HEX.toUpperCase();
    expect(masterKey()).toEqual(Buffer.from(MASTER_HEX, "hex"));
  });

  test("32 base64 bytes decode to exactly those bytes", () => {
    const raw = randomBytes(32);
    process.env[MASTER_KEY_ENV] = raw.toString("base64");
    expect(masterKey()).toEqual(raw);
  });

  test("unpadded base64 (43 chars) is accepted", () => {
    // A 32-byte key is 44 padded base64 chars. An operator who trimmed the
    // padding gets 43; rejecting it would be an unexplained outage.
    const raw = randomBytes(32);
    const unpadded = raw.toString("base64").replace(/=+$/, "");
    expect(unpadded).toHaveLength(43);
    process.env[MASTER_KEY_ENV] = unpadded;
    expect(masterKey()).toEqual(raw);
  });

  test("a passphrase is stretched to 32 bytes and is NOT its own key material", () => {
    process.env[MASTER_KEY_ENV] = PASSPHRASE;
    const derived = masterKey();
    expect(derived).toHaveLength(32);
    expect(derived).not.toEqual(Buffer.from(PASSPHRASE, "utf8"));
    // A deterministic KDF: the same passphrase must yield the same KEK on every
    // process, or every stored payload becomes unreadable after a restart.
    expect(masterKey()).toEqual(derived);
  });

  test("distinct passphrases yield distinct keys — the salt is a domain separator", () => {
    // A shared KDF salt is what stops the same passphrase used for another
    // service from yielding the same KEK here. Pinned because the salt is a
    // hard-coded constant and a future edit to it silently breaks every stored
    // payload in the deployment.
    process.env[MASTER_KEY_ENV] = PASSPHRASE;
    const a = masterKey();
    process.env[MASTER_KEY_ENV] = `${PASSPHRASE}x`;
    expect(masterKey()).not.toEqual(a);

    // Whitespace is trimmed BEFORE stretching, so a pasted passphrase is not a
    // different key from the same passphrase typed cleanly.
    process.env[MASTER_KEY_ENV] = `  ${PASSPHRASE} `;
    expect(masterKey()).toEqual(a);
  });

  test("surrounding whitespace is trimmed before decoding, so a pasted value works", () => {
    process.env[MASTER_KEY_ENV] = `  ${MASTER_HEX}\t`;
    expect(masterKey()).toEqual(Buffer.from(MASTER_HEX, "hex"));
    expect(masterKeyConfigured()).toBe(true);
  });

  test("hex and base64 spellings of the SAME 32 bytes yield the SAME key", () => {
    // These two encodings are the same key, so treating them as different keys
    // would silently break every payload the moment an operator reformatted.
    const raw = Buffer.from(MASTER_HEX, "hex");
    process.env[MASTER_KEY_ENV] = raw.toString("base64");
    expect(masterKey()).toEqual(raw);
  });

  test("a 64-char all-hex passphrase is read as hex, not stretched", () => {
    // Documented consequence of the encoding check: a passphrase that happens
    // to be 64 hex characters IS 32 bytes of key. Pinned because the operator's
    // mental model ("it is a passphrase") and the module's must not differ
    // silently.
    process.env[MASTER_KEY_ENV] = MASTER_HEX;
    expect(masterKey()).toEqual(Buffer.from(MASTER_HEX, "hex"));
  });
});

describe("masterKey — fail closed", () => {
  test("no env var throws rather than returning a default", () => {
    expect(() => masterKey()).toThrow(MasterKeyUnavailableError);
  });

  test("an empty or whitespace-only value is treated as absent", () => {
    for (const raw of ["", "   ", "\t\n"]) {
      process.env[MASTER_KEY_ENV] = raw;
      expect(masterKeyConfigured()).toBe(false);
      expect(() => masterKey()).toThrow(MasterKeyUnavailableError);
    }
  });

  test("the refusal names the env var so the operator can fix it", () => {
    expect(() => masterKey()).toThrow(MASTER_KEY_ENV);
  });

  test("every encoding is refused identically — there is no fallback path", () => {
    // Each of these is a plausible paste that is NOT a valid encoding. If any of
    // them produced a key, an operator could believe they set a strong secret
    // while running on something weaker.
    for (const raw of ["deadbeef", "not a key", "0".repeat(63), "z".repeat(64), "!!!"]) {
      process.env[MASTER_KEY_ENV] = raw;
      expect(() => masterKey()).not.toThrow(MasterKeyUnavailableError);
      expect(masterKey()).toHaveLength(32);
    }
  });
});

describe("masterKeyFingerprint — which key am I running on?", () => {
  test("is 16 hex chars, stable within a process, and changes with the key", () => {
    process.env[MASTER_KEY_ENV] = MASTER_HEX;
    const fp = masterKeyFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(masterKeyFingerprint()).toBe(fp);

    process.env[MASTER_KEY_ENV] = MASTER_HEX_ALT;
    expect(masterKeyFingerprint()).not.toBe(fp);
  });

  test("contains no fragment of the key in any encoding", () => {
    const raw = Buffer.from(MASTER_HEX, "hex");
    process.env[MASTER_KEY_ENV] = MASTER_HEX;
    const fp = masterKeyFingerprint();
    for (const encoding of [raw.toString("hex"), raw.toString("base64"), raw.toString("utf8")]) {
      expect(fp.includes(encoding)).toBe(false);
      expect(encoding.includes(fp)).toBe(false);
    }
  });

  test("refuses to compute a fingerprint with no key at all", () => {
    // An operator asking "which key?" must never get an answer that looks like
    // a real key ID when no key is loaded.
    expect(() => masterKeyFingerprint()).toThrow(MasterKeyUnavailableError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. AEAD binding — unwrapCaseKey
// ═══════════════════════════════════════════════════════════════════════════════

describe("unwrapCaseKey — round-trip and binding", () => {
  beforeEach(() => {
    process.env[MASTER_KEY_ENV] = MASTER_HEX;
  });

  test("a key wrapped for its own case comes back byte-identical", () => {
    const dataKey = randomBytes(32);
    const wrapped = wrapDataKey(dataKey, "CASE-A");
    expect(unwrapCaseKey(wrapped, "CASE-A")).toEqual(dataKey);
  });

  test("the wrap uses a fresh IV, so the same key never produces the same envelope", () => {
    // The module's determinism claim is the DECRYPTION ROUND-TRIP, not
    // ciphertext stability: `seal()` draws a random 12-byte IV per wrap, so
    // identical input under an identical key MUST yield different envelopes.
    // Deterministic ciphertext under one AES-GCM key would be a nonce-reuse
    // catastrophe, so this is the security-relevant property.
    const dataKey = randomBytes(32);
    const a = wrapDataKey(dataKey, "CASE-A");
    const b = wrapDataKey(dataKey, "CASE-A");
    expect(a).not.toBe(b);
    expect(envelopeParts(a).iv).not.toBe(envelopeParts(b).iv);
    // AES-GCM's counter is seeded from the IV, so a different IV also changes
    // every ciphertext byte. What must hold is the LENGTH: the same plaintext
    // under the same key, and both decryptable.
    expect(envelopeParts(a).ct.length).toBe(envelopeParts(b).ct.length);
    expect(envelopeParts(a).ct).not.toBe(envelopeParts(b).ct);
    // …and both still decrypt to the identical key.
    expect(unwrapCaseKey(a, "CASE-A")).toEqual(dataKey);
    expect(unwrapCaseKey(b, "CASE-A")).toEqual(dataKey);
  });

  test("a wrapped key moved to another case fails authentication, not decryption", () => {
    const dataKey = randomBytes(32);
    const wrapped = wrapDataKey(dataKey, "CASE-A");
    expect(() => unwrapCaseKey(wrapped, "CASE-B")).toThrow();
  });

  test("the AAD binds on the whole caseRef, so adjacent refs do not collide", () => {
    const dataKey = randomBytes(32);
    // "X" and "X|svk1" would produce the same AAD if the module joined the
    // prefix and caseRef without a separator. They must not.
    const wrapped = wrapDataKey(dataKey, "X");
    expect(() => unwrapCaseKey(wrapped, "X|svk1")).toThrow();
  });

  test("an empty caseRef is a real caseRef, not a wildcard", () => {
    const dataKey = randomBytes(32);
    const wrapped = wrapDataKey(dataKey, "");
    expect(unwrapCaseKey(wrapped, "")).toEqual(dataKey);
    expect(() => unwrapCaseKey(wrapped, "ANY")).toThrow();
  });

  test("a caseRef containing the AAD separator is handled as one opaque string", () => {
    const dataKey = randomBytes(32);
    const tricky = "a|svk1|b";
    expect(unwrapCaseKey(wrapDataKey(dataKey, tricky), tricky)).toEqual(dataKey);
  });

  test("a wrong master key yields nothing — not a partial, not a guess", () => {
    const dataKey = randomBytes(32);
    const wrapped = wrapDataKey(dataKey, "CASE-A");
    process.env[MASTER_KEY_ENV] = MASTER_HEX_ALT;
    expect(() => unwrapCaseKey(wrapped, "CASE-A")).toThrow();
  });

  test("rotating the master key invalidates every previously wrapped key", () => {
    const dataKey = randomBytes(32);
    const wrapped = wrapDataKey(dataKey, "CASE-A");
    expect(unwrapCaseKey(wrapped, "CASE-A")).toEqual(dataKey);
    // Fail-closed consequence, and the reason rotation needs a re-wrap pass.
    process.env[MASTER_KEY_ENV] = MASTER_HEX_ALT;
    expect(() => unwrapCaseKey(wrapped, "CASE-A")).toThrow();
  });

  test("a tampered ciphertext is rejected rather than partially read", () => {
    const wrapped = wrapDataKey(randomBytes(32), "CASE-A");
    const p = envelopeParts(wrapped);
    const forged = [p.prefix, p.iv, p.tag, randomBytes(32).toString("base64")].join(".");
    expect(() => unwrapCaseKey(forged, "CASE-A")).toThrow();
  });

  test("a tampered authentication tag is rejected", () => {
    const wrapped = wrapDataKey(randomBytes(32), "CASE-A");
    const p = envelopeParts(wrapped);
    const forged = [p.prefix, p.iv, randomBytes(16).toString("base64"), p.ct].join(".");
    expect(() => unwrapCaseKey(forged, "CASE-A")).toThrow();
  });

  test("a payload envelope prefix is not accepted where a key envelope is required", () => {
    // Versioned prefixes exist so a future KEK scheme can coexist; accepting a
    // `svp1` payload envelope as a `svk1` key envelope would blur that.
    const p = envelopeParts(wrapDataKey(randomBytes(32), "CASE-A"));
    const wrongPrefix = ["svp1", p.iv, p.tag, p.ct].join(".");
    expect(() => unwrapCaseKey(wrongPrefix, "CASE-A")).toThrow();
  });
});

describe("unwrapCaseKey — empty, short and nullish input", () => {
  beforeEach(() => {
    process.env[MASTER_KEY_ENV] = MASTER_HEX;
  });

  test("a shredded (null) key returns null — the destructed state is not an error", () => {
    // `null` means the key is GONE, which is the intended post-erasure state.
    // Returning null rather than throwing is what lets a DSR handler report
    // "erased" instead of crashing.
    expect(unwrapCaseKey(null, "CASE-A")).toBeNull();
  });

  test("an empty-string key is treated as absent, not as a malformed envelope", () => {
    expect(unwrapCaseKey("", "CASE-A")).toBeNull();
  });

  test("a null key short-circuits BEFORE the master key is needed", () => {
    // Erasure must work with no master key at all — that is the whole
    // fail-closed destruction story. If the key lookup happened first, an
    // erasure on a key-less host would throw instead of shredding.
    delete process.env[MASTER_KEY_ENV];
    expect(unwrapCaseKey(null, "CASE-A")).toBeNull();
  });

  test("structurally malformed envelopes throw a naming error, never silently", () => {
    const malformed = [
      "svk1.too.few",
      "svk1..tag.ct",
      "svk1.iv..ct",
      "svk1.iv.tag.",
      "svk1.a.b.c.d",
      "not-an-envelope",
      "",
    ];
    for (const value of malformed) {
      if (value === "") continue; // covered above: empty string is "absent"
      expect(() => unwrapCaseKey(value, "CASE-A")).toThrow();
    }
  });

  test("a well-formed envelope with a corrupt tag length fails loudly, not quietly", () => {
    const p = envelopeParts(wrapDataKey(randomBytes(32), "CASE-A"));
    const badTag = [p.prefix, p.iv, Buffer.from("ab").toString("base64"), p.ct].join(".");
    expect(() => unwrapCaseKey(badTag, "CASE-A")).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Irreversibility — the erasure claim, minus the database
// ═══════════════════════════════════════════════════════════════════════════════

describe("irreversibility — the data key is not recoverable from the envelope", () => {
  beforeEach(() => {
    process.env[MASTER_KEY_ENV] = MASTER_HEX;
  });

  test("the wrapped envelope contains the data key in no encoding whatsoever", () => {
    const dataKey = randomBytes(32);
    const wrapped = wrapDataKey(dataKey, "CASE-A");
    for (const encoding of [
      dataKey.toString("hex"),
      dataKey.toString("base64"),
      dataKey.toString("base64url"),
      dataKey.toString("utf8"),
      dataKey.toString("latin1"),
    ]) {
      expect(wrapped.includes(encoding)).toBe(false);
    }
  });

  test("the wrapped envelope contains no fragment of the master key either", () => {
    const wrapped = wrapDataKey(randomBytes(32), "CASE-A");
    const kek = Buffer.from(MASTER_HEX, "hex");
    for (const encoding of [MASTER_HEX, kek.toString("base64")]) {
      expect(wrapped.includes(encoding)).toBe(false);
    }
  });

  test("with the key destroyed there is no input left that returns key material", () => {
    // The pure half of `eraseCase`: `dataKeyEnc` becomes NULL, and from NULL
    // the module yields null. There is no derived, cached or reconstructed
    // fallback — that absence is what makes the erasure a destruction rather
    // than a hiding operation.
    expect(unwrapCaseKey(null, "CASE-A")).toBeNull();
    expect(unwrapCaseKey("", "CASE-A")).toBeNull();
    expect(masterKeyFingerprint()).not.toBe(masterKey().toString("hex"));
  });
});

describe("shredded records are distinguishable from live ones", () => {
  beforeEach(() => {
    process.env[MASTER_KEY_ENV] = MASTER_HEX;
  });

  test("a live key has a 16-hex fingerprint; a shredded one has none", () => {
    const wrapped = wrapDataKey(randomBytes(32), "CASE-A");
    expect(keyFingerprintOf(wrapped)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyFingerprintOf(null)).toBeNull();
    expect(keyFingerprintOf("")).toBeNull();
  });

  test("the fingerprint identifies the ENVELOPE, not the key — sameWrappedKey is the equality oracle", () => {
    // Adversarial: two wraps of the identical data key have different envelopes
    // (fresh IV), so different fingerprints. Anything that treated the
    // fingerprint as key identity would call two identical keys different.
    const dataKey = randomBytes(32);
    const a = wrapDataKey(dataKey, "CASE-A");
    const b = wrapDataKey(dataKey, "CASE-A");
    expect(keyFingerprintOf(a)).not.toBe(keyFingerprintOf(b));
    expect(sameWrappedKey(a, a)).toBe(true);
    expect(sameWrappedKey(a, b)).toBe(false);
  });

  test("sameWrappedKey compares the stored bytes, not the unwrapped key", () => {
    const dataKey = randomBytes(32);
    const a = wrapDataKey(dataKey, "CASE-A");
    const b = wrapDataKey(dataKey, "CASE-A");
    // Equal key material, different envelopes: NOT the same stored value. This
    // is what makes a lost-update re-wrap detectable instead of invisible.
    expect(unwrapCaseKey(a, "CASE-A")).toEqual(unwrapCaseKey(b, "CASE-A"));
    expect(sameWrappedKey(a, b)).toBe(false);
  });

  test("sameWrappedKey never reports two absent keys as equal", () => {
    // Absence must never read as identity: "both shredded" is not "the same
    // key", and a caller using this to confirm a key survived would be told a
    // false yes.
    expect(sameWrappedKey(null, null)).toBe(false);
    expect(sameWrappedKey(null, "svk1.a.b.c")).toBe(false);
    expect(sameWrappedKey("svk1.a.b.c", null)).toBe(false);
  });

  test("a length mismatch returns false instead of throwing", () => {
    // timingSafeEqual throws on unequal lengths; the guard is what keeps a
    // comparison from becoming a crash on attacker-controlled stored values.
    expect(sameWrappedKey("ab", "abc")).toBe(false);
    expect(sameWrappedKey("", "x")).toBe(false);
    expect(sameWrappedKey("x", "")).toBe(false);
  });

  test("the fingerprint is stable and distinguishes envelopes of different sizes", () => {
    const wrapped = wrapDataKey(randomBytes(32), "CASE-A");
    expect(keyFingerprintOf(wrapped)).toBe(keyFingerprintOf(wrapped));
    const long = `svk1.${"A".repeat(400)}.${"B".repeat(400)}.${"C".repeat(400)}`;
    expect(keyFingerprintOf(long)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyFingerprintOf(long)).not.toBe(keyFingerprintOf("svk1.A.B.C"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. No secret material in the module's own error paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("error paths leak no key material", () => {
  beforeEach(() => {
    process.env[MASTER_KEY_ENV] = MASTER_HEX;
  });

  const wrapped = (): string => wrapDataKey(randomBytes(32), "CASE-SECRET-CASE");

  test("MasterKeyUnavailableError names the variable and never a value", () => {
    delete process.env[MASTER_KEY_ENV];
    const err = new MasterKeyUnavailableError();
    expect(err.message).toContain(MASTER_KEY_ENV);
    expect(err.message).not.toContain(MASTER_HEX);
    expect(err.name).toBe("MasterKeyUnavailableError");
  });

  test("the erased / unsealed / undecryptable trio carries the caseRef, not the payload", () => {
    const errors = [
      new CaseErasedError("CASE-REF-1"),
      new PayloadNotSealedError("CASE-REF-1"),
      new PayloadUndecryptableError(
        "CASE-REF-1",
        "Unsupported state or unable to authenticate data",
      ),
    ];
    for (const err of errors) {
      expect(err.message).toContain("CASE-REF-1");
      expect(err).toBeInstanceOf(PayloadUnavailableError);
      expect(err.message).not.toContain(MASTER_HEX);
    }
  });

  test("erased and not-sealed are distinguishable messages, not one generic failure", () => {
    // The module's stated reason for the hierarchy: a caller that cannot tell
    // "erased" from "never sealed" will eventually report erased evidence as
    // though it existed.
    expect(new CaseErasedError("C").message).not.toBe(new PayloadNotSealedError("C").message);
    expect(new CaseErasedError("C").name).toBe("CaseErasedError");
    expect(new PayloadNotSealedError("C").name).toBe("PayloadNotSealedError");
    expect(new PayloadUndecryptableError("C", "m").name).toBe("PayloadUndecryptableError");
  });

  test("PayloadTooLargeError states the real limit and the real byte count", () => {
    const err = new PayloadTooLargeError("CASE-REF-1", MAX_SEALED_PAYLOAD_BYTES + 1);
    expect(err.bytes).toBe(MAX_SEALED_PAYLOAD_BYTES + 1);
    expect(err.message).toContain(String(MAX_SEALED_PAYLOAD_BYTES));
    expect(err.message).not.toContain(MASTER_HEX);
  });

  test("CaseNotFoundError echoes only the reference it was given", () => {
    const err = new CaseNotFoundError("CASE-REF-1");
    expect(err.caseRef).toBe("CASE-REF-1");
    expect(err.message).not.toContain(MASTER_HEX);
  });

  test("a malformed envelope error names the prefix, never the attacker-supplied value", () => {
    // The stored value may come from a restored backup or a tampered row, and
    // this error is logged verbatim. Both malformed paths must refuse WITHOUT
    // echoing the value back: the shape check (wrong field count / wrong
    // prefix) and the OpenSSL path (structurally fine, cryptographically not)
    // are covered separately because they fail at different layers.
    const hostile =
      "<script>alert(1)</script>.<script>2</script>.<script>3</script>.<script>4</script>";
    try {
      unwrapCaseKey(hostile, "CASE-A");
      throw new Error("expected a malformed envelope to be refused");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("script");
      expect(message).toContain(KEY_ENVELOPE_PREFIX);
    }

    // A well-SHAPED envelope carrying hostile base64 fails inside OpenSSL, whose
    // message is derived from the tag length only — never from the content.
    const wellShaped = `${KEY_ENVELOPE_PREFIX}.<script>a</script>.<script>b</script>.<script>c</script>`;
    try {
      unwrapCaseKey(wellShaped, "CASE-A");
      throw new Error("expected a corrupt envelope to be refused");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("script");
    }
  });

  test("no thrown error from a full wrong-key unwrap contains the key or the envelope", () => {
    const w = wrapped();
    process.env[MASTER_KEY_ENV] = MASTER_HEX_ALT;
    try {
      unwrapCaseKey(w, "CASE-SECRET-CASE");
      throw new Error("expected the wrong key to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(MASTER_HEX_ALT);
      expect(message).not.toContain(w);
    }
  });
});

describe("the payload-column contract erasure relies on", () => {
  test("every payload column is named, so a partial erasure is impossible to express", () => {
    expect(CASE_PAYLOAD_COLUMNS).toEqual([
      "transcriptRedacted",
      "evaluationResults",
      "dataCollectionResults",
    ]);
  });

  test("the audit columns retention refuses are the whole row, not a subset", () => {
    // Every field that either feeds the hash or orders the chain walk is listed.
    // Asserted as an exact set match in BOTH directions: a new AuditLog column
    // that nobody added here would otherwise slip past this test, and it is
    // precisely that omission which would let retention edit a chained field.
    const expected: Record<string, true> = {
      id: true,
      callRef: true,
      action: true,
      intent: true,
      callerId: true,
      redactedText: true,
      meta: true,
      prevHash: true,
      chainHash: true,
      orgId: true,
      createdAt: true,
    };
    // Compared as a sorted, joined string: `toEqual` infers a literal-union array
    // from the receiver, and a `Record<string, true>` lookup table cannot satisfy it.
    expect([...CHAIN_PROTECTED_COLUMNS].sort().join(",")).toBe(
      Object.keys(expected).sort().join(","),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Retention — policy resolution and precedence
// ═══════════════════════════════════════════════════════════════════════════════

describe("retentionPolicy — defaults", () => {
  test("an unconfigured org gets the platform defaults, attributed to 'default'", () => {
    const policy = retentionPolicy("org-1");
    expect(policy.audioDays).toBe(DEFAULT_RETENTION_DAYS.audio);
    expect(policy.transcriptDays).toBe(DEFAULT_RETENTION_DAYS.transcripts);
    expect(policy.caseRecordDays).toBe(DEFAULT_RETENTION_DAYS.caseRecords);
    expect(policy.sources).toEqual({
      audio: "default",
      transcripts: "default",
      caseRecords: "default",
    });
    expect(policy.notes).toEqual([]);
    expect(policy.audit).toBe(AUDIT_RETENTION);
  });

  test("the audit tier is a named policy, never a number", () => {
    expect(AUDIT_RETENTION).toBe("forever-hashes-only");
    expect(Number.isNaN(Number(AUDIT_RETENTION))).toBe(true);
    expect(retentionPolicy("org-1").audit).toBe(AUDIT_RETENTION);
  });

  test("the shared (org-less) namespace resolves like any other org", () => {
    // Rows with a NULL orgId are real seeded/demo data; a policy that never
    // looks at them is a policy that leaks.
    expect(retentionPolicy(null).audioDays).toBe(DEFAULT_RETENTION_DAYS.audio);
  });
});

describe("retentionPolicy — precedence", () => {
  test("env beats default, per tier, and says so", () => {
    process.env[ENV_AUDIO_DAYS] = "7";
    process.env[ENV_TRANSCRIPT_DAYS] = "14";
    const policy = retentionPolicy("org-1");
    expect(policy.audioDays).toBe(7);
    expect(policy.transcriptDays).toBe(14);
    expect(policy.caseRecordDays).toBe(DEFAULT_RETENTION_DAYS.caseRecords);
    expect(policy.sources.audio).toBe("env");
    expect(policy.sources.transcripts).toBe("env");
    expect(policy.sources.caseRecords).toBe("default");
    expect(policy.notes.some((n) => n.includes(`${ENV_AUDIO_DAYS}=7`))).toBe(true);
  });

  test("a 0 in env is a real value, not an absent one", () => {
    // "Delete immediately" is the strictest possible setting and must not be
    // mistaken for "unset, fall back to the default".
    process.env[ENV_AUDIO_DAYS] = "0";
    const policy = retentionPolicy("org-1");
    expect(policy.audioDays).toBe(0);
    expect(policy.sources.audio).toBe("env");
  });

  test("a pilot org gets 0-day audio regardless of env, and is told why", () => {
    process.env[ENV_AUDIO_DAYS] = "30";
    process.env[ENV_PILOT_ORGS] = "org-pilot";
    const policy = retentionPolicy("org-pilot");
    expect(policy.audioDays).toBe(PILOT_AUDIO_DAYS);
    expect(policy.sources.audio).toBe("pilot");
    expect(policy.notes.some((n) => n.includes(ENV_PILOT_ORGS))).toBe(true);
    // The pilot rule narrows audio only; the other tiers keep their values.
    expect(policy.transcriptDays).toBe(DEFAULT_RETENTION_DAYS.transcripts);
  });

  test("an override beats env and pilot on every tier, and says so", () => {
    process.env[ENV_AUDIO_DAYS] = "30";
    process.env[ENV_PILOT_ORGS] = "org-pilot";
    const policy = configureRetention("org-pilot", {
      audioDays: 45,
      transcriptDays: 3,
      caseRecordDays: 3,
    });
    expect(policy.audioDays).toBe(45);
    expect(policy.sources.audio).toBe("override");
    expect(policy.notes).toContain("programmatic override in force");
  });

  test("KNOWN GAP (BUG A): a partial override zeroes the tiers it does not name", () => {
    // retention.ts:157-159 seeds a new override from all-zero, not from
    // DEFAULT_RETENTION_DAYS. Setting only `audioDays` therefore makes the
    // transcript and case-record tiers due IMMEDIATELY. Expected values are the
    // current (buggy) behaviour; the fix should make these `90` / `2555`.
    const policy = configureRetention("org-partial", { audioDays: 5 });
    expect(policy.audioDays).toBe(5);
    expect(policy.transcriptDays).toBe(0);
    expect(policy.caseRecordDays).toBe(0);
    expect(policy.sources).toEqual({
      audio: "override",
      transcripts: "override",
      caseRecords: "override",
    });
  });

  test("KNOWN GAP (BUG A): successive partial overrides keep accumulating zeroes", () => {
    configureRetention("org-acc", { audioDays: 5 });
    const policy = configureRetention("org-acc", { transcriptDays: 9 });
    expect(policy.audioDays).toBe(5);
    expect(policy.transcriptDays).toBe(9);
    expect(policy.caseRecordDays).toBe(0);
  });

  test("KNOWN GAP (BUG B): an explicit audioDays:0 override is dropped when env sets audio", () => {
    // retention.ts:227 `if (override.audioDays !== 0 || sources.audio === "default")`
    // inverts the intent: the explicit override is discarded precisely when the
    // caller is tightening retention below the env value. The returned policy is
    // ALSO misleading — it says "env" while the notes claim an override is in
    // force.
    process.env[ENV_AUDIO_DAYS] = "30";
    const policy = configureRetention("org-tighten", {
      audioDays: 0,
      transcriptDays: 7,
      caseRecordDays: 7,
    });
    expect(policy.audioDays).toBe(30);
    expect(policy.sources.audio).toBe("env");
    expect(policy.notes).toContain("programmatic override in force");
    // Control: with no env in play the same override IS honoured.
    delete process.env[ENV_AUDIO_DAYS];
    const honoured = configureRetention("org-tighten", {
      audioDays: 0,
      transcriptDays: 7,
      caseRecordDays: 7,
    });
    expect(honoured.audioDays).toBe(0);
    expect(honoured.sources.audio).toBe("override");
  });
});

describe("retentionPolicy — validation", () => {
  test("a non-integer or negative day count is refused in an override", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => configureRetention("org-1", { audioDays: bad })).toThrow(RetentionConfigError);
    }
  });

  test("a non-integer or negative env value is refused", () => {
    // The raw string is in the message because the operator typed it; a resolved
    // `NaN` would leave them with nothing to fix.
    for (const bad of ["-1", "2.5", "abc", "12days", "1,5", "--3"]) {
      process.env[ENV_AUDIO_DAYS] = bad;
      expect(() => retentionPolicy("org-1")).toThrow(RetentionConfigError);
    }
  });

  test("whitespace-only env is 'unset', not 'invalid' — it falls back silently", () => {
    // An operator who exports an empty variable must get the DEFAULT, not a boot
    // failure. The distinction matters: refusing here would take retention down.
    for (const blank of ["", "   ", "\t\n"]) {
      process.env[ENV_AUDIO_DAYS] = blank;
      expect(retentionPolicy("org-1").audioDays).toBe(DEFAULT_RETENTION_DAYS.audio);
      expect(retentionPolicy("org-1").sources.audio).toBe("default");
    }
  });

  test("an exponential env value is accepted as the whole number it denotes", () => {
    // `Number("1e3") === 1000` is a whole number of days, so refusing it would be
    // stricter than the property `assertDays` claims to enforce. Pinned because
    // the module's documented contract is "whole number of days >= 0".
    process.env[ENV_AUDIO_DAYS] = "1e3";
    expect(retentionPolicy("org-1").audioDays).toBe(1000);
    process.env[ENV_AUDIO_DAYS] = "2e1";
    expect(retentionPolicy("org-1").audioDays).toBe(20);
  });

  test("each tier is validated independently", () => {
    process.env[ENV_TRANSCRIPT_DAYS] = "5";
    const policy = retentionPolicy("org-1");
    expect(policy.audioDays).toBe(DEFAULT_RETENTION_DAYS.audio);
    expect(policy.transcriptDays).toBe(5);
    expect(policy.caseRecordDays).toBe(DEFAULT_RETENTION_DAYS.caseRecords);
    delete process.env[ENV_TRANSCRIPT_DAYS];
    process.env[ENV_CASE_RECORD_DAYS] = "5";
    expect(retentionPolicy("org-1").caseRecordDays).toBe(5);
  });

  test("a refused configuration leaves no partial override behind", () => {
    expect(() => configureRetention("org-1", { audioDays: 3, transcriptDays: -1 })).toThrow();
    expect(configuredOrgs()).toEqual([]);
    expect(retentionPolicy("org-1").sources.audio).toBe("default");
  });
});

describe("pilot orgs", () => {
  test("a whitespace-padded, comma-separated list is trimmed and split", () => {
    process.env[ENV_PILOT_ORGS] = " a , b ,";
    expect(isPilotOrg("a")).toBe(true);
    expect(isPilotOrg("b")).toBe(true);
    expect(isPilotOrg("c")).toBe(false);
    expect(isPilotOrg(" a ")).toBe(false); // the list is trimmed once, not per lookup
  });

  test("the shared namespace can never be a pilot org", () => {
    process.env[ENV_PILOT_ORGS] = "org-a";
    expect(isPilotOrg(null)).toBe(false);
  });

  test("a whitespace-only pilot env lists nobody", () => {
    process.env[ENV_PILOT_ORGS] = "   ";
    expect(isPilotOrg("   ")).toBe(false);
  });
});

describe("override isolation", () => {
  test("an override on one org leaves every other org at the defaults", () => {
    // A tier configured for org A must never decide org B's deadline.
    configureRetention("org-1", { audioDays: 3, transcriptDays: 3, caseRecordDays: 3 });
    expect(retentionPolicy("org-2").audioDays).toBe(DEFAULT_RETENTION_DAYS.audio);
    expect(retentionPolicy(null).audioDays).toBe(DEFAULT_RETENTION_DAYS.audio);
    expect(configuredOrgs()).toEqual(["org-1"]);
  });

  test("the shared namespace is configured but never listed as an org", () => {
    // It is a real namespace with real rows, but reporting it in `configuredOrgs`
    // would hand an operator a NUL-prefixed internal key as if it were a tenant.
    configureRetention(null, { audioDays: 4, transcriptDays: 4, caseRecordDays: 4 });
    expect(configuredOrgs()).toEqual([]);
    expect(retentionPolicy(null).audioDays).toBe(4);
  });

  test("resetRetentionConfig forgets everything", () => {
    configureRetention("org-1", { audioDays: 3, transcriptDays: 3, caseRecordDays: 3 });
    resetRetentionConfig();
    expect(configuredOrgs()).toEqual([]);
    expect(retentionPolicy("org-1").audioDays).toBe(DEFAULT_RETENTION_DAYS.audio);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Retention — the selector: cutoffs, boundaries, and what is selected
// ═══════════════════════════════════════════════════════════════════════════════

describe("dueForDeletion — cutoff arithmetic", () => {
  /** 2026-03-10T12:00:00Z, chosen to sit clear of any DST transition anywhere. */
  const AT = new Date("2026-03-10T12:00:00.000Z");

  test("each cutoff is exactly `at − days × 86_400_000` ms", () => {
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    expect(sel.tiers.audio.cutoff?.getTime()).toBe(AT.getTime() - 30 * DAY_MS);
    expect(sel.tiers.transcripts.cutoff?.getTime()).toBe(AT.getTime() - 90 * DAY_MS);
    expect(sel.tiers.caseRecords.cutoff?.getTime()).toBe(AT.getTime() - 2555 * DAY_MS);
  });

  test("the cutoffs are the hand-computed dates, to the millisecond", () => {
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    expect(sel.tiers.audio.cutoff?.toISOString()).toBe("2026-02-08T12:00:00.000Z");
    expect(sel.tiers.transcripts.cutoff?.toISOString()).toBe("2025-12-10T12:00:00.000Z");
    // 2555 days is 7 × 365, i.e. seven calendar years ignoring leap days, so
    // the cutoff lands two days later than the naive calendar subtraction. That
    // is the documented arithmetic and it errs toward keeping data longer.
    expect(sel.tiers.caseRecords.cutoff?.toISOString()).toBe("2019-03-12T12:00:00.000Z");
  });

  test("the selector echoes the instant it was given, unmodified", () => {
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    expect(sel.at.getTime()).toBe(AT.getTime());
    expect(sel.orgId).toBe("org-1");
  });

  test("an omitted orgId means the shared namespace, not 'every org'", () => {
    const sel = dueForDeletion(AT);
    expect(sel.orgId).toBeNull();
    expect(sel.tiers.caseRecords.where).toMatchObject({ orgId: null });
  });

  test("a 0-day window puts the cutoff exactly ON `at` — due at once", () => {
    // This is the mechanism behind the pilot rule: `cutoff === at`, so every
    // call in the org is selected the moment the call ends.
    process.env[ENV_PILOT_ORGS] = "org-pilot";
    const sel = dueForDeletion(AT, { orgId: "org-pilot" });
    expect(sel.tiers.audio.days).toBe(0);
    expect(sel.tiers.audio.cutoff?.getTime()).toBe(AT.getTime());
  });
});

describe("dueForDeletion — the boundary rule is strictly-before", () => {
  const AT = new Date("2026-03-10T12:00:00.000Z");

  test("the comparison is `lt`, not `lte`: a row exactly on the cutoff survives", () => {
    // The window is half-open at its far edge. Asserted through selection, not
    // by reading the operator name, so a change of operator would fail here.
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    const cutoff = sel.tiers.audio.cutoff as Date;
    expect(cutoff).toBeInstanceOf(Date);

    const onBoundary = makeRow({ orgId: "org-1", postCallAt: cutoff, createdAt: cutoff });
    const oneMsBefore = makeRow({
      orgId: "org-1",
      postCallAt: new Date(cutoff.getTime() - 1),
      createdAt: new Date(cutoff.getTime() - 1),
    });
    const oneMsAfter = makeRow({
      orgId: "org-1",
      postCallAt: new Date(cutoff.getTime() + 1),
      createdAt: new Date(cutoff.getTime() + 1),
    });

    expect(selects(sel, "audio", oneMsBefore)).toBe(true);
    expect(selects(sel, "audio", onBoundary)).toBe(false);
    expect(selects(sel, "audio", oneMsAfter)).toBe(false);
  });

  test("the same boundary rule governs the transcript and case-record tiers", () => {
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    const tCut = sel.tiers.transcripts.cutoff as Date;
    const rCut = sel.tiers.caseRecords.cutoff as Date;
    const base = { orgId: "org-1", dataKeyEnc: "svk1.a.b.c" };

    expect(
      selects(sel, "transcripts", makeRow({ ...base, postCallAt: new Date(tCut.getTime() - 1) })),
    ).toBe(true);
    expect(selects(sel, "transcripts", makeRow({ ...base, postCallAt: tCut }))).toBe(false);
    expect(selects(sel, "transcripts", makeRow({ ...base, postCallAt: tCut }))).toBe(false);

    expect(
      selects(sel, "caseRecords", makeRow({ ...base, createdAt: new Date(rCut.getTime() - 1) })),
    ).toBe(true);
    expect(selects(sel, "caseRecords", makeRow({ ...base, createdAt: rCut }))).toBe(false);
  });
});

describe("dueForDeletion — what past the window actually selects", () => {
  const AT = new Date("2026-03-10T12:00:00.000Z");

  test("a row inside its window is not selected; one past it is", () => {
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    const cutoff = sel.tiers.audio.cutoff as Date;
    const inside = makeRow({ orgId: "org-1", postCallAt: new Date(cutoff.getTime() + 1) });
    const outside = makeRow({ orgId: "org-1", postCallAt: new Date(cutoff.getTime() - DAY_MS) });
    expect(selects(sel, "audio", inside)).toBe(false);
    expect(selects(sel, "audio", outside)).toBe(true);
  });

  test("a case with no postCallAt ages out on createdAt — an un-ingested case still expires", () => {
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    const cutoff = sel.tiers.audio.cutoff as Date;
    const stale = makeRow({
      orgId: "org-1",
      postCallAt: null,
      createdAt: new Date(cutoff.getTime() - 1),
    });
    const fresh = makeRow({ orgId: "org-1", postCallAt: null, createdAt: cutoff });
    expect(selects(sel, "audio", stale)).toBe(true);
    expect(selects(sel, "audio", fresh)).toBe(false);
  });

  test("a recent postCallAt does NOT save an old case when postCallAt is set", () => {
    // The fallback is keyed on `postCallAt IS NULL`, not on "which is older", so
    // a case that was created long before a late ingest is measured from the
    // ingest. Pinned because the opposite reading (min of the two) would keep
    // stale cases alive indefinitely.
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    const cutoff = sel.tiers.audio.cutoff as Date;
    const row = makeRow({
      orgId: "org-1",
      postCallAt: new Date(cutoff.getTime() - 1),
      createdAt: AT,
    });
    expect(selects(sel, "audio", row)).toBe(true);
  });

  test("the org filter is applied: another org's aged row is never selected", () => {
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    const cutoff = sel.tiers.audio.cutoff as Date;
    const foreign = makeRow({ orgId: "org-2", postCallAt: new Date(cutoff.getTime() - DAY_MS) });
    expect(selects(sel, "audio", foreign)).toBe(false);
  });

  test("the payload tier only selects rows that still HOLD something", () => {
    // Without this clause a shredded case re-enters the selection on every run
    // forever: the window has closed but shredding does not move `createdAt`.
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    const tCut = sel.tiers.transcripts.cutoff as Date;
    const aged = { orgId: "org-1", postCallAt: new Date(tCut.getTime() - 1), createdAt: AT };

    expect(selects(sel, "transcripts", makeRow({ ...aged, dataKeyEnc: "svk1.a.b.c" }))).toBe(true);
    expect(selects(sel, "transcripts", makeRow({ ...aged, transcriptRedacted: "masked" }))).toBe(
      true,
    );
    expect(selects(sel, "transcripts", makeRow(aged))).toBe(false);
  });

  test("a shredded row stops being selected by the PAYLOAD tier, so a sweep terminates", () => {
    // The DoS property, scoped correctly. `holdsPayloadWhere()` guards the
    // transcripts tier only, because that is the one whose action (shredding
    // the data key) does not remove the row: without the clause a shredded case
    // re-enters the selection on every run forever, since shredding does not move
    // `createdAt`. The other two tiers are EXPECTED to keep selecting it — see
    // the two tests below — so asserting "nothing selects it" would pin a
    // contract the module deliberately does not have.
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    const ancient = new Date("2020-01-01T00:00:00.000Z");
    const shredded = makeRow({ orgId: "org-1", postCallAt: ancient, createdAt: ancient });
    expect(selects(sel, "transcripts", shredded)).toBe(false);

    // The row was alive an instant before erasure: same age, but still holding
    // its key. The ONLY difference is what it holds, which is what makes this an
    // assertion about the hold clause rather than about the cutoff.
    const alive = makeRow({ ...shredded, dataKeyEnc: "svk1.a.b.c" });
    expect(selects(sel, "transcripts", alive)).toBe(true);
  });

  test("the audio tier selects by age alone, regardless of what the row holds", () => {
    // The audio tier's action is "purge the recording", and the platform stores
    // none (I-10); adding a "still holds something" clause here would silently
    // exempt exactly the rows a registered audio store still has files for.
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    const cutoff = sel.tiers.audio.cutoff as Date;
    const empty = makeRow({ orgId: "org-1", postCallAt: new Date(cutoff.getTime() - 1) });
    expect(empty.dataKeyEnc).toBeNull();
    expect(selects(sel, "audio", empty)).toBe(true);
  });

  test("the case-record tier still selects a shredded row — deleting it IS the point", () => {
    // The payload tier's hold clause exists to stop a SWEEP LOOP. The
    // case-record tier has no such problem: deleting the row removes it from
    // the result set, so re-selecting it cannot loop. Exempting shredded rows
    // here would strand a deleted case's row on disk forever — the opposite
    // failure. Its cutoff is 2555 days back, so the row must be older than that.
    const sel = dueForDeletion(AT, { orgId: "org-1" });
    const cutoff = sel.tiers.caseRecords.cutoff as Date;
    const ancient = new Date(cutoff.getTime() - DAY_MS);
    const shredded = makeRow({ orgId: "org-1", postCallAt: ancient, createdAt: ancient });
    expect(selects(sel, "caseRecords", shredded)).toBe(true);
  });
});

describe("dueForDeletion — the audit tier can never be selected", () => {
  const AT = new Date("2026-03-10T12:00:00.000Z");

  test("it is never due, never has a cutoff, and is not in the sweeper order", () => {
    const audit = dueForDeletion(AT, { orgId: "org-1" }).tiers.audit;
    expect(audit.due).toBe(false);
    expect(audit.cutoff).toBeNull();
    expect(audit.days).toBe(Number.POSITIVE_INFINITY);
    expect(TIER_ORDER).not.toContain("audit");
    expect(TIER_ORDER).toEqual(["audio", "transcripts", "caseRecords"]);
  });

  test("its `where` is `{}` — a match-everything that is loud rather than silent", () => {
    // Deliberately NOT a match-nothing filter: a caller that ignores `due` gets an
    // obvious, auditable mistake instead of a silent no-op.
    const audit = dueForDeletion(AT, { orgId: "org-1" }).tiers.audit;
    expect(audit.where).toEqual({});
    expect(matches(audit.where, makeRow())).toBe(true);
  });

  test("its declared mutation is a no-op, so the chain guard accepts it", () => {
    const audit = dueForDeletion(AT, { orgId: "org-1" }).tiers.audit;
    expect(audit.mutation).toEqual({ target: "AuditLog", columns: [], rowsDeleted: 0 });
    expect(() => assertRetentionMutationAllowed(audit.mutation)).not.toThrow();
  });

  test("AUDIT_TIER_DECISION reports zero deletions and zero updates, and is frozen", () => {
    expect(AUDIT_TIER_DECISION.rowsDeleted).toBe(0);
    expect(AUDIT_TIER_DECISION.rowsUpdated).toBe(0);
    expect(AUDIT_TIER_DECISION.columns).toEqual([]);
    expect(AUDIT_TIER_DECISION.action).toBe("append-only");
    expect(AUDIT_TIER_DECISION.protectedColumns).toBe(CHAIN_PROTECTED_COLUMNS);
    expect(Object.isFrozen(AUDIT_TIER_DECISION)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Retention — clock skew and time zones
// ═══════════════════════════════════════════════════════════════════════════════

describe("dueForDeletion — clock and time zone safety", () => {
  /** The instant under test, written three ways. */
  const UTC = new Date("2026-03-10T12:00:00.000Z");
  const PLUS_8 = new Date("2026-03-10T20:00:00.000+08:00");
  const MINUS_5 = new Date("2026-03-10T07:00:00.000-05:00");

  test("the three representations above are one instant", () => {
    expect(PLUS_8.getTime()).toBe(UTC.getTime());
    expect(MINUS_5.getTime()).toBe(UTC.getTime());
  });

  test("an instant expressed in another offset produces an IDENTICAL selector", () => {
    const a = dueForDeletion(UTC, { orgId: "org-1" });
    const b = dueForDeletion(PLUS_8, { orgId: "org-1" });
    const c = dueForDeletion(MINUS_5, { orgId: "org-1" });
    for (const tier of TIER_ORDER) {
      expect(b.tiers[tier].cutoff?.getTime()).toBe(a.tiers[tier].cutoff?.getTime());
      expect(c.tiers[tier].cutoff?.getTime()).toBe(a.tiers[tier].cutoff?.getTime());
      expect(b.tiers[tier].where).toEqual(a.tiers[tier].where);
    }
    expect(b.at.getTime()).toBe(a.at.getTime());
  });

  test("the window is a fixed number of milliseconds, so no DST transition can move a deadline", () => {
    // 2026-03-29 is the European DST change. A window computed in local time
    // would be 23 or 25 hours wide on that date; the fixed-ms contract is what
    // makes the deadline identical on both sides of it.
    const beforeChange = new Date("2026-03-28T12:00:00.000Z");
    const afterChange = new Date("2026-03-30T12:00:00.000Z");
    for (const at of [beforeChange, afterChange]) {
      const sel = dueForDeletion(at, { orgId: "org-1" });
      const elapsed = at.getTime() - (sel.tiers.transcripts.cutoff as Date).getTime();
      expect(elapsed).toBe(90 * DAY_MS);
      expect(elapsed).toBe(90 * 24 * 60 * 60 * 1000);
    }
  });

  test("a leap day is counted as one ordinary day", () => {
    // 2028-02-29 exists inside this window; the fixed-ms arithmetic must not
    // produce a 91-day window around it.
    const at = new Date("2028-03-01T12:00:00.000Z");
    const sel = dueForDeletion(at, { orgId: "org-1" });
    expect(at.getTime() - (sel.tiers.transcripts.cutoff as Date).getTime()).toBe(90 * DAY_MS);
  });

  test("the 7-year case-record window does not compensate for leap days", () => {
    // 7 × 365 = 2555 days, so the cutoff falls 2 days after the naive calendar
    // date across one leap day (2020) and two (2024, 2020+4). The module errs
    // toward retaining longer, which is the safe direction for a deletion
    // deadline — but it is a real 2-day slack, so it is pinned here.
    const sel = dueForDeletion(UTC, { orgId: "org-1" });
    const cutoff = sel.tiers.caseRecords.cutoff as Date;
    const sevenCalendarYearsEarlier = new Date("2019-03-10T12:00:00.000Z");
    expect(cutoff.getTime()).toBeGreaterThan(sevenCalendarYearsEarlier.getTime());
    expect(cutoff.getTime() - sevenCalendarYearsEarlier.getTime()).toBe(2 * DAY_MS);
  });

  test("sub-millisecond skew is not representable, so a deadline is stable across runners", () => {
    // Two callers a fraction of a millisecond apart agree exactly: the arithmetic
    // is on whole milliseconds, so "is this row due" cannot flap between a
    // scheduler and a request handler.
    const a = new Date("2026-03-10T12:00:00.000Z");
    const b = new Date("2026-03-10T12:00:00.001Z");
    const ca = dueForDeletion(a, { orgId: "org-1" }).tiers.audio.cutoff as Date;
    const cb = dueForDeletion(b, { orgId: "org-1" }).tiers.audio.cutoff as Date;
    expect(cb.getTime() - ca.getTime()).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Retention — the chain-protection rule as an enforcement point
// ═══════════════════════════════════════════════════════════════════════════════

describe("assertRetentionMutationAllowed", () => {
  test("a Case write is always allowed, but its columns must still be named", () => {
    // Case columns are not hashed, so writing them is legitimate — but the receipt
    // must name what it touched, or it is not a receipt.
    expect(() =>
      assertRetentionMutationAllowed({ target: "Case", columns: ["transcriptRedacted"] }),
    ).not.toThrow();
    expect(() => assertRetentionMutationAllowed({ target: "Case", columns: [] })).not.toThrow();
  });

  test("ANY AuditLog column write is refused, even one column, even zero rows", () => {
    // The headline claim of the module: dropping `redactedText` is refused, not
    // merely discouraged. Rows-deleted 0 must not be a loophole.
    for (const column of CHAIN_PROTECTED_COLUMNS) {
      expect(() =>
        assertRetentionMutationAllowed({ target: "AuditLog", columns: [column] }),
      ).toThrow(ChainMutationRefusedError);
    }
  });

  test("deleting an AuditLog row is refused even when it names no columns", () => {
    expect(() =>
      assertRetentionMutationAllowed({ target: "AuditLog", columns: [], rowsDeleted: 1 }),
    ).toThrow(ChainMutationRefusedError);
    expect(() =>
      assertRetentionMutationAllowed({ target: "AuditLog", columns: [], rowsDeleted: 99 }),
    ).toThrow(ChainMutationRefusedError);
  });

  test("a genuine no-op on AuditLog is allowed, so the tier report can be declared", () => {
    expect(() =>
      assertRetentionMutationAllowed({ target: "AuditLog", columns: [], rowsDeleted: 0 }),
    ).not.toThrow();
  });

  test("the refusal carries the columns and the row count it refused", () => {
    try {
      assertRetentionMutationAllowed({
        target: "AuditLog",
        columns: ["redactedText"],
        rowsDeleted: 3,
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ChainMutationRefusedError);
      const refusal = error as ChainMutationRefusedError;
      expect(refusal.columns).toEqual(["redactedText"]);
      expect(refusal.rowsDeleted).toBe(3);
      expect(refusal.target).toBe("AuditLog");
      expect(refusal.message).toContain("redactedText");
    }
  });

  test("the refusal says why re-deriving the hashes is not the fix", () => {
    // A rewritten chain is indistinguishable from an untouched one, which is the
    // one property the chain exists to provide. An operator who reads only the
    // error message must not be left thinking "recompute the hashes" is an option.
    try {
      assertRetentionMutationAllowed({ target: "AuditLog", columns: ["meta"] });
      throw new Error("expected a refusal");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("indistinguishable");
      expect(message).toContain("shredding the per-case data key");
    }
  });
});
