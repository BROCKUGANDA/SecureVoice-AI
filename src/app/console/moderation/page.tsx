import type { Metadata } from "next";
import { requireSignedIn } from "@/lib/credits";
import { db } from "@/lib/db";
import { moderationHealth, moderationKillSwitchDbState } from "@/lib/qwen3guard/moderate";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Moderation — Command Center",
  description: "Qwen3Guard moderation health, policy and decision history.",
  robots: { index: false, follow: false },
};

/**
 * GET /console/moderation — the operator view of the moderation subsystem.
 *
 * A server component that guards ITSELF (`requireSignedIn`), so it does not
 * depend on the AppRoot shell's client-side RBAC: a signed-in operator gets
 * the page, anyone else gets the sign-in notice. Tenant scoping is the
 * session's org, never a query parameter — the same rule every console read
 * follows. Cross-tenant rows are filtered by the orgId predicate, so the
 * history a tenant sees is only ever its own.
 *
 * Read-only by design: policy and kill-switch writes go through
 * `POST /api/console/moderation` (operator-gated, audited), so the page that
 * shows state can never be the thing that changes it.
 */

function verdictColor(verdict: string): string {
  switch (verdict) {
    case "safe":
      return "text-emerald-700 dark:text-emerald-400";
    case "unsafe":
      return "text-red-700 dark:text-red-400";
    case "controversial":
      return "text-amber-700 dark:text-amber-400";
    default:
      return "text-slate-600 dark:text-slate-300";
  }
}

export default async function ModerationPage() {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-xl font-semibold">Moderation</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {guard.error} — sign in to view the moderation surface.
        </p>
      </main>
    );
  }
  const orgId = guard.profile?.orgId ?? null;

  const ANALYTICS_WINDOW_DAYS = 7;
  const analyticsCutoff = new Date(Date.now() - ANALYTICS_WINDOW_DAYS * 86_400_000);

  const [
    health,
    killSwitch,
    distribution,
    recent,
    policy,
    byStage,
    bySource,
    callsLast7Days,
    metered,
  ] = await Promise.all([
    Promise.resolve(moderationHealth()),
    moderationKillSwitchDbState(),
    db.moderationRequest
      .groupBy({ by: ["verdict"], _count: { _all: true }, where: { orgId: orgId ?? undefined } })
      .catch(() => [] as { verdict: string; _count: { _all: number } }[]),
    db.moderationRequest
      .findMany({
        where: { orgId: orgId ?? undefined },
        orderBy: { createdAt: "desc" },
        take: 25,
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
      .catch(() => []),
    orgId
      ? db.moderationPolicyVersion
          .findFirst({ where: { orgId, active: true }, orderBy: { version: "desc" } })
          .catch(() => null)
      : Promise.resolve(null),
    db.moderationRequest
      .groupBy({
        by: ["stage", "verdict"],
        _count: { _all: true },
        where: { orgId: orgId ?? undefined },
      })
      .catch(() => [] as { stage: string; verdict: string; _count: { _all: number } }[]),
    db.moderationRequest
      .groupBy({ by: ["source"], _count: { _all: true }, where: { orgId: orgId ?? undefined } })
      .catch(() => [] as { source: string; _count: { _all: number } }[]),
    db.moderationRequest
      .count({ where: { orgId: orgId ?? undefined, createdAt: { gte: analyticsCutoff } } })
      .catch(() => 0),
    db.usageLedger
      .groupBy({
        by: ["kind"],
        where: { kind: "moderation", orgId: orgId ?? undefined },
        _sum: { units: true },
        _count: { _all: true },
      })
      .catch(
        () => [] as { kind: string; _sum: { units: number | null }; _count: { _all: number } }[],
      ),
  ]);

  type VerdictCount = { verdict: string; _count: { _all: number } };
  type MeteredCount = { kind: string; _sum: { units: number | null }; _count: { _all: number } };
  const verdictRows = distribution as VerdictCount[];
  const meteredRows = metered as MeteredCount[];
  let totalCalls = 0;
  for (const d of verdictRows) totalCalls += d._count._all;
  const refusalCalls =
    (distribution.find((d) => d.verdict === "unsafe")?._count._all ?? 0) +
    (distribution.find((d) => d.verdict === "controversial")?._count._all ?? 0);
  const degradedCalls = bySource
    .filter((s) => s.source === "degraded" || s.source === "invalid")
    .reduce((n, s) => n + s._count._all, 0);
  const pct = (n: number, total: number) =>
    total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "—";
  let meteredUnits = 0;
  let meteredCalls = 0;
  for (const r of meteredRows) {
    meteredUnits += r._sum.units ?? 0;
    meteredCalls += r._count._all;
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header>
        <h1 className="text-xl font-semibold">Moderation</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Qwen3Guard classifier health, tenant policy and recent decisions. The deterministic guard
          layer runs with or without the model layer; a non-<code>model</code> source is never
          reported as safe.
        </p>
      </header>

      <section aria-labelledby="mod-health" className="space-y-2">
        <h2 id="mod-health" className="text-base font-medium">
          Health
        </h2>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <dt className="text-slate-500 dark:text-slate-400">Classifier</dt>
            <dd className="font-medium">{health.flagOn ? "enabled" : "disabled (flag off)"}</dd>
          </div>
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <dt className="text-slate-500 dark:text-slate-400">Breaker</dt>
            <dd className="font-medium">
              {health.breaker.state} ({health.breaker.consecutiveFailures} consecutive failures)
            </dd>
          </div>
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <dt className="text-slate-500 dark:text-slate-400">Failure mode</dt>
            <dd className="font-medium">{health.failureMode}</dd>
          </div>
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <dt className="text-slate-500 dark:text-slate-400">Kill switch</dt>
            <dd
              className={`font-medium ${killSwitch.engaged ? "text-red-700 dark:text-red-400" : ""}`}
            >
              {killSwitch.engaged ? "ENGAGED" : "released"}
            </dd>
          </div>
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <dt className="text-slate-500 dark:text-slate-400">Model</dt>
            <dd className="font-medium">{health.model}</dd>
          </div>
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <dt className="text-slate-500 dark:text-slate-400">Cache entries</dt>
            <dd className="font-medium">{health.cacheEntries}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="mod-policy" className="space-y-2">
        <h2 id="mod-policy" className="text-base font-medium">
          Tenant policy
        </h2>
        {policy ? (
          <p className="text-sm">
            Version {policy.version} · profile <strong>{policy.profile}</strong> · escalate on{" "}
            <strong>{policy.escalateOn}</strong> · tool gating {policy.gateTools ? "on" : "off"} ·
            retention {policy.retentionDays} days
          </p>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            No active policy version — the platform defaults apply.
          </p>
        )}
      </section>

      <section aria-labelledby="mod-dist" className="space-y-2">
        <h2 id="mod-dist" className="text-base font-medium">
          Verdict distribution
        </h2>
        {distribution.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">No moderation decisions yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-3 text-sm">
            {distribution.map((d) => (
              <li
                key={d.verdict}
                className={`rounded border border-slate-200 px-3 py-1 dark:border-slate-700 ${verdictColor(d.verdict)}`}
              >
                {d.verdict}: {d._count._all}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="mod-quality" className="space-y-2">
        <h2 id="mod-quality" className="text-base font-medium">
          Decision quality
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Refusal and degraded shares against the tenant&apos;s own decisions — no ground-truth
          labels exist, so these are never presented as false-positive rates. Degraded means the
          model did not answer (invalid or timeout); kill switch and flag-off are deliberate
          operator states and are reported in sources, not here.
        </p>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <dt className="text-slate-500 dark:text-slate-400">Refusal rate</dt>
            <dd className="font-medium">{pct(refusalCalls, totalCalls)}</dd>
          </div>
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <dt className="text-slate-500 dark:text-slate-400">Degraded share</dt>
            <dd className="font-medium">{pct(degradedCalls, totalCalls)}</dd>
          </div>
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <dt className="text-slate-500 dark:text-slate-400">Calls (7 days)</dt>
            <dd className="font-medium">{callsLast7Days}</dd>
          </div>
          <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
            <dt className="text-slate-500 dark:text-slate-400">Metered units</dt>
            <dd className="font-medium">
              {meteredUnits}{" "}
              <span className="text-slate-500 dark:text-slate-400">({meteredCalls} calls)</span>
            </dd>
          </div>
        </dl>
        {byStage.length > 0 ? (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Verdict mix by moderation stage (scrollable)"
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Moderation verdict counts per lifecycle stage for this organisation
              </caption>
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Stage
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Safe
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Unsafe
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Controversial
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Invalid
                  </th>
                </tr>
              </thead>
              <tbody>
                {Array.from(new Set(byStage.map((r) => r.stage)))
                  .sort()
                  .map((stage) => {
                    const rows = byStage.filter((r) => r.stage === stage);
                    const count = (verdict: string) =>
                      rows.find((r) => r.verdict === verdict)?._count._all ?? 0;
                    return (
                      <tr key={stage} className="border-b border-slate-100 dark:border-slate-800">
                        <td className="py-1.5 pr-4">{stage}</td>
                        <td className="py-1.5 pr-4">{count("safe")}</td>
                        <td className={`py-1.5 pr-4 ${verdictColor("unsafe")}`}>
                          {count("unsafe")}
                        </td>
                        <td className={`py-1.5 pr-4 ${verdictColor("controversial")}`}>
                          {count("controversial")}
                        </td>
                        <td className="py-1.5">{count("invalid")}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="mod-recent" className="space-y-2">
        <h2 id="mod-recent" className="text-base font-medium">
          Recent decisions (this tenant)
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">Nothing recorded.</p>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Recent moderation decisions for this organisation (scrollable)"
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Recent moderation decisions for this organisation
              </caption>
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    When
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Stage
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Verdict
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Categories
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Source
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Case
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Latency
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 pr-4">
                      {r.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                    </td>
                    <td className="py-1.5 pr-4">{r.stage}</td>
                    <td className={`py-1.5 pr-4 ${verdictColor(r.verdict)}`}>{r.verdict}</td>
                    <td className="py-1.5 pr-4">{r.categories.join(", ") || "—"}</td>
                    <td className="py-1.5 pr-4">{r.source}</td>
                    <td className="py-1.5 pr-4">{r.caseRef ?? "—"}</td>
                    <td className="py-1.5">{r.latencyMs != null ? `${r.latencyMs} ms` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
