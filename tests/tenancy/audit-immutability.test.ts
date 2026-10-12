/**
 * Audit immutability, prevented rather than merely detected.
 *
 * `src/lib/audit-chain.ts` proves the chain *reports* a forged row: several
 * suites deliberately mutate an `AuditLog` row and assert `verifyChain()` names
 * it. Detection is a good control and it is well tested. It is not the control
 * the questionnaire answers with, and it is the reason this file exists
 * separately: a detector tells an auditor afterwards that the record was
 * rewritten, and the record is still rewritten.
 *
 * So the claim under test here is prevention, at the two layers that can enforce
 * it, on the two roles that can write:
 *
 *   1. THE TRIGGER, for the application role. `securevoice` connects as a
 *      superuser with `BYPASSRLS` (asserted below, not assumed), so no privilege
 *      grant on this table constrains it — only `no_modify_audit` does.
 *   2. THE GRANTS, for `sv_tenant`. The tenant path enters that role with
 *      `SET LOCAL ROLE`, and migration
 *      `9zzzzzzzzzzzzzzzzzzzzzzzzz_audit_immutability_grants` revoked its UPDATE
 *      and DELETE. Row-level security decides WHICH rows a tenant reaches;
 *      privileges decide WHAT it may do to them, and that was the open half.
 *
 * The tests that need the trigger OFF are the reason `tests/preload.ts` disables
 * it, and `ALTER TABLE ... DISABLE TRIGGER` is persistent table state: the guard
 * is off for every connection while a suite is running, and — before that
 * migration existed — stayed off afterwards. That is why the `sv_tenant` half
 * below is the stronger of the two proofs, and why this file restores rather than
 * redistributes table state: every test here enables or disables inside a
 * transaction that it then rolls back, and the last test asserts the catalog is
 * exactly as it found it.
 *
 *   bun test tests/tenancy/audit-immutability.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

const TRIGGER = "no_modify_audit";
const TABLE = '"AuditLog"';

// A trigger name cannot be a bind parameter (it is an identifier, not a value),
// so every use below interpolates this module-level literal. Nothing here is
// derived from a request.
const ENABLE_SQL = `ALTER TABLE ${TABLE} ENABLE TRIGGER ${TRIGGER}`;
const DISABLE_SQL = `ALTER TABLE ${TABLE} DISABLE TRIGGER ${TRIGGER}`;

const RUN = `mv${Date.now().toString(36)}`;
const ORG_ID = `audit-immutable-${RUN}`;
const ids: string[] = [];

/**
 * The guard's live catalog state: 'O' enabled, 'D' disabled, null absent.
 *
 * The runner is a parameter because the state inside a transaction is the whole
 * question: `db.$queryRaw` here would take a DIFFERENT pooled connection, which
 * still sees the committed catalog and reports 'D' no matter what the
 * transaction just enabled. That reads as "the trigger did not turn on", and is
 * the difference between a refused write and a test that never tested one.
 */
type Queryable = Pick<Prisma.TransactionClient, "$queryRaw">;

async function guardState(on: Queryable): Promise<string | null> {
  const rows = await on.$queryRaw<{ tgenabled: string }[]>`
    SELECT t.tgenabled::text AS "tgenabled"
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'AuditLog' AND t.tgname = ${TRIGGER} AND NOT t.tgisinternal`;
  return rows[0]?.tgenabled ?? null;
}

const ROLLBACK = Symbol("always-rollback");

type Attempt = {
  /** The error the mutation raised, or null if it was accepted. */
  raised: unknown;
  /** `pg_trigger.tgenabled` measured INSIDE the transaction, so a silent no-op
   *  cannot be reported as a refusal. */
  stateInTxn?: string | null;
  /** Rows the statement changed, when the statement got that far. */
  affected?: number;
};

/**
 * Run `body` with the guard ENABLED, then roll the transaction back.
 *
 * The rollback is unconditional — a Prisma interactive transaction COMMITS when
 * the callback returns normally, and if the guard had silently stopped firing the
 * callback would return normally with a real forged row behind it. So the success
 * path of a refusal test is "the body threw", and the safety path is a sentinel
 * that makes the commit impossible either way.
 */
async function attemptAgainstLiveGuard(
  body: (tx: Prisma.TransactionClient) => Promise<number | void>,
): Promise<Attempt> {
  let raised: unknown = null;
  let stateInTxn: string | null = null;
  let affected: number | undefined;
  try {
    await db.$transaction(
      async (tx) => {
        // Fail fast and legibly on lock contention instead of eating the whole
        // transaction timeout: ENABLE takes ACCESS EXCLUSIVE on a busy table.
        await tx.$executeRaw`SET LOCAL lock_timeout = '5000'`;
        await tx.$executeRawUnsafe(ENABLE_SQL);
        stateInTxn = await guardState(tx);
        try {
          const r = await body(tx);
          if (typeof r === "number") affected = r;
        } catch (e) {
          raised = e;
        }
        throw ROLLBACK;
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
  } catch (e) {
    // An ENABLE that itself failed (a database without the migration) arrives as
    // an error rather than as a passing test, which is the only honest outcome.
    if (e !== ROLLBACK && !raised) raised = e;
  }
  return { raised, stateInTxn, affected };
}

/** Run `sql` as `sv_tenant`, with `app.org_id` pinned, and roll it back. */
async function attemptAsTenant(sql: string, orgId: string): Promise<Attempt> {
  let raised: unknown = null;
  let affected: number | undefined;
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "sv_tenant"`);
        const who = await tx.$queryRaw<{ r: string }[]>`SELECT current_user::text AS r`;
        if (who[0]?.r !== "sv_tenant") {
          throw new Error(`role switch did not take: current_user = ${who[0]?.r}`);
        }
        try {
          affected = await tx.$executeRawUnsafe(sql);
        } catch (e) {
          raised = e;
        }
        throw ROLLBACK;
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
  } catch (e) {
    if (e !== ROLLBACK && !raised) raised = e;
  }
  // No `stateInTxn`: what this helper proves is a privilege refusal, and tying it
  // to the trigger's catalog state would make it fail for the wrong reason on a
  // database where the trigger happens to be absent.
  return { raised, affected };
}

function messageOf(err: unknown): string {
  const anyErr = err as { message?: string; code?: string };
  return `${anyErr?.message ?? String(err)} ${anyErr?.code ?? ""}`;
}

/** A short, honest failure string: name the guard's state, not just "it threw". */
function describe(err: unknown): string {
  const anyErr = err as { message?: string; code?: string };
  return `${anyErr?.code ?? "no-code"}: ${String(anyErr?.message ?? err).slice(0, 220)}`;
}

async function makeRow(tag: string): Promise<string> {
  const row = await db.auditLog.create({
    data: {
      callRef: `SV-F-IMMUT-${RUN}-${tag}`,
      action: "freeze",
      chainHash: `immut-${RUN}-${tag}`,
      redactedText: "the original, sealed row",
      orgId: ORG_ID,
    },
    select: { id: true },
  });
  ids.push(row.id);
  return row.id;
}

let rowA = "";
let rowB = "";
let stateAtStart: string | null = null;

beforeAll(async () => {
  stateAtStart = await guardState(db);
  rowA = await makeRow("a");
  rowB = await makeRow("b");
});

afterAll(async () => {
  if (ids.length === 0) return;
  // Delete without leaving the guard in a state this suite chose: disable inside
  // the transaction, delete, restore whatever the catalog said on the way in, and
  // commit. A suite that "tidies up" by leaving the trigger off is how an
  // immutability control becomes a fixture.
  await db.$transaction(
    async (tx) => {
      if (stateAtStart) await tx.$executeRawUnsafe(DISABLE_SQL);
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "id" = ANY(${ids}::text[])`;
      if (stateAtStart === "D") await tx.$executeRawUnsafe(DISABLE_SQL);
      else if (stateAtStart === "O") await tx.$executeRawUnsafe(ENABLE_SQL);
    },
    { maxWait: 15_000, timeout: 30_000 },
  );
});

// ── 1. The control is present in the database, not just in a migration file ──

test("the guard exists on AuditLog and covers BOTH mutations", async () => {
  const rows = await db.$queryRaw<{ tgname: string; def: string }[]>`
    SELECT t.tgname::text AS "tgname", pg_get_triggerdef(t.oid) AS "def"
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'AuditLog' AND NOT t.tgisinternal`;
  const guard = rows.find((r) => r.tgname === TRIGGER);
  // "A migration exists" is not the claim; this catalog row is.
  expect(
    guard,
    `no ${TRIGGER} trigger on AuditLog — ${rows.map((r) => r.tgname).join(", ") || "no triggers"}`,
  ).toBeDefined();
  const def = guard?.def ?? "";
  // A BEFORE UPDATE-only trigger would pass a DELETE test by accident of the
  // other half being revoked, and a DELETE-only one would do the reverse.
  expect(def.includes("UPDATE"), `trigger does not cover UPDATE: ${def}`).toBe(true);
  expect(def.includes("DELETE"), `trigger does not cover DELETE: ${def}`).toBe(true);
  expect(def).toContain("prevent_audit_modification");
});

test("the application role is a superuser, which is why grants cannot be the only control", async () => {
  const rows = await db.$queryRaw<{ r: boolean }[]>`
    SELECT rolsuper::bool AS r FROM pg_roles WHERE rolname = current_user`;
  // Documents the asymmetry this suite rests on: if this ever flips, the REVOKE
  // is binding on the app path as well and the trigger stops being the sole
  // guard — at which point the reasoning in the header has to be re-read, not
  // quietly kept.
  expect(
    rows[0]?.r,
    "the connecting role is no longer a superuser; re-derive which control binds it",
  ).toBe(true);
});

// ── 2. Prevention, for the role that no grant can bind ───────────────────────

test("UPDATE of an audit row is refused while the trigger is live", async () => {
  const attempt = await attemptAgainstLiveGuard(async (tx) => {
    await tx.auditLog.update({
      where: { id: rowA },
      data: { redactedText: "rewritten by a forged run" },
    });
  });
  expect(attempt.stateInTxn, "the guard was not enabled inside the transaction").toBe("O");
  expect(attempt.raised, "the UPDATE was accepted — the audit row is writable").toBeDefined();
  expect(messageOf(attempt.raised)).toContain("immutable");

  // The rollback really did undo the ALTER *and* the attempted write.
  const after = await db.auditLog.findUnique({
    where: { id: rowA },
    select: { redactedText: true },
  });
  expect(after?.redactedText).toBe("the original, sealed row");
});

test("DELETE of an audit row is refused while the trigger is live", async () => {
  const attempt = await attemptAgainstLiveGuard(async (tx) => {
    await tx.auditLog.delete({ where: { id: rowB } });
  });
  expect(attempt.stateInTxn, "the guard was not enabled inside the transaction").toBe("O");
  expect(attempt.raised, "the DELETE was accepted — the audit row is deletable").toBeDefined();
  expect(messageOf(attempt.raised)).toContain("immutable");

  expect(await db.auditLog.count({ where: { id: rowB } })).toBe(1);
});

test("raw SQL is refused too, so the guard is not an ORM convention", async () => {
  // Prisma's client-side validation is not the control; the database's is. A
  // trigger that only binds the ORM would be defeated by the `$executeRaw` calls
  // this repository already has in its workers and test harnesses.
  const attempt = await attemptAgainstLiveGuard(
    async (tx) =>
      tx.$executeRaw`UPDATE "AuditLog" SET "redactedText" = 'via raw sql' WHERE "id" = ${rowA}`,
  );
  expect(attempt.stateInTxn).toBe("O");
  expect(attempt.raised, `raw UPDATE was accepted (${attempt.affected ?? 0} rows)`).toBeDefined();
  expect(messageOf(attempt.raised)).toContain("immutable");

  const attempt2 = await attemptAgainstLiveGuard(
    async (tx) => tx.$executeRaw`DELETE FROM "AuditLog" WHERE "id" = ${rowA}`,
  );
  expect(attempt2.raised, "raw DELETE was accepted").toBeDefined();
  expect(messageOf(attempt2.raised)).toContain("immutable");
});

// ── 3. Prevention, for the role the grants DO bind ───────────────────────────

test("sv_tenant cannot UPDATE an audit row, and cannot DELETE one either", async () => {
  // The role switch, not the revoke, is what makes this test mean anything: the
  // connecting role is a superuser and would pass through any privilege check.
  const update = await attemptAsTenant(
    `UPDATE "AuditLog" SET "redactedText" = 'tenant rewrote' WHERE "id" = '${rowA}'`,
    ORG_ID,
  );
  expect(update.raised, "sv_tenant's UPDATE was accepted").toBeDefined();
  expect(messageOf(update.raised)).toContain("permission denied");
  expect(messageOf(update.raised)).toContain("AuditLog");

  const del = await attemptAsTenant(`DELETE FROM "AuditLog" WHERE "id" = '${rowA}'`, ORG_ID);
  expect(del.raised, "sv_tenant's DELETE was accepted").toBeDefined();
  expect(messageOf(del.raised)).toContain("permission denied");

  // The refusal is the PRIVILEGE layer's, not the trigger's: it names neither
  // `immutable` nor `no_modify_audit`. That is what makes this half of the control
  // independent of the harness — it binds while a suite has the guard disabled,
  // which is the state `stateInTxn` recorded for this very transaction.
  expect(messageOf(update.raised)).not.toContain("immutable");
  expect(messageOf(del.raised)).not.toContain("immutable");
});

test("sv_tenant can still read and append: a revocation that broke the append path would be an outage", async () => {
  // The other half of "append-only". SELECT and INSERT stay granted, so a
  // legitimate audit write from inside a tenant scope must still work — and it
  // must still work with the guard live, because a trigger on UPDATE/DELETE has
  // no business firing on an INSERT.
  const read = await attemptAsTenant(`SELECT count(*)::int AS n FROM "AuditLog"`, ORG_ID);
  expect(read.raised, `sv_tenant's SELECT failed: ${describe(read.raised)}`).toBeNull();

  const append = await attemptAsTenant(
    `INSERT INTO "AuditLog" ("id", "callRef", "action", "chainHash", "redactedText", "orgId")
     VALUES ('ins-${RUN}', 'SV-F-IMMUT-${RUN}-ins', 'asr', 'immut-${RUN}-ins', 'appended', '${ORG_ID}')`,
    ORG_ID,
  );
  expect(append.raised, `sv_tenant's INSERT failed: ${describe(append.raised)}`).toBeNull();
  expect(append.affected).toBe(1);

  // The append transaction was rolled back by the helper, which is the point of
  // running it that way: no fixture escapes into the shared table.
  expect(await db.auditLog.count({ where: { callRef: `SV-F-IMMUT-${RUN}-ins` } })).toBe(0);
});

test("the tenant role holds no mutating privilege on AuditLog in the catalog", async () => {
  const rows = await db.$queryRaw<{ priv: string }[]>`
    SELECT privilege_type::text AS "priv"
    FROM information_schema.table_privileges
    WHERE table_schema = 'public' AND table_name = 'AuditLog' AND grantee = 'sv_tenant'`;
  const granted = rows.map((r) => r.priv).sort();
  // Exact set match in both directions: a future `GRANT ... ON ALL TABLES`
  // replay (the tenant_rls migration does exactly that) re-adds UPDATE here and
  // has to be caught by a red test, not by whoever notices the drift.
  expect(granted).toEqual(["INSERT", "SELECT"]);
});

// ── 4. This suite leaves no table state behind ───────────────────────────────

test("the guard's catalog state is exactly what this suite found", async () => {
  const now = await guardState(db);
  // 'D' on a database whose harness disables it, 'O' on one that does not, null
  // on one that never had the migration. Anything else means the suite flipped
  // persistent table state that other connections and other suites inherit.
  expect({ now, atStart: stateAtStart }).toEqual({ now: stateAtStart, atStart: stateAtStart });
});
