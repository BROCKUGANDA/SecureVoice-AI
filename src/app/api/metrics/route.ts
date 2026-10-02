import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

import "server-only";
import { db } from "@/lib/db";
import { admissionSnapshot } from "@/lib/admission";
import { capacitySnapshot } from "@/lib/capacity";

export const dynamic = "force-dynamic";

/**
 * Optional lock-down. The body below carries no secrets and no customer data,
 * so it is safe to scrape unauthenticated — but a deployment that wants it
 * closed sets METRICS_TOKEN and the scraper sends it as a bearer value.
 * Unset means open, which is the right default for a scraper that lives on
 * the same private network.
 */
function metricsAuthorised(req: Request): boolean {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return true;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(createHash("sha256").update(expected).digest("hex"), "hex");
  const b = Buffer.from(createHash("sha256").update(presented).digest("hex"), "hex");
  return timingSafeEqual(a, b);
}

/**
 * Prometheus metrics — the surface a scraper (or a human with curl) watches.
 *
 * Design rules, all of which cost something to honour:
 *   1. **No secrets, no customer data, no org names.** Metric labels are drawn
 *      from a fixed vocabulary, never from a request. A metrics endpoint is
 *      read by monitoring infrastructure far more widely than the app itself,
 *      so it must be safe to expose to anything.
 *   2. **No unbounded label cardinality.** `callRef`, `orgId` and `customerRef`
 *      are never labels. Cardinality is bounded by the vocabulary below, so a
 *      scrape stays small and cheap no matter how much traffic flows.
 *   3. **Every collector is individually guarded.** A metric that throws must
 *      not take the scrape down with it — a monitoring endpoint that fails
 *      during an incident is worse than no monitoring.
 *   4. **Cheap enough to scrape every 15 seconds.** One connection, a handful
 *      of COUNTs and one latency probe. No table scans over the audit chain.
 */
export async function GET(req: Request) {
  if (!metricsAuthorised(req)) {
    return new NextResponse("unauthorized\n", { status: 401 });
  }
  const started = Date.now();
  const out: string[] = [];
  const push = (name: string, help: string, type: "gauge" | "counter", value: number, labels = "" as string) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name}${labels} ${value}`);
  };

  // ── process ──────────────────────────────────────────────────────────────
  const mem = process.memoryUsage();
  push("sv_process_resident_memory_bytes", "Resident set size of the Node process.", "gauge", mem.rss);
  push("sv_process_heap_used_bytes", "V8 heap in use.", "gauge", mem.heapUsed);
  push("sv_process_uptime_seconds", "Process uptime.", "gauge", Math.round(process.uptime()));

  // ── database ─────────────────────────────────────────────────────────────
  // Latency is the number that matters: the tool round-trip sits inside the
  // voice path, so database distance is audible as hesitation on the call.
  const dbStart = Date.now();
  let dbOk = 1;
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbOk = 0;
  }
  push("sv_db_up", "1 when the primary database answered the probe.", "gauge", dbOk);
  push("sv_db_probe_latency_ms", "Round-trip latency of the database probe.", "gauge", Date.now() - dbStart);

  // ── cases and admission ─────────────────────────────────────────────────
  try {
    const byState = await db.case.groupBy({
      by: ["state"],
      _count: { _all: true },
    });
    for (const row of byState) {
      push(
        "sv_cases_total",
        "Cases by lifecycle state (bounded vocabulary from the state machine).",
        "gauge",
        row._count._all,
        `{state="${row.state.toLowerCase()}"}`,
      );
    }
  } catch {
    push("sv_cases_total", "Cases by lifecycle state.", "gauge", 0, `{state="unknown"}`);
  }

  try {
    const capacity = await admissionSnapshot();
    push("sv_conversations_active", "Conversations currently consuming a voice slot.", "gauge", capacity.activeConversations);
    push(
      "sv_admission_band",
      "Current admission band: 0 normal, 1 constrained, 2 shed.",
      "gauge",
      capacity.band === "NORMAL" ? 0 : capacity.band === "CONSTRAINED" ? 1 : 2,
    );
    push("sv_vendor_ceiling_concurrent", "Enforced vendor concurrency ceiling (ElevenLabs).", "gauge", capacity.ceilings.elevenLabsBurstCeiling);
    push(
      "sv_vendor_ceiling_utilisation",
      "Active conversations as a fraction of the burst ceiling.",
      "gauge",
      capacity.ceilings.elevenLabsBurstCeiling > 0
        ? Number((capacity.activeConversations / capacity.ceilings.elevenLabsBurstCeiling).toFixed(4))
        : 0,
    );
  } catch {
    push("sv_conversations_active", "Conversations currently consuming a voice slot.", "gauge", -1);
  }

  // ── outbox: the bank-notification backlog ───────────────────────────────
  // A growing PENDING backlog means verdicts are not reaching the bank's CRM,
  // which is invisible from the outside and is the definition of a silent
  // failure. This is the metric that catches it.
  try {
    const pending = await db.outboxEvent.count({ where: { state: "PENDING" } });
    push("sv_outbox_pending", "Bank notifications waiting for delivery.", "gauge", pending);
    const oldest = await db.outboxEvent.findFirst({
      where: { state: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    push(
      "sv_outbox_oldest_pending_age_seconds",
      "Age of the oldest undelivered notification; the SLO is minutes, not hours.",
      "gauge",
      oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000) : 0,
    );
    const dead = await db.deadLetter.count({ where: { replayedAt: null } });
    push("sv_outbox_dead_letter", "Notifications that exhausted retries and need replay.", "gauge", dead);
  } catch {
    push("sv_outbox_pending", "Bank notifications waiting for delivery.", "gauge", -1);
  }

  // ── audit chain freshness ───────────────────────────────────────────────
  // If the chain has not been written for a long time while the platform is
  // supposedly serving, the evidence pipeline is broken even though the site
  // looks fine.
  try {
    const last = await db.auditLog.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    push(
      "sv_audit_last_write_age_seconds",
      "Seconds since the last audit-chain append.",
      "gauge",
      last ? Math.round((Date.now() - last.createdAt.getTime()) / 1000) : -1,
    );
    const today = new Date(Date.now() - 24 * 3600 * 1000);
    const rows24h = await db.auditLog.count({ where: { createdAt: { gte: today } } });
    push("sv_audit_rows_24h", "Audit rows written in the last 24 hours.", "gauge", rows24h);
  } catch {
    push("sv_audit_last_write_age_seconds", "Seconds since the last audit-chain append.", "gauge", -1);
  }

  // ── scrape self-timing ──────────────────────────────────────────────────
  push("sv_scrape_duration_ms", "Time taken to produce this scrape.", "gauge", Date.now() - started);

  return new NextResponse(`${out.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** Liveness probe for a monitoring system that only needs a status code. */
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

/** Re-exported so the health check can report the same ceilings. */
export { capacitySnapshot };