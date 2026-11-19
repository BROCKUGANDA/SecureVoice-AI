import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator, requireSignedIn } from "@/lib/credits";
import { db } from "@/lib/db";
import { scopedDb } from "@/lib/tenancy/guard";
import {
  moderationHealth,
  moderationKillSwitchDbState,
  setModerationKillSwitch,
  MODERATION_KILL_SWITCH_NAME,
} from "@/lib/qwen3guard/moderate";
import { append as auditAppend } from "@/lib/audit-chain";

export const dynamic = "force-dynamic";

/**
 * Operator surface for the moderation subsystem — read the health and the
 * tenant's active policy; write a NEW policy version (never an UPDATE: the
 * exact rules applied to a historical decision must stay reproducible) or
 * toggle the platform kill switch.
 *
 * TENANCY: the org operand is derived from the session, never a body field —
 * the same rule as the pilot route. A tenant policy row is only ever read and
 * written against the signed-in operator's own organisation; cross-tenant
 * reads are impossible by construction because the predicate comes from
 * `guard.profile.orgId`.
 *
 * The kill switch is platform-wide (a PlatformSwitch row, no orgId by design
 * — same shape as `dial_kill_switch`), so engaging it is an OPERATOR act and
 * is audited with the actor's identity.
 */

const POLICY_PROFILES = [
  "general",
  "enterprise",
  "financial",
  "support",
  "security_ops",
  "internal",
] as const;

const policySchema = z
  .object({
    profile: z.enum(POLICY_PROFILES).optional(),
    escalateOn: z.enum(["unsafe", "controversial"]).optional(),
    gateTools: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    languages: z.array(z.string().min(2).max(7)).max(6).optional(),
    note: z.string().max(280).optional(),
  })
  .strict();

const bodySchema = z
  .object({
    policy: policySchema.optional(),
    killSwitch: z.boolean().optional(),
  })
  .strict();

export async function GET() {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const orgId = guard.profile?.orgId ?? null;

  // Tenant reads go through the scoped client: the org predicate is the
  // guard's, not this file's, and an unscoped moderation read is exactly the
  // cross-tenant leak the WP-12 matrix probes.
  const sdb = orgId ? scopedDb({ orgId }) : null;

  const [policy, killSwitch, distribution, recent] = await Promise.all([
    sdb
      ? sdb.moderationPolicyVersion
          .findFirst({ where: { active: true }, orderBy: { version: "desc" } })
          .catch(() => null)
      : Promise.resolve(null),
    moderationKillSwitchDbState(),
    sdb
      ? sdb.moderationRequest.groupBy({ by: ["verdict"], _count: { _all: true } }).catch(() => [])
      : Promise.resolve([]),
    sdb
      ? sdb.moderationRequest
          .findMany({
            orderBy: { createdAt: "desc" },
            take: 50,
            select: {
              id: true,
              stage: true,
              verdict: true,
              categories: true,
              source: true,
              caseRef: true,
              latencyMs: true,
              createdAt: true,
            },
          })
          .catch(() => [])
      : Promise.resolve([]),
  ]);

  // Latency p95 over the recent window (operator triage, not the SLO gate —
  // the durable percentile lives in the spans store).
  const latencies = (
    await (sdb
      ? sdb.moderationRequest
          .findMany({
            where: { latencyMs: { not: null } },
            orderBy: { createdAt: "desc" },
            take: 200,
            select: { latencyMs: true },
          })
          .catch(() => [])
      : Promise.resolve([] as { latencyMs: number | null }[]))
  )
    .map((r) => r.latencyMs ?? 0)
    .sort((a, b) => a - b);
  const p95 = latencies.length ? (latencies[Math.floor(latencies.length * 0.95)] ?? null) : null;

  // ── Decision-quality analytics (P2) ─────────────────────────────────────
  // FP measurement proxy: no ground-truth labels exist, so "quality" is
  // never claimed as false-positive/false-negative rates. What the evidence
  // rows DO support — verdict mix per stage, source mix (model vs
  // invalid/degraded), refusal and degraded shares, and metered usage — is
  // published here with empty data as null, never as a flattering 0%.
  const ANALYTICS_WINDOW_DAYS = 7;
  const analyticsCutoff = new Date(Date.now() - ANALYTICS_WINDOW_DAYS * 86_400_000);

  const byStage = sdb
    ? await sdb.moderationRequest
        .groupBy({ by: ["stage", "verdict"], _count: { _all: true } })
        .catch(() => [] as { stage: string; verdict: string; _count: { _all: number } }[])
    : [];
  const bySource = sdb
    ? await sdb.moderationRequest
        .groupBy({ by: ["source"], _count: { _all: true } })
        .catch(() => [] as { source: string; _count: { _all: number } }[])
    : [];
  const callsLast7Days = sdb
    ? await sdb.moderationRequest
        .count({ where: { createdAt: { gte: analyticsCutoff } } })
        .catch(() => 0)
    : 0;
  const totalCalls = distribution.reduce((n, row) => n + row._count._all, 0);
  const refusalCalls = distribution.find((d) => d.verdict === "unsafe")?._count._all ?? 0;
  const controversialCalls =
    distribution.find((d) => d.verdict === "controversial")?._count._all ?? 0;
  const safeCalls = distribution.find((d) => d.verdict === "safe")?._count._all ?? 0;
  const degradedCalls = bySource
    .filter((s) => s.source === "degraded" || s.source === "invalid")
    .reduce((n, s) => n + s._count._all, 0);
  // Metered usage: the wallet-neutral ledger rows (see recordModerationUsage).
  // This is the tenant's moderation VOLUME — the surface a quota would be
  // measured against — not a charge.
  const metered = sdb
    ? await sdb.usageLedger
        .groupBy({
          by: ["kind"],
          where: { kind: "moderation" },
          _sum: { units: true },
          _count: { _all: true },
        })
        .catch(
          () => [] as { kind: string; _sum: { units: number | null }; _count: { _all: number } }[],
        )
    : [];
  const meteredUnits = metered.reduce((n, r) => n + (r._sum.units ?? 0), 0);
  const meteredCalls = metered.reduce((n, r) => n + r._count._all, 0);

  return NextResponse.json(
    {
      health: moderationHealth(),
      killSwitch: killSwitch,
      policy,
      distribution,
      recent,
      latencyP95Ms: p95,
      analytics: {
        windowDays: ANALYTICS_WINDOW_DAYS,
        totalCalls,
        callsLast7Days,
        byStage,
        bySource,
        // Ratios are null without data: a 0() refused share from zero
        // decisions would claim health that has not been earned.
        rates:
          totalCalls > 0
            ? {
                refusalRate: (refusalCalls + controversialCalls) / totalCalls,
                degradedShare: degradedCalls / totalCalls,
                safeShare: safeCalls / totalCalls,
              }
            : null,
        meteredUnits,
        meteredCalls,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: `${first?.path.join(".")} ${first?.message ?? "invalid"}` },
      { status: 422 },
    );
  }

  const actor = guard.profile?.userId ?? "operator";
  const orgId = guard.profile?.orgId ?? null;

  // Kill switch first: it outranks policy work and must not wait on it.
  if (parsed.data.killSwitch !== undefined) {
    await setModerationKillSwitch(parsed.data.killSwitch, actor);
    await auditAppend({
      callRef: `moderation-switch-${Date.now().toString(36)}`,
      action: "freeze",
      intent: parsed.data.killSwitch
        ? "moderation_kill_switch_engaged"
        : "moderation_kill_switch_released",
      callerId: actor,
      redactedText: `${MODERATION_KILL_SWITCH_NAME} ${parsed.data.killSwitch ? "engaged" : "released"}`,
      meta: { switch: MODERATION_KILL_SWITCH_NAME, engaged: parsed.data.killSwitch },
      orgId: orgId ?? undefined,
    }).catch(() => {});
  }

  let policy: {
    profile: string;
    escalateOn: string;
    gateTools: boolean;
    retentionDays: number;
    version: number;
  } | null = null;
  if (parsed.data.policy) {
    const current = await db.moderationPolicyVersion.findFirst({
      where: { orgId, active: true },
      orderBy: { version: "desc" },
    });
    const nextVersion = (current?.version ?? 0) + 1;
    policy = await db.moderationPolicyVersion.create({
      data: {
        orgId,
        version: nextVersion,
        profile: parsed.data.policy.profile ?? current?.profile ?? "general",
        escalateOn: parsed.data.policy.escalateOn ?? current?.escalateOn ?? "unsafe",
        gateTools: parsed.data.policy.gateTools ?? current?.gateTools ?? true,
        retentionDays: parsed.data.policy.retentionDays ?? current?.retentionDays ?? 90,
        languages: parsed.data.policy.languages ?? current?.languages ?? [],
        createdBy: actor,
        note: parsed.data.policy.note ?? null,
      },
    });
    // A policy change is an administrator act on the audit chain, with the
    // version number — so a historical decision can be tied to the exact
    // rules that were active when it was made.
    await auditAppend({
      callRef: `moderation-policy-v${nextVersion}`,
      action: "agent",
      intent: "moderation_policy_version_created",
      callerId: actor,
      redactedText: `moderation policy version ${nextVersion}`,
      meta: {
        version: nextVersion,
        profile: policy.profile,
        escalateOn: policy.escalateOn,
        gateTools: policy.gateTools,
        retentionDays: policy.retentionDays,
      },
      orgId: orgId ?? undefined,
    }).catch(() => {});
  }

  return NextResponse.json(
    { ok: true, policy, killSwitch: await moderationKillSwitchDbState() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
