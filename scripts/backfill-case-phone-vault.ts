/**
 * Backfill the PII vault for the case rows that still hold a plaintext number.
 *
 * Why this is a script and not a migration: sealing a value needs `AUTH_SECRET`,
 * which lives in the application's environment and deliberately not in the
 * database. SQL inside a migration cannot encrypt under a key it must not hold, so
 * a migration can only add the columns — moving the data is an application job.
 *
 * What it does, per row that still carries `Case.phone`:
 *   1. seal the number in `pii_vault` under the row's own org (idempotent: the
 *      vault's per-tenant blind index returns the token that already exists),
 *   2. write `customerPhoneToken` + `phoneIndex`,
 *   3. clear `phone`.
 *
 * Order matters and is not cosmetic: the pointers are written in the same update
 * that clears the value, so there is no instant at which a case has lost its
 * destination and not yet gained a token. A row that fails any step keeps its
 * number and is reported.
 *
 * ## This is the operation that needs a human watching
 * It rewrites customer data in place, irreversibly per row (the plaintext is
 * dropped). Default mode is DRY RUN: it counts and samples, and writes nothing.
 * `--apply` is required, and `--org` narrows the run to one tenant so a rollout can
 * start with the smallest one and read the result before widening.
 *
 * Usage (the preload neutralises the `server-only` marker, as for every Bun-run
 * worker and job in this repo — `bun run pii:backfill` wraps exactly this):
 *   bun --preload ./scripts/worker-preload.ts scripts/backfill-case-phone-vault.ts
 *   ... --org <orgId>        # one tenant, for a staged rollout
 *   ... --apply              # do it
 */
import { db } from "@/lib/db";
import { blindIndexOf, normalizePiiValue, storePii } from "@/lib/compliance/pii-vault";
import { logError, logInfo } from "@/lib/validation/safe-log";

const APPLY = process.argv.includes("--apply");
const orgIndex = process.argv.indexOf("--org");
const ONLY_ORG = orgIndex >= 0 ? process.argv[orgIndex + 1] : undefined;
const BATCH = Number(process.env.BACKFILL_BATCH ?? 200);

type Report = {
  mode: "dry-run" | "apply";
  scanned: number;
  tokenized: number;
  alreadyVaulted: number;
  /** Rows with a number and no tenant: `storePii` refuses an unscoped vault row. */
  skippedNoOrg: number;
  /** Rows whose number could not be sealed (missing key, or a write that failed). */
  failed: number;
  /** Distinct orgs touched — the widening unit for a staged rollout. */
  orgs: string[];
  samples: { caseRef: string; orgId: string | null; redacted: string }[];
};

/** The number as it may be shown in a report: leading country code, last two digits. */
function sampleForm(phone: string): string {
  const normalized = normalizePiiValue("phone", phone);
  return normalized.replace(/\d(?=\d{2})/g, "*");
}

async function main(): Promise<number> {
  if (!process.env.AUTH_SECRET) {
    logError(
      "[pii-backfill] AUTH_SECRET is required — sealing cannot proceed under a guessable key",
    );
    return 2;
  }

  const report: Report = {
    mode: APPLY ? "apply" : "dry-run",
    scanned: 0,
    tokenized: 0,
    alreadyVaulted: 0,
    skippedNoOrg: 0,
    failed: 0,
    orgs: [],
    samples: [],
  };

  // `phone IS NOT NULL` is the whole queue: a vaulted row has cleared the column,
  // so re-running this script costs one indexed scan and does nothing.
  let cursor: string | null = null;
  for (;;) {
    const rows = await db.case.findMany({
      where: {
        phone: { not: null },
        ...(ONLY_ORG ? { orgId: ONLY_ORG } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, caseRef: true, orgId: true, phone: true, customerPhoneToken: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      report.scanned++;
      const phone = row.phone;
      if (!phone) continue;
      if (!row.orgId) {
        // Unscoped values cannot be vaulted: the vault's tenant column is what
        // makes a token unresolvable for anyone who did not store it.
        report.skippedNoOrg++;
        continue;
      }
      if (report.samples.length < 10) {
        report.samples.push({
          caseRef: row.caseRef,
          orgId: row.orgId,
          redacted: sampleForm(phone),
        });
      }
      if (!report.orgs.includes(row.orgId)) report.orgs.push(row.orgId);

      let token: string | null = row.customerPhoneToken;
      let index: string;
      try {
        index = blindIndexOf("phone", phone);
        if (!token) token = await storePii({ orgId: row.orgId, type: "phone", plaintext: phone });
      } catch (err) {
        report.failed++;
        logError("[pii-backfill] could not seal — row left exactly as it was", {
          caseRef: row.caseRef,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (row.customerPhoneToken) {
        // Already pointed at a token but still holding the number: the column is
        // the residue, not the queue. Counted separately so a run that only cleans
        // residue is visible as such.
        report.alreadyVaulted++;
      }
      if (!APPLY) {
        report.tokenized += row.customerPhoneToken ? 0 : 1;
        continue;
      }

      // One conditional update: pointers in, plaintext out. The `phone IS NOT NULL`
      // predicate means a concurrent erase that already cleared the column loses
      // nothing, and a re-run touches no row twice.
      const wrote = await db.case.updateMany({
        where: { id: row.id, phone: { not: null } },
        data: { customerPhoneToken: token, phoneIndex: index, phone: null },
      });
      if (wrote.count === 1) report.tokenized++;
      else report.failed++;
    }
    logInfo("[pii-backfill] progress", { scanned: report.scanned, mode: report.mode });
  }

  // One machine-readable line, prefixed so a caller (including the gate that
  // asserts this script writes nothing without `--apply`) can find the report
  // without parsing the progress log around it.
  console.log(`PII_BACKFILL_REPORT ${JSON.stringify(report)}`);
  for (const sample of report.samples) {
    console.log(`  ${sample.caseRef}  org=${sample.orgId}  ${sample.redacted}`);
  }
  if (!APPLY) {
    console.log(
      `\nDRY RUN — nothing was written. ${report.scanned} row(s) still hold a plaintext number` +
        ` (${report.skippedNoOrg} of them have no tenant and cannot be vaulted).` +
        `\nRe-run with --apply to move them. This is the irreversible step; read the counts first.`,
    );
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logError("[pii-backfill] aborted", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
