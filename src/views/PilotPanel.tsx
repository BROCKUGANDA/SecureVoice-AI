"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t, type Lang } from "@/lib/store";
import { PILOT_POLL_INTERVAL_MS } from "@/lib/public-config";

/**
 * The PILOT panel — the console surface for the bounded operating mode.
 *
 * ── Why this is a PANEL and not a runbook step ───────────────────────────────
 *
 * Three controls define a live pilot, and all three are things a person has to
 * reach DURING an incident or a shift:
 *
 *   1. The kill switch. "Stop dialling now" has to be one click for whoever
 *      holds the pager. It was, until this panel existed, a `curl` against a
 *      route nobody had a link to — which is a runbook step, and a runbook
 *      step at 03:00 is a step that does not happen.
 *   2. The per-dial approval. Phase 1 says a human approves EVERY dial, so
 *      the queue of cases waiting for that approval is the pilot's work item.
 *   3. The ceiling. The daily cap and the count against it are what an
 *      operator checks before saying yes to another pilot.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────
 *
 * It does not decide anything. The mode, the caps and the charter live in the
 * deployment configuration, and this panel READS them. The only thing it
 * writes is a decision a human has already made: approve this dial, decline
 * this dial, stop dialling, resume dialling.
 *
 * The kill switch is platform-wide, so flipping it is a PLATFORM action and the
 * route refuses it to a tenant-scoped operator. The panel says so rather than
 * offering a button that would 403 — a dead control in an incident is worse
 * than an absent one, because it teaches people that the console is lying.
 */

export type PilotStatus = {
  mode: "off" | "shadow" | "live";
  rawMode: string;
  modeRecognised: boolean;
  killSwitch: {
    env: boolean;
    database: boolean;
    engaged: boolean;
    databaseAvailable: boolean;
    envRaw: string | null;
    envRecognised: boolean;
  };
  dailyCap: number | null;
  concurrencyCap: number | null;
  capError: string | null;
  humanApprovalRequired: boolean;
  signalKind: string | null;
  actedToday: number | null;
  inFlightNow: number | null;
  secondsUntilReset: number | null;
  waiting?: Array<{ caseRef: string; attemptNo: number }>;
  waitingCount?: number;
  /** Whether this caller may flip the platform-wide kill switch. */
  canFlipKillSwitch?: boolean;
  /** Whether this caller may record a per-dial approval or decline. */
  canApprove?: boolean;
};

type Props = { lang: Lang };

export function PilotPanel({ lang }: Props) {
  const [pilot, setPilot] = useState<PilotStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [staleSince, setStaleSince] = useState<string | null>(null);

  /**
   * A monotonically increasing request id, and a ref for the request in
   * flight.
   *
   * The panel polls, and the poll is not instant: the status route counts the
   * PENDING backlog with a window function. Two responses can therefore
   * overlap, and if the OLDER one lands last it overwrites the newer state —
   * which on this surface means an approval the operator just recorded
   * reappearing in the waiting list.
   *
   * The sequence token drops any response that is not the latest, and the
   * in-flight ref stops the interval from starting a second request while one
   * is outstanding.
   */
  const requestId = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = ++requestId.current;
    try {
      const r = await fetch("/api/console/pilot", { cache: "no-store" });
      const d = (await r.json()) as { pilot?: PilotStatus; error?: string };
      // A response that is not the latest is dropped, not applied.
      if (id !== requestId.current) return;
      if (!r.ok) {
        setError(d.error ?? "pilot_status_unavailable");
        setStaleSince((prev) => prev ?? new Date().toISOString());
        return;
      }
      setError(null);
      setStaleSince(null);
      if (d.pilot) setPilot(d.pilot);
    } catch {
      if (id !== requestId.current) return;
      setError("pilot_status_unavailable");
      setStaleSince((prev) => prev ?? new Date().toISOString());
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    // The counters move while a pilot runs, so the panel refreshes. A slow
    // poll: this is an operator surface, not a live feed, and the pilot's own
    // dial decisions are far more precise than a screen refresh.
    const iv = setInterval(() => void load(), PILOT_POLL_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [load]);

  /**
   * Act: approve, decline, or flip the switch.
   *
   * Every write goes through the same funnel so the failure handling is in one
   * place — a 409 from a declined pilot and a 503 from an unreachable
   * database are different problems and the operator has to be able to tell
   * them apart.
   */
  const act = useCallback(
    async (key: string, path: string, body: Record<string, unknown>) => {
      setBusy(key);
      setNotice(null);
      try {
        const r = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
        if (!r.ok) {
          setNotice(d.message ?? d.error ?? `request_failed_${r.status}`);
          return;
        }
        await load();
      } catch {
        setNotice("request_failed");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  if (error && !pilot) {
    return (
      <div className="rounded-3xl border border-line bg-white p-6">
        <h2 className="font-display text-[15px] font-semibold">{t("Pilot", "التجربة", lang)}</h2>
        <p className="mt-1.5 text-[12px] text-ink-3">
          {t(
            "Pilot status is unavailable. Reload the page; if it keeps failing, the platform's control plane is not answering — check /api/readyz.",
            "حالة التجربة غير متاحة. أعد تحميل الصفحة؛ وإذا استمر الفشل، فمستوى التحكم في المنصة لا يستجيب — تحقّق من ‎/api/readyz.",
            lang,
          )}
        </p>
      </div>
    );
  }

  if (!pilot) {
    return (
      <div className="rounded-3xl border border-line bg-white p-6">
        <h2 className="font-display text-[15px] font-semibold">{t("Pilot", "التجربة", lang)}</h2>
        <p className="mt-1.5 text-[12px] text-ink-3">{t("Loading…", "جارٍ التحميل…", lang)}</p>
      </div>
    );
  }

  const engaged = pilot.killSwitch.engaged;
  const waiting = pilot.waiting ?? [];
  const waitingCount = pilot.waitingCount ?? waiting.length;

  return (
    <div className="rounded-3xl border border-line bg-white p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-[15px] font-semibold">{t("Pilot", "التجربة", lang)}</h2>
          <span
            className={`num rounded-lg px-2 py-0.5 text-[11px] font-semibold ${
              pilot.mode === "live"
                ? "bg-green-tint text-primary"
                : pilot.mode === "shadow"
                  ? "bg-amber-tint text-amber-700"
                  : "bg-secondary text-ink-3"
            }`}
          >
            {pilot.mode}
          </span>
          {engaged && (
            <span className="num rounded-lg bg-red-tint px-2 py-0.5 text-[11px] font-semibold text-red-700">
              {t("DIALLING STOPPED", "الاتصال متوقف", lang)}
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={busy !== null || pilot.canFlipKillSwitch === false}
          title={
            pilot.canFlipKillSwitch === false
              ? t(
                  "The kill switch is platform-wide. A platform operator has to flip it.",
                  "مفتاح الإيقاف على مستوى المنصة، ويجب أن يفعّله مشغّل منصة.",
                  lang,
                )
              : undefined
          }
          onClick={() =>
            void act(
              "kill-switch",
              "/api/console/pilot/kill-switch",
              engaged
                ? { engaged: false, reason: "resumed from the console" }
                : { engaged: true, reason: "stopped from the console" },
            )
          }
          className="rounded-xl border border-line px-3 py-1.5 text-[12px] font-semibold text-ink-2 disabled:opacity-50"
        >
          {busy === "kill-switch"
            ? t("Applying…", "جارٍ التنفيذ…", lang)
            : engaged
              ? t("Resume dialling", "استئناف الاتصال", lang)
              : t("Stop dialling", "إيقاف الاتصال", lang)}
        </button>
      </div>

      {pilot.canFlipKillSwitch === false && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
          {t(
            "The kill switch is platform-wide, so a platform operator has to flip it. You can see that it is engaged.",
            "مفتاح الإيقاف على مستوى المنصة، ويجب أن يفعّله مشغّل منصة. ويمكنك أن ترى أنه مُفعَّل.",
            lang,
          )}
        </p>
      )}

      {!pilot.modeRecognised && (
        <p className="mt-2 text-[12px] leading-relaxed text-red-700">
          {t(
            `PILOT_MODE is set to "${pilot.rawMode}", which is not a mode this platform understands. It is running as "shadow" — no customer is contacted.`,
            `قيمة PILOT_MODE هي "${pilot.rawMode}" وهي ليست وضعاً تعرفه المنصة، لذلك تعمل المنصة في وضع "الظل" — لا يتم الاتصال بأي عميل.`,
            lang,
          )}
        </p>
      )}

      {pilot.killSwitch.envRaw !== null && !pilot.killSwitch.envRecognised && (
        <p className="mt-2 text-[12px] leading-relaxed text-amber-700">
          {t(
            `DIAL_KILL_SWITCH is set to "${pilot.killSwitch.envRaw}", which is not a spelling this platform recognises. The switch is NOT engaged.`,
            `قيمة DIAL_KILL_SWITCH هي "${pilot.killSwitch.envRaw}" وهي ليست صيغة معروفة، لذلك المفتاح غير مُفعَّل.`,
            lang,
          )}
        </p>
      )}

      {pilot.killSwitch.databaseAvailable === false && (
        <p className="mt-2 text-[12px] leading-relaxed text-amber-700">
          {t(
            "The operator kill switch could not be read, so it is treated as ENGAGED. Dialling is stopped until the database is reachable.",
            "تعذّرت قراءة مفتاح الإيقاف، لذلك يُعامَل على أنه مُفعَّل. الاتصال متوقف حتى تعود قاعدة البيانات.",
            lang,
          )}
        </p>
      )}

      {pilot.capError && (
        <p className="mt-2 text-[12px] leading-relaxed text-red-700">
          {t(
            `A pilot cap is misconfigured, so the platform refuses to dial: ${pilot.capError}`,
            `إعداد أحد حدود التجربة غير صحيح، لذلك ترفض المنصة الاتصال: ${pilot.capError}`,
            lang,
          )}
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-4">
        <Stat
          label={t("Interventions today", "تدخّلات اليوم", lang)}
          value={
            pilot.actedToday === null
              ? "—"
              : `${pilot.actedToday}${pilot.dailyCap === null ? "" : ` / ${pilot.dailyCap}`}`
          }
        />
        <Stat
          label={t("In flight", "قيد التنفيذ", lang)}
          value={
            pilot.inFlightNow === null
              ? "—"
              : `${pilot.inFlightNow}${pilot.concurrencyCap === null ? "" : ` / ${pilot.concurrencyCap}`}`
          }
        />
        <Stat
          label={t("Chartered alert type", "نوع التنبيه المُعتمد", lang)}
          value={pilot.signalKind ?? "—"}
        />
        <Stat
          label={t("Human approval", "موافقة بشرية", lang)}
          value={
            // The app-wide renderings, deliberately: `SloPanel` and `Docs` already
            // spell "required" as مطلوب and `Demo` spells "off" as مُعطّل, and the
            // translation gate refuses one English string with two Arabic
            // renderings. The feminine forms read better against موافقة بشرية,
            // and they are exactly the kind of local flourish that makes the same
            // English word mean two different things on two screens.
            pilot.humanApprovalRequired ? t("required", "مطلوب", lang) : t("off", "مُعطّل", lang)
          }
        />
      </dl>

      {pilot.mode === "shadow" && (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
          {t(
            "Shadow mode: cases are recorded and every gate runs, but no customer is contacted. That is the Phase 0 readout.",
            "وضع الظل: تُسجَّل الحالات وتعمل كل البوابات، دون الاتصال بأي عميل. هذه قراءة المرحلة صفر.",
            lang,
          )}
        </p>
      )}

      {staleSince && (
        <p
          // The data below is the LAST GOOD reading, and the operator has to be
          // told that. A panel that keeps rendering yesterday's counters with
          // no warning is the one surface where a stale number does the most
          // damage.
          aria-live="polite"
          className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-800"
        >
          {t(
            "These numbers are STALE — the last refresh failed. Check /api/readyz before acting on them.",
            "هذه الأرقام قديمة — فشل آخر تحديث. تحقّق من ‎/api/readyz قبل التصرّف بناءً عليها.",
            lang,
          )}
        </p>
      )}

      {notice && (
        <p
          // The result of an ACTION the operator just took. Without a live
          // region it appears silently, and a screen-reader user is left
          // guessing whether the approval was recorded.
          aria-live="polite"
          className="mt-3 rounded-xl border border-line bg-secondary px-3 py-2 text-[12px] text-ink-2"
        >
          {notice}
        </p>
      )}

      {waitingCount > 0 && (
        <div className="mt-4 border-t border-line pt-4">
          <p
            // The count an operator must not miss: a case parked for want of a
            // signature is a fraud intervention that has not happened. It
            // changes asynchronously, so it is announced.
            aria-live="polite"
            className="text-[12.5px] font-semibold text-ink-2"
          >
            {t("Waiting for a decision", "بانتظار قرار", lang)} ·{" "}
            <span className="num">{waitingCount}</span>
          </p>
          <ul className="mt-2 space-y-2">
            {waiting.map((c) => (
              <li
                key={`${c.caseRef}-${c.attemptNo}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2"
              >
                <span className="num min-w-0 break-words text-[12px] text-ink-2">
                  {c.caseRef}
                  <span className="text-ink-3">
                    {" "}
                    · {t("attempt", "محاولة", lang)} {c.attemptNo}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    // The approvals route needs the operator role AND an
                    // organisation, so the button is offered only to a caller
                    // who can actually use it. A control that is present and
                    // answers 400 teaches people the console is lying.
                    disabled={busy !== null || pilot.canApprove === false}
                    title={
                      pilot.canApprove === false
                        ? t(
                            "Recording a decision needs an organisation, and an operator role.",
                            "تسجيل القرار يحتاج منظمة ودور مشغّل.",
                            lang,
                          )
                        : undefined
                    }
                    onClick={() =>
                      void act(`approve:${c.caseRef}`, "/api/console/pilot/approvals", {
                        caseRef: c.caseRef,
                        decision: "approve",
                      })
                    }
                    className="rounded-lg bg-primary px-2.5 py-1 text-[11.5px] font-semibold text-white disabled:opacity-50"
                  >
                    {t("Approve", "موافقة", lang)}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null || pilot.canApprove === false}
                    onClick={() =>
                      void act(`decline:${c.caseRef}`, "/api/console/pilot/approvals", {
                        caseRef: c.caseRef,
                        decision: "decline",
                      })
                    }
                    className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink-2 disabled:opacity-50"
                  >
                    {t("Decline", "رفض", lang)}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {waitingCount > waiting.length && (
            <p className="mt-2 text-[11.5px] text-ink-3">
              {t(
                `Showing the first ${waiting.length} of ${waitingCount}.`,
                `يُعرض أول ${waiting.length} من ${waitingCount}.`,
                lang,
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="num mt-0.5 text-[13px] font-semibold text-ink-2">{value}</dd>
    </div>
  );
}
