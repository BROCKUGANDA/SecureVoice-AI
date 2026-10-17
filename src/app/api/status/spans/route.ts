import { NextResponse } from "next/server";

import "server-only";
import { requireOperator } from "@/lib/credits";
import { latencyBlock, paginateRecords } from "@/lib/telemetry/report";
import { buildOtlpExport } from "@/lib/telemetry/export";
import { recentSpans } from "@/lib/telemetry/spans";
import { readSpanRecords } from "@/lib/telemetry/store";
import { etaggedJson } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/status/spans — the latency block (WP-7).
 *
 * Same guard as `/api/status`: latency is fingerprinting data and this endpoint
 * reads a local log, so it is operator-only. 200s are conditional (strong ETag,
 * `Cache-Control: private, no-cache`) — a panel re-poll of an unchanged block
 * is a body-less 304, but nothing here is cacheable without revalidation.
 *
 * Query
 *   ?interventions=50   keep the newest N distinct interventions (default 50)
 *   ?windowMinutes=1440 only samples started in the last N minutes (default: all time)
 *   ?format=otlp        return the OTLP/JSON trace payload instead of the panel shape
 *   ?format=records     paginated raw records (the drill-down): ?span=,
 *                       ?sort=newest|slowest, ?page=1, ?pageSize=50 (max 500).
 *                       Projected to display fields only — collectors use otlp.
 *   ?page=&pageSize=    with format=otlp, page the records BEFORE export. The
 *                       default (no page params) returns the raw OTLP payload
 *                       unwrapped, so existing collectors keep working.
 *
 * Honesty rules on this surface:
 *   - `ok: false` when nothing is measured, so the panel can say so rather than
 *     render an empty-but-healthy dashboard;
 *   - a span with no samples comes back with `p95Ms: null`, never 0;
 *   - `persistence.note` states that the store is per-instance local disk, so an
 *     operator knows these are this instance's numbers and not a fleet average;
 *   - the response never fabricates. There is no seeded default anywhere below.
 */
export async function GET(req: Request) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const url = new URL(req.url);
  const interventions = clampInt(url.searchParams.get("interventions"), 1, 10_000, 50);
  const windowMinutes = clampInt(url.searchParams.get("windowMinutes"), 1, 60 * 24 * 365, null);
  const format = url.searchParams.get("format");

  const noStore = { "Cache-Control": "no-store" };

  // Page params are shared by both record-serving formats. Parsed once so the
  // two branches cannot disagree on what "page 2" means.
  const rawPage = url.searchParams.get("page");
  const rawPageSize = url.searchParams.get("pageSize");
  const paged = rawPage !== null || rawPageSize !== null;

  try {
    if (format === "otlp") {
      // OTLP/JSON, served straight to whoever wants to open a collector. No
      // collector required for this to work: this is the pull half. The push half
      // is `otel.ts`, which exports the SDK's own spans, not this ring buffer.
      const read = await readSpanRecords(interventions === null ? {} : { interventions });
      if (!paged) return etaggedJson(req, buildOtlpExport(read.records));
      // Paged export: slice BEFORE building, and wrap so the collector can
      // tell a partial payload from a complete one.
      const page = paginateRecords(read.records, {
        page: rawPage === null ? 1 : Number(rawPage),
        pageSize: rawPageSize === null ? 50 : Number(rawPageSize),
      });
      const full = read.records;
      const start = (page.page - 1) * page.pageSize;
      const slice = full.slice(start, start + page.pageSize);
      return etaggedJson(req, {
        data: buildOtlpExport(slice),
        page: page.page,
        pageSize: page.pageSize,
        total: page.total,
        hasMore: page.hasMore,
      });
    }

    if (format === "records") {
      // The drill-down: one span's raw records, newest (or slowest) first,
      // projected to display fields. Window applies here too, so a "last hour,
      // slowest first" view is one request.
      const windowMs = windowMinutes === null ? undefined : Date.now() - windowMinutes * 60_000;
      const read = await readSpanRecords(interventions === null ? {} : { interventions });
      const inWindow =
        windowMs === undefined
          ? read.records
          : read.records.filter((r) => r.startedAtMs >= windowMs);
      const sortRaw = url.searchParams.get("sort");
      const page = paginateRecords(inWindow, {
        span: url.searchParams.get("span"),
        sort: sortRaw === "slowest" ? "slowest" : "newest",
        page: rawPage === null ? 1 : Number(rawPage),
        pageSize: rawPageSize === null ? 50 : Number(rawPageSize),
      });
      return etaggedJson(req, page);
    }

    const block = await latencyBlock({ windowMinutes, interventions });
    // `?scope=memory` reads the in-process ring instead of the log — useful for
    // a dev box where the log lives on another volume. Published explicitly
    // rather than inferred, so the operator knows which one they are looking at.
    if (url.searchParams.get("scope") === "memory") {
      return etaggedJson(req, {
        ...block,
        source: "in-process span ring (this Node process only; nothing durable)",
        records: recentSpans(2000).length,
      });
    }
    return etaggedJson(req, block);
  } catch (err) {
    // A telemetry read must not present as a 500 with a stack trace to an
    // operator mid-incident. Say the read failed and why, in one line.
    const message = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    return NextResponse.json(
      { ok: false, error: `latency_block_unavailable: ${message}` },
      { status: 500, headers: noStore },
    );
  }
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number | null,
): number | null {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}
