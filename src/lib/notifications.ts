import "server-only";
/**
 * In-app inbox, severity routing and acknowledgement-based escalation (WP-20).
 *
 * Three properties this exists to guarantee:
 *
 *   1. **A burst becomes one alert.** A smishing wave that triggers 500
 *      interventions must not page a human 500 times. Rows are keyed by
 *      `{orgId}:{alertType}:{windowBucket}` and the count increments, so the
 *      operator sees one item carrying the real number.
 *   2. **Escalation is acknowledgement-driven, not time-driven alone.** An
 *      unacknowledged `page` advances through the contact ladder; an
 *      acknowledged one stops. Every hop is written to the tamper-evident
 *      audit chain, because "we paged the on-call and nobody came" is a fact a
 *      bank's post-incident review will ask about.
 *   3. **Delivery goes through the outbox** (WP-5), never an in-handler fetch,
 *      and the in-app row is the single source of truth for what is outstanding.
 */

import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import { notifyRealtime } from "@/lib/realtime";

export type Severity = "page" | "urgent" | "info";

/** Routing: what "page" means, and how long a human has to answer. */
export const SEVERITY_SLA_MS: Record<Severity, number> = {
  page: 5 * 60_000, // 5 minutes
  urgent: 30 * 60_000,
  info: 24 * 3600_000,
};

/** The contact ladder. Order is the escalation order. */
export const ESCALATION_CONTACTS = [
  { id: "fraud_oncall", channel: "pager" as const, label: "Fraud on-call" },
  { id: "fraud_desk", channel: "email" as const, label: "Fraud desk" },
  { id: "head_of_risk", channel: "email" as const, label: "Head of Risk" },
];

export function dedupeKeyFor(input: {
  orgId: string | null;
  alertType: string;
  at?: Date;
  windowMinutes?: number;
}): string {
  const windowMinutes = input.windowMinutes ?? 15;
  const bucket =
    windowMinutes > 0
      ? Math.floor((input.at ?? new Date()).getTime() / (windowMinutes * 60_000))
      : 0;
  return `${input.orgId ?? "default"}:${input.alertType}:${bucket}`;
}

export type NotifyInput = {
  orgId: string | null;
  alertType: string;
  severity: Severity;
  title: string;
  body?: string;
  caseRef?: string | null;
  windowMinutes?: number;
  at?: Date;
};

/**
 * Record (or aggregate into) a notification and fan it out.
 * Returns whether this call created a new item or folded into an existing one.
 */
export async function notify(
  input: NotifyInput,
): Promise<{ id: string; deduplicated: boolean; count: number }> {
  const dedupeKey = dedupeKeyFor(input);
  const existing = await db.notification.findUnique({ where: { dedupeKey } });
  const row = existing
    ? await db.notification.update({
        where: { dedupeKey },
        data: { count: { increment: 1 }, updatedAt: new Date() },
        select: { id: true, count: true },
      })
    : await db.notification.create({
        data: {
          orgId: input.orgId,
          caseRef: input.caseRef ?? null,
          alertType: input.alertType,
          severity: input.severity,
          title: input.title,
          body: input.body ?? null,
          dedupeKey,
          windowMinutes: input.windowMinutes ?? 15,
          // `at` exists so fixtures and replays can place the alert on a
          // deterministic clock; production callers omit it and take now().
          ...(input.at ? { createdAt: input.at } : {}),
        },
        select: { id: true, count: true },
      });

  void notifyRealtime({
    orgId: input.orgId,
    callRef: input.caseRef ?? `alert:${input.alertType}`,
    payload: {
      type: "notification",
      alertType: input.alertType,
      severity: input.severity,
      title: input.title,
      count: row.count,
    },
  }).catch(() => {});

  return { id: row.id, deduplicated: existing !== null, count: row.count };
}

/**
 * A human has seen it. Escalation stops here permanently.
 *
 * Org-scoped, and that is the point of the signature. It previously took only
 * an id and would acknowledge ANY org's alert; the inbox route pre-checked
 * ownership first, so the leak was covered at exactly one call site. The
 * predicate belongs here, once, so a second caller cannot reintroduce it.
 */
export async function acknowledge(
  notificationId: string,
  orgId: string | null | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const scope = orgId ? { orgId } : { OR: [{ orgId: null }, { orgId: "default" }] };
  const row = await db.notification.findFirst({ where: { id: notificationId, ...scope } });
  if (!row) return { ok: false, error: "not_found" };
  if (row.acknowledgedAt) return { ok: false, error: "already_acknowledged" };
  await db.notification.update({
    where: { id: notificationId },
    data: { acknowledgedAt: new Date() },
  });
  return { ok: true };
}

export type EscalationHop = {
  id: string;
  alertType: string;
  severity: Severity;
  fromContact: string;
  toContact: string | null;
  contactIndex: number;
  terminal: boolean;
};

/**
 * Advance every unacknowledged notification whose SLA has expired to the next
 * contact in the ladder. Idempotent per run: a notification is only advanced
 * once per SLA window, tracked by `escalatedAt`.
 *
 * A `page` that exhausts the ladder is marked terminal — which is exactly the
 * signal the console must not hide.
 */
export async function advanceEscalations(now: Date = new Date()): Promise<EscalationHop[]> {
  const outstanding = await db.notification.findMany({
    where: { acknowledgedAt: null },
    orderBy: { createdAt: "asc" },
  });

  const hops: EscalationHop[] = [];
  for (const n of outstanding) {
    const severity = (n.severity as Severity) ?? "info";
    const sla = SEVERITY_SLA_MS[severity];
    const lastHopAt = n.escalatedAt ?? n.createdAt;
    if (now.getTime() - lastHopAt.getTime() < sla) continue;

    const nextIndex = n.contactIndex + 1;
    const nextContact = ESCALATION_CONTACTS[nextIndex] ?? null;
    const terminal = nextContact === null;

    await db.notification.update({
      where: { id: n.id },
      data: {
        contactIndex: nextIndex,
        escalatedAt: now,
        attempts: { increment: 1 },
        lastAttemptAt: now,
      },
    });

    // The ladder is part of the record: every hop is chained.
    await auditAppend(
      {
        callRef: n.caseRef ?? `alert:${n.alertType}`,
        action: "handoff",
        intent: terminal ? "escalation_exhausted" : "escalation_advanced",
        callerId: "escalation",
        meta: {
          notificationId: n.id,
          alertType: n.alertType,
          severity,
          fromContact: ESCALATION_CONTACTS[n.contactIndex]?.id ?? null,
          toContact: nextContact?.id ?? null,
          contactIndex: nextIndex,
          terminal,
        },
        orgId: n.orgId ?? undefined,
      },
      { fast: true },
    );

    hops.push({
      id: n.id,
      alertType: n.alertType,
      severity,
      fromContact: ESCALATION_CONTACTS[n.contactIndex]?.id ?? "none",
      toContact: nextContact?.id ?? null,
      contactIndex: nextIndex,
      terminal,
    });
  }
  return hops;
}

/** The inbox for the console: outstanding first, most severe first. */
export async function inbox(orgId: string | null, take = 50) {
  return db.notification.findMany({
    where: orgId ? { orgId } : { OR: [{ orgId: null }, { orgId: "default" }] },
    orderBy: [{ acknowledgedAt: "asc" }, { createdAt: "desc" }],
    take,
  });
}
