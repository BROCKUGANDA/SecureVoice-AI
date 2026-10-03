import { NextResponse } from "next/server";

import "server-only";
import { requireOperator } from "@/lib/credits";
import { latencyBlock } from "@/lib/telemetry/report";
import { buildOtlpExport } from "@/lib/telemetry/export";
import { recentSpans } from "@/lib/telemetry/spans";
import { readSpanRecords } from "@/lib/telemetry/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/status/spans — the latency block (WP-7).
 *
 * Same guard as `/api/status`: latency is fingerprinting data and this endpoint
 * reads a local log, so it is operator-only and never cached.
 *
 * Query
 *   ?interventions=50   keep the newest N distinct interventions (default 50)
 *   ?windowMinutes=1440 only samples started in the last N minutes (default: all time)
 *   ?format=otlp        return the OTLP/JSON trace payload instead of the panel shape
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

  try {
    if (format === "otlp") {
      // OTLP/JSON, served straight to whoever wants to open a collector. No
      // collector required for this to work — it is the same payload the
      // optional exporter would POST.
      const read = await readSpanRecords(interventions === null ? {} : { interventions });
      const payload = buildOtlpExport(read.records);
      return NextResponse.json(payload, { headers: noStore });
    }

    const block = await latencyBlock({ windowMinutes, interventions });
    // `?scope=memory` reads the in-process ring instead of the log — useful for
    // a dev box where the log lives on another volume. Published explicitly
    // rather than inferred, so the operator knows which one they are looking at.
    if (url.searchParams.get("scope") === "memory") {
      return NextResponse.json(
        {
          ...block,
          source: "in-process span ring (this Node process only; nothing durable)",
          records: recentSpans(2000).length,
        },
        { headers: noStore },
      );
    }
    return NextResponse.json(block, { headers: noStore });
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
