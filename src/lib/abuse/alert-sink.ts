import "server-only";
/**
 * The production sink for velocity-breaker alerts.
 *
 * `setAlertSink()` existed, was documented as "configure a sink at boot", and was
 * called by nothing outside two test files. So in production the breaker's
 * `auto_pause` — the sticky control that silences a tenant's fraud calling until
 * a human resumes it — was reported only as a stderr line. Everything else about
 * the alert path already existed: `notify()` writes a deduped, escalating row to
 * the operator inbox, the worker advances unacknowledged pages up the contact
 * ladder, and the inbox route renders them.
 *
 * What was missing was the one line that connects them. This module is that
 * line, and `installAbuseAlertSink()` is idempotent because `register()` may run
 * more than once in a process's life (dev hot reload).
 *
 * Delivery is fire-and-forget on purpose: the sink is called synchronously from
 * inside the dial gate, and `velocity.ts` already guarantees a broken sink must
 * not become a failed dial decision. Its rejection is logged loudly rather than
 * swallowed, because a page that was never written is the failure mode this
 * module exists to prevent.
 */
import { logError } from "@/lib/validation/safe-log";
import type { NotifyInput } from "@/lib/notifications";
import { setAlertSink, type AbuseAlert } from "./velocity";

/** Alert types as they appear in the operator inbox and its dedupe keys. */
export const ABUSE_ALERT_TYPE = "abuse_auto_pause";
export const ABUSE_WARN_ALERT_TYPE = "abuse_velocity_warn";

/**
 * Pure mapping from a breaker alert to an inbox row.
 *
 * `auto_pause` is a PAGE: a tenant's calls are refused, the pause is sticky
 * (`ABUSE_PAUSE_TTL_SEC` defaults to 0), and only a human can reopen it — a
 * five-minute response is the documented SLA. A `warn` is an `info`: it blocked
 * nothing and its SLA is a day.
 *
 * One alert per org per 15-minute window: a smishing wave trips the breaker
 * hundreds of times, and the inbox row is the aggregate that carries the real
 * count. Destinations are already masked in `detail` by `velocity.ts`.
 */
export function abuseAlertToNotification(alert: AbuseAlert): NotifyInput {
  const paused = alert.action === "auto_pause";
  return {
    orgId: alert.orgId,
    alertType: paused ? ABUSE_ALERT_TYPE : ABUSE_WARN_ALERT_TYPE,
    severity: paused ? "page" : "info",
    title: paused
      ? `Calling paused for ${alert.orgId}: ${alert.reason}`
      : `Velocity warning for ${alert.orgId}: ${alert.reason}`,
    body: alert.detail,
    windowMinutes: 15,
    at: new Date(alert.at),
  };
}

let installed = false;

/**
 * Route breaker alerts to the notification inbox. Call once at boot
 * (`src/instrumentation.ts`); safe to call again.
 */
export function installAbuseAlertSink(): void {
  if (installed) return;
  installed = true;
  setAlertSink((alert) => {
    const notification = abuseAlertToNotification(alert);
    logError("[abuse] velocity alert", {
      orgId: alert.orgId,
      action: alert.action,
      reason: alert.reason,
      signals: alert.signals.join(","),
      deliveredAs: `${notification.alertType}/${notification.severity}`,
    });
    // Loaded lazily: this runs on the dial hot path, and pulling the Prisma
    // client into the module graph of every route that can dial buys nothing
    // until an alert actually fires.
    void import("@/lib/notifications")
      .then(({ notify }) => notify(notification))
      .catch((err) => {
        logError("[abuse] alert delivery failed — no inbox row was written", {
          orgId: alert.orgId,
          action: alert.action,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });
}
