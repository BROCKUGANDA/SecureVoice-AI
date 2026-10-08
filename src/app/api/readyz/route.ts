import { NextResponse } from "next/server";

import "server-only";
import { leakSafeText } from "@/lib/failures/envelope";
import { db } from "@/lib/db";
import { classifyDatabaseUrl } from "@/lib/db-target";
import { auth } from "@/lib/better-auth";
import { env } from "@/lib/config";
import { abuseConfig } from "@/lib/abuse/config";
import { isE164 } from "@/lib/twilio";
import { maskE164 } from "@/lib/abuse/geo";

export const dynamic = "force-dynamic";

/**
 * Two health endpoints with two different jobs, and confusing them is how
 * monitoring lies to you.
 *
 *   /api/health — LIVENESS. "Is the process running?" Deliberately touches no
 *                 dependency, because a liveness probe that fails when the
 *                 database is down causes an orchestrator to restart a process
 *                 that was working fine. It answers in milliseconds.
 *
 *   /api/readyz — READINESS. "Should this instance receive traffic?" Asserts
 *                 the dependencies the instance cannot serve without. This is
 *                 what an orchestrator gates on, and what Caddy's healthcheck
 *                 should probe.
 *
 * A dependency that is degraded but not fatal reports `degraded` with HTTP 200
 * and a non-empty `checks`, so a monitoring system can alert on the detail
 * without the container being killed for it.
 */
type Check = {
  name: string;
  ok: boolean;
  fatal: boolean;
  detail?: string | number;
  ms?: number;
};

const OUTBOX_BACKLOG_WARN_SECONDS = env.readyzOutboxWarnSec; // 5 minutes
const AUDIT_STALE_WARN_SECONDS = env.readyzAuditStaleSec; // 1 hour

export async function GET() {
  const started = Date.now();
  const checks: Check[] = [];

  // Fatality is declared per check, never inferred from the outcome. A check
  // that throws is still classified by what it protects: inferring fatality
  // from the failure is how a monitoring endpoint pulls a healthy process out
  // of service during a partial outage — which is exactly what a missing
  // outbox table did before this was fixed.
  const timed = async (name: string, fatal: boolean, fn: () => Promise<Check>) => {
    const t0 = Date.now();
    let check: Check;
    try {
      check = await fn();
    } catch (err) {
      check = {
        name,
        ok: false,
        fatal,
        detail: err instanceof Error ? leakSafeText(err.message, 120) || "error" : "error",
      };
    }
    check.ms = Date.now() - t0;
    checks.push(check);
  };

  await timed("database", true, async () => {
    await db.$queryRaw`SELECT 1`;
    // `detail` is the coarse CLASS of database (vps-container, managed-supabase,
    // ...), never a host or credential. It answers "is production on the VPS
    // Postgres?" with one curl against the live instance, which a .env file you
    // cannot see from here cannot.
    return {
      name: "database",
      ok: true,
      fatal: true,
      detail: classifyDatabaseUrl(env.databaseUrl),
    };
  });

  // Auth wiring, as the running process sees it. The Better Auth dashboard says
  // "organization / dash plugin not enabled" when it cannot find them on the
  // instance it is pointed at; this reports what THIS instance actually loaded,
  // so the two can be compared without guessing. Non-fatal: it is a diagnostic.
  await timed("auth", false, async () => {
    const ids = (auth.options.plugins ?? []).map((p: { id?: string }) => p.id).filter(Boolean);
    const hasKey = Boolean(env.betterAuthApiKey);
    const ok = ids.includes("organization") && ids.includes("dash") && hasKey;
    return {
      name: "auth",
      ok,
      fatal: false,
      detail: `plugins=${ids.join(",")} dashApiKey=${hasKey ? "set" : "MISSING"}`,
    };
  });

  // Bank-notification backlog. Fatal=false: a wedged outbox degrades the
  // product (the bank is not notified promptly) but the platform can still take
  // and verify interventions, so we must not take the instance out of service.
  await timed("outbox", false, async () => {
    const oldest = await db.outboxEvent.findFirst({
      where: { state: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const ageSec = oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000) : 0;
    return {
      name: "outbox",
      ok: ageSec < OUTBOX_BACKLOG_WARN_SECONDS,
      fatal: false,
      detail: ageSec === 0 ? "empty" : `oldest pending ${ageSec}s`,
    };
  });

  // The evidence pipeline. If no audit row has been written in over an hour on
  // a platform that is supposed to be serving cases, the chain pipeline is
  // broken even though every request returns 200 — this is the alert that
  // catches it.
  await timed("audit_chain", false, async () => {
    const last = await db.auditLog.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const ageSec = last ? Math.round((Date.now() - last.createdAt.getTime()) / 1000) : -1;
    return {
      name: "audit_chain",
      // -1 means the chain is empty, which is healthy on a fresh install.
      ok: ageSec === -1 || ageSec < AUDIT_STALE_WARN_SECONDS,
      fatal: false,
      detail: ageSec === -1 ? "empty" : `last write ${ageSec}s ago`,
    };
  });

  // Vendor reachability is reported, never asserted: a voice-provider outage
  // must not mark us unready, because we would then refuse the very traffic
  // that is queueing while the provider recovers.
  await timed("voice_provider", false, async () => {
    const configured = !!(env.elevenLabsApiKey || env.twilioAccountSid);
    return {
      name: "voice_provider",
      ok: true,
      fatal: false,
      detail: configured ? "configured" : "unconfigured (audit-only mode)",
    };
  });

  // Dial-readiness preflight: reports the four live-send gates without taking
  // the instance out of service. A failed check here is degraded, not fatal:
  // the platform can still serve webhook traffic, auth, and the console even
  // when live sends are blocked by config.
  await timed("dial_readiness", false, async () => {
    const issues: string[] = [];

    const geo = abuseConfig().geo;
    const upperAllowlist = geo.allowlist.map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (upperAllowlist.length === 0) {
      issues.push("geo_allowlist_unconfigured");
    } else if (!upperAllowlist.includes("US")) {
      issues.push(`country US not in allowlist (${upperAllowlist.join(",")})`);
    }

    if (!env.twilioLiveSend) {
      issues.push("TWILIO_LIVE_SEND not attested");
    }

    const fromNumber = env.twilioFromNumber;
    if (!fromNumber || !isE164(fromNumber)) {
      issues.push("TWILIO_FROM_NUMBER missing or invalid");
    }

    const defaultTier = abuseConfig().tier.defaultTier;
    const testNumbers = abuseConfig().tier.testNumbers;
    if (defaultTier === "demo" && testNumbers.length === 0) {
      issues.push("demo tier with no test numbers");
    }

    const ok = issues.length === 0;
    const rawDetail = ok
      ? `geo=${upperAllowlist.join(",")}, live_send=true, from=${maskE164(fromNumber ?? "")}, tier=${defaultTier}`
      : issues.join("; ");
    const detail = rawDetail.length > 120 ? `${rawDetail.slice(0, 117)}...` : rawDetail;

    return {
      name: "dial_readiness",
      ok,
      fatal: false,
      detail,
    };
  });

  const fatal = checks.filter((c) => c.fatal && !c.ok);
  const degraded = checks.filter((c) => !c.fatal && !c.ok);
  const ready = fatal.length === 0;

  return NextResponse.json(
    {
      ok: ready,
      status: !ready ? "unready" : degraded.length > 0 ? "degraded" : "ok",
      checks,
      ts: new Date().toISOString(),
      durationMs: Date.now() - started,
    },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
