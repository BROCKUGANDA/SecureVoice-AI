/**
 * The velocity breaker's alert → operator inbox mapping.
 *
 * `setAlertSink()` was documented as "configure a sink at boot" and called by
 * nothing outside tests, so an `auto_pause` — which silences a tenant's fraud
 * calling until a human resumes it — reached stderr and nothing else. The
 * mapping is the part that can be wrong in a way nobody notices until an
 * incident: the wrong severity means the on-call is not paged inside the
 * five-minute SLA, and the wrong alert type means a wave of 500 trips becomes
 * 500 inbox rows instead of one aggregate.
 */
import { describe, expect, test } from "bun:test";

import {
  ABUSE_ALERT_TYPE,
  ABUSE_WARN_ALERT_TYPE,
  abuseAlertToNotification,
} from "@/lib/abuse/alert-sink";
import type { AbuseAlert } from "@/lib/abuse/velocity";

const metrics = {
  windowAttempts: 40,
  burstAttempts: 18,
  distinctPrefixes: 5,
  newPrefixes: 4,
  afterHoursAttempts: 2,
  afterHours: false,
  burstWindowSec: 60,
  newPrefixWindowSec: 900,
};

const base: Omit<AbuseAlert, "action" | "reason"> = {
  id: "alert-1",
  orgId: "org_fixture",
  at: "2026-10-29T10:00:00.000Z",
  signals: ["new_destination_prefix"],
  metrics,
  detail: "4 new destination prefixes in 900s (destinations masked: +9715•••••••)",
};

describe("abuseAlertToNotification", () => {
  test("an auto-pause is a page, on the auto-pause alert type", () => {
    const n = abuseAlertToNotification({
      ...base,
      action: "auto_pause",
      reason: "velocity_new_prefix_burst",
    });
    expect(n.alertType).toBe(ABUSE_ALERT_TYPE);
    expect(n.severity).toBe("page");
    expect(n.orgId).toBe("org_fixture");
    expect(n.body).toBe(base.detail);
    expect(n.title).toContain("org_fixture");
    expect(n.title).toContain("velocity_new_prefix_burst");
    expect(n.at?.toISOString()).toBe("2026-10-29T10:00:00.000Z");
  });

  test("a warning is info and uses its own type — it blocked nothing", () => {
    const n = abuseAlertToNotification({
      ...base,
      action: "warn",
      reason: "velocity_after_hours",
    });
    expect(n.alertType).toBe(ABUSE_WARN_ALERT_TYPE);
    expect(n.severity).toBe("info");
  });

  test("one inbox row per org per window — a wave aggregates instead of paging 500 times", () => {
    const a = abuseAlertToNotification({
      ...base,
      action: "auto_pause",
      reason: "velocity_burst_rate",
    });
    const b = abuseAlertToNotification({
      ...base,
      action: "auto_pause",
      reason: "velocity_burst_rate",
    });
    expect(a.windowMinutes).toBe(15);
    expect(a.windowMinutes).toBe(b.windowMinutes);
    expect(a.alertType).toBe(b.alertType);
    expect(a.orgId).toBe(b.orgId);
  });
});
