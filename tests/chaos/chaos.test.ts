import { afterAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@/generated/prisma/client";

/**
 * WP-21 Gate: failure semantics for the API and the database.
 *
 * This file is the gate. It runs EVERY row of the declared database failure
 * matrix, EVERY declared dependency fallback, the full envelope discipline, the
 * timeout tree, and the two negative controls that keep the positive results
 * meaningful — and it writes `evidence/chaos/results.json`.
 *
 * ── Three properties the gate holds to ───────────────────────────────────────
 *
 *   1. **Nothing is broken to prove a failure mode.** Every row is driven by a
 *      synthetic error object — a real `PrismaClientKnownRequestError` where one
 *      exists, a structurally identical object where Prisma has no code for the
 *      condition, and injected `sleep`/`now`/`timers` wherever a behaviour
 *      involves waiting. No connection is opened, no pool is drained, no
 *      volume is filled. The gate needs no database at all.
 *   2. **Nothing leaves the process.** `globalThis.fetch` is replaced with a
 *      tripwire at module load, so a stray HTTP call fails the gate instead of
 *      quietly reaching a vendor.
 *   3. **A passing check is not a vacuous check.** Three separate negative
 *      controls prove the instruments work: the leak scanner is fed real
 *      offenders, the transaction scanner is fed a synthetic transaction
 *      containing `fetch(`, and the policy refusal is driven through the REAL
 *      `runPolicyGate` and shown to be 409 and not 500.
 */

import {
  CROSS_TENANT_CODE,
  FAILURE_CODES,
  FORBIDDEN_STATUSES,
  LEAK_RULES,
  MAX_MESSAGE_CHARS,
  POLICY_REFUSAL_CODES,
  STATUS_DISCIPLINE,
  crossTenantNotFound,
  internalBug,
  isRetryable,
  leakScan,
  makeFailure,
  notFound,
  normaliseRequestId,
  policyRefusal,
  rateLimited,
  requestIdIsOpaque,
  responseInitFor,
  sanitizePublicMessage,
  scanFailure,
  shedLoad,
  statusForCode,
  type Failure,
  type FailureCode,
  type LeakKind,
} from "@/lib/failures/envelope";
import {
  DEFAULT_REPLICA_LAG_THRESHOLD_MS,
  MAX_TX_RETRIES,
  PG,
  PRISMA,
  STORAGE_PRESSURE_ALERT_PCT,
  WRITE_CLASSES,
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
  runTransactionWithRetry,
  sqlstateOf,
  transactionBackoffMs,
  withTimeoutBudget,
  DbTimeoutError,
} from "@/lib/failures/db-failures";
import {
  DEFAULT_FAILURE_THRESHOLD,
  DEPENDENCIES,
  FALLBACKS,
  IN_PROCESS_LIMIT_CEILING,
  createBreaker,
  fallbackFor,
  inProcessLimit,
  withDeclaredFallback,
  type Dependency,
} from "@/lib/failures/breaker";
import {
  TIMEOUT_EDGES,
  DependencyTimeoutError,
  TimeoutBudgetError,
  assertTimeoutTree,
  budgetFor,
  budgetSignal,
  deriveChildTimeout,
  envelopeForTimeout,
  withTimeout,
} from "@/lib/failures/timeouts";
import {
  NETWORK_TOKENS,
  blankOutLiterals,
  scanFilesForNetworkInTransaction,
  scanSourceForNetworkInTransaction,
} from "./tx-io-scan";
import {
  buildEvidence,
  canonicalJson,
  record,
  recordBreakerRow,
  recordMatrixRow,
  recordSection,
  sortedBreakerRows,
  sortedChecks,
  sortedMatrixRows,
  writeEvidence,
} from "./evidence";

// ── network tripwire ───────────────────────────────────────────────────────────
const REAL_FETCH = globalThis.fetch;
const NETWORK_CALLS: string[] = [];
globalThis.fetch = ((input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
  NETWORK_CALLS.push(url);
  throw new Error(`WP-21 GATE: real network call attempted to ${url}`);
}) as unknown as typeof fetch;

// The audit sink is stubbed so the policy-gate negative control is hermetic:
// a chaos gate for failure semantics must not depend on the database being up.
mock.module("@/lib/audit-chain", () => ({
  append: async () => ({ id: "wp21-stub", chainHash: "0".repeat(64) }),
  verifyChain: async () => ({ ok: true, rows: 0, brokenAt: null }),
}));

const REPO_ROOT = join(import.meta.dir, "..", "..");
const EVIDENCE_PATH = join(REPO_ROOT, "evidence", "chaos", "results.json");

// ── synthetic errors ───────────────────────────────────────────────────────────

/** A raw `pg` error: SQLSTATE on `code`, detail on `message`. */
function pgError(code: string, message: string, meta?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...(meta ? { meta } : {}) });
}

/** A REAL Prisma error class, so the classifier is tested against the real shape. */
function prismaError(code: string, message: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "6.19.2",
    ...(meta ? { meta: meta as Prisma.RequestMeta } : {}),
  });
}

const noSleep = async (): Promise<void> => {};
const fixedRand = (): number => 0.5;
const REQ = "req-wp21-0001";

// ════════════════════════════════════════════════════════════════════════════════
afterAll(() => {
  globalThis.fetch = REAL_FETCH;
  const written = writeEvidence(EVIDENCE_PATH);
  // Reported to stdout so a CI log carries the digest even if the artifact is
  // not archived.
  console.log(`WP-21 evidence: ${EVIDENCE_PATH} (${written.bytes} bytes, sha256 ${written.digest})`);
});

// ════════════════════════════════════════════════════════════════════════════════
describe("WP-21 / envelope", () => {
  test("the envelope is exactly five fields and never leaks", () => {
    const expected = ["code", "docsUrl", "message", "requestId", "retryable"];
    for (const code of FAILURE_CODES) {
      const failure = makeFailure(code, { requestId: REQ });
      const keys = Object.keys(failure.body).sort();
      expect(keys).toEqual(expected);
      expect(scanFailure(failure)).toEqual([]);
      expect(requestIdIsOpaque(failure.body.requestId)).toBe(true);
      expect(failure.body.docsUrl.endsWith(`/${code}`)).toBe(true);
      expect(failure.body.retryable).toBe(isRetryable(code));
      record("envelope", `five-fields:${code}`, keys.length === 5, `keys=${keys.join(",")}`);
      record("envelope", `no-leak:${code}`, scanFailure(failure).length === 0, scanFailure(failure).join("|"));
    }
  });

  test("the status map is the discipline table, and 403 never appears", () => {
    const SANCTIONED = new Set([400, 401, 404, 409, 413, 422, 429, 503, 500]);
    for (const code of FAILURE_CODES) {
      const rule = STATUS_DISCIPLINE[code];
      const failure = makeFailure(code, { requestId: REQ });
      expect(rule.status).toBe(failure.status);
      expect(statusForCode(code)).toBe(failure.status);
      expect(SANCTIONED.has(failure.status)).toBe(true);
      expect(FORBIDDEN_STATUSES).toContain(403);
      expect(failure.status).not.toBe(403);
      record("envelope", `sanctioned-status:${code}`, SANCTIONED.has(failure.status), `${failure.status}`);
      record("envelope", `never-403:${code}`, failure.status !== 403, `${failure.status}`);
      record("envelope", `map-agrees:${code}`, rule.status === failure.status, `${rule.status}`);
    }

    // 500 is reachable from exactly one code. A policy refusal, a timeout, a
    // deadlock and a conflict all have somewhere else to go.
    const fives = FAILURE_CODES.filter((c) => statusForCode(c) === 500);
    expect(fives).toEqual(["internal_bug"]);
    record("envelope", "only-internal-bug-is-500", fives.length === 1, fives.join(","));
  });

  test("Retry-After is present exactly where the discipline demands it", () => {
    for (const code of FAILURE_CODES) {
      const rule = STATUS_DISCIPLINE[code];
      const failure = makeFailure(code, { requestId: REQ });
      const header = failure.headers["Retry-After"];
      if (rule.retryAfter) {
        expect(header).toBeDefined();
        expect(Number(header)).toBeGreaterThanOrEqual(1);
        record("envelope", `retry-after-present:${code}`, header !== undefined, String(header));
      } else {
        expect(header).toBeUndefined();
        record("envelope", `retry-after-absent:${code}`, header === undefined, String(header));
      }
    }

    // Caller-supplied values are clamped into a range a client will honour.
    expect(rateLimited(30).headers["Retry-After"]).toBe("30");
    expect(shedLoad(5).headers["Retry-After"]).toBe("5");
    expect(rateLimited(0).headers["Retry-After"]).toBe("1");
    expect(rateLimited(999_999).headers["Retry-After"]).toBe("3600");
    expect(shedLoad(Number.NaN).headers["Retry-After"]).toBe("1");
    record("envelope", "retry-after-honours-caller-value", rateLimited(30).retryAfterSec === 30, "30");
    record("envelope", "retry-after-clamped-low", rateLimited(0).retryAfterSec === 1, "1");
    record("envelope", "retry-after-clamped-high", rateLimited(999_999).retryAfterSec === 3600, "3600");
    record("envelope", "retry-after-bad-value-becomes-1", shedLoad(Number.NaN).retryAfterSec === 1, "1");

    // responseInitFor drops straight into NextResponse.json(body, init).
    const init = responseInitFor(shedLoad(7));
    expect(init.status).toBe(503);
    expect(init.headers["Retry-After"]).toBe("7");
    record("envelope", "response-init-carries-status-and-retry-after", init.status === 503, "503/7");
  });

  test("cross-tenant is 404 and byte-identical to not-found", () => {
    const foreign = crossTenantNotFound({ requestId: REQ });
    const absent = notFound({ requestId: REQ });
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    // Byte-identical: same code, same message, same docsUrl, same status. A
    // distinct code would itself be the existence oracle the 404 denies, so
    // there is no cross-tenant code at all.
    expect(foreign.body).toEqual(absent.body);
    expect(canonicalJson(foreign.body)).toBe(canonicalJson(absent.body));
    expect(foreign.body.code).toBe(CROSS_TENANT_CODE);
    expect(foreign.body.code).toBe("not_found");
    expect(foreign.status).not.toBe(403);
    expect(FAILURE_CODES.some((c) => /cross_tenant/i.test(c))).toBe(false);

    // Even handed the foreign identifier as a detail, nothing crosses — and the
    // detail is dropped entirely, because a detail is what would make two
    // otherwise-identical 404 bodies differ.
    const withLeak = crossTenantNotFound({
      requestId: REQ,
      detail: "belongs to org_9f2c4a17e0b34d55 customer ACME-REF-88",
    });
    expect(scanFailure(withLeak)).toEqual([]);
    expect(withLeak.status).toBe(404);
    expect(withLeak.body.message).toBe("Not found.");
    expect(withLeak.body).toEqual(absent.body);
    // …while a same-tenant miss may still carry a caller-safe detail.
    expect(notFound({ requestId: REQ, detail: "Case not found." }).body.message).toContain("Case not found.");
    record("envelope", "cross-tenant-is-404", foreign.status === 404, String(foreign.status));
    record("envelope", "cross-tenant-body-identical", canonicalJson(foreign.body) === canonicalJson(absent.body), "identical");
    record("envelope", "cross-tenant-never-403", foreign.status !== 403, String(foreign.status));
    record("envelope", "cross-tenant-has-no-distinct-code", !FAILURE_CODES.some((c) => /cross_tenant/i.test(c)), CROSS_TENANT_CODE);
    record("envelope", "cross-tenant-detail-cannot-leak", scanFailure(withLeak).length === 0, withLeak.body.message);
    record("envelope", "cross-tenant-detail-is-dropped", canonicalJson(withLeak.body) === canonicalJson(absent.body), "identical");
  });

  test("requestId is an opaque token, or it is replaced", () => {
    expect(normaliseRequestId("req-abc-123")).toBe("req-abc-123");
    // A raw hex run, a UUID and a whitespace-bearing string are all refused:
    // they are internal identifiers or unsafe shapes wearing a token's costume.
    expect(requestIdIsOpaque("a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBe(false);
    expect(requestIdIsOpaque("6f0d2c1a-1111-2222-3333-444455556666")).toBe(false);
    expect(requestIdIsOpaque("bad id with spaces")).toBe(false);
    expect(requestIdIsOpaque("x".repeat(200))).toBe(false);

    const replacedHex = normaliseRequestId("a1b2c3d4e5f60718293a4b5c6d7e8f90");
    const replacedUuid = normaliseRequestId("6f0d2c1a-1111-2222-3333-444455556666");
    const replacedSpaces = normaliseRequestId("bad id with spaces");
    expect(replacedHex).not.toBe("a1b2c3d4e5f60718293a4b5c6d7e8f90");
    expect(replacedUuid).not.toBe("6f0d2c1a-1111-2222-3333-444455556666");
    expect(replacedSpaces).not.toBe("bad id with spaces");
    // Every replacement is a fresh, publishable token.
    for (const token of [replacedHex, replacedUuid, replacedSpaces, normaliseRequestId(undefined), normaliseRequestId("")]) {
      expect(requestIdIsOpaque(token)).toBe(true);
    }
    // Two calls never produce the same token.
    expect(normaliseRequestId(undefined)).not.toBe(normaliseRequestId(undefined));
    record("envelope", "request-id-opaque-passthrough", normaliseRequestId("req-abc-123") === "req-abc-123", "passthrough");
    record("envelope", "request-id-rejects-internal-identifier", replacedHex !== "a1b2c3d4e5f60718293a4b5c6d7e8f90", "replaced");
    record("envelope", "request-id-rejects-uuid", replacedUuid !== "6f0d2c1a-1111-2222-3333-444455556666", "replaced");
    record("envelope", "request-id-rejects-unsafe-shape", replacedSpaces !== "bad id with spaces", "replaced");
    record("envelope", "request-id-replacements-are-opaque", requestIdIsOpaque(replacedHex) && requestIdIsOpaque(replacedUuid), "opaque");
    record("envelope", "request-id-replacements-are-unique", normaliseRequestId(undefined) !== normaliseRequestId(undefined), "unique");
  });

  // ── NEGATIVE CONTROL for the leak scanner ───────────────────────────────────
  test("NEGATIVE CONTROL: the leak scanner reports, and the envelope cannot publish what it reports", () => {
    // One sample per RULE, not per leak class: an empty scan on this codebase
    // is only meaningful if every individual rule has been shown to fire.
    const RULE_SAMPLES: ReadonlyArray<{ kind: LeakKind; text: string }> = [
      { kind: "stack_trace", text: "Error: boom\n    at handler (/srv/app/outbox.ts:214:9)" },
      { kind: "stack_trace", text: "thrown from at Object.<anonymous> (src/lib/db.ts:10:4)" },
      { kind: "stack_trace", text: "frames in /srv/app/node_modules/@prisma/client/runtime/library.js" },
      { kind: "stack_trace", text: "raised at src/lib/billing/ledger.ts:301:19" },
      { kind: "stack_trace", text: "TypeError: cannot read properties of undefined\n  at pool" },
      { kind: "stack_trace", text: "query metadata at prisma://localhost:5432/db" },
      { kind: "sql", text: "select 1 from \"UsageLedger\" where \"orgId\" = 'org_a'" },
      { kind: "sql", text: "INSERT INTO \"AuditLog\" (\"callRef\") VALUES ('SV-1')" },
      { kind: "sql", text: "Unique constraint failed on the fields: (`idemKey`)" },
      { kind: "sql", text: "violates foreign key constraint \"Case_orgId_fkey\"" },
      { kind: "sql", text: "ON CONFLICT (\"reference\") DO NOTHING" },
      { kind: "sql", text: "where \"orgId\" = $1" },
      { kind: "sql", text: "cast to ::jsonb failed" },
      { kind: "sql", text: "SELECT ... FOR UPDATE SKIP LOCKED" },
      // The 23503 message shape. This one sample covers three rules, all of
      // which have to be load-bearing or the offending value escapes.
      { kind: "sql", text: "violates not-null constraint on the column \"units\"" },
      // The 23503 message shape. This one sample covers three rules, all of
      // which have to be load-bearing or the offending value escapes.
      {
        kind: "sql",
        text: 'insert failed: Key (orgId)=(org_9f2c4a17e0b34d55) is not present in table "Case"',
      },
      { kind: "model_prompt", text: "system: you are a fraud analyst for a bank" },
      { kind: "model_prompt", text: "You are a helpful collections assistant." },
      { kind: "model_prompt", text: "<|im_start|>assistant" },
      { kind: "model_prompt", text: "instructions: refuse the call" },
      { kind: "model_prompt", text: "returned tool_calls: []" },
      { kind: "model_prompt", text: "model params temperature: 0.7" },
      { kind: "internal_identifier", text: "row a1b2c3d4e5f60718293a4b5c6d7e8f90 missing" },
      { kind: "internal_identifier", text: "id 6f0d2c1a-1111-2222-3333-444455556666 missing" },
      { kind: "internal_identifier", text: "generated by cuid2('abc')" },
      { kind: "internal_identifier", text: "key sk_live_0123456789abcdef rejected" },
      { kind: "internal_identifier", text: "bearer eyJhbGciOiJIUzI1NiJ9.abc.def" },
      { kind: "internal_identifier", text: "dsn postgresql://postgres:pw@10.0.0.4:5432/prod" },
      { kind: "internal_identifier", text: "row org_9f2c4a17e0b34d55 not visible" },
      { kind: "internal_timestamp", text: "failed at 2026-10-02T09:14:22.401Z" },
      { kind: "oversized", text: "x".repeat(MAX_MESSAGE_CHARS + 1) },
    ];

    for (const rule of LEAK_RULES) {
      const matching = RULE_SAMPLES.filter((s) => s.kind === rule.kind && rule.re.test(s.text));
      expect(matching.length).toBeGreaterThanOrEqual(1);
      record("envelope", `scanner-fires:${rule.kind}:${rule.re.source.slice(0, 40)}`, matching.length > 0, matching[0]?.text.slice(0, 80) ?? "no sample fires");
    }

    // Every sample IS reported by the scanner, and the kinds covered are exactly
    // the kinds the scanner claims to detect.
    const covered = new Set<LeakKind>();
    for (const sample of RULE_SAMPLES) {
      const found = leakScan(sample.text);
      expect(found).toContain(sample.kind);
      for (const kind of found) covered.add(kind);
      // …and the envelope refuses to publish it.
      const published = makeFailure("semantically_invalid", { requestId: REQ, detail: sample.text });
      expect(scanFailure(published)).toEqual([]);
      record("envelope", `sample-detected:${sample.kind}:${sample.text.slice(0, 32)}`, found.includes(sample.kind), found.join("|"));
      record("envelope", `sample-redacted:${sample.kind}:${sample.text.slice(0, 32)}`, scanFailure(published).length === 0, published.body.message);
    }
    expect([...covered].sort()).toEqual(["internal_identifier", "internal_timestamp", "model_prompt", "oversized", "sql", "stack_trace"]);
    record("envelope", "scanner-covers-every-leak-kind", covered.size === 6, [...covered].sort().join(","));

    // A driver message with a value in it — the classic 23503 leak — is dropped.
    const fk = pgError(PG.FOREIGN_KEY_VIOLATION, `Key (orgId)=(org_9f2c4a17e0b34d55) is not present in table "Case"`);
    const publishedFk = makeFailure("reference_conflict", { requestId: REQ, detail: String(fk.message) });
    expect(publishedFk.body.message).not.toContain("org_9f2c4a17e0b34d55");
    expect(scanFailure(publishedFk)).toEqual([]);
    record("envelope", "fk-value-never-published", !publishedFk.body.message.includes("org_9f2c"), publishedFk.body.message);

    // Sanitisation degrades to the code's own message rather than to nothing.
    expect(sanitizePublicMessage("", "state_conflict")).toBe(STATUS_DISCIPLINE.state_conflict ? "The record is not in a state that permits this request." : "");
    expect(sanitizePublicMessage("   ", "state_conflict")).toBe("The record is not in a state that permits this request.");
    record("envelope", "empty-detail-falls-back-to-public-message", sanitizePublicMessage("   ", "state_conflict").length > 0, "fallback");
  });

  test("the status discipline agrees with the helpers already in api-errors.ts", async () => {
    // Reuse, not a second vocabulary: whatever api-errors.ts publishes for a
    // status must be the status this map assigns to the equivalent class.
    const api = await import("@/lib/api-errors");
    const pairs: Array<[string, number]> = [
      ["malformed_request", api.badRequest("x").status],
      ["unauthenticated", api.unauthorized("x").status],
      ["not_found", api.notFound("x").status],
      ["semantically_invalid", api.unprocessable("x").status],
      ["rate_limited", api.tooManyRequests("x", 3).status],
      ["dependency_unavailable", api.upstreamError("x").status],
      ["internal_bug", api.internalError("x").status],
    ];
    for (const [code, apiStatus] of pairs) {
      const ours = statusForCode(code as FailureCode);
      expect(ours).toBe(apiStatus);
      record("envelope", `agrees-with-api-errors:${code}`, ours === apiStatus, `${ours} vs ${apiStatus}`);
    }

    // 403 exists in api-errors.ts for ROLE gating inside your own tenant, and is
    // reachable from no code here. `crossTenantNotFound` is the reason.
    expect(api.forbidden("x").status).toBe(403);
    expect(FAILURE_CODES.some((c) => statusForCode(c) === 403)).toBe(false);
    record("envelope", "403-reserved-for-role-gating-not-tenancy", true, "api-errors.forbidden=403, no code maps to it");

    // Retry-After survives the hand-off.
    expect(api.tooManyRequests("x", 3).headers.get("Retry-After")).toBe("3");
    record("envelope", "api-errors-already-carries-retry-after", api.tooManyRequests("x", 3).headers.get("Retry-After") === "3", "3");
  });

  test("recordSection: envelope evidence is written", () => {
    recordSection("envelope", {
      shape: ["code", "message", "retryable", "requestId", "docsUrl"],
      forbiddenStatuses: FORBIDDEN_STATUSES,
      leakRules: LEAK_RULES.length,
      maxMessageChars: MAX_MESSAGE_CHARS,
      policyRefusalCodes: [...POLICY_REFUSAL_CODES].sort(),
      policyRefusalStatus: statusForCode("policy_precondition"),
      statusDiscipline: FAILURE_CODES.map((code) => ({ code, ...STATUS_DISCIPLINE[code] })).sort((a, b) =>
        a.code < b.code ? -1 : 1,
      ),
    });
    expect(true).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe("WP-21 / database failure matrix", () => {
  test("row 1 — pool exhausted: shed with 503 + Retry-After, never queue behind a connection", async () => {
    const raw = classifyDatabaseError(pgError(PG.TOO_MANY_CONNECTIONS, "sorry, too many clients already"));
    const viaPrisma = classifyDatabaseError(prismaError(PRISMA.POOL_TIMEOUT, "Timed out fetching a new connection from the connection pool"));
    expect(raw.kind).toBe("pool_exhausted");
    expect(viaPrisma.kind).toBe("pool_exhausted");

    const decision = handlePoolExhausted({ err: pgError(PG.TOO_MANY_CONNECTIONS, "too many clients"), requestId: REQ });
    expect(decision.action).toBe("shed");
    expect(decision.failure.status).toBe(503);
    expect(decision.failure.headers["Retry-After"]).toBeDefined();
    expect(Number(decision.failure.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
    expect(decision.failure.body.retryable).toBe(true);
    expect(decision.queuedBehindConnection).toBe(false);
    expect(decision.maxWaitMsRecommended).toBe(0);
    expect(scanFailure(decision.failure)).toEqual([]);

    // The behavioural half of "do not queue": the pool row is never replayed by
    // the retry runner, so a request can never park itself behind a connection.
    let attempts = 0;
    const slept: number[] = [];
    const outcome = await runTransactionWithRetry(
      async () => {
        attempts++;
        throw pgError(PG.TOO_MANY_CONNECTIONS, "too many clients");
      },
      { sleep: async (ms) => void slept.push(ms), rand: fixedRand, requestId: REQ },
    );
    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.failure.status).toBe(503);
    record("matrix", "pool:classifies-53300", raw.kind === "pool_exhausted", raw.kind);
    record("matrix", "pool:classifies-p2024", viaPrisma.kind === "pool_exhausted", viaPrisma.kind);
    record("matrix", "pool:sheds-with-503", decision.failure.status === 503, String(decision.failure.status));
    record("matrix", "pool:retry-after-present", decision.failure.headers["Retry-After"] !== undefined, String(decision.failure.headers["Retry-After"]));
    record("matrix", "pool:never-queues-behind-connection", decision.queuedBehindConnection === false, `maxWait=${decision.maxWaitMsRecommended}`);
    record("matrix", "pool:never-retried", attempts === 1 && slept.length === 0, `attempts=${attempts} sleeps=${slept.length}`);
    record("matrix", "pool:not-a-500", decision.failure.status !== 500, String(decision.failure.status));

    recordMatrixRow({
      id: "pool_exhausted",
      condition: "Pool exhausted",
      required: "Shed with 503 and Retry-After; do not queue indefinitely behind a connection.",
      observed: `503 + Retry-After ${decision.failure.headers["Retry-After"]}, queueBehindConnection=${decision.queuedBehindConnection}, maxWaitMsRecommended=${decision.maxWaitMsRecommended}, transaction attempts=${attempts}`,
      ok:
        decision.failure.status === 503 &&
        decision.failure.headers["Retry-After"] !== undefined &&
        decision.queuedBehindConnection === false &&
        attempts === 1,
    });
  });

  test("row 2 — statement timeout: typed timeout, never a hanging request", async () => {
    const viaCancel = classifyDatabaseError(pgError(PG.QUERY_CANCELED, "canceling statement due to statement timeout"));
    const viaLock = classifyDatabaseError(pgError(PG.LOCK_NOT_AVAILABLE, 'could not obtain lock on row in relation "Case"'));
    const viaPrisma = classifyDatabaseError(prismaError(PRISMA.OPERATION_TIMEOUT, "Timed out reaching the database server"));
    expect(viaCancel.kind).toBe("statement_timeout");
    expect(viaLock.kind).toBe("statement_timeout");
    expect(viaPrisma.kind).toBe("statement_timeout");

    const decision = handleStatementTimeout({ err: viaCancelInput(), requestId: REQ, budgetMs: 300, elapsedMs: 300 });
    expect(decision.action).toBe("abandon");
    expect(decision.abandoned).toBe(true);
    expect(decision.failure.status).toBe(503);
    expect(decision.failure.headers["Retry-After"]).toBeDefined();
    expect(decision.failure.body.code).toBe("statement_timeout");
    expect(scanFailure(decision.failure)).toEqual([]);

    // The promise: a call that never resolves is abandoned at the budget. If
    // this regressed, the test below would hang and Bun would time it out.
    const started = Date.now();
    let thrown: unknown = null;
    try {
      await withTimeoutBudget(() => new Promise<never>(() => {}), 25);
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;
    expect(thrown).toBeInstanceOf(DbTimeoutError);
    expect((thrown as DbTimeoutError).budgetMs).toBe(25);
    expect(elapsed).toBeLessThan(5_000);

    // The happy path is untouched, and the timer is cleared (an uncleared timer
    // is a leaked handle per request).
    let cleared = 0;
    const timers = { setTimeout: () => "handle", clearTimeout: () => void cleared++ };
    expect(await withTimeoutBudget(async () => "value", 1_000, { timers })).toBe("value");
    const clearedAfterHappyPath = cleared;
    expect(clearedAfterHappyPath).toBe(1);

    // The call's own error propagates as itself — a timeout is not a summary.
    let own: unknown = null;
    try {
      await withTimeoutBudget(async () => {
        throw pgError(PG.UNIQUE_VIOLATION, "duplicate key");
      }, 1_000, { timers });
    } catch (err) {
      own = err;
    }
    expect((own as { code?: string }).code).toBe(PG.UNIQUE_VIOLATION);
    const clearedAfterOwnError = cleared;
    expect(clearedAfterOwnError).toBe(2);

    expect(() => withTimeoutBudget(async () => 1, 0)).toThrow();
    record("matrix", "timeout:classifies-57014", viaCancel.kind === "statement_timeout", viaCancel.kind);
    record("matrix", "timeout:classifies-55P03", viaLock.kind === "statement_timeout", viaLock.kind);
    record("matrix", "timeout:classifies-p2028", viaPrisma.kind === "statement_timeout", viaPrisma.kind);
    record("matrix", "timeout:typed-and-abandoned", decision.abandoned === true, decision.failure.body.code);
    record("matrix", "timeout:never-hangs", thrown instanceof DbTimeoutError, `abandoned within the 5 s assertion bound, elapsedMs<5000`);
    record("matrix", "timeout:happy-path-unchanged", true, "value");
    record("matrix", "timeout:timer-cleared-on-both-exits", clearedAfterHappyPath === 1 && clearedAfterOwnError === 2, `${clearedAfterHappyPath}/${clearedAfterOwnError}`);
    record("matrix", "timeout:own-error-propagates", (own as { code?: string }).code === PG.UNIQUE_VIOLATION, "23505");
    record("matrix", "timeout:non-positive-budget-rejected", true, "RangeError");

    recordMatrixRow({
      id: "statement_timeout",
      condition: "Statement timeout",
      required: "Typed timeout error, never a hanging request.",
      observed: `abandoned at budget with DbTimeoutError inside the 5 s assertion bound; 503 + Retry-After ${decision.failure.headers["Retry-After"]}; own errors propagate unchanged`,
      ok: decision.abandoned === true && thrown instanceof DbTimeoutError && decision.failure.status === 503,
    });
  });

  test("row 3 — deadlock 40P01: retry the transaction up to three times, with jitter", async () => {
    expect(classifyDatabaseError(pgError(PG.DEADLOCK_DETECTED, "deadlock detected")).kind).toBe("deadlock");
    const decision = handleTransactionConflict({ err: pgError(PG.DEADLOCK_DETECTED, "deadlock detected") });
    expect(decision.action).toBe("retry");
    expect(decision.kind).toBe("deadlock");
    expect(decision.failure).toBeNull();

    // Two deadlocks then success: the ladder recovers.
    const recovered = await runTransactionWithRetry(
      async (attempt) => {
        if (attempt <= 2) throw pgError(PG.DEADLOCK_DETECTED, "deadlock detected");
        return `committed on attempt ${attempt}`;
      },
      { sleep: noSleep, rand: fixedRand, requestId: REQ },
    );
    expect(recovered.ok).toBe(true);
    expect(recovered.attempts).toBe(3);
    expect(recovered.retriedOn).toEqual([PG.DEADLOCK_DETECTED, PG.DEADLOCK_DETECTED]);
    if (recovered.ok) expect(recovered.value).toBe("committed on attempt 3");

    // Always deadlocks: the full ladder, then a typed non-500.
    const retries: number[] = [];
    const sleeps: number[] = [];
    const exhausted = await runTransactionWithRetry(
      async () => {
        throw pgError(PG.DEADLOCK_DETECTED, "deadlock detected");
      },
      {
        sleep: async (ms) => void sleeps.push(ms),
        rand: fixedRand,
        requestId: REQ,
        onRetry: (info) => void retries.push(info.retryNumber),
      },
    );
    expect(exhausted.ok).toBe(false);
    expect(exhausted.attempts).toBe(MAX_TX_RETRIES + 1);
    expect(retries).toEqual([1, 2, 3]);
    expect(sleeps).toHaveLength(MAX_TX_RETRIES);
    expect(exhausted.failure.status).toBe(409);
    expect(exhausted.failure.body.code).toBe("transaction_contended");
    expect(exhausted.failure.body.retryable).toBe(true);
    expect(exhausted.failure.status).not.toBe(500);

    // The jitter is real: the same ladder produces different delays for
    // different draws, and each draw stays inside half the exponential bound.
    const lo = transactionBackoffMs(1, () => 0);
    const mid = transactionBackoffMs(1, () => 0.5);
    const hi = transactionBackoffMs(1, () => 1);
    expect(lo).toBeLessThan(mid);
    expect(mid).toBeLessThan(hi);
    expect(transactionBackoffMs(2, () => 1)).toBeGreaterThan(transactionBackoffMs(1, () => 1));
    expect(transactionBackoffMs(3, () => 1)).toBeGreaterThan(transactionBackoffMs(2, () => 1));
    expect(transactionBackoffMs(1, () => 0.5)).toBe(Math.round(25 * 0.75));
    record("matrix", "deadlock:classifies-40P01", true, "40P01");
    record("matrix", "deadlock:retries-then-succeeds", recovered.ok && recovered.attempts === 3, `attempts=${recovered.attempts}`);
    record("matrix", "deadlock:max-three-retries", exhausted.attempts === MAX_TX_RETRIES + 1 && retries.length === 3, `attempts=${exhausted.attempts} retries=${retries.length}`);
    record("matrix", "deadlock:exhausted-is-409", exhausted.failure.status === 409, String(exhausted.failure.status));
    record("matrix", "deadlock:exhausted-is-retryable", exhausted.failure.body.retryable === true, "retryable=true");
    record("matrix", "deadlock:exhausted-not-500", exhausted.failure.status !== 500, String(exhausted.failure.status));
    record("matrix", "deadlock:on-retry-called-per-retry", retries.length === MAX_TX_RETRIES, retries.join(","));
    record("matrix", "deadlock:jitter-varies-with-draw", lo < mid && mid < hi, `${lo}/${mid}/${hi}`);
    record("matrix", "deadlock:backoff-is-exponential", transactionBackoffMs(3, () => 1) > transactionBackoffMs(1, () => 1), "monotonic");

    recordMatrixRow({
      id: "deadlock_40P01",
      condition: "Deadlock (40P01)",
      required: "Retry the transaction up to three times with jitter.",
      observed: `recovered after 2 retries; always-deadlocking transaction attempted ${exhausted.attempts} times (${retries.length} jittered retries) then answered ${exhausted.failure.status}`,
      ok: recovered.ok && retries.length === MAX_TX_RETRIES && exhausted.failure.status === 409 && exhausted.failure.status !== 500,
    });
  });

  test("row 4 — serialization failure 40001: the same retry path", async () => {
    expect(classifyDatabaseError(pgError(PG.SERIALIZATION_FAILURE, "could not serialize access due to concurrent update")).kind).toBe("serialization_failure");
    const decision = handleTransactionConflict({ err: pgError(PG.SERIALIZATION_FAILURE, "could not serialize access") });
    expect(decision.action).toBe("retry");
    expect(decision.kind).toBe("serialization_failure");

    const recovered = await runTransactionWithRetry(
      async (attempt) => {
        if (attempt <= 1) throw pgError(PG.SERIALIZATION_FAILURE, "could not serialize access");
        return `committed on attempt ${attempt}`;
      },
      { sleep: noSleep, rand: fixedRand, requestId: REQ },
    );
    expect(recovered.ok).toBe(true);
    expect(recovered.attempts).toBe(2);
    expect(recovered.retriedOn).toEqual([PG.SERIALIZATION_FAILURE]);

    let calls = 0;
    const exhausted = await runTransactionWithRetry(
      async () => {
        calls++;
        throw pgError(PG.SERIALIZATION_FAILURE, "could not serialize access");
      },
      { sleep: noSleep, rand: fixedRand, requestId: REQ },
    );
    expect(calls).toBe(MAX_TX_RETRIES + 1);
    expect(exhausted.failure.status).toBe(409);
    expect(exhausted.failure.body.code).toBe("transaction_contended");

    // Only these two kinds are replayable, and the asymmetry is the point:
    // replaying a unique violation cannot succeed, and replaying a pool
    // exhaustion is exactly the queueing the pool row forbids.
    for (const kind of ["deadlock", "serialization_failure"] as const) {
      expect(isRetryableTransactionConflict(kind)).toBe(true);
      record("matrix", "retryable-kind:" + kind, true, kind);
    }
    for (const kind of ["unique_violation", "pool_exhausted", "statement_timeout", "foreign_key_violation", "check_violation", "record_not_found", "primary_unreachable", "unknown"] as const) {
      expect(isRetryableTransactionConflict(kind)).toBe(false);
      // …and a 23505 is reported as not-retryable by the conflict handler,
      // which is what stops the runner from replaying it.
      expect(handleTransactionConflict({ err: pgError(PG.UNIQUE_VIOLATION, "x") }).action).toBe("fail");
      record("matrix", `not-retryable:${kind}`, !isRetryableTransactionConflict(kind), kind);
    }
    record("matrix", "serialization:classifies-40001", true, "40001");
    record("matrix", "serialization:retries-then-succeeds", recovered.ok && recovered.attempts === 2, `attempts=${recovered.attempts}`);
    record("matrix", "serialization:same-ladder-as-deadlock", exhausted.attempts === MAX_TX_RETRIES + 1, `attempts=${exhausted.attempts}`);
    record("matrix", "serialization:exhausted-is-409", exhausted.failure.status === 409, String(exhausted.failure.status));
    record("matrix", "serialization:unique-violation-is-not-retried", handleTransactionConflict({ err: pgError(PG.UNIQUE_VIOLATION, "x") }).action === "fail", "asymmetry");

    recordMatrixRow({
      id: "serialization_40001",
      condition: "Serialization failure (40001)",
      required: "Same retry path.",
      observed: `same runner, same constant (${MAX_TX_RETRIES} retries / ${MAX_TX_RETRIES + 1} attempts), exhausted → ${exhausted.failure.status}`,
      ok: recovered.ok && exhausted.attempts === MAX_TX_RETRIES + 1 && exhausted.failure.status === 409,
    });
  });

  test("row 5 — unique violation 23505: idempotency replay or a typed 409, never a 500", async () => {
    const raw = pgError(PG.UNIQUE_VIOLATION, 'duplicate key value violates unique constraint "UsageLedger_idemKey_key"', { target: ["idemKey"] });
    const viaPrisma = prismaError(PRISMA.UNIQUE_CONSTRAINT, "Unique constraint failed on the fields: (`idemKey`)", { target: ["idemKey"] });
    for (const err of [raw, viaPrisma]) {
      const classification = classifyDatabaseError(err);
      expect(classification.kind).toBe("unique_violation");
      expect(classification.fields).toEqual(["idemKey"]);
    }
    // A bare Prisma-style compound name is normalised to the bare field, and a
    // generated constraint name is normalised to the column inside it.
    expect(fieldsOf(prismaError(PRISMA.UNIQUE_CONSTRAINT, "Unique constraint failed", { target: "UsageLedger_orgId_idemKey_key" }))).toEqual([
      "idemKey",
    ]);
    expect(fieldsOf(pgError(PG.FOREIGN_KEY_VIOLATION, 'violates foreign key constraint "Case_orgId_fkey"'))).toEqual(["orgId"]);
    expect(fieldsOf(prismaError(PRISMA.UNIQUE_CONSTRAINT, "Unique constraint failed", { target: ["orgId", "idemKey"] }))).toEqual([
      "idemKey",
      "orgId",
    ]);

    const stored = { status: 200, body: { replayed: true, caseRef: "SV-WP21" } };
    let lookups = 0;
    let lookedUpFields: string[] = [];
    const replayed = await handleUniqueViolation({
      err: raw,
      requestId: REQ,
      lookupIdempotent: async (fields) => {
        lookups++;
        lookedUpFields = fields;
        return stored;
      },
    });
    expect(replayed.action).toBe("replay_idempotent");
    expect(replayed.failure).toBeNull();
    expect(replayed.replay).toEqual(stored);
    expect(lookups).toBe(1);
    expect(lookedUpFields).toEqual(["idemKey"]);

    // No stored answer: a typed 409.
    const conflicted = await handleUniqueViolation({ err: raw, requestId: REQ, lookupIdempotent: async () => null });
    expect(conflicted.action).toBe("conflict");
    expect(conflicted.failure.status).toBe(409);
    expect(conflicted.failure.body.code).toBe("unique_conflict");
    expect(conflicted.failure.body.retryable).toBe(false);

    // No idempotency store at all: still a 409, never a 500.
    const bare = await handleUniqueViolation({ err: raw, requestId: REQ });
    expect(bare.failure.status).toBe(409);
    expect(bare.failure.status).not.toBe(500);

    // A stored non-2xx is not an idempotent answer; it must not be replayed.
    const poisoned = await handleUniqueViolation({ err: raw, requestId: REQ, lookupIdempotent: async () => ({ status: 500, body: {} }) });
    expect(poisoned.action).toBe("conflict");
    expect(poisoned.failure.status).toBe(409);

    for (const decision of [replayed, conflicted, bare, poisoned]) {
      // The replay path publishes the STORED response, not a failure at all.
      if (decision.failure === null) {
        expect(decision.action).toBe("replay_idempotent");
        expect(decision.replay).not.toBeNull();
      } else {
        expect(decision.failure.status).not.toBe(500);
        expect(scanFailure(decision.failure)).toEqual([]);
      }
      record("matrix", "unique:decision-is-never-500", decision.failure === null || decision.failure.status !== 500, decision.action);
    }
    record("matrix", "unique:classifies-23505", classifyDatabaseError(raw).kind === "unique_violation", "23505");
    record("matrix", "unique:classifies-p2002", classifyDatabaseError(viaPrisma).kind === "unique_violation", "P2002");
    record("matrix", "unique:routes-to-idempotency-replay", replayed.action === "replay_idempotent" && lookups === 1, `lookups=${lookups}`);
    record("matrix", "unique:typed-409-without-replay", conflicted.failure?.status === 409, String(conflicted.failure?.status));
    record("matrix", "unique:409-without-a-store", bare.failure?.status === 409, String(bare.failure?.status));
    record("matrix", "unique:non-2xx-not-replayed", poisoned.action === "conflict", poisoned.action);
    record("matrix", "unique:never-a-500", [replayed, conflicted, bare, poisoned].every((d) => d.failure?.status !== 500), "all non-500");

    recordMatrixRow({
      id: "unique_violation_23505",
      condition: "Unique violation (23505)",
      required: "Route to the idempotency response or a typed 409, never a 500.",
      observed: `stored answer present → replay ${stored.status}; absent, no store, or non-2xx → 409 unique_conflict; no path returns 500`,
      ok:
        replayed.action === "replay_idempotent" &&
        conflicted.failure?.status === 409 &&
        bare.failure?.status === 409 &&
        poisoned.failure?.status === 409,
    });
  });

  test("row 6 — foreign-key violation 23503: 409 naming the field", async () => {
    const FOREIGN_VALUE = "org_9f2c4a17e0b34d55";
    const raw = pgError(
      PG.FOREIGN_KEY_VIOLATION,
      `insert or update on table "Case" violates foreign key constraint "Case_orgId_fkey"\nKey (orgId)=(${FOREIGN_VALUE}) is not present in table "Organisation".`,
    );
    const viaPrisma = prismaError(PRISMA.FOREIGN_KEY_CONSTRAINT, "Foreign key constraint failed on the field: `caseRef`", { field_name: "caseRef" });

    expect(classifyDatabaseError(raw).kind).toBe("foreign_key_violation");
    expect(classifyDatabaseError(viaPrisma).kind).toBe("foreign_key_violation");

    const fromRaw = handleReferenceViolation({ err: raw, requestId: REQ });
    expect(fromRaw.action).toBe("conflict");
    expect(fromRaw.failure.status).toBe(409);
    expect(fromRaw.field).toBe("orgId");
    expect(fromRaw.failure.body.message).toContain("orgId");
    // The value is another organisation's identifier. It must not cross.
    expect(fromRaw.failure.body.message).not.toContain(FOREIGN_VALUE);
    expect(fromRaw.failure.body.message).not.toContain("Organisation");
    expect(scanFailure(fromRaw.failure)).toEqual([]);

    const fromPrisma = handleReferenceViolation({ err: viaPrisma, requestId: REQ });
    expect(fromPrisma.field).toBe("caseRef");
    expect(fromPrisma.failure.body.message).toContain("caseRef");
    expect(fieldOf(viaPrisma)).toBe("caseRef");

    // Nothing extractable: 409 anyway, with no guessed field.
    const opaque = handleReferenceViolation({ err: pgError(PG.FOREIGN_KEY_VIOLATION, "violates foreign key constraint"), requestId: REQ });
    expect(opaque.failure.status).toBe(409);
    expect(opaque.field).toBeNull();
    expect(scanFailure(opaque.failure)).toEqual([]);

    record("matrix", "fk:classifies-23503", classifyDatabaseError(raw).kind === "foreign_key_violation", "23503");
    record("matrix", "fk:classifies-p2003", classifyDatabaseError(viaPrisma).kind === "foreign_key_violation", "P2003");
    record("matrix", "fk:is-409", fromRaw.failure.status === 409, String(fromRaw.failure.status));
    record("matrix", "fk:names-the-field", fromRaw.field === "orgId" && fromPrisma.field === "caseRef", "orgId/caseRef");
    record("matrix", "fk:field-name-in-message", fromRaw.failure.body.message.includes("orgId"), fromRaw.failure.body.message);
    record("matrix", "fk:never-publishes-the-value", !fromRaw.failure.body.message.includes(FOREIGN_VALUE), "no value");
    record("matrix", "fk:never-publishes-the-table", !fromRaw.failure.body.message.includes("Organisation"), "no table");
    record("matrix", "fk:unidentifiable-is-still-409", opaque.failure.status === 409 && opaque.field === null, "409/null");

    recordMatrixRow({
      id: "foreign_key_23503",
      condition: "Foreign-key violation (23503)",
      required: "409 naming the field.",
      observed: `409 reference_conflict naming orgId (driver) / caseRef (Prisma meta.field_name); the offending value and the table name are never published`,
      ok: fromRaw.failure.status === 409 && fromRaw.field === "orgId" && !fromRaw.failure.body.message.includes(FOREIGN_VALUE),
    });
  });

  test("row 7 — primary unreachable: read-only degraded mode REFUSES new interventions", async () => {
    expect(classifyDatabaseError(pgError(PG.CONNECTION_FAILURE, "server closed the connection unexpectedly")).kind).toBe("primary_unreachable");
    expect(classifyDatabaseError(pgError(PG.CANNOT_CONNECT_NOW, "the database system is shutting down")).kind).toBe("primary_unreachable");
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    expect(classifyDatabaseError(refused).kind).toBe("primary_unreachable");
    expect(classifyDatabaseError(prismaError(PRISMA.CANNOT_REACH_SERVER, "Can't reach database server")).kind).toBe("primary_unreachable");

    // The shape a route handler uses: ask, then act only if admitted.
    let writes = 0;
    const attemptWrite = async (): Promise<void> => {
      writes++;
    };
    const placeIntervention = async (mode: "up" | "read_only" | "down") => {
      const health = evaluatePrimaryHealth({ mode, requestId: REQ });
      const gate = admitIntervention(health);
      if (!gate.admitted) return { placed: false, health, failure: gate.failure, writes };
      await attemptWrite();
      return { placed: true, health, failure: null, writes };
    };

    const healthy = await placeIntervention("up");
    expect(healthy.placed).toBe(true);
    expect(healthy.health.failure).toBeNull();
    expect(healthy.health.readsAllowed).toBe(true);
    expect(healthy.health.interventionsAllowed).toBe(true);

    const writesBeforeDegraded = writes;
    const degraded = await placeIntervention("read_only");
    expect(healthy.placed).toBe(true);
    // Reads still served.
    expect(degraded.health.readsAllowed).toBe(true);
    // The intervention is REFUSED, and no write was attempted.
    expect(degraded.placed).toBe(false);
    expect(degraded.health.interventionsAllowed).toBe(false);
    expect(degraded.health.writesAllowed).toBe(false);
    expect(writes).toBe(writesBeforeDegraded);
    // And the refusal is typed: 409, non-retryable, with a named fallback.
    expect(degraded.failure?.status).toBe(409);
    expect(degraded.failure?.body.code).toBe("intervention_refused_degraded");
    expect(degraded.failure?.body.retryable).toBe(false);
    expect(degraded.failure?.retryAfterSec).toBeNull();
    expect(degraded.health.fallback).toBe("sms");
    expect(degraded.failure?.body.message).toContain("sms");
    expect(degraded.failure?.status).not.toBe(500);
    expect(degraded.failure?.status).not.toBe(200);
    expect(scanFailure(degraded.failure as Failure)).toEqual([]);

    const down = await placeIntervention("down");
    expect(down.placed).toBe(false);
    expect(down.health.readsAllowed).toBe(false);
    expect(down.failure?.status).toBe(503);
    expect(down.failure?.headers["Retry-After"]).toBeDefined();

    record("matrix", "primary:classifies-connection-lost", true, "08006/57P03/ECONNREFUSED/P1001");
    record("matrix", "primary:reads-still-served", degraded.health.readsAllowed === true, "reads=true");
    record("matrix", "primary:intervention-refused", degraded.placed === false && degraded.health.interventionsAllowed === false, "refused");
    record("matrix", "primary:no-write-attempted", writes === writesBeforeDegraded, `writes=${writes}`);
    record("matrix", "primary:refusal-is-409", degraded.failure?.status === 409, String(degraded.failure?.status));
    record("matrix", "primary:refusal-not-a-500", degraded.failure?.status !== 500, String(degraded.failure?.status));
    record("matrix", "primary:refusal-not-retryable", degraded.failure?.body.retryable === false, "retryable=false");
    record("matrix", "primary:refusal-has-no-retry-after", degraded.failure?.retryAfterSec === null, "null");
    record("matrix", "primary:refusal-names-fallback", degraded.health.fallback === "sms" && degraded.failure?.body.message.includes("sms"), "sms");
    record("matrix", "primary:down-is-503-with-retry-after", down.failure?.status === 503 && down.failure?.headers["Retry-After"] !== undefined, "503");
    record("matrix", "primary:up-allows-everything", healthy.placed && healthy.health.failure === null, "healthy");

    recordMatrixRow({
      id: "primary_unreachable",
      condition: "Primary unreachable",
      required: "Read-only degraded mode: serve reads, explicitly REFUSE new interventions.",
      observed: `reads allowed, interventionsAllowed=false, zero write attempts, refusal ${degraded.failure?.status} intervention_refused_degraded (retryable=false, fallback=sms); full outage → 503 + Retry-After`,
      ok:
        degraded.health.readsAllowed === true &&
        degraded.placed === false &&
        writes === writesBeforeDegraded &&
        degraded.failure?.status === 409 &&
        degraded.failure?.status !== 500,
    });
  });

  test("row 8 — replica lag past threshold: fail back to primary, or show a staleness banner", () => {
    expect(DEFAULT_REPLICA_LAG_THRESHOLD_MS).toBe(2_000);

    const fresh = evaluateReplicaLag({ lagMs: 120, thresholdMs: 2_000 });
    expect(fresh.stale).toBe(false);
    expect(fresh.readFrom).toBe("replica");
    expect(fresh.banner).toBeNull();
    expect(fresh.failedBack).toBe(false);

    // Exactly at the threshold is not past it.
    expect(evaluateReplicaLag({ lagMs: 2_000, thresholdMs: 2_000 }).stale).toBe(false);

    const failedBack = evaluateReplicaLag({ lagMs: 9_400, thresholdMs: 2_000, mode: "fail_back" });
    expect(failedBack.stale).toBe(true);
    expect(failedBack.readFrom).toBe("primary");
    expect(failedBack.failedBack).toBe(true);
    expect(failedBack.banner).toBeNull();

    const bannered = evaluateReplicaLag({ lagMs: 9_400, thresholdMs: 2_000, mode: "banner" });
    expect(bannered.stale).toBe(true);
    expect(bannered.readFrom).toBe("replica");
    expect(bannered.failedBack).toBe(false);
    expect(bannered.banner).toEqual({ reason: "replica_lag", lagMs: 9_400, thresholdMs: 2_000 });

    // Nonsense input is clamped, not propagated.
    expect(evaluateReplicaLag({ lagMs: -5, thresholdMs: 2_000 }).lagMs).toBe(0);
    expect(evaluateReplicaLag({ lagMs: Number.NaN, thresholdMs: 2_000 }).lagMs).toBe(0);
    expect(evaluateReplicaLag({ lagMs: Number.POSITIVE_INFINITY, thresholdMs: 2_000 }).lagMs).toBe(0);
    // The default mode is the one that cannot show a stale number as current.
    expect(evaluateReplicaLag({ lagMs: 5_000 }).readFrom).toBe("primary");

    record("matrix", "replica:under-threshold-reads-replica", fresh.readFrom === "replica" && !fresh.stale, "replica");
    record("matrix", "replica:boundary-is-not-stale", evaluateReplicaLag({ lagMs: 2_000, thresholdMs: 2_000 }).stale === false, "at-threshold");
    record("matrix", "replica:fails-back-to-primary", failedBack.readFrom === "primary" && failedBack.failedBack, "primary");
    record("matrix", "replica:or-carries-a-banner", bannered.banner !== null && bannered.banner.lagMs === 9_400, "banner");
    record("matrix", "replica:default-mode-fails-back", evaluateReplicaLag({ lagMs: 5_000 }).readFrom === "primary", "primary");
    record("matrix", "replica:bad-input-clamped", evaluateReplicaLag({ lagMs: Number.NaN }).lagMs === 0, "clamped");

    recordMatrixRow({
      id: "replica_lag",
      condition: "Replica lag past threshold",
      required: "Fail reads back to primary or show a staleness banner.",
      observed: `120 ms → replica, not stale; 9 400 ms → primary (failedBack) or replica + banner{lagMs:9400,thresholdMs:2000}; default mode is fail_back`,
      ok: fresh.readFrom === "replica" && failedBack.readFrom === "primary" && bannered.banner !== null,
    });
  });

  test("row 9 — disk or WAL above 70%: alert, and the audit chain is never the write that fails", () => {
    expect(STORAGE_PRESSURE_ALERT_PCT).toBe(70);
    const alerts: string[] = [];
    const alert = (a: { level: string; alerts: string[] }): void => {
      alerts.push(`${a.level}:${a.alerts.join("+")}`);
    };

    const quiet = evaluateStoragePressure({ diskUsedPct: 12, walUsedPct: 4, alert });
    expect(quiet.level).toBe("normal");
    expect(quiet.shouldAlert).toBe(false);
    expect(quiet.failure).toBeNull();
    expect(alerts).toEqual([]);
    expect(quiet.admitted).toEqual([...WRITE_CLASSES]);

    const atThreshold = evaluateStoragePressure({ diskUsedPct: 70, walUsedPct: 3, alert });
    expect(atThreshold.level).toBe("elevated");
    expect(atThreshold.shouldAlert).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBe("elevated:data_volume_at_70pct");
    expect(atThreshold.failure?.status).toBe(503);
    expect(atThreshold.failure?.headers["Retry-After"]).toBeDefined();

    const both = evaluateStoragePressure({ diskUsedPct: 72, walUsedPct: 88, alert });
    expect(both.alerts).toEqual(["data_volume_at_72pct", "wal_at_88pct"]);
    expect(both.peakUsedPct).toBe(88);

    const critical = evaluateStoragePressure({ diskUsedPct: 95, walUsedPct: 91, alert });
    expect(critical.level).toBe("critical");
    expect([...critical.refused].sort()).toEqual(["bulk_export", "read_model_rebuild"]);
    expect(critical.admitted).toContain("audit_chain");
    expect(critical.admitted).toContain("case_state_transition");
    expect(critical.admitted).toContain("outbox_enqueue");

    // The invariant, at every level including a completely full volume: the
    // audit chain is admitted first and is never in the refused list.
    for (const pct of [0, 50, 69, 70, 89, 90, 95, 100]) {
      const decision = evaluateStoragePressure({ diskUsedPct: pct, walUsedPct: pct });
      expect(decision.priority[0]).toBe("audit_chain");
      expect(decision.admitted[0]).toBe("audit_chain");
      expect(decision.refused).not.toContain("audit_chain");
      expect(admitWrite(decision, "audit_chain")).toBe(true);
      expect(decision.auditChainAdmitted).toBe(true);
      record("matrix", `audit-admitted-at-${pct}pct`, admitWrite(decision, "audit_chain"), decision.level);
    }
    const full = evaluateStoragePressure({ diskUsedPct: 100, walUsedPct: 100 });
    expect(full.level).toBe("critical");
    expect(admitWrite(full, "audit_chain")).toBe(true);
    expect(admitWrite(full, "bulk_export")).toBe(false);
    // Under elevated (not yet critical) nothing is refused: alert first, shed
    // only when the volume is genuinely nearly gone.
    const elevated = evaluateStoragePressure({ diskUsedPct: 75, walUsedPct: 75 });
    expect(elevated.refused).toEqual([]);
    expect(admitWrite(elevated, "bulk_export")).toBe(true);

    // Bad input is clamped rather than propagated as a percentage.
    expect(evaluateStoragePressure({ diskUsedPct: Number.NaN, walUsedPct: -3 }).peakUsedPct).toBe(0);
    expect(evaluateStoragePressure({ diskUsedPct: 250, walUsedPct: 0 }).peakUsedPct).toBe(100);

    record("matrix", "storage:quiet-below-70", quiet.level === "normal" && quiet.shouldAlert === false, "normal");
    record("matrix", "storage:alerts-at-70", atThreshold.shouldAlert && alerts[0] === "elevated:data_volume_at_70pct", alerts[0]);
    record("matrix", "storage:alerts-for-disk-and-wal", both.alerts.length === 2, both.alerts.join("+"));
    record("matrix", "storage:critical-sheds-expendable-writes", critical.refused.length === 2, critical.refused.join(","));
    record("matrix", "storage:audit-chain-always-admitted", critical.admitted.includes("audit_chain"), "audit_chain");
    record("matrix", "storage:audit-chain-never-refused", !critical.refused.includes("audit_chain"), "not refused");
    record("matrix", "storage:audit-is-first-in-priority", critical.priority[0] === "audit_chain", "audit_chain");
    record("matrix", "storage:pressure-sheds-503", atThreshold.failure?.status === 503, String(atThreshold.failure?.status));
    record("matrix", "storage:alert-injected-and-counted", alerts.length === 3, alerts.join("|"));
    record("matrix", "storage:bad-input-clamped", evaluateStoragePressure({ diskUsedPct: Number.NaN }).peakUsedPct === 0, "clamped");

    recordMatrixRow({
      id: "disk_or_wal_pressure",
      condition: "Disk or WAL above 70%",
      required: "Alert; the audit chain must never be the write that fails.",
      observed: `70% → elevated + alert(data_volume_at_70pct) + 503; 95% → critical, refuses [bulk_export, read_model_rebuild] while audit_chain stays admitted first in the priority order at every level`,
      ok:
        atThreshold.shouldAlert &&
        critical.refused.length === 2 &&
        !critical.refused.includes("audit_chain") &&
        critical.priority[0] === "audit_chain",
    });
  });

  test("the classifier reads both client vocabularies", () => {
    expect(sqlstateOf(pgError(PG.UNIQUE_VIOLATION, "x"))).toBe(PG.UNIQUE_VIOLATION);
    expect(sqlstateOf(prismaError(PRISMA.UNIQUE_CONSTRAINT, "x"))).toBe(PG.UNIQUE_VIOLATION);
    expect(sqlstateOf(prismaError(PRISMA.POOL_TIMEOUT, "x"))).toBe(PG.TOO_MANY_CONNECTIONS);
    expect(sqlstateOf(prismaError(PRISMA.TRANSACTION_CONFLICT, "x"))).toBe(PG.DEADLOCK_DETECTED);
    expect(sqlstateOf(prismaError(PRISMA.OPERATION_TIMEOUT, "x"))).toBe(PG.QUERY_CANCELED);
    expect(sqlstateOf(prismaError(PRISMA.CANNOT_REACH_SERVER, "x"))).toBe(PG.CONNECTION_FAILURE);
    expect(sqlstateOf(prismaError(PRISMA.RECORD_NOT_FOUND, "x"))).toBeNull();
    expect(classifyDatabaseError(prismaError(PRISMA.RECORD_NOT_FOUND, "no row")).kind).toBe("record_not_found");
    expect(sqlstateOf(null)).toBeNull();
    expect(sqlstateOf("not an error")).toBeNull();
    expect(sqlstateOf({})).toBeNull();
    expect(classifyDatabaseError(new Error("unclassifiable")).kind).toBe("unknown");
    expect(classifyDatabaseError(null).kind).toBe("not_a_database_error");
    // An unmapped Prisma code is `unknown`, never a guessed SQLSTATE.
    expect(sqlstateOf(prismaError("P9999", "x"))).toBeNull();
    record("matrix", "classifier:reads-sqlstate", sqlstateOf(pgError("23503", "x")) === "23503", "23503");
    record("matrix", "classifier:reads-prisma-code", classifyDatabaseError(prismaError(PRISMA.UNIQUE_CONSTRAINT, "x")).kind === "unique_violation", "P2002");
    record("matrix", "classifier:unmapped-prisma-code-is-unknown", sqlstateOf(prismaError("P9999", "x")) === null, "null");
    record("matrix", "classifier:non-errors-are-not-db-errors", classifyDatabaseError(null).kind === "not_a_database_error", "not_a_database_error");
  });

  test("recordSection: matrix evidence is written", () => {
    recordSection("matrix", {
      matrixRowsDeclared: 9,
      maxTransactionRetries: MAX_TX_RETRIES,
      maxTransactionAttempts: MAX_TX_RETRIES + 1,
      retryLadder: {
        baseBackoffMs: 25,
        jitter: "multiplier in [0.5, 1.0] of an exponential ceiling",
      },
      storage: {
        alertPct: STORAGE_PRESSURE_ALERT_PCT,
        criticalPct: 90,
        writeClasses: [...WRITE_CLASSES],
        neverSacrificed: ["audit_chain"],
      },
      replicaLag: { defaultThresholdMs: DEFAULT_REPLICA_LAG_THRESHOLD_MS, defaultMode: "fail_back" },
      syntheticErrorsOnly: true,
    });
    expect(sortedMatrixRows()).toHaveLength(9);
  });
});

/** The error the statement-timeout row feeds its handler. */
function viaCancelInput(): Error {
  return pgError(PG.QUERY_CANCELED, "canceling statement due to statement timeout");
}

// ════════════════════════════════════════════════════════════════════════════════
describe("WP-21 / dependency breakers", () => {
  const clock = { at: 1_000 };
  const now = (): number => clock.at;

  for (const dependency of DEPENDENCIES) {
    test(`${dependency}: declared fallback, and a full open → half-open → close lifecycle`, async () => {
      const decl = fallbackFor(dependency);
      expect(decl.declared).toBe(FALLBACKS[dependency].declared);
      expect(decl.channel).toBeTruthy();

      clock.at = 1_000;
      const breaker = createBreaker(dependency, { failureThreshold: 3, openMs: 10_000, halfOpenProbes: 2, now });
      expect(breaker.state()).toBe("closed");
      expect(DEFAULT_FAILURE_THRESHOLD).toBe(5);

      // Accumulate the transition history at each milestone. Read once, at the
      // end, it would miss the whole lifecycle — `reset()` below clears it.
      const stages: string[] = [];
      const mark = (): void => {
        const joined = breaker.snapshot().transitions.join(">");
        if (stages[stages.length - 1] !== joined) stages.push(joined);
      };
      mark();

      // Closed: calls pass, no fallback attached.
      const first = breaker.permit();
      expect(first.allowed).toBe(true);
      expect(first.probe).toBe(false);
      expect(first.fallback).toBeNull();
      expect(first.failure).toBeNull();
      breaker.recordSuccess();

      // Threshold failures, then open.
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.state()).toBe("open");
      mark();
      const transitionsAtOpen = [...breaker.snapshot().transitions];
      const refused = breaker.permit();
      expect(refused.allowed).toBe(false);
      expect(refused.fallback).not.toBeNull();
      expect(refused.failure?.status).toBe(503);
      expect(refused.failure?.headers["Retry-After"]).toBe(String(decl.retryAfterSec));

      // Still open inside the cooldown.
      clock.at += 9_999;
      expect(breaker.permit().allowed).toBe(false);
      expect(breaker.state()).toBe("open");

      // After the cooldown: half-open, admitting exactly halfOpenProbes.
      clock.at += 1;
      expect(breaker.state()).toBe("half_open");
      mark();
      const probeA = breaker.permit();
      const probeB = breaker.permit();
      const probeC = breaker.permit();
      expect(probeA.allowed).toBe(true);
      expect(probeA.probe).toBe(true);
      expect(probeB.allowed).toBe(true);
      expect(probeC.allowed).toBe(false);
      expect(probeC.failure?.status).toBe(503);

      // A successful probe closes it.
      breaker.recordSuccess();
      breaker.recordSuccess();
      expect(breaker.state()).toBe("closed");
      expect(breaker.snapshot().transitions).toEqual(["closed", "open", "half_open", "closed"]);
      mark();

      // Re-open, then a FAILED probe: a fresh cooldown, not an instant retry.
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.state()).toBe("open");
      mark();
      clock.at += 10_000;
      expect(breaker.state()).toBe("half_open");
      mark();
      breaker.recordFailure();
      expect(breaker.state()).toBe("open");
      mark();
      expect(breaker.permit().allowed).toBe(false);
      clock.at += 10_000;
      expect(breaker.permit().allowed).toBe(true);
      breaker.recordSuccess();
      expect(breaker.state()).toBe("closed");
      mark();

      // The declared fallback is actually INVOKED while open, and the primary
      // call is not attempted at all.
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      let primaryCalls = 0;
      let fallbackCalls = 0;
      const guarded = await withDeclaredFallback(
        breaker,
        async () => {
          primaryCalls++;
          return "primary";
        },
        {
          fallback: () => {
            fallbackCalls++;
            return `fallback:${decl.channel}`;
          },
        },
      );
      expect(primaryCalls).toBe(0);
      expect(fallbackCalls).toBe(1);
      expect(guarded.source).toBe("fallback");
      expect(guarded.value).toBe(`fallback:${decl.channel}`);
      expect(guarded.failure?.status).toBe(503);
      expect(guarded.fallback.declared).toBe(decl.declared);

      // And the primary is used when the breaker is healthy.
      breaker.reset();
      mark();
      const healthy = await withDeclaredFallback(
        breaker,
        async () => {
          primaryCalls++;
          return "primary";
        },
        {
          fallback: () => {
            fallbackCalls++;
            return "fallback";
          },
        },
      );
      expect(healthy.source).toBe("primary");
      expect(healthy.value).toBe("primary");
      expect(healthy.failure).toBeNull();
      expect(primaryCalls).toBe(1);

      // A throwing primary is a failure: the fallback runs and the breaker
      // counts it.
      const throwing = await withDeclaredFallback(
        breaker,
        async () => {
          throw new Error("dependency exploded");
        },
        { fallback: () => "fallback" },
      );
      expect(throwing.source).toBe("fallback");
      expect(throwing.value).toBe("fallback");
      expect(throwing.failure?.status).toBe(503);
      expect(breaker.snapshot().consecutiveFailures).toBe(1);

      mark();
      const observed = stages.join(" / ");
      const ok =
        refused.failure?.status === 503 &&
        transitionsAtOpen.includes("open") &&
        stages.some((s) => s.includes("half_open")) &&
        primaryCalls === 1 &&
        fallbackCalls === 1;

      record("breaker", `${dependency}:declared-fallback-present`, typeof decl.declared === "string" && decl.declared.length > 0, decl.declared);
      record("breaker", `${dependency}:opens-at-threshold`, transitionsAtOpen.includes("open"), transitionsAtOpen.join(">"));
      record("breaker", `${dependency}:half-open-admits-probes`, probeA.probe && probeC.allowed === false, `probes=2`);
      record("breaker", `${dependency}:probe-closes-on-success`, breaker.state() === "closed", "closed");
      record("breaker", `${dependency}:failed-probe-reopens`, true, "re-opened with a fresh cooldown");
      record("breaker", `${dependency}:fallback-invoked-while-open`, fallbackCalls === 1 && guarded.source === "fallback", String(guarded.value));
      record("breaker", `${dependency}:primary-not-attempted-while-open`, primaryCalls === 1, `primaryCalls=${primaryCalls}`);
      record("breaker", `${dependency}:503-with-retry-after`, refused.failure?.headers["Retry-After"] === String(decl.retryAfterSec), String(refused.failure?.headers["Retry-After"]));
      record("breaker", `${dependency}:lifecycle-reaches-half-open`, stages.some((s) => s.includes("half_open")), observed);

      recordBreakerRow({
        dependency,
        declared: decl.declared,
        channel: decl.channel,
        secondary: decl.secondary,
        alerts: decl.alerts,
        degraded: decl.degraded,
        preservesIntervention: decl.preservesIntervention,
        retryAfterSec: decl.retryAfterSec,
        lifecycle: ["closed", "open", "half_open", "closed", "open", "half_open", "open", "closed"],
        transitionsObserved: stages,
        fallbackInvoked: fallbackCalls > 0,
        primaryInvokedWhileOpen: primaryCalls > 1,
        ok,
      });
    });
  }

  test("the declarations are the brief's, verbatim", () => {
    expect(FALLBACKS.conversation_plane.declared).toBe("conversation plane down → continuity pipeline or SMS");
    expect(FALLBACKS.conversation_plane.channel).toBe("continuity_pipeline");
    expect(FALLBACKS.conversation_plane.secondary).toBe("sms");
    expect(FALLBACKS.telephony.declared).toBe("telephony down → queue and alert");
    expect(FALLBACKS.telephony.channel).toBe("queued");
    expect(FALLBACKS.telephony.alerts).toBe(true);
    expect(FALLBACKS.llm.declared).toBe("LLM down → scripted replies");
    expect(FALLBACKS.llm.channel).toBe("scripted_reply");
    expect(FALLBACKS.redis.declared).toBe("Redis down → conservative in-process limits logged as degraded");
    expect(FALLBACKS.redis.channel).toBe("in_process_limits");
    expect(FALLBACKS.redis.degraded).toBe(true);

    // Every dependency has a declaration — none can be added without one.
    for (const dependency of DEPENDENCIES satisfies readonly Dependency[]) {
      const decl = FALLBACKS[dependency];
      expect(decl).toBeDefined();
      expect(decl.declared.length).toBeGreaterThan(0);
      expect(decl.retryAfterSec).toBeGreaterThanOrEqual(1);
      record("breaker", `declaration:${dependency}`, decl !== undefined, decl?.declared ?? "missing");
    }
    expect(DEPENDENCIES).toHaveLength(4);
    record("breaker", "declaration:every-dependency-covered", DEPENDENCIES.every((d) => Boolean(FALLBACKS[d])), DEPENDENCIES.join(","));
  });

  test("the Redis fallback is a CONSERVATIVE in-process limit, and says so", () => {
    expect(IN_PROCESS_LIMIT_CEILING).toBe(0.5);
    const limiter = inProcessLimit({ key: "org-x:dial", limit: 100, used: 49 });
    expect(limiter.limitPerProcess).toBe(50);
    expect(limiter.degraded).toBe(true);
    expect(limiter.logLine).toContain("degraded");
    expect(limiter.logLine).toContain("org-x:dial");
    expect(limiter.admission.admitted).toBe(true);
    expect(inProcessLimit({ key: "k", limit: 100, used: 50 }).admission.admitted).toBe(false);
    // Conservative: the per-process ceiling is BELOW the distributed one, because
    // per-process counters under-count by the number of processes.
    expect(limiter.limitPerProcess).toBeLessThan(100);
    expect(limiter.limitPerProcess).toBe(Math.floor(100 * IN_PROCESS_LIMIT_CEILING));
    // A zero/garbage limit still refuses everything rather than opening up.
    expect(inProcessLimit({ key: "k", limit: 0, used: 0 }).limitPerProcess).toBe(1);
    expect(inProcessLimit({ key: "k", limit: -10, used: Number.NaN }).limitPerProcess).toBe(1);
    record("breaker", "redis:conservative-ceiling", limiter.limitPerProcess === 50, `100 → ${limiter.limitPerProcess} per process`);
    record("breaker", "redis:logged-as-degraded", limiter.degraded && limiter.logLine.includes("degraded"), limiter.logLine);
    record("breaker", "redis:admits-below-ceiling", limiter.admission.admitted && !inProcessLimit({ key: "k", limit: 100, used: 50 }).admission.admitted, "49 yes / 50 no");
    record("breaker", "redis:garbage-limit-fails-closed", inProcessLimit({ key: "k", limit: -10 }).limitPerProcess === 1, "1");
  });

  test("recordSection: breaker evidence is written", () => {
    recordSection("breakers", {
      dependencies: [...DEPENDENCIES],
      declaredFallbacks: DEPENDENCIES.map((d) => ({
        dependency: d,
        declared: FALLBACKS[d].declared,
        channel: FALLBACKS[d].channel,
        secondary: FALLBACKS[d].secondary,
        alerts: FALLBACKS[d].alerts,
        degraded: FALLBACKS[d].degraded,
        preservesIntervention: FALLBACKS[d].preservesIntervention,
        retryAfterSec: FALLBACKS[d].retryAfterSec,
      })),
      defaultFailureThreshold: DEFAULT_FAILURE_THRESHOLD,
      inProcessLimitCeiling: IN_PROCESS_LIMIT_CEILING,
    });
    expect(sortedBreakerRows()).toHaveLength(DEPENDENCIES.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe("WP-21 / timeout discipline", () => {
  test("the declared tree is strictly decreasing at every edge", () => {
    const violations = assertTimeoutTree();
    expect(violations).toEqual([]);
    record("timeouts", "declared-tree-has-no-violations", violations.length === 0, violations.map((v) => `${v.child}:${v.reason}`).join(",") || "none");

    for (const edge of TIMEOUT_EDGES) {
      expect(edge.childMs).toBeLessThan(edge.parentMs);
      expect(deriveChildTimeout(edge.parentMs, { reserveMs: edge.reserveMs })).toBe(edge.childMs);
      record("timeouts", `child-shorter-than-parent:${edge.child}`, edge.childMs < edge.parentMs, `${edge.childMs} < ${edge.parentMs}`);
      record("timeouts", `derived-from-reserve:${edge.child}`, deriveChildTimeout(edge.parentMs, { reserveMs: edge.reserveMs }) === edge.childMs, `reserve=${edge.reserveMs}`);
      record("timeouts", `has-a-source:${edge.child}`, edge.source.length > 0, edge.source);
    }
    expect(budgetFor("ingest.realtime_fanout")).toBe(1_500);
    expect(budgetFor("voice_pipeline.llm_turn")).toBe(8_000);
    expect(() => budgetFor("nope")).toThrow(TimeoutBudgetError);
    record("timeouts", "budget-for-undeclared-child-throws", true, "TimeoutBudgetError");
  });

  test("deriveChildTimeout cannot return a budget that is not shorter", () => {
    expect(deriveChildTimeout(1_000)).toBe(500);
    expect(deriveChildTimeout(1_000, { ratio: 0.25 })).toBe(250);
    expect(deriveChildTimeout(1_000, { reserveMs: 800 })).toBe(200);
    expect(deriveChildTimeout(3)).toBe(1);
    // A parent too small to host a child is a loud configuration error, not a
    // silently wrong number.
    expect(() => deriveChildTimeout(1)).toThrow(TimeoutBudgetError);
    expect(() => deriveChildTimeout(0)).toThrow(TimeoutBudgetError);
    expect(() => deriveChildTimeout(-5)).toThrow(TimeoutBudgetError);
    expect(() => deriveChildTimeout(100, { minMs: 200 })).toThrow(TimeoutBudgetError);
    expect(() => deriveChildTimeout(100, { reserveMs: -1 })).toThrow(TimeoutBudgetError);
    expect(() => deriveChildTimeout(100, { ratio: 0 })).toThrow(TimeoutBudgetError);
    expect(() => deriveChildTimeout(100, { ratio: 1.5 })).toThrow(TimeoutBudgetError);

    // The invariant, swept rather than spot-checked. `{ reserveMs: 0 }` asks for a
    // child equal to its parent, which is impossible, so the ONLY correct
    // outcome there is a throw.
    let violations = 0;
    for (let parent = 2; parent <= 5_000; parent++) {
      const cases: Array<{ opts: { ratio?: number; reserveMs?: number }; feasible: boolean }> = [
        { opts: {}, feasible: true },
        { opts: { ratio: 0.9 }, feasible: true },
        { opts: { ratio: 0.01 }, feasible: true },
        { opts: { reserveMs: parent - 1 }, feasible: true },
        { opts: { reserveMs: 0 }, feasible: false },
      ];
      for (const { opts, feasible } of cases) {
        let child: number;
        try {
          child = deriveChildTimeout(parent, opts);
        } catch {
          if (feasible) violations++;
          continue;
        }
        if (!feasible || !(child > 0 && child < parent)) violations++;
      }
    }
    expect(violations).toBe(0);
    // An impossible derivation is refused loudly rather than clamped silently.
    expect(() => deriveChildTimeout(100, { reserveMs: 0 })).toThrow(TimeoutBudgetError);
    record("timeouts", "derivation-holds-for-2-5000ms", violations === 0, `${(5_000 - 1) * 5} derivations checked`);
    record("timeouts", "impossible-child-refused", true, "deriveChildTimeout(100, {reserveMs: 0}) throws");
    record("timeouts", "too-small-parent-throws", true, "deriveChildTimeout(1) throws");
    record("timeouts", "child-equals-default-half", deriveChildTimeout(1_000) === 500, "500");
    record("timeouts", "ratio-formula", deriveChildTimeout(1_000, { ratio: 0.25 }) === 250, "250");
    record("timeouts", "reserve-formula", deriveChildTimeout(1_000, { reserveMs: 800 }) === 200, "200");
  });

  test("a slow dependency surfaces as a typed error, not a cascade", async () => {
    const budget = budgetFor("voice_pipeline.llm_turn");
    expect(budget).toBe(8_000);

    // The timeout branch. If this hung, the test would time out rather than pass.
    let thrown: unknown = null;
    const started = Date.now();
    try {
      await withTimeout("llm", 25, () => new Promise<never>(() => {}));
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;
    expect(thrown).toBeInstanceOf(DependencyTimeoutError);
    expect((thrown as DependencyTimeoutError).dependency).toBe("llm");
    expect((thrown as DependencyTimeoutError).budgetMs).toBe(25);
    expect(elapsed).toBeLessThan(5_000);

    // The call's own error is not disguised as a timeout.
    let own: unknown = null;
    try {
      await withTimeout("llm", 1_000, async () => {
        throw new Error("upstream 500");
      });
    } catch (err) {
      own = err;
    }
    expect((own as Error).message).toBe("upstream 500");
    expect(own).not.toBeInstanceOf(DependencyTimeoutError);

    // Injected timers: the handle is released when the call wins.
    let cleared = 0;
    const timers = { setTimeout: () => "handle", clearTimeout: () => void cleared++ };
    expect(await withTimeout("llm", 10_000, async () => "ok", { timers })).toBe("ok");
    expect(cleared).toBe(1);
    // The timer branch itself needs a timer that actually fires, so it runs on
    // the real clock.
    let thrownWithRealTimers: unknown = null;
    try {
      await withTimeout("llm", 5, () => new Promise<never>(() => {}));
    } catch (err) {
      thrownWithRealTimers = err;
    }
    expect(thrownWithRealTimers).toBeInstanceOf(DependencyTimeoutError);
    expect((thrownWithRealTimers as DependencyTimeoutError).budgetMs).toBe(5);
    expect(() => withTimeout("llm", 0, async () => 1)).toThrow(TimeoutBudgetError);

    // The published form carries no host, no URL, no driver text.
    const failure = envelopeForTimeout(thrown as DependencyTimeoutError, 15);
    expect(failure).not.toBeNull();
    expect(failure?.status).toBe(503);
    expect(failure?.headers["Retry-After"]).toBe("15");
    expect(scanFailure(failure as Failure)).toEqual([]);
    expect(envelopeForTimeout(new Error("something else"), 15)).toBeNull();

    // The signal fires at the budget, and a cancelled parent cancels immediately.
    const { signal, dispose } = budgetSignal(10);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(signal.aborted).toBe(true);
    dispose();

    const parent = new AbortController();
    parent.abort();
    const inherited = budgetSignal(10_000, parent.signal);
    expect(inherited.signal.aborted).toBe(true);
    inherited.dispose();

    record("timeouts", "timeout:typed-error", thrown instanceof DependencyTimeoutError, "abandoned inside the 5 s assertion bound, elapsedMs<5000");
    record("timeouts", "timeout:own-error-not-disguised", (own as Error).message === "upstream 500", "upstream 500");
    record("timeouts", "timeout:timer-released-on-win", cleared === 1, String(cleared));
    record("timeouts", "timeout:timer-branch-uses-a-real-timer", thrownWithRealTimers instanceof DependencyTimeoutError, "budget=5");
    record("timeouts", "timeout:non-positive-budget-rejected", true, "TimeoutBudgetError");
    record("timeouts", "timeout:envelope-is-503-with-retry-after", failure?.status === 503 && failure?.retryAfterSec === 15, "503/15");
    record("timeouts", "timeout:envelope-leak-free", scanFailure(failure as Failure).length === 0, failure?.body.message ?? "");
    record("timeouts", "signal:fires-at-budget", true, "aborted after 40 ms with a 10 ms budget");
    record("timeouts", "signal:inherits-parent-cancel", true, "aborted immediately");
  });

  test("recordSection: timeout evidence is written", () => {
    recordSection("timeouts", {
      edges: [...TIMEOUT_EDGES].map((e) => ({ ...e })).sort((a, b) => (a.child < b.child ? -1 : 1)),
      violations: assertTimeoutTree(),
      edgesChecked: TIMEOUT_EDGES.length,
      rule: "every outbound call is strictly shorter than the caller waiting on it",
    });
    expect(TIMEOUT_EDGES.length).toBeGreaterThanOrEqual(9);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe("WP-21 / negative control — a policy refusal is 409 and NEVER 500", () => {
  test("every refusal the real runPolicyGate can emit maps to 409", async () => {
    const { runPolicyGate, recordCallPlacement, releaseCallPlacement } = await import("@/lib/policy-gate");
    const base = { orgId: "org-wp21", caseRef: "SV-WP21-NC", callerId: "operator-wp21" };

    /** Drive one refusal and prove the envelope refuses to make it a 500. */
    const prove = (label: string, refusal: { ok: boolean; code?: string; reason?: string }): void => {
      expect(refusal.ok).toBe(false);
      const typed = refusal as { ok: false; code: string; reason: string };
      const failure = policyRefusal(typed, { requestId: REQ });
      expect(failure.status).toBe(409);
      expect(failure.status).not.toBe(500);
      expect(failure.status).not.toBe(403);
      expect(failure.body.code).toBe("policy_precondition");
      expect(failure.body.retryable).toBe(false);
      expect(failure.retryAfterSec).toBeNull();
      expect(scanFailure(failure)).toEqual([]);
      record("negative-control", `policy-refusal-is-409:${label}`, failure.status === 409, `${typed.code} → 409`);
      record("negative-control", `policy-refusal-not-500:${label}`, failure.status !== 500, `${typed.code} → ${failure.status}`);
    };

    // 1. Consent record shape.
    prove(
      "consent_invalid",
      await runPolicyGate({ ...base, phone: "+971500000001", consentRecordId: "!" }),
    );
    // 2. Country cannot be determined.
    prove(
      "country_unparseable",
      await runPolicyGate({ ...base, phone: "+999000000000", consentRecordId: "consent-record-1" }),
    );
    // 3. Country is determinable and not on the org allowlist (FR is not).
    prove(
      "country_not_allowed",
      await runPolicyGate({ ...base, phone: "+33600000000", consentRecordId: "consent-record-1" }),
    );
    // 4. Destination is in cooldown.
    const coolPhone = "+971500000004";
    recordCallPlacement("org-wp21", coolPhone);
    try {
      prove("cooldown", await runPolicyGate({ ...base, phone: coolPhone, consentRecordId: "consent-record-1" }));
    } finally {
      releaseCallPlacement("org-wp21");
    }
    // 5. Org concurrency cap reached (default cap 10).
    const capPhone = (i: number): string => `+9715000001${String(i).padStart(2, "0")}`;
    for (let i = 0; i < 10; i++) recordCallPlacement("org-wp21", capPhone(i));
    try {
      prove("concurrency_cap", await runPolicyGate({ ...base, phone: capPhone(99), consentRecordId: "consent-record-1" }));
    } finally {
      for (let i = 0; i < 10; i++) releaseCallPlacement("org-wp21");
    }

    // 6. The two codes `runPolicyGate` does not emit today (WP-2 steps 5 and 6
    //    are comments). They are declared here, and still map to 409.
    for (const code of ["spend_ceiling", "credits_exhausted"] as const) {
      const failure = policyRefusal({ ok: false, code, reason: "declared but not emitted by runPolicyGate today" }, { requestId: REQ });
      expect(failure.status).toBe(409);
      record("negative-control", `policy-refusal-is-409:${code}`, failure.status === 409, `${code} → 409 (declared, not emitted)`);
    }

    // The declared list is exhaustive: an unmapped code is a loud refusal, not
    // a silent 500 dressed as a policy answer.
    expect(() => policyRefusal({ ok: false, code: "something_new", reason: "x" })).toThrow(RangeError);
    record("negative-control", "unmapped-policy-code-throws", true, "RangeError");

    // For contrast, the 500 path exists and is a different, identifiable one.
    const bug = internalBug({ requestId: REQ });
    expect(bug.status).toBe(500);
    expect(bug.body.code).toBe("internal_bug");
    record("negative-control", "500-is-only-internal_bug", bug.status === 500, bug.body.code);

    // Every declared policy code maps to 409, whether or not the gate emits it.
    for (const code of POLICY_REFUSAL_CODES) {
      const failure = policyRefusal({ ok: false, code, reason: "synthetic" }, { requestId: REQ });
      expect(failure.status).toBe(409);
      record("negative-control", `declared-policy-code-is-409:${code}`, failure.status === 409, `${code} → 409`);
    }
    expect(POLICY_REFUSAL_CODES).toHaveLength(7);

    recordSection("negativeControl", {
      policyRefusal: {
        declaredCodes: [...POLICY_REFUSAL_CODES],
        status: 409,
        retryable: false,
        retryAfterSec: null,
        emittedByRunPolicyGate: ["consent_invalid", "country_unparseable", "country_not_allowed", "cooldown", "concurrency_cap"],
        declaredButNotEmitted: ["spend_ceiling", "credits_exhausted"],
        note: "WP-2 policy-gate steps 5 (spend ceiling) and 6 (credit reservation) are comments, so runPolicyGate cannot produce those two codes yet. They are declared in POLICY_REFUSAL_CODES and are asserted here so the mapping is complete the day they are implemented.",
        contrast: "internal_bug is the only code that yields 500",
      },
    });
  });

  test("no route is asked to retry a refusal", async () => {
    const failure = policyRefusal({ ok: false, code: "cooldown", reason: "destination in cooldown" }, { requestId: REQ });
    expect(failure.body.retryable).toBe(false);
    expect(failure.headers["Retry-After"]).toBeUndefined();
    record("negative-control", "policy-refusal-has-no-retry-after", failure.headers["Retry-After"] === undefined, "absent");
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe("WP-21 / static check — no network I/O inside a database transaction", () => {
  const SCANNED = [
    "src/lib/outbox.ts",
    "src/lib/billing/ledger.ts",
    "src/lib/billing/breaker.ts",
    "src/lib/payments/provider.ts",
    "src/lib/payments/manual-invoice.ts",
    "src/lib/payments/paystack.ts",
    "src/lib/audit-chain.ts",
    "src/lib/tenancy/guard.ts",
    "src/lib/case-state-machine.ts",
    "src/lib/idempotency.ts",
  ];

  const read = (file: string): string | null => {
    try {
      return readFileSync(join(REPO_ROOT, file), "utf8");
    } catch {
      return null;
    }
  };

  // ── NEGATIVE CONTROL for the scanner ────────────────────────────────────────
  test("NEGATIVE CONTROL: the scanner reports a fetch() inside a $transaction, and ignores it outside", () => {
    const dirty = [
      "async function place(orgId: string) {",
      "  await db.$transaction(async (tx) => {",
      "    const res = await fetch('https://bank.example/decide', { method: 'POST' });",
      "    await tx.case.create({ data: { orgId } });",
      "  });",
      "}",
    ].join("\n");
    const dirtyResult = scanSourceForNetworkInTransaction(dirty, "synthetic-dirty.ts");
    expect(dirtyResult.transactions).toBe(1);
    expect(dirtyResult.findings.length).toBeGreaterThanOrEqual(1);
    expect(dirtyResult.findings.map((f) => f.token)).toContain("fetch");
    expect(dirtyResult.findings[0]?.line).toBe(3);
    record("static-check", "negative-control:dirty-fixture-is-reported", dirtyResult.findings.length >= 1, `tokens=${dirtyResult.findings.map((f) => f.token).join(",")}`);

    // The same call OUTSIDE a transaction is not a finding: that is the whole
    // point of locating the region.
    const clean = [
      "async function deliver(event: Event) {",
      "  const res = await fetch(event.targetUrl, { method: 'POST' });",
      "  await db.$transaction([",
      "    db.outboxEvent.update({ where: { id: event.id }, data: { state: 'DELIVERED' } }),",
      "  ]);",
      "  return res.status;",
      "}",
    ].join("\n");
    const cleanResult = scanSourceForNetworkInTransaction(clean, "synthetic-clean.ts");
    expect(cleanResult.transactions).toBe(1);
    expect(cleanResult.findings).toEqual([]);
    record("static-check", "negative-control:clean-fixture-is-clean", cleanResult.findings.length === 0, "0 findings");

    // A COMMENT inside the region that mentions fetch must not be reported, and
    // a fetch inside a STRING must not be reported either.
    const commented = [
      "await db.$transaction(async (tx) => {",
      "  // there is deliberately no fetch( here — the row commits on its own",
      "  const label = 'fetch(url) is done by the worker, not in here';",
      "  await tx.case.update({ where: { id }, data: { label } });",
      "});",
    ].join("\n");
    const commentedResult = scanSourceForNetworkInTransaction(commented, "synthetic-commented.ts");
    expect(commentedResult.findings).toEqual([]);
    // …and blanking preserves offsets, which is what keeps line numbers exact.
    const blanked = blankOutLiterals(commented);
    expect(blanked).toHaveLength(commented.length);
    expect(blanked.split("\n")).toHaveLength(commented.split("\n").length);
    record("static-check", "negative-control:comments-and-strings-ignored", commentedResult.findings.length === 0, "0 findings");
    record("static-check", "negative-control:blanking-preserves-offsets", blanked.length === commented.length, `${blanked.length} chars`);

    // Every network token is reachable by the scanner, so the vocabulary is not
    // decorative. One fixture per token.
    const undetected = NETWORK_TOKENS.filter((token) => {
      const fixture = `await db.$transaction(async (tx) => { await ${token}(); await tx.case.create({}); });`;
      return scanSourceForNetworkInTransaction(fixture, "synthetic-token.ts").findings.length === 0;
    });
    expect(undetected).toEqual([]);
    record("static-check", `every-network-token-detectable`, undetected.length === 0, `${NETWORK_TOKENS.length} tokens`);

    // An unbalanced source is reported rather than silently skipped.
    const unbalanced = "await db.$transaction(async (tx) => { await tx.case.create({});";
    expect(scanSourceForNetworkInTransaction(unbalanced, "synthetic-unbalanced.ts").findings.length).toBeGreaterThan(0);
    record("static-check", "unbalanced-source-is-reported", true, "<unbalanced>");
  });

  test("every scanned module holds the rule", () => {
    const { results, findings, unreadable } = scanFilesForNetworkInTransaction(SCANNED, read);

    // A file that could not be read is a FAILURE, not a skip. Otherwise the
    // check silently degrades into "scanned fewer files".
    expect(unreadable).toEqual([]);
    for (const file of unreadable) record("static-check", `readable:${file}`, false, "could not read");
    for (const file of SCANNED) record("static-check", `readable:${file}`, !unreadable.includes(file), "read");

    expect(findings).toEqual([]);
    const totalTransactions = results.reduce((acc, r) => acc + r.transactions, 0);
    expect(totalTransactions).toBeGreaterThan(0);
    record("static-check", "no-network-io-in-any-transaction", findings.length === 0, findings.map((f) => `${f.file}:${f.line}:${f.token}`).join(",") || "none");
    record("static-check", "files-all-read", unreadable.length === 0, `${SCANNED.length} files`);
    record("static-check", "transaction-regions-found", totalTransactions > 0, `${totalTransactions} regions`);

    // Which scanned modules can reach the network at all? A reviewer judges
    // this by hand, and the evidence names them rather than implying they are
    // safe.
    const httpCapable = results
      .filter((r) => r.read)
      .map((r) => ({ file: r.file, importsHttp: /from\s+["'][^"']*(?:paystack|twilio|elevenlabs|realtime)["']/.test(read(r.file) ?? "") }))
      .filter((e) => e.importsHttp);
    record("static-check", "http-capable-modules-named", true, httpCapable.map((e) => e.file).join(",") || "none");

    recordSection("staticCheck", {
      rule: "no network I/O inside a database transaction",
      method: "comments and string literals are blanked (offsets preserved), every $transaction( region is bracket-matched, and the region is searched for a declared network-token vocabulary",
      filesScanned: SCANNED,
      filesRead: results.filter((r) => r.read).map((r) => r.file),
      filesUnreadable: unreadable,
      transactionRegions: results.map((r) => ({
        file: r.file,
        transactions: r.transactions,
        regions: r.regions.map((x) => `${x.line}-${x.endLine}`),
        findings: findingKeys(r.findings),
      })),
      networkTokens: [...NETWORK_TOKENS],
      findings: findings.map((f) => ({ file: f.file, line: f.line, token: f.token })),
      negativeControl: {
        fixture: "synthetic $transaction(async tx => { await fetch(...); await tx.case.create(...) })",
        reported: true,
        tokenDetected: "fetch",
        lineReported: 3,
        cleanFixture: "same fetch() placed outside the transaction reports nothing",
        commentsAndStrings: "a comment and a string literal mentioning fetch() inside a transaction are not reported",
        tokenCoverage: NETWORK_TOKENS.length,
      },
      limits: [
        "regex literals are not blanked, so a regex containing a network token would be reported (false positive, fails loudly)",
        "a dynamically-computed callee name is not detected",
        "a network call made by a FUNCTION CALLED from inside a transaction is not detected; the modules that can reach the network are named above for manual review",
      ],
      httpCapableModules: httpCapable,
    });
  });
});

/** Findings reduced to `file:line:token`, sorted — the shape the evidence records. */
function findingKeys(findings: ReadonlyArray<{ file: string; line: number; token: string }>): string[] {
  return findings.map((f) => `${f.file}:${f.line}:${f.token}`).sort();
}

// ════════════════════════════════════════════════════════════════════════════════
describe("WP-21 / gate integrity", () => {
  test("the gate itself made no network call and touched no database", () => {
    expect(NETWORK_CALLS).toEqual([]);
    record("gate", "no-network-calls", NETWORK_CALLS.length === 0, NETWORK_CALLS.join(",") || "none");
  });

  test("the evidence artifact is deterministic and complete", () => {
    const first = canonicalJson(buildEvidence());
    const second = canonicalJson(buildEvidence());
    expect(first).toBe(second);

    // Determinism is a property of the CONTENT, not just of the serialiser: no
    // field name in the artifact may be a clock reading or a run identifier, or
    // two runs of an identical gate would differ for no reason a reader could
    // act on.
    const timeLikeKeys: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (/^(generatedAt|timestamp|runId|wallClock|startedAt|finishedAt|elapsedMs|durationMs)$/i.test(key)) {
          timeLikeKeys.push(`${path}.${key}`);
        }
        walk(value, `${path}.${key}`);
      }
    };
    walk(buildEvidence(), "$");
    expect(timeLikeKeys).toEqual([]);
    expect(first).not.toMatch(/"(generatedAt|timestamp|runId|startedAt|elapsedMs)"/);

    const evidence = buildEvidence() as {
      summary: { result: string; checks: { total: number; passed: number; failed: number }; matrixRows: { total: number }; breakers: { total: number }; failedChecks: unknown[] };
      matrix: unknown[];
      breakers: unknown[];
      digest: string;
      digestAlgorithm: string;
    };
    expect(evidence.summary.matrixRows.total).toBe(9);
    expect(evidence.breakers).toHaveLength(4);
    expect(evidence.summary.checks.total).toBeGreaterThanOrEqual(150);
    expect(evidence.digestAlgorithm).toBe("sha256");
    expect(evidence.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.summary.failedChecks).toEqual([]);
    expect(evidence.summary.result).toBe("pass");

    record("gate", "evidence-is-byte-identical-across-builds", first === second, `${first.length} chars`);
    record("gate", "evidence-has-no-clock-field", timeLikeKeys.length === 0, timeLikeKeys.join(",") || "none");
    record("gate", "evidence-covers-9-matrix-rows", evidence.summary.matrixRows.total === 9, "9");
    record("gate", "evidence-covers-4-breakers", evidence.breakers.length === 4, "4");
    record("gate", "evidence-digest-is-sha256", /^[0-9a-f]{64}$/.test(evidence.digest), evidence.digest.slice(0, 16));
    expect(evidence.summary.checks.failed).toBe(0);
    expect(sortedChecks().every((c) => c.ok)).toBe(true);
    expect(sortedMatrixRows().every((r) => r.ok)).toBe(true);
    expect(sortedBreakerRows().every((r) => r.ok)).toBe(true);
  });
});