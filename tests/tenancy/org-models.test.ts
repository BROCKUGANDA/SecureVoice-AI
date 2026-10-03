/**
 * AUDIT FIX — three org-bearing models were in neither tenancy registry.
 *
 * `TENANTED_MODELS` is what makes `scopedDb(org).<model>` inject the org
 * predicate. `UsageLedger` and `PaymentRecord` carry `orgId` and were absent,
 * so the guard refused them as `unregistered_model`: not org-scoped, but simply
 * unreachable through a scope at all.
 *
 * `DialJob` is the interesting one, and the audit's premise was WRONG. It does
 * not carry an `orgId`:
 *
 *   · `prisma/schema.prisma` model DialJob  → fields caseRef, attemptNo, state,
 *     priority, attempts, ... — no orgId;
 *   · the generated client agrees (DialJobSelect has no orgId);
 *   · `information_schema agrees: dial_job has no `orgId` column;
 *   · `dial_job` (snake_case, migration 2_dial_job, the table
 *     src/lib/scale/queue.ts drives with raw SQL) DOES have `org_id` — but that
 *     is a different table and is never reached through Prisma.
 *
 * Registering it as a TENANT model would make the guard inject an `orgId`
 * predicate Prisma rejects at query time. It is declared in `PLATFORM_MODELS`
 * with that reason instead, alongside the existing `DeadLetter` precedent: the
 * org lives on the Case row joined by `caseRef`, and a worker legitimately
 * claims across ALL orgs (exactly like `lib.outbox.claim-batch`).
 *
 *   bun test tests/tenancy/org-models.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  PLATFORM_MODELS,
  TENANCY_BYPASS,
  isTenancyScopeError,
  isTenantedModel,
  scopedDb,
} from "@/lib/tenancy/guard";

const RUN = Date.now().toString(36);
const ORG = { A: `org-reg-a-${RUN}`, B: `org-reg-b-${RUN}` } as const;

const KEY = {
  ledgerIdemKey: { A: `${ORG.A}:0:topup:reg-${RUN}`, B: `${ORG.B}:0:topup:reg-${RUN}` },
  paymentReference: { A: `pay-reg-a-${RUN}`, B: `pay-reg-b-${RUN}` },
} as const;

beforeAll(async () => {
  for (const side of ["A", "B"] as const) {
    await db.usageLedger.create({
      data: {
        orgId: ORG[side],
        kind: "topup",
        units: 1000,
        reason: "registry probe",
        idemKey: KEY.ledgerIdemKey[side],
      },
    });
    await db.paymentRecord.create({
      data: {
        orgId: ORG[side],
        provider: "manualinvoice",
        reference: KEY.paymentReference[side],
        amountMinor: 100_000,
        currency: "AED",
        status: "success",
      },
    });
  }
}, 60_000);

afterAll(async () => {
  const orgs = { in: [ORG.A, ORG.B] };
  await db.usageLedger.deleteMany({ where: { orgId: orgs } });
  await db.paymentRecord.deleteMany({ where: { orgId: orgs } });
}, 60_000);

// ── UsageLedger ──────────────────────────────────────────────────────────────

test("UsageLedger: registered as a tenant model and scoped", async () => {
  expect(isTenantedModel("UsageLedger")).toBe(true);

  const asA = scopedDb({ orgId: ORG.A });
  // Control first: the fixture must be reachable at all, or "empty" is vacuous.
  expect(
    (await asA.usageLedger.findFirst({ where: { idemKey: KEY.ledgerIdemKey.A } }))?.orgId,
  ).toBe(ORG.A);

  // The cross-org read.
  expect(await asA.usageLedger.findFirst({ where: { idemKey: KEY.ledgerIdemKey.B } })).toBeNull();

  // And symmetric.
  const asB = scopedDb({ orgId: ORG.B });
  expect(
    (await asB.usageLedger.findFirst({ where: { idemKey: KEY.ledgerIdemKey.B } }))?.orgId,
  ).toBe(ORG.B);
  expect(await asB.usageLedger.findFirst({ where: { idemKey: KEY.ledgerIdemKey.A } })).toBeNull();
});

test("UsageLedger: a scoped listing contains only the caller's own rows", async () => {
  const rows = await scopedDb({ orgId: ORG.A }).usageLedger.findMany({ select: { orgId: true } });
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.orgId === ORG.A)).toBe(true);
});

test("UsageLedger: naming another org in `where` is refused, not silently emptied", async () => {
  let caught: unknown = null;
  try {
    await scopedDb({ orgId: ORG.A }).usageLedger.findFirst({ where: { orgId: ORG.B } });
  } catch (err) {
    caught = err;
  }
  expect(isTenancyScopeError(caught)).toBe(true);
  expect((caught as { reason: string }).reason).toBe("cross_org_request");
});

// ── PaymentRecord ────────────────────────────────────────────────────────────

test("PaymentRecord: registered as a tenant model and scoped", async () => {
  expect(isTenantedModel("PaymentRecord")).toBe(true);

  const asA = scopedDb({ orgId: ORG.A });
  // Control: `reference` is globally UNIQUE, so a null here could just mean the
  // row is missing. Prove the fixture resolves through the RAW client first.
  const unscoped = await db.paymentRecord.findFirst({
    where: { reference: KEY.paymentReference.B },
  });
  expect(unscoped?.orgId).toBe(ORG.B);

  // Through the scoped client the same identifier resolves nothing.
  expect(
    await asA.paymentRecord.findFirst({ where: { reference: KEY.paymentReference.B } }),
  ).toBeNull();
  expect(
    (await asA.paymentRecord.findFirst({ where: { reference: KEY.paymentReference.A } }))?.orgId,
  ).toBe(ORG.A);
});

test("PaymentRecord: the scoped listing is bounded to the caller's org", async () => {
  const rows = await scopedDb({ orgId: ORG.B }).paymentRecord.findMany({ select: { orgId: true } });
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.orgId === ORG.B)).toBe(true);
});

// ── DialJob: a documented bypass, not a registration ─────────────────────────

test("DialJob: the Prisma model carries no orgId, so it is platform-declared", async () => {
  // The premise this rests on, asserted rather than assumed: if a future
  // migration adds `orgId` to the "DialJob" table, this declaration becomes
  // WRONG and the model must move to TENANTED_MODELS.
  const cols = await db.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'DialJob' AND column_name = 'orgId'`,
  );
  expect(cols).toHaveLength(0);

  expect(isTenantedModel("DialJob")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(PLATFORM_MODELS, "DialJob")).toBe(true);
  expect(PLATFORM_MODELS.DialJob?.reason).toContain("NO orgId");
});

test("DialJob: the bypass is available and audited; tenant models still are not", async () => {
  TENANCY_BYPASS.reset();
  const raw = TENANCY_BYPASS.client("DialJob", "dial worker claims across orgs by design");
  expect(raw).toBeDefined();
  const logged = TENANCY_BYPASS.log();
  expect(logged.some((b) => b.model === "DialJob")).toBe(true);

  // The hatch still cannot reach a tenant model — registration did not weaken it.
  for (const model of ["UsageLedger", "PaymentRecord"]) {
    let caught: unknown = null;
    try {
      TENANCY_BYPASS.client(model as never, "a very good reason that is still refused");
    } catch (err) {
      caught = err;
    }
    expect(isTenancyScopeError(caught), `${model} must not be bypassable`).toBe(true);
    expect((caught as { reason: string }).reason).toBe("bypass_refused");
  }
  TENANCY_BYPASS.reset();
});

test("DialJob: a worker read is genuinely cross-org, which is why it is not scoped", async () => {
  // Two jobs, one per org, then read them the way a worker does — by state,
  // with no org predicate. This is the read a per-org scope would break.
  //
  // Raw SQL on purpose: the Prisma `DialJob` model is not declared in
  // prisma/schema.prisma, so `db.dialJob` does not exist at runtime. That is a
  // further reason the model cannot be a TENANT model — the guard's `$extends`
  // only ever sees models the generated client actually has.
  const refs = [`SV-Q-REG-A-${RUN}`, `SV-Q-REG-B-${RUN}`];
  for (const [i, caseRef] of refs.entries()) {
    // dial_job's canonical vocabulary: snake_case columns, states
    // PENDING | CLAIMED | DONE | DEAD (src/lib/scale/queue.ts).
    await db.$executeRawUnsafe(
      `INSERT INTO dial_job ("id","case_id","case_ref","attempt_no","state","priority","retries","payload","available_at","created_at","updated_at")
       VALUES ($1,$1,$2,1,'DEAD',0,1,'{}',NOW(),NOW(),NOW())`,
      `reg-probe-${RUN}-${i}`,
      caseRef,
    );
  }

  const rows = await db.$queryRawUnsafe<{ caseRef: string }[]>(
    `SELECT case_ref FROM dial_job WHERE "state" = 'DEAD' AND case_ref = ANY($1)`,
    refs,
  );
  expect(rows).toHaveLength(2);

  await db.$executeRawUnsafe(`DELETE FROM dial_job WHERE "id" LIKE $1`, `reg-probe-${RUN}-%`);
});
