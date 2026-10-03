/**
 * WP-15 GATE — data protection and retention (crypto-shredding + retention).
 *
 *   cd C:\Users\HP\Desktop\SecureVoiceai
 *   $env:TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/securevoice_test?connection_limit=20"
 *   bun test tests/privacy/privacy.test.ts
 *
 * What this file proves, and why each proof is load-bearing:
 *
 *   1. The per-case data key is UNIQUE per case — two cases in the same org do
 *      not share key material, so destroying one case's key provably cannot
 *      affect the other. Checked on the raw key bytes (an implementation that
 *      derived every key from one secret would pass a fingerprint comparison),
 *      plus an independent node:crypto decrypt that must FAIL, proving the
 *      caseRef is bound in as AAD.
 *   2. The stored ciphertext never contained the plaintext — asserted against
 *      every audit row for the case, the raw base64-decoded ciphertext bytes,
 *      and the sealed envelope fields.
 *   3. Erasure destroys the plaintext: the columns are NULL, the wrapped key is
 *      gone, and reading the payload afterwards THROWS instead of returning an
 *      empty string (a caller that cannot tell "erased" from "empty" will
 *      eventually report erased evidence as if it existed).
 *   4. INVARIANT I-6 — the chain still verifies FROM GENESIS after erasure, and
 *      every pre-existing chained row is BYTE-IDENTICAL. A negative control
 *      tampers with one row and asserts verifyChain() reports it, so (4) cannot
 *      pass vacuously.
 *   5. Retention deletes on schedule per tier, and a 0-day audio policy (the
 *      pilot rule) deletes immediately while the 30-day default does not.
 *   6. A retention run cannot break the audit chain — same byte-identity check,
 *      plus the sweeper's own post-run verification of every chain it touched.
 *   7. The rule that reconciles erasure with immutability is ENFORCED, not
 *      documented: retention is refused any AuditLog mutation, including the
 *      tempting `redactedText` drop that would silently break the chain.
 *
 * Honesty rules: every destructive action is RUN-scoped (`caseRef` prefixed with
 * this run id) and cleaned up in afterAll; every `runRetention()` call passes an
 * explicit `orgIds` so this gate can never sweep another org's rows (including
 * the shared namespace) while other agents work in the same database.
 */

import { afterAll, expect, test } from "bun:test";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { db } from "@/lib/db";
import { append, verifyChain } from "@/lib/audit-chain";
import {
  AUDIT_INTENT_ERASED,
  CaseErasedError,
  CHAIN_PROTECTED_COLUMNS,
  MasterKeyUnavailableError,
  deleteCaseRecord,
  ensureCaseKey,
  eraseCase,
  keyFingerprintOf,
  masterKey,
  masterKeyConfigured,
  masterKeyFingerprint,
  readCasePayload,
  sameWrappedKey,
  sealCasePayload,
  sealedRowFor,
  casePrivacyState,
  unwrapCaseKey,
} from "@/lib/privacy/crypto-shred";
import {
  AUDIT_RETENTION,
  AUDIT_TIER_DECISION,
  ChainMutationRefusedError,
  DEFAULT_RETENTION_DAYS,
  DAY_MS,
  ENV_PILOT_ORGS,
  assertRetentionMutationAllowed,
  audioStoreConfigured,
  configureRetention,
  dueForDeletion,
  isPilotOrg,
  registerAudioStore,
  retentionPolicy,
  resetRetentionConfig,
  runRetention,
  type AudioArtifact,
  type AudioStore,
} from "@/lib/privacy/retention";

// ── Run identity ──────────────────────────────────────────────────────────────

const RUN = Date.now().toString(36);
const ORG_DEFAULT = `org-privacy-default-${RUN}`;
const ORG_PILOT = `org-privacy-pilot-${RUN}`;
const ORG_OVERRIDE = `org-privacy-override-${RUN}`;
const MY_ORGS: (string | null)[] = [ORG_DEFAULT, ORG_PILOT, ORG_OVERRIDE];

/** A run-scoped master key. Deterministic per run, never reused, never logged. */
const TEST_MASTER_KEY = createHash("sha256").update(`wp15-test-master:${RUN}`).digest("hex");
process.env.PRIVACY_MASTER_KEY = TEST_MASTER_KEY;
// The pilot org is declared to retention through the ENV surface, so the gate
// exercises the declarative path an operator would actually use.
process.env[ENV_PILOT_ORGS] = ORG_PILOT;

const EVIDENCE_PATH = resolve(process.cwd(), "evidence/privacy/privacy.json");

/** Chain appends share a millisecond-resolution `createdAt`; two appends inside
 *  one millisecond make `audit-chain` read an ambiguous head. Pace them. */
const pace = (): Promise<void> => Bun.sleep(4);

// ── Network tripwire (counted, not thrown at setup: the audit chain's realtime
//    bridge is loaded lazily and must not fail a privacy gate) ────────────────
const REAL_FETCH = globalThis.fetch;
let HTTP_CALLS = 0;
globalThis.fetch = ((input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
  HTTP_CALLS += 1;
  throw new Error(`WP-15 GATE: real network call attempted to ${url}`);
}) as unknown as typeof fetch;

// ── Check collector (evidence is written from these, before assertions) ───────

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}
const passCount = () => checks.filter((c) => c.ok).length;
const failCount = () => checks.filter((c) => !c.ok).length;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRANSCRIPT =
  "[user] my card is 4271 1381 3381 1081 and I never called you [agent] we are freezing it";
const ANALYSIS = {
  verified_caller: false,
  spoofed_number: true,
  notes: "caller claimed to be the bank",
};
/** A string that appears nowhere except inside the plaintext we seal. */
const PLAINTEXT_MARKER = "4271 1381 3381 1081";
const SEALED_MARKER = "svp1";

type CaseFixture = { caseRef: string; orgId: string | null; ageDays: number };

async function createCase(input: {
  caseRef: string;
  orgId: string | null;
  ageDays?: number;
  transcript?: string | null;
  analysis?: unknown;
  withPostCall?: boolean;
}): Promise<void> {
  const ageMs = Math.round((input.ageDays ?? 0) * DAY_MS);
  const createdAt = new Date(Date.now() - ageMs);
  await db.case.create({
    data: {
      caseRef: input.caseRef,
      orgId: input.orgId,
      state: "CLOSED",
      createdAt,
      updatedAt: createdAt,
      ...(input.withPostCall === false ? {} : { postCallAt: createdAt }),
      transcriptRedacted: input.transcript ?? null,
      evaluationResults: input.analysis === undefined ? null : JSON.stringify(input.analysis),
      dataCollectionResults: null,
    },
    select: { id: true },
  });
}

const ref = (name: string): string => `SV-P-${RUN}-${name}`;

/** Seed a pre-existing chain so erasure has something immutable to preserve. */
async function seedChain(caseRef: string, orgId: string | null, rows: number): Promise<void> {
  for (let i = 0; i < rows; i++) {
    await append(
      {
        callRef: caseRef,
        action: "agent",
        intent: `pre_${i}`,
        callerId: "caller-1",
        // Redacted at write time, exactly as production does (I-10).
        redactedText: `[user] card ${i} [REDACTED] step ${i}`,
        meta: { step: i, lang: "en" },
        orgId: orgId ?? undefined,
      },
      { fast: true },
    );
    await pace();
  }
}

type ChainRowSnapshot = {
  id: string;
  action: string;
  intent: string | null;
  callerId: string | null;
  redactedText: string | null;
  meta: string | null;
  prevHash: string | null;
  chainHash: string;
  orgId: string | null;
  createdAt: string;
};

/** Every chained byte of every row for a caseRef — the thing that must not move. */
async function chainSnapshot(caseRef: string): Promise<ChainRowSnapshot[]> {
  const rows = await db.auditLog.findMany({
    where: { callRef: caseRef },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    intent: r.intent,
    callerId: r.callerId,
    redactedText: r.redactedText,
    meta: r.meta,
    prevHash: r.prevHash,
    chainHash: r.chainHash,
    orgId: r.orgId,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Rows that existed before the operation under test — appends are allowed, edits are not. */
const preExisting = (before: ChainRowSnapshot[], after: ChainRowSnapshot[]): ChainRowSnapshot[] => {
  const ids = new Set(before.map((r) => r.id));
  return after.filter((r) => ids.has(r.id));
};

const changedRows = (a: ChainRowSnapshot[], b: ChainRowSnapshot[]): string[] =>
  a.filter((row, i) => JSON.stringify(row) !== JSON.stringify(b[i])).map((row) => row.id);

function fakeAudioStore(seed: (add: (caseRef: string, count: number) => void) => void) {
  const artifacts = new Map<string, AudioArtifact[]>();
  const purged: { caseRef: string; count: number }[] = [];
  const store: AudioStore = {
    async listForCase(caseRef) {
      return artifacts.get(caseRef) ?? [];
    },
    async deleteForCase(caseRef) {
      const count = (artifacts.get(caseRef) ?? []).length;
      purged.push({ caseRef, count });
      artifacts.delete(caseRef);
      return count;
    },
  };
  seed((caseRef, count) => {
    artifacts.set(
      caseRef,
      Array.from({ length: count }, (_, i) => ({
        id: `${caseRef}-a${i}`,
        caseRef,
        bytes: 1024 * (i + 1),
      })),
    );
  });
  return { store, purged };
}

// ── 1. Per-case key uniqueness ────────────────────────────────────────────────

test("per-case data keys are unique, and a ciphertext cannot be replayed into another case", async () => {
  const a = ref("KEYA");
  const b = ref("KEYB");
  await createCase({ caseRef: a, orgId: ORG_DEFAULT, transcript: TRANSCRIPT });
  await createCase({ caseRef: b, orgId: ORG_DEFAULT, transcript: TRANSCRIPT });

  const sealedA = await sealCasePayload(
    a,
    { transcript: TRANSCRIPT, analysis: ANALYSIS },
    { reason: "key-isolation" },
  );
  await pace();
  await sealCasePayload(
    b,
    { transcript: TRANSCRIPT, analysis: ANALYSIS },
    { reason: "key-isolation" },
  );
  await pace();

  const rowA = await db.case.findUnique({ where: { caseRef: a }, select: { dataKeyEnc: true } });
  const rowB = await db.case.findUnique({ where: { caseRef: b }, select: { dataKeyEnc: true } });
  expect(rowA?.dataKeyEnc).toBeTruthy();
  expect(rowB?.dataKeyEnc).toBeTruthy();

  // Raw key bytes, not fingerprints: a fingerprint only proves the WRAPPED blobs
  // differ, which a per-case IV proves even when both wrap the SAME key.
  const keyA = unwrapCaseKey(rowA!.dataKeyEnc, a)!;
  const keyB = unwrapCaseKey(rowB!.dataKeyEnc, b)!;
  const master = masterKey();

  check(
    "key-bytes-32",
    keyA.length === 32 && keyB.length === 32,
    `keyA=${keyA.length}B keyB=${keyB.length}B`,
  );
  check("keys-differ-bytes", !keyA.equals(keyB), "two cases must not share key material");
  check(
    "keys-differ-from-master",
    !keyA.equals(master) && !keyB.equals(master),
    "a per-case key must not BE the master key",
  );
  check(
    "wrapped-blobs-differ",
    !sameWrappedKey(rowA!.dataKeyEnc, rowB!.dataKeyEnc) &&
      keyFingerprintOf(rowA!.dataKeyEnc) !== keyFingerprintOf(rowB!.dataKeyEnc),
    "independent IVs must make the stored envelopes differ too",
  );

  // Independent node:crypto check: A's ciphertext must not open under B's key,
  // and must not open under B's caseRef as AAD. This is what "bound to the
  // case" means, proven without the library's own helpers.
  const metaA = JSON.parse((await sealedRowFor(a))!.meta!) as {
    iv: string;
    tag: string;
    ct: string;
  };
  const openWith = (key: Buffer, aad: string): Buffer => {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(metaA.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(metaA.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(metaA.ct, "base64")), decipher.final()]);
  };
  let foreignKeyRejected = false;
  let foreignCaseRejected = false;
  try {
    openWith(keyB, `${SEALED_MARKER}|${a}`);
  } catch {
    foreignKeyRejected = true;
  }
  try {
    openWith(keyA, `${SEALED_MARKER}|${b}`);
  } catch {
    foreignCaseRejected = true;
  }
  const selfOpens = openWith(keyA, `${SEALED_MARKER}|${a}`).toString("utf8");
  check(
    "ciphertext-rejects-foreign-key",
    foreignKeyRejected,
    "another case's key must not decrypt it",
  );
  check("ciphertext-bound-to-case", foreignCaseRejected, "the caseRef is authenticated data");
  check(
    "ciphertext-opens-for-owner",
    selfOpens.includes(PLAINTEXT_MARKER),
    "sanity: the owner key opens it",
  );

  // A second call must ADOPT the existing key. A fork here (two keys, one case)
  // would silently make a sealed payload unreadable.
  const adopted = await ensureCaseKey(a);
  check(
    "key-is-stable-across-calls",
    adopted.created === false && adopted.fingerprint === sealedA.fingerprint,
    `ensureCaseKey returned the same fingerprint (created=${adopted.created}) — no key fork`,
  );

  keyA.fill(0);
  keyB.fill(0);
  expect(sealedA.rowId).toBeTruthy();
});

// ── 2. The stored ciphertext never contained the plaintext ────────────────────

test("sealed ciphertext never contained the plaintext, anywhere in the row", async () => {
  const caseRef = ref("SEAL");
  await createCase({ caseRef, orgId: ORG_DEFAULT, transcript: TRANSCRIPT, analysis: ANALYSIS });

  const sealed = await sealCasePayload(
    caseRef,
    { transcript: TRANSCRIPT, analysis: ANALYSIS },
    { reason: "post_call_ingest", clearPlaintext: true },
  );
  await pace();

  const rows = await db.auditLog.findMany({ where: { callRef: caseRef } });
  const rowsJson = JSON.stringify(rows);
  check(
    "no-plaintext-in-any-audit-row",
    !rowsJson.includes(PLAINTEXT_MARKER) && !rowsJson.includes(ANALYSIS.notes),
    `${rows.length} audit rows searched for the plaintext marker and the analysis note`,
  );

  const sealedRow = rows.find((r) => r.id === sealed.rowId)!;
  const envelope = JSON.parse(sealedRow.meta!) as {
    iv: string;
    tag: string;
    ct: string;
    bytes: number;
  };
  check(
    "no-plaintext-in-redactedText",
    !String(sealedRow.redactedText).includes(PLAINTEXT_MARKER),
    `redactedText = ${JSON.stringify(sealedRow.redactedText)}`,
  );
  check(
    "no-plaintext-in-seal-fields",
    ![envelope.iv, envelope.tag, envelope.ct].some((v) => v.includes(PLAINTEXT_MARKER)),
    "iv/tag/ct are opaque",
  );

  const raw = Buffer.from(envelope.ct, "base64");
  check(
    "raw-ciphertext-bytes-are-not-plaintext",
    !raw.includes(Buffer.from(PLAINTEXT_MARKER, "utf8")) &&
      !raw.toString("utf8").includes("transcript"),
    `${raw.length} ciphertext bytes, no readable content`,
  );
  check(
    "ciphertext-is-larger-than-nothing-and-auth-tagged",
    envelope.tag.length > 0 && raw.length === envelope.bytes,
    `tag present, ${raw.length} bytes for a ${envelope.bytes}-byte plaintext (GCM overhead is in the tag)`,
  );

  // `clearPlaintext: true` is the full encryption-at-rest posture: nothing
  // readable is left on the Case row.
  const caseRow = await db.case.findUnique({ where: { caseRef } });
  check(
    "case-row-holds-no-plaintext-after-clear",
    caseRow?.transcriptRedacted === null &&
      caseRow?.evaluationResults === null &&
      caseRow?.dataCollectionResults === null,
    "clearPlaintext nulled all three payload columns",
  );

  const readBack = await readCasePayload(caseRef);
  expect(readBack.transcript).toBe(TRANSCRIPT);
  expect(readBack.reason).toBe("post_call_ingest");
});

// ── 3 + 4. Erasure destroys the plaintext, and the chain still verifies ───────

test("I-6: erasure destroys the plaintext and the chain still verifies from genesis", async () => {
  const caseRef = ref("ERASE");
  await createCase({ caseRef, orgId: ORG_DEFAULT, transcript: TRANSCRIPT, analysis: ANALYSIS });
  await seedChain(caseRef, ORG_DEFAULT, 4);

  const beforeErase = await chainSnapshot(caseRef);
  // `seedChain(caseRef, ORG_DEFAULT, 4)` wrote these rows with
  // `orgId: ORG_DEFAULT`, and the seal/erasure witnesses in crypto-shred.ts
  // append with `orgId: row.orgId` — the Case's own ORG_DEFAULT. This scope is
  // load-bearing: the `rows === 4` check below is vacuous under a null scope.
  const verificationBefore = await verifyChain(caseRef, ORG_DEFAULT);
  expect(verificationBefore.ok).toBe(true);
  check(
    "chain-ok-before",
    verificationBefore.ok && verificationBefore.rows === 4,
    `${verificationBefore.ok ? "ok" : "broken"} with ${verificationBefore.rows} rows before erasure`,
  );

  await sealCasePayload(
    caseRef,
    { transcript: TRANSCRIPT, analysis: ANALYSIS },
    { reason: "post_call_ingest" },
  );
  await pace();
  const afterSeal = await chainSnapshot(caseRef);
  check(
    "sealing-appends-only",
    changedRows(beforeErase, preExisting(beforeErase, afterSeal)).length === 0,
    "sealing added a row and changed none of the four originals",
  );

  // The payload is readable right up to the moment the key is destroyed.
  expect((await readCasePayload(caseRef)).transcript).toBe(TRANSCRIPT);

  const result = await eraseCase(caseRef, {
    reason: "dsr_request",
    requestedBy: "dpo@example.test",
    legalBasis: "policy:test",
  });
  await pace();

  // (a) The plaintext is gone.
  const erasedCase = await db.case.findUnique({ where: { caseRef } });
  check(
    "plaintext-columns-cleared",
    erasedCase?.transcriptRedacted === null &&
      erasedCase?.evaluationResults === null &&
      erasedCase?.dataCollectionResults === null,
    `cleared: [${result.clearedColumns.join(", ")}]`,
  );
  check(
    "data-key-destroyed",
    erasedCase?.dataKeyEnc === null,
    "dataKeyEnc is NULL — no durable key copy",
  );
  check(
    "erased-at-recorded",
    Boolean(erasedCase?.erasedAt),
    `erasedAt=${erasedCase?.erasedAt?.toISOString()}`,
  );

  let threw: unknown = null;
  try {
    await readCasePayload(caseRef);
  } catch (error) {
    threw = error;
  }
  check(
    "read-after-erasure-throws",
    threw instanceof CaseErasedError,
    threw ? `threw ${(threw as Error).name}` : "returned a value instead of throwing",
  );

  // (b) The ciphertext survives, and it is inert: no key exists that opens it.
  const ciphertextRow = await sealedRowFor(caseRef);
  check(
    "ciphertext-row-survives",
    Boolean(ciphertextRow),
    "the ciphertext is chained, so it is not deleted",
  );
  const envelope = JSON.parse(ciphertextRow!.meta!) as { iv: string; tag: string; ct: string };
  let masterKeyRejected = false;
  let randomKeyRejected = false;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      masterKey(),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(`${SEALED_MARKER}|${caseRef}`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]);
  } catch {
    masterKeyRejected = true;
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      randomBytes(32),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(`${SEALED_MARKER}|${caseRef}`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]);
  } catch {
    randomKeyRejected = true;
  }
  check(
    "ciphertext-undecryptable-after-erasure",
    masterKeyRejected && randomKeyRejected,
    "not even the master key can open it — the data key is gone",
  );

  // (c) INVARIANT I-6: verifies from genesis, byte-identical, plus one appended
  // witness row.
  const afterErase = await chainSnapshot(caseRef);
  const verificationAfter = await verifyChain(caseRef, ORG_DEFAULT);
  check(
    "chain-ok-after-erasure-I6",
    verificationAfter.ok === true,
    verificationAfter.ok
      ? `${verificationAfter.rows} rows verify from genesis after erasure`
      : `BROKEN at ${verificationAfter.brokenAt}`,
  );
  expect(verificationAfter.ok).toBe(true);
  const moved = changedRows(beforeErase, preExisting(beforeErase, afterErase));
  check(
    "no-chained-byte-mutated",
    moved.length === 0,
    moved.length === 0
      ? "all 4 pre-existing rows are byte-identical (text, meta, hashes, timestamps)"
      : `mutated rows: ${moved.join(", ")}`,
  );
  check(
    "erasure-appended-not-mutated",
    afterErase.length === beforeErase.length + 2,
    `${beforeErase.length} rows → ${afterErase.length} (sealed + erasure witness appended)`,
  );
  const witness = afterErase.find((r) => r.intent === AUDIT_INTENT_ERASED);
  const witnessMeta = witness ? JSON.parse(witness.meta ?? "{}") : {};
  check(
    "erasure-witness-in-chain",
    witnessMeta.keyDestroyed === true && witnessMeta.caseRef === caseRef,
    `witness row ${witness?.id} records keyDestroyed=true`,
  );

  // (d) NEGATIVE CONTROL — without this, (c) proves nothing. Tamper with one
  // pre-existing row and require verifyChain() to say so.
  // The chain was verified to hold exactly four rows just above, so index 1 exists.
  const victim = beforeErase[1]!;
  await db.auditLog.update({
    where: { id: victim.id },
    data: { redactedText: "TAMPERED — this text was never written by the app" },
  });
  const tampered = await verifyChain(caseRef, ORG_DEFAULT);
  check(
    "negative-control-tamper-is-detected",
    tampered.ok === false && tampered.brokenAt === victim.id,
    tampered.ok
      ? "tampering went UNDETECTED — the gate above is vacuous"
      : `detected at ${tampered.brokenAt}`,
  );
  expect(tampered.ok).toBe(false);

  // Restore the row so the rest of the run sees an intact chain.
  await db.auditLog.update({
    where: { id: victim.id },
    data: { redactedText: victim.redactedText },
  });
  const restored = await verifyChain(caseRef, ORG_DEFAULT);
  expect(restored.ok).toBe(true);

  // (e) Erasure is idempotent, and does not append a second witness.
  const again = await eraseCase(caseRef, { reason: "dsr_repeat" });
  await pace();
  check(
    "erasure-is-idempotent",
    again.alreadyErased === true && again.clearedColumns.length === 0,
    "a second erase reports alreadyErased and changes nothing",
  );
  const finalChain = await chainSnapshot(caseRef);
  check(
    "repeat-erasure-adds-no-row",
    finalChain.length === afterErase.length,
    `${afterErase.length} rows → ${finalChain.length}`,
  );

  const state = await casePrivacyState(caseRef);
  check(
    "privacy-state-reports-erased",
    state.erased === true && state.sealed === true && state.fingerprint === null,
    `erased=${state.erased} sealed=${state.sealed} fingerprint=${state.fingerprint}`,
  );
});

// ── Erasure does not need the master key (fail-closed destruction) ───────────

test("erasure succeeds even with no master key; sealing does not", async () => {
  const caseRef = ref("NOKEK");
  await createCase({ caseRef, orgId: ORG_DEFAULT, transcript: TRANSCRIPT });
  await sealCasePayload(caseRef, { transcript: TRANSCRIPT, analysis: null }, { reason: "nokek" });
  await pace();

  const saved = process.env.PRIVACY_MASTER_KEY;
  delete process.env.PRIVACY_MASTER_KEY;
  let sealError: unknown = null;
  try {
    await sealCasePayload(caseRef, { transcript: "x", analysis: null });
  } catch (error) {
    sealError = error;
  }
  const eraseResult = await eraseCase(caseRef, { reason: "dsr_request" }).finally(() => {
    process.env.PRIVACY_MASTER_KEY = saved;
  });
  await pace();

  check(
    "sealing-refuses-without-master-key",
    sealError instanceof MasterKeyUnavailableError,
    sealError
      ? `${(sealError as Error).name} names ${"PRIVACY_MASTER_KEY"}`
      : "sealed without a key!",
  );
  check(
    "erasure-needs-no-master-key",
    eraseResult.keyDestroyed === true,
    "a lost KEK must not be able to BLOCK a deletion request",
  );
  const chain = await verifyChain(caseRef, ORG_DEFAULT);
  check("chain-ok-after-nokek-erasure", chain.ok === true, `${chain.ok ? "ok" : "broken"}`);
});

// ── 5. Retention policy + selector ───────────────────────────────────────────

test("retention policy is per organisation, and the pilot rule makes audio due immediately", async () => {
  const baseline = retentionPolicy(ORG_DEFAULT);
  expect(baseline.audioDays).toBe(DEFAULT_RETENTION_DAYS.audio);
  expect(baseline.transcriptDays).toBe(DEFAULT_RETENTION_DAYS.transcripts);
  expect(baseline.caseRecordDays).toBe(DEFAULT_RETENTION_DAYS.caseRecords);
  check(
    "defaults-are-30-90-7y",
    baseline.audioDays === 30 && baseline.transcriptDays === 90 && baseline.caseRecordDays === 2555,
    `audio=${baseline.audioDays}d transcripts=${baseline.transcriptDays}d records=${baseline.caseRecordDays}d`,
  );
  check(
    "audit-is-forever-hashes-only",
    baseline.audit === AUDIT_RETENTION && baseline.audit === "forever-hashes-only",
    `audit=${baseline.audit}`,
  );
  check(
    "audio-default-not-immediate",
    baseline.audioDays > 0 && baseline.sources.audio === "default",
    `audioDays=${baseline.audioDays}, source=${baseline.sources.audio}`,
  );

  const pilot = retentionPolicy(ORG_PILOT);
  check(
    "pilot-audio-is-zero-days",
    isPilotOrg(ORG_PILOT) && pilot.audioDays === 0 && pilot.sources.audio === "pilot",
    `${ORG_PILOT}: audioDays=${pilot.audioDays} (source ${pilot.sources.audio})`,
  );
  check(
    "pilot-leaves-other-tiers-alone",
    pilot.transcriptDays === 90 && pilot.caseRecordDays === 2555,
    "the pilot rule is scoped to the audio tier only",
  );

  configureRetention(ORG_OVERRIDE, { audioDays: 7, transcriptDays: 0, caseRecordDays: 365 });
  const overridden = retentionPolicy(ORG_OVERRIDE);
  check(
    "per-org-override-applies",
    overridden.audioDays === 7 &&
      overridden.transcriptDays === 0 &&
      overridden.caseRecordDays === 365,
    `override: audio=${overridden.audioDays} transcripts=${overridden.transcriptDays} records=${overridden.caseRecordDays}`,
  );
  check(
    "override-is-not-shared-across-orgs",
    retentionPolicy(ORG_DEFAULT).transcriptDays === 90,
    "org A's override must not change org B's deadline",
  );

  let configError: unknown = null;
  try {
    configureRetention(ORG_OVERRIDE, { transcriptDays: -1 });
  } catch (error) {
    configError = error;
  }
  check(
    "negative-retention-is-refused",
    configError instanceof Error && /whole number of days/.test((configError as Error).message),
    "a negative window would put the cutoff in the FUTURE and shred live cases",
  );

  // The selector: cutoffs are exactly `at - days`, and 0 days means "now".
  const at = new Date("2026-10-02T12:00:00.000Z");
  const selector = dueForDeletion(at, { orgId: ORG_DEFAULT });
  const expectedAudio = new Date(at.getTime() - 30 * DAY_MS).toISOString();
  check(
    "audio-cutoff-is-at-minus-30d",
    selector.tiers.audio.cutoff?.toISOString() === expectedAudio,
    `cutoff=${selector.tiers.audio.cutoff?.toISOString()}`,
  );
  const pilotSelector = dueForDeletion(at, { orgId: ORG_PILOT });
  check(
    "zero-day-cutoff-is-now",
    pilotSelector.tiers.audio.cutoff?.toISOString() === at.toISOString(),
    `pilot audio cutoff === at (${at.toISOString()}) — due immediately`,
  );
  check(
    "audit-tier-is-never-due",
    selector.tiers.audit.due === false && selector.tiers.audit.cutoff === null,
    "the chain has no cutoff and no due predicate",
  );
});

// ── 6. The chain-protection rule is enforced, not documented ─────────────────

test("retention is refused any audit-chain mutation, including a redactedText drop", async () => {
  let refusedText = false;
  let refusedDelete = false;
  try {
    assertRetentionMutationAllowed({ target: "AuditLog", columns: ["redactedText"] });
  } catch (error) {
    refusedText = error instanceof ChainMutationRefusedError;
  }
  try {
    assertRetentionMutationAllowed({ target: "AuditLog", columns: [], rowsDeleted: 1 });
  } catch (error) {
    refusedDelete = error instanceof ChainMutationRefusedError;
  }
  let caseWriteAllowed = true;
  try {
    assertRetentionMutationAllowed({
      target: "Case",
      columns: ["transcriptRedacted", "dataKeyEnc"],
    });
  } catch {
    caseWriteAllowed = false;
  }

  check(
    "redactedText-drop-refused",
    refusedText,
    "dropping redactedText changes the canonical row → the chain breaks at that row",
  );
  check("audit-row-delete-refused", refusedDelete, "a deleted row orphans every descendant");
  check(
    "case-writes-still-allowed",
    caseWriteAllowed,
    "no hash covers a Case column, so erasing there is safe",
  );
  check(
    "audit-tier-decision-is-zero-mutation",
    AUDIT_TIER_DECISION.rowsDeleted === 0 &&
      AUDIT_TIER_DECISION.rowsUpdated === 0 &&
      AUDIT_TIER_DECISION.columns.length === 0,
    "the reported decision matches the enforcement",
  );
  check(
    "protected-columns-published",
    CHAIN_PROTECTED_COLUMNS.includes("prevHash") &&
      CHAIN_PROTECTED_COLUMNS.includes("chainHash") &&
      CHAIN_PROTECTED_COLUMNS.includes("redactedText"),
    `protected: ${CHAIN_PROTECTED_COLUMNS.join(", ")}`,
  );
  check(
    "master-key-configured",
    masterKeyConfigured(),
    "PRIVACY_MASTER_KEY resolved for this run (never logged, never defaulted)",
  );
});

// ── 7. 0-day audio policy deletes immediately; the 30-day default does not ─────

test("a 0-day audio policy purges immediately, a 30-day policy does not", async () => {
  const pilotCase = ref("AUDIO0");
  const defaultCase = ref("AUDIO30");
  await createCase({ caseRef: pilotCase, orgId: ORG_PILOT, ageDays: 0, transcript: TRANSCRIPT });
  await createCase({
    caseRef: defaultCase,
    orgId: ORG_DEFAULT,
    ageDays: 5,
    transcript: TRANSCRIPT,
  });

  const fake = fakeAudioStore((add) => {
    add(pilotCase, 2);
    add(defaultCase, 3);
  });
  registerAudioStore(fake.store);
  check(
    "audio-store-registered",
    audioStoreConfigured(),
    "the audio tier purges a registered store",
  );

  // Both cases are FRESH: the only thing that can make the pilot case due is the
  // 0-day window. Age is therefore not a hidden variable in this assertion.
  const dryRun = await runRetention(new Date(), { dryRun: true, orgIds: [ORG_PILOT, ORG_DEFAULT] });
  check(
    "dry-run-purges-nothing",
    dryRun.audioArtifactsPurged === 0 && dryRun.tiers.audio.acted === 0,
    `dry-run reported ${dryRun.audioArtifactsPurged} artifacts purged and ${dryRun.tiers.audio.acted} actions`,
  );
  check(
    "dry-run-reports-due-work",
    dryRun.tiers.audio.due === 1,
    `dry run would act on ${dryRun.tiers.audio.due} audio tier case(s): ${dryRun.tiers.audio.caseRefs.join(", ")}`,
  );
  check(
    "dry-run-reports-no-transcript-work",
    dryRun.tiers.transcripts.due === 0 && dryRun.tiers.caseRecords.due === 0,
    "a fresh case is inside every other window",
  );
  expect(fake.purged).toHaveLength(0);

  const run = await runRetention(new Date(), { orgIds: [ORG_PILOT, ORG_DEFAULT] });
  const purgedRefs = fake.purged.map((p) => p.caseRef);
  check(
    "zero-day-audio-purged-immediately",
    purgedRefs.includes(pilotCase),
    `pilot case purged on the first run (${purgedRefs.join(", ") || "nothing"})`,
  );
  check(
    "thirty-day-audio-not-purged",
    !purgedRefs.includes(defaultCase),
    "a 5-day-old case is inside the 30-day window",
  );
  check(
    "pilot-case-payload-intact",
    (
      await db.case.findUnique({
        where: { caseRef: pilotCase },
        select: { transcriptRedacted: true },
      })
    )?.transcriptRedacted === TRANSCRIPT,
    "the audio tier does not touch transcripts",
  );
  check(
    "run-reported-purge-count",
    run.audioArtifactsPurged === 2,
    `${run.audioArtifactsPurged} artifacts purged across ${run.orgs.length} org(s)`,
  );

  // 31 days later the default case is due and the pilot case is simply absent
  // from the store (idempotent: nothing left to purge).
  const later = new Date(Date.now() + 31 * DAY_MS);
  fake.purged.length = 0;
  const laterRun = await runRetention(later, { orgIds: [ORG_PILOT, ORG_DEFAULT] });
  check(
    "thirty-day-audio-due-after-31-days",
    fake.purged.map((p) => p.caseRef).includes(defaultCase),
    `at +31d the default case is due (${laterRun.tiers.audio.due} due)`,
  );
  registerAudioStore(null);
  check("audio-store-unregistered", !audioStoreConfigured(), "back to the no-store default (I-10)");
});

// ── 8. Per-tier scheduling, and a run cannot break the chain ─────────────────

test("transcripts shred at 90 days, case records at their window, and the chain survives both", async () => {
  const aged = ref("TIER");
  await createCase({
    caseRef: aged,
    orgId: ORG_DEFAULT,
    ageDays: 40,
    transcript: TRANSCRIPT,
    analysis: ANALYSIS,
  });
  await seedChain(aged, ORG_DEFAULT, 3);
  await sealCasePayload(
    aged,
    { transcript: TRANSCRIPT, analysis: ANALYSIS },
    { reason: "post_call_ingest" },
  );
  await pace();

  const before = await chainSnapshot(aged);
  // `seedChain(aged, ORG_DEFAULT, 3)` — ORG_DEFAULT owns this chain.
  expect((await verifyChain(aged, ORG_DEFAULT)).ok).toBe(true);
  const stateBefore = await casePrivacyState(aged);

  // t+0: 40 days old — inside the transcript window (90), so nothing but audio
  // (30, already passed) is due. The payload and the key must both survive.
  const first = await runRetention(new Date(), { orgIds: [ORG_DEFAULT] });
  check(
    "transcript-tier-not-due-at-40-days",
    first.tiers.transcripts.acted === 0,
    `transcripts acted on ${first.tiers.transcripts.acted} case(s) at 40 days`,
  );
  check(
    "payload-survives-inside-window",
    (await db.case.findUnique({ where: { caseRef: aged }, select: { transcriptRedacted: true } }))
      ?.transcriptRedacted === TRANSCRIPT,
    "40 days < 90 day transcript window",
  );

  // t+100d: 140 days old — transcripts are due (90) and case records are not.
  const at100 = new Date(Date.now() + 100 * DAY_MS);
  const second = await runRetention(at100, { orgIds: [ORG_DEFAULT] });
  check(
    "transcript-tier-fires-at-140-days",
    second.tiers.transcripts.acted >= 1,
    `acted on ${second.tiers.transcripts.acted} case(s): ${second.tiers.transcripts.caseRefs.join(", ")}`,
  );
  check(
    "transcript-tier-scrubs-payload",
    second.payloadsShredded >= 1,
    `${second.payloadsShredded} payload(s) shredded — the key, not the row`,
  );

  const shredded = await db.case.findUnique({
    where: { caseRef: aged },
    select: { dataKeyEnc: true, erasedAt: true, transcriptRedacted: true, evaluationResults: true },
  });
  check(
    "transcript-tier-destroys-key-and-text",
    shredded?.dataKeyEnc === null &&
      shredded?.transcriptRedacted === null &&
      shredded?.erasedAt !== null,
    "dataKeyEnc NULL, transcriptRedacted NULL, erasedAt set",
  );
  check(
    "ciphertext-row-still-there-and-inert",
    (await sealedRowFor(aged)) !== null,
    "the sealed ciphertext is chain-resident: it stays, and without the key it is noise",
  );
  check(
    "case-record-still-inside-7y-window",
    (await db.case.findUnique({ where: { caseRef: aged } })) !== null,
    "90 days < 7 year record window",
  );

  // The chain: still verifies, and nothing pre-existing moved.
  const after = await chainSnapshot(aged);
  const moved = changedRows(before, preExisting(before, after));
  check(
    "retention-did-not-mutate-chained-bytes",
    moved.length === 0,
    moved.length === 0
      ? `all ${before.length} pre-existing rows byte-identical after a retention run`
      : `mutated: ${moved.join(", ")}`,
  );
  const verification = await verifyChain(aged, ORG_DEFAULT);
  check(
    "retention-kept-chain-verifying-I6",
    verification.ok === true,
    verification.ok
      ? `${verification.rows} rows verify from genesis`
      : `BROKEN at ${verification.brokenAt}`,
  );
  check(
    "retention-self-report-chain-intact",
    second.chain.intact === true && second.chain.refsChecked >= 1,
    `sweeper verified ${second.chain.refsChecked} chain(s), intact=${second.chain.intact}`,
  );
  check(
    "retention-reported-no-errors",
    second.errors.length === 0,
    second.errors.length === 0 ? "clean" : JSON.stringify(second.errors),
  );
  check(
    "key-fingerprint-changed-on-shred",
    (await casePrivacyState(aged)).fingerprint === null && stateBefore.fingerprint !== null,
    "a fingerprint existed before the shred and is gone after",
  );

  // Now the record window: an org configured to delete case records now.
  const recordCase = ref("RECORD");
  await createCase({
    caseRef: recordCase,
    orgId: ORG_OVERRIDE,
    ageDays: 400,
    transcript: TRANSCRIPT,
  });
  await seedChain(recordCase, ORG_OVERRIDE, 2);
  configureRetention(ORG_OVERRIDE, { audioDays: 30, transcriptDays: 365, caseRecordDays: 0 });
  const recordBefore = await chainSnapshot(recordCase);
  const recordRun = await runRetention(new Date(), { orgIds: [ORG_OVERRIDE] });
  check(
    "case-record-tier-fires",
    recordRun.caseRecordsDeleted === 1 &&
      (await db.case.findUnique({ where: { caseRef: recordCase } })) === null,
    "the Case row is gone after its retention window closes",
  );
  const recordAfter = await chainSnapshot(recordCase);
  // `seedChain(recordCase, ORG_OVERRIDE, 2)` — ORG_OVERRIDE owns this chain,
  // NOT ORG_DEFAULT: the record tier is deliberately configured on a different
  // org, and scoping this to ORG_DEFAULT would verify zero rows.
  const recordVerification = await verifyChain(recordCase, ORG_OVERRIDE);
  check(
    "deleting-the-case-row-left-the-chain-intact",
    recordVerification.ok === true && recordAfter.length > recordBefore.length,
    `${recordBefore.length} → ${recordAfter.length} rows, chain ok=${recordVerification.ok}`,
  );
  check(
    "record-deletion-mutated-nothing",
    changedRows(recordBefore, preExisting(recordBefore, recordAfter)).length === 0,
    "deletion appends a witness; it never edits a chained row",
  );
});

// ── 9. Bounded batches, and per-org scoping of the deadline ──────────────────

test("the sweeper is bounded, resumable, and applies each org's own policy", async () => {
  const batchOrg = ref("BATCHORG");
  const batchRefs: string[] = [];
  for (let i = 0; i < 5; i++) {
    const caseRef = ref(`BATCH${i}`);
    batchRefs.push(caseRef);
    await createCase({ caseRef, orgId: batchOrg, ageDays: 200, transcript: TRANSCRIPT });
  }
  configureRetention(batchOrg, { audioDays: 30, transcriptDays: 90, caseRecordDays: 3650 });

  const oneBatch = await runRetention(new Date(), {
    orgIds: [batchOrg],
    batchSize: 2,
    maxBatchesPerTier: 1,
  });
  check(
    "batch-bound-respected",
    oneBatch.tiers.transcripts.batches === 1 &&
      oneBatch.tiers.transcripts.due === 2 &&
      oneBatch.tiers.transcripts.acted === 2,
    `batchSize=2, maxBatches=1 → ${oneBatch.tiers.transcripts.due} due, ${oneBatch.tiers.transcripts.acted} acted, in ${oneBatch.tiers.transcripts.batches} batch(es)`,
  );
  check(
    "truncation-is-reported",
    oneBatch.tiers.transcripts.truncated === true,
    "the scheduler is told there is more work to do",
  );
  check(
    "cursor-does-not-repeat-rows",
    new Set(oneBatch.tiers.transcripts.caseRefs).size ===
      oneBatch.tiers.transcripts.caseRefs.length,
    "each case appeared in exactly one batch",
  );

  const finish = await runRetention(new Date(), {
    orgIds: [batchOrg],
    batchSize: 2,
    maxBatchesPerTier: 4,
  });
  const acted = await db.case.count({
    where: { caseRef: { in: batchRefs }, transcriptRedacted: { not: null } },
  });
  check(
    "resumed-run-finishes-the-backlog",
    finish.tiers.transcripts.acted >= 3 && finish.tiers.transcripts.batches === 2 && acted === 0,
    `${oneBatch.tiers.transcripts.acted} + ${finish.tiers.transcripts.acted} = 5 shredded across ` +
      `${finish.tiers.transcripts.batches} further batch(es); ${acted} case(s) still hold plaintext`,
  );

  // Two orgs, identical age, opposite policy: the deadline is per org. Both are
  // SEALED first, so "shredded" is a real state change and not just a column
  // that was already NULL.
  const eagerRef = ref("EAGER");
  const patientRef = ref("PATIENT");
  await createCase({ caseRef: eagerRef, orgId: ORG_OVERRIDE, ageDays: 1, transcript: TRANSCRIPT });
  await createCase({ caseRef: patientRef, orgId: ORG_DEFAULT, ageDays: 1, transcript: TRANSCRIPT });
  await sealCasePayload(eagerRef, { transcript: TRANSCRIPT, analysis: null }, { reason: "tier" });
  await pace();
  await sealCasePayload(patientRef, { transcript: TRANSCRIPT, analysis: null }, { reason: "tier" });
  await pace();
  configureRetention(ORG_OVERRIDE, { audioDays: 30, transcriptDays: 0, caseRecordDays: 3650 });

  await runRetention(new Date(), { orgIds: [ORG_OVERRIDE, ORG_DEFAULT] });
  const eagerRow = await db.case.findUnique({
    where: { caseRef: eagerRef },
    select: { dataKeyEnc: true, erasedAt: true, transcriptRedacted: true },
  });
  const patientRow = await db.case.findUnique({
    where: { caseRef: patientRef },
    select: { dataKeyEnc: true, erasedAt: true, transcriptRedacted: true },
  });
  // Both cases were created just above, so both rows exist; without them the
  // checks below would compare against `undefined` and pass vacuously.
  if (eagerRow === null || patientRow === null)
    throw new Error("both fixture cases must exist before the shred checks");
  check(
    "eager-org-shredded",
    eagerRow.dataKeyEnc === null &&
      eagerRow.erasedAt !== null &&
      eagerRow.transcriptRedacted === null,
    "org with transcriptDays=0 shreds immediately",
  );
  check(
    "patient-org-untouched",
    patientRow.dataKeyEnc !== null &&
      patientRow.erasedAt === null &&
      patientRow.transcriptRedacted === TRANSCRIPT,
    "the same-age, same-org-shaped case in the default org keeps its key and text for another 89 days",
  );
  check(
    "keys-are-not-shredded-across-orgs",
    patientRow?.dataKeyEnc !== eagerRow?.dataKeyEnc,
    "one org's deadline must not reach another org's key",
  );

  let batchError: unknown = null;
  try {
    await runRetention(new Date(), { orgIds: [batchOrg], batchSize: 0 });
  } catch (error) {
    batchError = error;
  }
  check(
    "invalid-batch-size-refused",
    batchError instanceof Error && /batchSize/.test((batchError as Error).message),
    "a zero batch size would spin forever",
  );
});

// ── 10. Record deletion standalone (the API a DSR handler calls) ─────────────

test("deleteCaseRecord removes the row and keeps the chain, eraseCase is safe to repeat", async () => {
  const caseRef = ref("DSR");
  await createCase({
    caseRef,
    orgId: ORG_DEFAULT,
    ageDays: 3,
    transcript: TRANSCRIPT,
    analysis: ANALYSIS,
  });
  await seedChain(caseRef, ORG_DEFAULT, 2);
  await sealCasePayload(caseRef, { transcript: TRANSCRIPT, analysis: ANALYSIS }, { reason: "dsr" });
  await pace();

  const deleted = await deleteCaseRecord(caseRef, {
    reason: "dsr_request",
    requestedBy: "dpo@example.test",
  });
  await pace();

  check(
    "case-record-deleted",
    (await db.case.findUnique({ where: { caseRef: caseRef } })) === null,
    `cleared [${deleted.clearedColumns.join(", ")}], keyDestroyed=${deleted.keyDestroyed}`,
  );
  // `seedChain(caseRef, ORG_DEFAULT, 2)` — ORG_DEFAULT owns this chain.
  const verification = await verifyChain(caseRef, ORG_DEFAULT);
  check(
    "chain-survives-case-deletion",
    verification.ok === true,
    `${verification.ok ? "ok" : "broken"} with ${verification.rows} rows — the chain does not depend on the Case row`,
  );
  const sealedRow = await sealedRowFor(caseRef);
  check(
    "ciphertext-row-not-deleted-with-the-case",
    sealedRow !== null,
    "it is chain-resident and its key was shredded instead",
  );
  const state = await casePrivacyState(caseRef);
  check(
    "state-for-deleted-case-is-honest",
    state.exists === false && state.sealed === true,
    `exists=${state.exists} sealed=${state.sealed} — "no Case row" must not read as "no data was ever held"`,
  );
});

// ── Evidence ─────────────────────────────────────────────────────────────────

test("evidence artifact is written, well-formed and digest-stable", async () => {
  check(
    "no-network-calls",
    HTTP_CALLS === 0,
    `${HTTP_CALLS} HTTP call(s) attempted during the gate`,
  );
  const fingerprint = masterKeyFingerprint();
  check(
    "master-key-in-process",
    masterKeyConfigured() &&
      /^[0-9a-f]{16}$/.test(fingerprint) &&
      fingerprint !== masterKey().toString("hex"),
    `master key resolved; ops fingerprint ${fingerprint} is a hash, not the key`,
  );

  // Deterministic core only: no run-scoped identifiers, no timestamps.
  const core = {
    schemaVersion: 1,
    gate: "WP-15 data protection and retention",
    digestAlgorithm: "sha256",
    tiers: {
      audio: DEFAULT_RETENTION_DAYS.audio,
      transcripts: DEFAULT_RETENTION_DAYS.transcripts,
      caseRecords: DEFAULT_RETENTION_DAYS.caseRecords,
      audit: AUDIT_RETENTION,
    },
    pilotAudioDays: 0,
    auditTier: {
      action: AUDIT_TIER_DECISION.action,
      rowsDeleted: AUDIT_TIER_DECISION.rowsDeleted,
      rowsUpdated: AUDIT_TIER_DECISION.rowsUpdated,
      protectedColumns: CHAIN_PROTECTED_COLUMNS,
    },
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
  };
  const digest = createHash("sha256").update(JSON.stringify(core)).digest("hex");

  const artifact = {
    ...core,
    digest,
    generatedAt: new Date().toISOString(),
    run: {
      id: RUN,
      orgs: { default: ORG_DEFAULT, pilot: ORG_PILOT, override: ORG_OVERRIDE },
      batch: ref("BATCHORG"),
      database: "TEST_DATABASE_URL",
      note: "identifiers above are per-run; the digest covers the deterministic core only",
    },
    summary: {
      result: failCount() === 0 ? "pass" : "fail",
      total: checks.length,
      passed: passCount(),
      failed: failCount(),
      invariants: {
        "I-6 chain verifies from genesis after erasure": checks.some(
          (c) => c.name === "chain-ok-after-erasure-I6" && c.ok,
        ),
        "I-10 ciphertext never contained plaintext": checks.some(
          (c) => c.name === "no-plaintext-in-any-audit-row" && c.ok,
        ),
        "retention cannot mutate the chain": checks.some(
          (c) => c.name === "no-chained-byte-mutated" && c.ok,
        ),
      },
    },
    reconciliation: {
      question: "How does right-to-erasure coexist with an append-only hash chain?",
      answer: [
        "The chain never holds personal data: every audit row is PII-free at write time (redact.ts, I-10).",
        "The one payload that must survive briefly is stored as ciphertext under a per-case AES-256-GCM key.",
        "eraseCase() destroys that key and APPENDS a privacy_erasure_v1 row; it never edits or deletes a chained row.",
        "The sealed ciphertext row cannot be deleted without rewriting the chain, so retention shreds the KEY instead: the row survives as inert noise, and the data is unrecoverable.",
        "Re-deriving the chain hashes after a deletion was rejected: a rewritten chain is indistinguishable from an untouched one, which is the one property the chain exists to provide.",
      ],
    },
    declaredGaps: [
      "No policy table: per-org retention is env + programmatic config only (no migration in WP-15 scope).",
      "Master-key rotation needs a re-wrap pass over Case.dataKeyEnc, which is NOT implemented.",
      "The audio tier purges a REGISTERED store; the platform stores no audio itself (I-10), so with no store registered the tier is a no-op.",
    ],
  };

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  // Re-read and assert: a driver that under-reports what it observed is worse
  // than no gate at all.
  const reread = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as typeof artifact;
  expect(reread.digest).toBe(digest);
  expect(reread.summary.total).toBe(checks.length);
  expect(reread.summary.passed).toBe(passCount());
  expect(reread.summary.failed).toBe(failCount());
  expect(reread.checks).toHaveLength(checks.length);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[WP-15] ${checks.length} checks — ${passCount()} passed, ${failCount()} failed`);
  for (const failure of failed) console.log(`  ✗ ${failure.name}: ${failure.detail}`);
  expect(failed).toHaveLength(0);
  expect(reread.summary.invariants["I-6 chain verifies from genesis after erasure"]).toBe(true);
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  globalThis.fetch = REAL_FETCH;
  resetRetentionConfig();
  registerAudioStore(null);
  delete process.env[ENV_PILOT_ORGS];
  // Everything is RUN-prefixed, so this cannot touch another agent's rows.
  await db.auditLog.deleteMany({ where: { callRef: { startsWith: `SV-P-${RUN}` } } });
  await db.case.deleteMany({ where: { caseRef: { startsWith: `SV-P-${RUN}` } } });
  await db.$disconnect();
});
