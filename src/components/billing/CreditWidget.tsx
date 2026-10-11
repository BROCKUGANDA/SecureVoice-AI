"use client";

/**
 * Live credit balance for the tenant wallet.
 *
 * ## Where the number comes from
 *
 * Two sources, and neither is authoritative alone:
 *
 *   1. A READ. `/api/console/me` (or a balance the caller already rendered) is
 *      the starting value. It is a snapshot, and on a multi-analyst desk a
 *      snapshot is stale the moment a colleague fires an intervention.
 *   2. A PUSH. `credit.deducted` arrives on the tenant's realtime org channel
 *      (see `announceCredit` in src/lib/credits.ts) for EVERY movement — the
 *      operator's own fire, a colleague's, a webhook's, a queue worker's. The
 *      event carries the AUTHORITATIVE remaining balance, not a delta, so
 *      applying it cannot drift: the widget renders the same integer the
 *      database row holds.
 *
 * The push is an accelerator over the read, never a replacement for it — the
 * same posture `realtime-client.ts` takes for the case feed. If realtime is
 * unavailable the widget still shows the read balance; it simply does not move
 * until the screen is refreshed, which is exactly what it did before the socket
 * existed. There is no error state for "no socket": a deployment without the
 * realtime flag is a supported deployment, not a broken one.
 *
 * ## The warnings, and the denominator they need
 *
 * "Yellow at 20%, red at 0" only means something relative to an allowance. The
 * plan's included volume (`PLAN_INCLUDED_UNITS`, mirrored by `includedPerMonth`
 * in src/lib/commercial.ts) is the honest denominator, so it is accepted as a
 * prop. Where the caller does not know it — an org with no subscription row, a
 * demo tenant — the FIRST balance the widget observes becomes the baseline, so
 * the warnings still work rather than silently never firing. That fallback is a
 * baseline, not an allowance, and is documented as such in the UI copy.
 *
 * Overage is a distinct state, not a synonym for "empty": it is raised only
 * when we know the plan (an `allowance` was supplied) AND the balance has been
 * drawn past zero, i.e. usage is now billing beyond the included volume. With a
 * prepaid wallet that is the moment the excess starts to cost money, which is
 * the only thing a badge called "Overage" should ever mean.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Coins, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { openRealtime, type RealtimeHandle, type RealtimeStatus } from "@/lib/realtime-client";
import type { CreditDeductedEvent } from "@/lib/realtime-events";
import { useApp, t } from "@/lib/store";
import { LiveDot } from "@/components/fx/core";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/** Balance at or below this fraction of the baseline raises the yellow state. */
export const LOW_BALANCE_RATIO = 0.2;

export type CreditLevel = "ok" | "warning" | "critical";

export type CreditWidgetProps = {
  /**
   * Balance the server already knows. When OMITTED (`undefined`) the widget
   * fetches `/api/console/me` on mount; when passed as `null` it does not fetch
   * and simply waits for the first realtime event. The distinction is the
   * difference between "we have not looked" and "there is nothing to look at".
   */
  initialCredits?: number | null;
  /**
   * Interventions included for the billing period — the denominator for the
   * usage percentage and the overage state. `null` means the plan is unknown or
   * negotiable, in which case no overage badge is raised and the baseline falls
   * back to the first observed balance.
   */
  allowance?: number | null;
  /** Fired after every balance change, so a parent chip can mirror it. */
  onBalance?: (credits: number) => void;
  /** Optional container class override. */
  className?: string;
};

export function CreditWidget({
  initialCredits,
  allowance,
  onBalance,
  className,
}: CreditWidgetProps) {
  const { lang } = useApp();

  const [credits, setCredits] = useState<number | null>(
    typeof initialCredits === "number" ? initialCredits : null,
  );
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [fetchError, setFetchError] = useState(false);

  /**
   * The denominator when the caller did not supply the plan's allowance. Seeded
   * from the rendered balance, then from the first value we observe. Held in a
   * ref because it must survive a re-render without triggering one — it is a
   * baseline, not UI state.
   */
  const baselineRef = useRef<number | null>(
    typeof initialCredits === "number" ? initialCredits : null,
  );
  /** Last level, so a toast fires on a TRANSITION and not on every event. */
  const levelRef = useRef<CreditLevel>("ok");

  // Latest callbacks, so the socket opens exactly once and never reconnects
  // because a prop or the language changed.
  const onBalanceRef = useRef(onBalance);
  useEffect(() => {
    onBalanceRef.current = onBalance;
  }, [onBalance]);

  const applyBalance = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    // First observation seeds the fallback baseline (see the header). Guarded on
    // > 0 so a wallet that mounts empty does not pin the baseline at zero.
    if (baselineRef.current === null && next > 0) baselineRef.current = next;
    setCredits(next);
    onBalanceRef.current?.(next);
  }, []);

  const handleCredit = useCallback(
    (event: CreditDeductedEvent) => {
      const remaining = event.data.remaining;
      applyBalance(remaining);
      if (event.data.refunded) {
        // A refund is rare and always worth a word: it is the only movement
        // that makes the balance go UP, and an unexplained increase reads as a
        // bug to the analyst watching it.
        toast.success(t("Credit refunded", "تم ردّ الاعتماد", lang), {
          id: "credit-refund",
          description: t(
            `${remaining.toLocaleString()} credits available again.`,
            `${remaining.toLocaleString()} اعتماداً متاحاً مرة أخرى.`,
            lang,
          ),
        });
      }
    },
    [applyBalance, lang],
  );

  const callbacksRef = useRef<{
    onCredit: (event: CreditDeductedEvent) => void;
    onStatus: (next: RealtimeStatus) => void;
  }>({ onCredit: () => {}, onStatus: () => {} });

  useEffect(() => {
    callbacksRef.current = { onCredit: handleCredit, onStatus: setStatus };
  }, [handleCredit]);

  // ── Initial read ──────────────────────────────────────────────────────────
  useEffect(() => {
    // A caller that passed a value (number or an explicit null) has already
    // decided; only `undefined` means "please look".
    if (initialCredits !== undefined) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/console/me", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { profile?: { credits?: unknown } | null };
        const value = body.profile?.credits;
        if (alive && typeof value === "number") applyBalance(value);
      } catch {
        // Surfaced inline, not as a toast: the balance simply does not move,
        // and a red toast on a read-only display would overstate the failure.
        if (alive) setFetchError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialCredits, applyBalance]);

  // ── Live updates ──────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    let handle: RealtimeHandle | null = null;

    void openRealtime({
      // No case subscriptions: a wallet movement is an ORG-level event,
      // published with an empty callRef so it rides `org:<orgId>` and never a
      // case channel. The client joins that channel for every operator, so an
      // empty case list is exactly the subscription this widget wants.
      callRefs: [],
      onCredit: (event) => callbacksRef.current.onCredit(event),
      onStatus: (next) => {
        if (alive) callbacksRef.current.onStatus(next);
      },
    })
      .then((opened) => {
        // Unmount during the handshake: close what we just opened rather than
        // leaving a reconnecting socket behind the widget.
        if (!alive) {
          opened?.close();
          return;
        }
        handle = opened;
      })
      .catch(() => {
        // `openRealtime` resolves to null when the push path is unavailable and
        // only rejects on an unexpected fault. Either way the read balance
        // stands; there is nothing to report to the operator.
      });

    return () => {
      alive = false;
      handle?.close();
    };
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────
  const baseline = allowance && allowance > 0 ? allowance : baselineRef.current;
  const remaining = credits ?? 0;

  const usage = useMemo(() => {
    if (baseline === null || baseline <= 0 || credits === null) return null;
    const used = Math.max(0, baseline - remaining);
    const usedPercent = Math.min(100, Math.round((used / baseline) * 100));
    return { used, usedPercent, remainingPercent: Math.max(0, 100 - usedPercent) };
  }, [baseline, credits, remaining]);

  const level: CreditLevel =
    credits === null
      ? "ok"
      : remaining <= 0
        ? "critical"
        : usage !== null && usage.remainingPercent <= LOW_BALANCE_RATIO * 100
          ? "warning"
          : "ok";

  /**
   * Past the included volume. Gated on `allowance` being KNOWN: without a plan
   * we cannot say whether usage beyond the wallet is billed or refused, and a
   * badge that guesses would be wrong on the one screen a finance team reads.
   */
  const isOverage = Boolean(allowance && allowance > 0) && credits !== null && remaining < 0;

  // ── Threshold notifications ───────────────────────────────────────────────
  useEffect(() => {
    const previous = levelRef.current;
    if (level === previous) return;
    levelRef.current = level;

    if (level === "warning") {
      toast.warning(t("Low credit balance", "رصيد اعتمادات منخفض", lang), {
        // A stable id replaces rather than stacks: an analyst watching the
        // balance fall gets one warning, not one per intervention.
        id: "credit-low",
        description: t(
          `${remaining.toLocaleString()} credits left — top up before the wallet empties.`,
          `بقي ${remaining.toLocaleString()} اعتماداً — اشحن الرصيد قبل أن ينفد.`,
          lang,
        ),
      });
    } else if (level === "critical") {
      toast.error(t("Credit balance exhausted", "نفد رصيد الاعتمادات", lang), {
        id: "credit-empty",
        description: t(
          "New interventions are refused until the wallet is topped up.",
          "تُرفض التدخّلات الجديدة حتى يُشحن الرصيد.",
          lang,
        ),
      });
    }
  }, [level, remaining, lang]);

  const live = status === "live";

  return (
    <section
      className={cn("rounded-3xl border border-line bg-white p-6", className)}
      aria-label={t("Intervention credits", "اعتمادات التدخّل", lang)}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Coins
            className={cn(
              "h-4 w-4",
              level === "critical"
                ? "text-red-600"
                : level === "warning"
                  ? "text-amber-500"
                  : "text-primary",
            )}
          />
          <h2 className="font-display text-[17px] font-semibold tracking-tight">
            {t("Intervention credits", "اعتمادات التدخّل", lang)}
          </h2>
        </div>

        <div className="flex items-center gap-2">
          {isOverage && (
            <Badge
              variant="destructive"
              className="gap-1"
              title={t(
                "Usage has passed the included volume and is billing as overage.",
                "تجاوز الاستهلاك الحجم المشمول ويُحتسب الآن كرسوم إضافية.",
                lang,
              )}
            >
              <TrendingUp className="h-3 w-3" />
              {t("Overage", "تجاوز", lang)}
            </Badge>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[11px] font-medium",
              live ? "text-primary" : "text-ink-3",
            )}
            title={
              live
                ? t("Live — updates as credits move.", "مباشر — يتحدّث مع حركة الاعتمادات.", lang)
                : t("Snapshot — refresh to re-read the balance.", "لقطة — حدّث لقراءة الرصيد.", lang)
            }
          >
            <LiveDot className={cn(!live && "opacity-40")} />
            {live ? t("Live", "مباشر", lang) : t("Snapshot", "لقطة", lang)}
          </span>
        </div>
      </header>

      <p
        // Polite, not assertive: a balance ticking down must not interrupt what
        // a screen-reader user is reading mid-sentence.
        role="status"
        aria-live="polite"
        className="mt-3 flex items-baseline gap-2"
      >
        <span
          className={cn(
            "font-display text-[28px] font-semibold tabular-nums",
            level === "critical" && "text-red-600",
            level === "warning" && "text-amber-600",
          )}
        >
          {credits === null ? "…" : credits.toLocaleString()}
        </span>
        <span className="text-[13px] text-ink-2">
          {t("credits left", "رصيد متبقٍّ", lang)}
        </span>
      </p>

      {usage && (
        <>
          <Progress
            value={usage.usedPercent}
            className={cn(
              "mt-3 h-2.5",
              level === "critical" && "bg-red-100 [&_[data-slot=progress-indicator]]:bg-red-500",
              level === "warning" &&
                "bg-amber-100 [&_[data-slot=progress-indicator]]:bg-amber-500",
            )}
            aria-label={t("Credit usage this period", "استهلاك الاعتمادات هذه الفترة", lang)}
          />
          <p className="mt-1.5 text-[12px] text-ink-3">
            {t(
              `${usage.used.toLocaleString()} of ${baseline?.toLocaleString()} used this period`,
              `استُهلك ${usage.used.toLocaleString()} من ${baseline?.toLocaleString()} هذه الفترة`,
              lang,
            )}
          </p>
        </>
      )}

      {level === "warning" && (
        <p role="alert" className="mt-3 text-[12.5px] font-medium text-amber-700">
          {t(
            "Low balance — plan a top-up before the next intervention is refused.",
            "رصيد منخفض — خطّط للشحن قبل أن يُرفض التدخّل التالي.",
            lang,
          )}
        </p>
      )}

      {level === "critical" && (
        <p role="alert" className="mt-3 flex items-center gap-1.5 text-[12.5px] font-medium text-red-600">
          <AlertTriangle className="h-3.5 w-3.5" />
          {t(
            "Wallet empty — interventions are refused until it is topped up.",
            "المحفظة فارغة — تُرفض التدخّلات حتى يُشحن الرصيد.",
            lang,
          )}
        </p>
      )}

      {fetchError && credits === null && (
        <p role="alert" className="mt-3 text-[12.5px] text-ink-3">
          {t(
            "Could not read the balance. It will update when the next movement arrives.",
            "تعذّرت قراءة الرصيد. سيتحدّث عند وصول الحركة التالية.",
            lang,
          )}
        </p>
      )}
    </section>
  );
}
