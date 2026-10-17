/**
 * A LOST AUDIT RECORD IS A COUNTED EVENT, NOT A SWALLOWED ONE.
 *
 * Roughly thirty call sites in this product append to the tamper-evident chain
 * and answer a failure with `.catch(() => {})`. That is the right call for
 * fire-and-forget evidence — a record that lands a moment late must not roll
 * back a payment that already committed — but a swallow that logs nothing makes
 * "the chain refused to record this" indistinguishable from "this action never
 * needed a record". The chain can then quietly stop covering the actions it was
 * built to cover while every caller still reports success.
 *
 * So `audit-chain` counts its own terminal failures at the single place that
 * can know, exports the number, and `/api/metrics` publishes it. These cases
 * prove the counter moves — including the negative control, that a retried
 * chain-hash collision is NOT a lost record and must not inflate it.
 *
 *   bun scripts/run-tests.mjs audit-failure-counter
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// The fixture's sequence holds the OUTCOME name per write, and both the mock below
// (`kind === "down"`) and every caller (`queue("ok", "collision")`) pass it as a
// string. It used to be declared as `{ kind: … }`, an object, which made those
// call sites type errors and the comparisons unreachable — the file could not even
// be typechecked, let alone run under `tsc`.
type Write = "ok" | "collision" | "down";

const writer = {
  sequence: [] as Write[],
  calls: 0,
  index: 0,
};

/**
 * `AuditLog.create` with just enough of the client to run `append()`'s fast
 * path: read the chain head, hash, insert. The failure under test is the insert,
 * so the head read resolves `null` (GENESIS) and never depends on a database.
 *
 * `$transaction` is here because `append()` ESCALATES on its last attempt: the
 * final try drops the fast path and takes `pg_advisory_xact_lock` so two replicas
 * cannot fork the chain by both reading the same head (see the retry loop in
 * `append`). Without a `$transaction` on the mock, that escalation threw a
 * TypeError instead of the collision the test staged, and the give-up path ended
 * one attempt early — the retry budget looked exhausted at three writes when the
 * production loop allows four. The callback receives a tx with the same
 * `findFirst`/`create`, so both paths drive the same `writer.sequence`.
 */
mock.module("@/lib/db", () => {
  const auditLog = {
    findFirst: async () => null,
    create: async () => {
      writer.calls += 1;
      const kind = writer.sequence[writer.index] ?? "ok";
      writer.index += 1;
      if (kind === "down") throw new Error("connection terminated");
      if (kind === "collision") {
        const err = new Error("Unique constraint failed on the fields: (`chainHash`)") as Error & {
          code: string;
          meta: { modelName: string };
        };
        err.code = "P2002";
        err.meta = { modelName: "AuditLog" };
        throw err;
      }
      return { id: "audit-1", chainHash: "hash-1", prevHash: "0".repeat(64) };
    },
  };
  return {
    dbAudit: {
      auditLog,
      // The escalation path runs its callback against a tx that carries
      // `$executeRaw` (the advisory lock) and its own `auditLog`. Both are
      // needed for the give-up path to reach a FOURTH write: without
      // `$executeRaw` the callback threw before it ever called `create`, and
      // `writer.calls` stopped at three.
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $executeRaw: async () => 0, auditLog }),
    },
    db: {},
  };
});

// Imported after the seam, so `append()` runs against it.
const { append, auditAppendFailures } = await import("@/lib/audit-chain");

const entry = {
  callRef: "SV-COUNTER-CASE",
  action: "freeze" as const,
  intent: "counter_probe",
};

beforeEach(() => {
  writer.sequence = [];
  writer.calls = 0;
  writer.index = 0;
});

describe("the audit-chain failure counter", () => {
  test("starts clean for a successful append", async () => {
    writer.sequence = ["ok"];
    const before = auditAppendFailures();
    const row = await append(entry, { fast: true });
    expect(row.id).toBe("audit-1");
    expect(auditAppendFailures()).toBe(before);
  });

  test("a terminal failure increments exactly once and still rejects", async () => {
    const before = auditAppendFailures();
    writer.sequence = ["down"];
    let threw = false;
    await append(entry, { fast: true }).catch(() => {
      threw = true;
    });
    expect(threw).toBe(true);
    expect(auditAppendFailures()).toBe(before + 1);
  });

  test("a retried chain-hash collision is not a lost record", async () => {
    // The negative control. Without it, the retry logic inside `append()` would
    // report every burst-load collision as missing evidence, and the one signal
    // operators are asked to act on would be noise.
    const before = auditAppendFailures();
    writer.sequence = ["collision", "collision", "ok"];
    const row = await append(entry, { fast: true });
    expect(row.id).toBe("audit-1");
    expect(writer.calls).toBe(3);
    expect(auditAppendFailures()).toBe(before);
  });

  test("exhausting the collision retries counts as the failure it is", async () => {
    const before = auditAppendFailures();
    // `CHAIN_HASH_COLLISION_RETRIES` is 3, so four attempts all colliding is the
    // give-up path — a record that genuinely did not land.
    writer.sequence = ["collision", "collision", "collision", "collision"];
    let threw = false;
    await append(entry, { fast: true }).catch(() => {
      threw = true;
    });
    expect(threw).toBe(true);
    expect(writer.calls).toBe(4);
    expect(auditAppendFailures()).toBe(before + 1);
  });

  test("the counter is monotonic across appends", async () => {
    const before = auditAppendFailures();
    writer.sequence = ["down", "down", "down"];
    for (let i = 0; i < 3; i++) {
      await append({ ...entry, callRef: `SV-COUNTER-${i}` }, { fast: true }).catch(() => {});
    }
    expect(auditAppendFailures()).toBe(before + 3);
  });
});
