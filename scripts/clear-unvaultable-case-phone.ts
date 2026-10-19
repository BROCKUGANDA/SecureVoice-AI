/**
 * Clear the phone numbers that the vault cannot seal, and leave the rows.
 *
 * Measured on production 2026-10-19: 847 `Case` rows still held a plaintext
 * number. `backfill-case-phone-vault.ts` can seal a row only when the row's
 * `orgId` names a tenant — the vault's per-tenant blind index is what makes a
 * token resolvable — and 825 of those rows have no tenant to seal under: the
 * `orgId` is null, or it belongs to a load/isolation fixture, or the
 * organization row is gone. They are harness data that was written into the
 * production database, and the backfill reports them forever.
 *
 * Why not DELETE them, which is the obvious move: 5,764 `AuditLog` rows name
 * these cases, and the chain is append-only and hash-linked — deleting or
 * editing any of them breaks verification for every row after it, which the
 * retention guard refuses outright. Another 1,229 rows in `Notification`,
 * `OutboxEvent`, `DeadLetter` and `UsageLedger` (billing) reference them by
 * `caseRef`, and no foreign key would stop a delete from stranding all of it.
 * The privacy goal is "no readable number", not "no row", so the number goes
 * and the evidence keeps resolving.
 *
 * A cleared row is unmatchable by design: `phone` is null and no `phoneIndex`
 * is written, so neither arm of `casePhoneWhere` can reach it. That is correct
 * for a value that was never a customer's. Rows whose tenant DOES exist are
 * refused here and reported as the vault queue instead — those get sealed, not
 * dropped.
 *
 * ## This is the operation that needs a human watching
 * Default mode is DRY RUN: it counts and samples, and writes nothing.
 *   bun --preload ./scripts/worker-preload.ts scripts/clear-unvaultable-case-phone.ts
 *   ... --apply                  # do it
 *   ... --org <orgId>            # restrict to one orgId (`null` is not selectable)
 *   ... --ref-prefix <caseRef>   # restrict to one writer's rows — what makes this
 *                                # script safe to run against a shared database
 */
import { db } from "@/lib/db";
import { normalizePiiValue } from "@/lib/compliance/pii-vault";
import { logError, logInfo } from "@/lib/validation/safe-log";

const APPLY = process.argv.includes("--apply");
const orgIndex = process.argv.indexOf("--org");
const ONLY_ORG = orgIndex >= 0 ? process.argv[orgIndex + 1] : undefined;
const prefixIndex = process.argv.indexOf("--ref-prefix");
const ONLY_PREFIX = prefixIndex >= 0 ? process.argv[prefixIndex + 1] : undefined;
const BATCH = Number(process.env.BACKFILL_BATCH ?? 200);

const scope = () => ({
  ...(ONLY_ORG ? { orgId: ONLY_ORG } : {}),
  ...(ONLY_PREFIX ? { caseRef: { startsWith: ONLY_PREFIX } } : {}),
});

type Report = {
  mode: "dry-run" | "apply";
  scanned: number;
  /** Rows with no `orgId` at all. */
  clearedNoOrg: number;
  /** Rows whose `orgId` matches no organization — the tenant is gone, or never was. */
  clearedNoOrgRow: number;
  /** Rows deliberately left alone because their tenant exists: the vault's queue. */
  leftForVault: number;
  /** Rows found already cleared between the read and the write — same end state. */
  contended: number;
  /** Distinct numbers removed from readable storage by this run. */
  distinctNumbers: number;
  /** Rows still holding a plaintext number after this run, in this scope. */
  pending: number;
  samples: { caseRef: string; orgId: string | null; reason: string; redacted: string }[];
};

function sampleForm(phone: string): string {
  return normalizePiiValue("phone", phone).replace(/\d(?=\d{2})/g, "*");
}

async function main(): Promise<number> {
  const report: Report = {
    mode: APPLY ? "apply" : "dry-run",
    scanned: 0,
    clearedNoOrg: 0,
    clearedNoOrgRow: 0,
    leftForVault: 0,
    contended: 0,
    distinctNumbers: 0,
    pending: 0,
    samples: [],
  };
  const seenNumbers = new Set<string>();

  // Which of the raw rows' orgIds name a real tenant? Resolved once, up front,
  // because the answer decides every row below — a row is cleared here only when
  // no organization can own it.
  //
  // `organization.id` is a uuid column while `Case.orgId` is text, so only
  // uuid-shaped candidates can possibly name a tenant row. Passing a harness id
  // (`credits_…`, `org-load-…`) into the `in` list makes Postgres reject the whole
  // query — measured on production 2026-10-19 — and such an id could not be a
  // tenant anyway.
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawOrgIds = await db.case.findMany({
    where: { phone: { not: null }, ...scope() },
    select: { orgId: true },
    distinct: ["orgId"],
  });
  const candidateIds = rawOrgIds
    .map((r) => r.orgId)
    .filter((id): id is string => Boolean(id) && UUID_SHAPE.test(id));
  const living = new Set<string>();
  for (let i = 0; i < candidateIds.length; i += 200) {
    const found = await db.organization.findMany({
      where: { id: { in: candidateIds.slice(i, i + 200) } },
      select: { id: true },
    });
    for (const org of found) living.add(org.id);
  }

  let cursor: string | null = null;
  for (;;) {
    const rows = await db.case.findMany({
      where: {
        phone: { not: null },
        ...scope(),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, caseRef: true, orgId: true, phone: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    const clearIds: string[] = [];
    for (const row of rows) {
      report.scanned++;
      const phone = row.phone;
      if (!phone) continue;
      const reason = !row.orgId
        ? "no-org"
        : living.has(row.orgId)
          ? "tenant-lives"
          : "org-row-gone";
      if (reason === "tenant-lives") {
        // Not this script's business: a real tenant's number gets sealed, not dropped.
        report.leftForVault++;
        continue;
      }
      seenNumbers.add(normalizePiiValue("phone", phone));
      if (report.samples.length < 10) {
        report.samples.push({
          caseRef: row.caseRef,
          orgId: row.orgId,
          reason,
          redacted: sampleForm(phone),
        });
      }
      if (!APPLY) {
        if (reason === "no-org") report.clearedNoOrg++;
        else report.clearedNoOrgRow++;
        continue;
      }
      clearIds.push(row.id);
    }

    if (APPLY && clearIds.length > 0) {
      // One conditional update per batch: the `phone IS NOT NULL` predicate makes a
      // re-run a no-op and a concurrent clear lose nothing.
      const wrote = await db.case.updateMany({
        where: { id: { in: clearIds }, phone: { not: null } },
        data: { phone: null },
      });
      // A shortfall means somebody else cleared a row between the read and the
      // write. The end state is the one this script reports — no number held — so
      // it is counted as cleared and recorded as contention, not as a failure.
      const decided = clearIds.length;
      if (wrote.count !== decided) {
        report.contended += decided - wrote.count;
        logInfo("[phone-clear] rows already cleared by another writer", {
          decided,
          written: wrote.count,
        });
      }
      for (const id of clearIds) {
        const row = rows.find((r) => r.id === id);
        if (!row?.orgId) report.clearedNoOrg++;
        else report.clearedNoOrgRow++;
      }
    }
    logInfo("[phone-clear] progress", { scanned: report.scanned, mode: report.mode });
  }

  report.distinctNumbers = seenNumbers.size;
  report.pending = await db.case.count({ where: { phone: { not: null }, ...scope() } });

  console.log(`PHONE_CLEAR_REPORT ${JSON.stringify(report)}`);
  for (const sample of report.samples) {
    console.log(
      `  ${sample.caseRef}  org=${sample.orgId ?? "NULL"}  ${sample.reason}  ${sample.redacted}`,
    );
  }
  if (!APPLY) {
    console.log(
      `\nDRY RUN — nothing was written. ${report.clearedNoOrg + report.clearedNoOrgRow} row(s)` +
        ` hold a number nothing can seal (${report.clearedNoOrg} with no tenant,` +
        ` ${report.clearedNoOrgRow} whose organization row is gone).` +
        `\n${report.leftForVault} row(s) belong to a living tenant and are left for the vault.` +
        `\nRe-run with --apply. Cleared rows keep their identity and lose their number.`,
    );
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logError("[phone-clear] aborted", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
