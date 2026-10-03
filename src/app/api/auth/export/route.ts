import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePrivileged } from "@/lib/auth/guards";
import { scopedDb, orgScopeFor } from "@/lib/tenancy/guard";
import { toCsv, csvContentDisposition } from "@/lib/csv-export";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/export — bulk export of case records.
 *
 * One of the five privileged actions in WP-11 item 4 (`export_bulk_data`).
 * Requires `export:bulk` AND a fresh step-up.
 *
 * Two controls on the same route, deliberately:
 *
 *   · ROLE — `requirePrivileged` checks `export:bulk`, so an `Analyst` cannot
 *     reach this at all, and an `Auditor` (read-only) can never reach it.
 *   · STEP-UP — a role check alone would let anyone holding a stolen Analyst
 *     cookie dump the org's records. The step-up asks for a credential the
 *     cookie does not contain.
 *
 * Reads go through `scopedDb` (src/lib/tenancy/guard.ts) so the org predicate is
 * injected rather than typed here — this route cannot accidentally become an
 * unauthenticated cross-tenant read, because it never writes a `where` clause
 * of its own.
 *
 * The CSV goes through `toCsv`, which formula-neutralises cells: an exported
 * merchant name beginning `=` is a CSV-injection vector when the file is opened
 * in Excel, and this is the route that hands organisation records to a
 * spreadsheet.
 */
export async function GET(req: NextRequest) {
  const authed = await requirePrivileged(req.headers.get("cookie"), "export_bulk_data");
  if (!authed.ok) {
    return NextResponse.json(
      { error: authed.error, code: authed.code },
      // 403 when the role is wrong, 428 when only the step-up is missing, so the
      // console can distinguish "not allowed" from "confirm it's you".
      { status: authed.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const take = Math.min(Math.max(Number(url.searchParams.get("take") ?? "500") || 500, 1), 5_000);

  const rows = await scopedDb(orgScopeFor(authed.orgId)).case.findMany({
    select: {
      caseRef: true,
      state: true,
      riskScore: true,
      currency: true,
      amountMinor: true,
      merchant: true,
      language: true,
      createdAt: true,
      postCallAt: true,
    },
    orderBy: { createdAt: "desc" },
    take,
  });

  type ExportRow = (typeof rows)[number];

  const csv = toCsv<ExportRow>(
    rows,
    [
      { header: "caseRef", value: (r) => r.caseRef },
      { header: "state", value: (r) => r.state },
      { header: "riskScore", value: (r) => r.riskScore },
      { header: "amountMinor", value: (r) => r.amountMinor },
      { header: "currency", value: (r) => r.currency },
      { header: "merchant", value: (r) => r.merchant },
      { header: "language", value: (r) => r.language },
      { header: "createdAt", value: (r) => r.createdAt.toISOString() },
      { header: "postCallAt", value: (r) => r.postCallAt?.toISOString() ?? "" },
    ],
    {},
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": csvContentDisposition(`securevoice-cases-${authed.orgId}.csv`),
      // An export is the most exportable thing in the product: it must not be
      // cached by a proxy or a CDN.
      "Cache-Control": "no-store",
    },
  });
}
