/**
 * The audit-chain watch — a broken chain that is FOUND and not DELIVERED is
 * indistinguishable from a chain nobody checked.
 *
 * `verifyChain()` was called from the console route, per case, on request. An
 * alteration anywhere else stayed broken in silence. The worker now sweeps a
 * bounded sample of recent chains every ten minutes, `verifyChain()` counts what
 * it finds, `/api/metrics` publishes the count, and a break pages the operator
 * inbox through the existing `notify()` dedupe/escalation path.
 *
 * These cases run against the real database and the real chain: two rows are
 * appended, one is ALTERED, and every layer between detection and delivery is
 * required to notice.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { db } from "@/lib/db";
import { append, auditChainBreaks, verifyChain } from "@/lib/audit-chain";
import {
  auditChainWatchTick,
  pageBrokenChains,
  resetChainWatchSchedule,
  scanRecentChains,
} from "@/lib/audit-chain-watch";

const RUN = Date.now().toString(36);
const ORG = `watch-org-${RUN}`;
const REF = `AUD_WATCH_${RUN}`;

const rowsFor = async () =>
  db.auditLog.findMany({ where: { callRef: REF }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

afterAll(async () => {
  await db.notification.deleteMany({ where: { caseRef: REF } });
  await db.auditLog.deleteMany({ where: { callRef: REF } });
});

beforeEach(() => {
  resetChainWatchSchedule();
});

describe("the audit-chain watch", () => {
  test("an intact chain verifies and moves no counter", async () => {
    await append({
      callRef: REF,
      action: "freeze",
      intent: "watch_probe",
      redactedText: "first",
      orgId: ORG,
    });
    await append({
      callRef: REF,
      action: "handoff",
      intent: "watch_probe",
      redactedText: "second",
      orgId: ORG,
    });
    const before = auditChainBreaks();
    const v = await verifyChain(REF, ORG);
    expect(v.ok).toBe(true);
    expect(auditChainBreaks()).toBe(before);
  });

  test("an altered row is detected, counted, and found by the sweep", async () => {
    const rows = await rowsFor();
    expect(rows.length).toBe(2);
    const victim = rows[0]!;
    const before = auditChainBreaks();

    await db.auditLog.update({
      where: { id: victim.id },
      data: { redactedText: "TAMPERED — never written by the app" },
    });

    const v = await verifyChain(REF, ORG);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.brokenAt).toBe(victim.id);
    expect(auditChainBreaks()).toBe(before + 1);

    // The sweep must surface the same chain and the same broken row without
    // being told which case to look at.
    const report = await scanRecentChains({ windowMinutes: 60, limit: 400 });
    const found = report.broken.find((b) => b.callRef === REF);
    expect(found).toBeDefined();
    expect(found!.brokenAt).toBe(victim.id);
    expect(found!.orgId).toBe(ORG);
  });

  test("a break pages the operator inbox — once per org per window", async () => {
    const pending = await scanRecentChains({ windowMinutes: 60, limit: 400 });
    const mine = pending.broken.filter((b) => b.callRef === REF);
    expect(mine.length).toBe(1);

    await pageBrokenChains({
      checked: pending.checked,
      broken: mine,
      at: new Date().toISOString(),
    });
    // A second identical page inside the window folds into the same row.
    await pageBrokenChains({
      checked: pending.checked,
      broken: mine,
      at: new Date().toISOString(),
    });

    const alerts = await db.notification.findMany({ where: { caseRef: REF } });
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.alertType).toBe("audit_chain_broken");
    expect(alerts[0]!.severity).toBe("page");
    expect(alerts[0]!.count).toBe(2);
  });

  test("the tick runs when due and refuses to run again inside the interval", async () => {
    const now = Date.now();
    const first = await auditChainWatchTick(now);
    expect(first).not.toBeNull();
    const second = await auditChainWatchTick(now + 1_000);
    expect(second).toBeNull();
  });

  test("restoring the row heals the chain; the counter stays monotonic", async () => {
    const rows = await rowsFor();
    const victim = rows[0]!;
    await db.auditLog.update({
      where: { id: victim.id },
      data: { redactedText: "first" },
    });
    const breaksBefore = auditChainBreaks();
    const v = await verifyChain(REF, ORG);
    expect(v.ok).toBe(true);
    expect(auditChainBreaks()).toBe(breaksBefore);
  });
});
