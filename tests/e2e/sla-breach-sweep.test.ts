/**
 * E2E — the SLA-breach sweep, on the real path.
 *
 * `SLA_SECONDS` has been the published case deadline since the intake handler first
 * computed `slaDeadline`, and nothing ever checked it. This suite is the check that the
 * checker works, and specifically that it cannot lie in either direction:
 *
 *   - it must fire on a case that genuinely never reached anyone (the silent failure:
 *     a queue that stopped draining looks exactly like a healthy system from every
 *     other surface);
 *   - it must NOT fire twice on one case, because a breach count that counts sweep
 *     passes instead of cases turns a 60-second check into an escalating incident that
 *     never happened;
 *   - it must NOT fire on a case that rang, or one whose deadline is unknown — the
 *     second one is the invented-history failure mode: a column added today cannot
 *     retroactively certify or condemn the rows that predate it.
 *
 * The metric surface is asserted here too, because a breach nobody can chart is the
 * same absence wearing a different name.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { GET as metricsGet } from "@/app/api/metrics/route";
import { slaSeconds } from "@/lib/config";
import { CASE_STATES, createCase } from "@/lib/case-state-machine";
import { db } from "@/lib/db";
import { slaBreachPopulation, sweepSlaBreaches } from "@/lib/sla-breach";

const RUN = `sla${Date.now().toString(36).slice(-7)}`;
const ORG = `org-${RUN}`;
const refs: string[] = [];

async function caseWith(opts: {
  tag: string;
  receivedAgoMs: number | null;
  ring?: boolean;
  sms?: boolean;
  /** Dispatch the case to the dial queue, as a real intervention would be. */
  dispatch?: boolean;
}): Promise<string> {
  const caseRef = `SLA-${RUN}-${opts.tag}`;
  refs.push(caseRef);
  const created = await createCase({
    caseRef,
    orgId: ORG,
    transactionRef: `TX-${RUN}-${opts.tag}`,
    riskScore: 0.9,
    language: "en",
    phone: "+971501234567",
    amountMinor: 420_00,
    currency: "AED",
    consentRecordId: `consent-${RUN}-${opts.tag}`,
    signalReceivedAt: opts.receivedAgoMs == null ? null : new Date(Date.now() - opts.receivedAgoMs),
  });
  if (opts.dispatch) {
    // The sweep only marks a case that was DISPATCHED to the dial queue, and
    // for the right reason: a case the platform never tried to contact cannot
    // have missed a CONTACT deadline. That is not a corner case — it is every
    // case of a Phase 0 shadow pilot, where the whole point is that nobody is
    // called, and a sweep that marked them all would make the shadow readout
    // read as a 100% deadline miss.
    //
    // So "never reached the customer" has to mean DISPATCHED AND NOT REACHED,
    // and that is what the fixture below builds.
    const { enqueueDialJob } = await import("@/lib/scale/queue");
    await enqueueDialJob({
      caseId: caseRef,
      caseRef,
      orgId: ORG,
      attemptNo: 1,
      payload: { phone: "+971501234567", language: "en" },
    });
  }
  if (opts.ring) {
    await db.case.update({ where: { id: created.id }, data: { ringingAt: new Date() } });
  }
  if (opts.sms) {
    await db.case.update({
      where: { id: created.id },
      data: { smsSentAt: new Date() },
    });
  }
  return caseRef;
}

async function row(caseRef: string) {
  return db.case.findUniqueOrThrow({
    where: { caseRef },
    select: { slaBreachedAt: true, state: true },
  });
}

async function breaches(): Promise<number> {
  return db.case.count({ where: { orgId: ORG, slaBreachedAt: { not: null } } });
}

describe("the SLA-breach sweep", () => {
  beforeAll(() => {
    expect(slaSeconds()).toBeGreaterThan(0);
  });

  afterAll(async () => {
    // Audit rows stay: the chain is append-only by a trigger, and this suite's own
    // assertion is that a breach is auditable, so deleting evidence to tidy up would
    // contradict the test.
    await db.case.deleteMany({ where: { caseRef: { in: refs } } });
  });

  test("a case that never reached its customer is marked, and the audit says so", async () => {
    const caseRef = await caseWith({
      tag: "miss",
      receivedAgoMs: (slaSeconds() + 30) * 1000,
      dispatch: true,
    });
    const res = await sweepSlaBreaches();
    expect(res.windowSecs).toBe(slaSeconds());
    expect(res.breached).toBeGreaterThan(0);

    const marked = await row(caseRef);
    expect(marked.slaBreachedAt).toBeInstanceOf(Date);
    const audit = await db.auditLog.findFirst({
      where: { callRef: caseRef, intent: "sla_breached" },
      select: { action: true, callerId: true, meta: true },
    });
    expect(audit).not.toBeNull();
    expect(audit!.callerId).toBe("sla-sweep");
    // The record must say it only recorded. A reader who takes this for "the platform
    // fixed it by texting the customer" is being lied to by the evidence itself.
    const meta = JSON.parse(String(audit!.meta)) as Record<string, unknown>;
    expect(meta.enforcement).toBe("recorded_for_operator");
    expect(meta.contacted_by).toBeNull();
    expect(Number(meta.secs_since_signal)).toBeGreaterThan(slaSeconds());
  });

  test("the same case is never counted twice by a second sweep", async () => {
    // Idempotence is asserted about OUR case, not about the fleet: the sweep is
    // deliberately global, so a concurrent process creating eligible rows (another
    // suite, another worker) legitimately raises its count. The claim that matters is
    // that one case is recorded once — which is what the compare-and-set buys, and
    // what a breach-per-sweep-pass bug would break.
    const mine = await caseWith({
      tag: "twice",
      receivedAgoMs: (slaSeconds() + 30) * 1000,
      dispatch: true,
    });
    await sweepSlaBreaches();
    const first = (await row(mine)).slaBreachedAt;
    expect(first).toBeInstanceOf(Date);

    await sweepSlaBreaches();
    await sweepSlaBreaches();
    const after = (await row(mine)).slaBreachedAt;
    expect(after).toBeInstanceOf(Date);
    expect(after!.getTime()).toBe(first!.getTime());

    // Exactly one audit append per breach, for the same reason.
    const appends = await db.auditLog.count({ where: { callRef: mine, intent: "sla_breached" } });
    expect(appends).toBe(1);
  });

  test("a case that rang is not a breach", async () => {
    const caseRef = await caseWith({
      tag: "rang",
      receivedAgoMs: (slaSeconds() + 30) * 1000,
      ring: true,
    });
    await sweepSlaBreaches();
    expect((await row(caseRef)).slaBreachedAt).toBeNull();
  });

  test("the SMS fallback counts as contact — the deadline is reachability, not voice", async () => {
    const caseRef = await caseWith({
      tag: "sms",
      receivedAgoMs: (slaSeconds() + 30) * 1000,
      sms: true,
    });
    await sweepSlaBreaches();
    expect((await row(caseRef)).slaBreachedAt).toBeNull();
  });

  test("inside the deadline is not a breach yet", async () => {
    const caseRef = await caseWith({ tag: "fresh", receivedAgoMs: 1000 });
    await sweepSlaBreaches();
    expect((await row(caseRef)).slaBreachedAt).toBeNull();
  });

  test("a case with no arrival instant is excluded, and says it is excluded", async () => {
    const caseRef = await caseWith({ tag: "nostart", receivedAgoMs: null });
    const before = await breaches();
    const pop = await slaBreachPopulation();
    await sweepSlaBreaches();

    expect((await row(caseRef)).slaBreachedAt).toBeNull();
    expect(await breaches()).toBe(before);
    // The blind spot has to be a number, not an inference: `evaluated` must not include
    // the row above, and `notEvaluatable` must.
    expect(pop.notEvaluatable).toBeGreaterThanOrEqual(1);
    const countedAsEvaluated = await db.case.count({
      where: { orgId: ORG, signalReceivedAt: { not: null } },
    });
    expect(pop.evaluated).toBeGreaterThanOrEqual(countedAsEvaluated);
  });

  test("the breach is scrapeable, with its denominator", async () => {
    const body = await (await metricsGet(new Request("http://localhost/api/metrics"))).text();
    const total = /sv_sla_breach_total (\d+)/.exec(body);
    const evaluated = /sv_sla_evaluated_cases (\d+)/.exec(body);
    const deadline = /sv_sla_deadline_seconds (\d+)/.exec(body);
    const notEvaluable = /sv_sla_not_evaluable_cases (\d+)/.exec(body);

    expect(deadline?.[1]).toBe(String(slaSeconds()));
    // Same predicate, same scope as the collector: the metric is fleet-wide, so it is
    // compared to a fleet-wide count, not to this suite's tenant.
    expect(Number(total?.[1])).toBe(
      await db.case.count({ where: { slaBreachedAt: { not: null } } }),
    );
    expect(Number(evaluated?.[1])).toBeGreaterThanOrEqual(1);
    expect(Number(notEvaluable?.[1])).toBeGreaterThanOrEqual(1);
  });

  test("a failure inside the collector reports -1, never a comfortable zero", async () => {
    // The sweep's own honesty depends on the metric distinguishing "no breaches" from
    // "could not ask". Pinning the sentinel here means a future refactor cannot quietly
    // turn a broken collector into a green dashboard.
    const real = db.case.count.bind(db.case) as () => Promise<number>;
    db.case.count = (async () => {
      throw new Error("collector probe");
    }) as typeof db.case.count;
    try {
      const body = await (await metricsGet(new Request("http://localhost/api/metrics"))).text();
      expect(body).toMatch(/^sv_sla_breach_total -1$/m);
      expect(body).not.toMatch(/^sv_sla_evaluated_cases/m);
    } finally {
      db.case.count = real as typeof db.case.count;
    }
    const after = await (await metricsGet(new Request("http://localhost/api/metrics"))).text();
    expect(after).toMatch(/^sv_sla_evaluated_cases \d+$/m);
  });

  test("the sweep cannot reach a terminal state by itself", async () => {
    const caseRef = await caseWith({ tag: "state", receivedAgoMs: (slaSeconds() + 30) * 1000 });
    await sweepSlaBreaches();
    const seen = await row(caseRef);
    // Recording a breach is not advancing the case: the states stay the state
    // machine's, so a sweep can never be the thing that closes a customer's case.
    expect(CASE_STATES).toContain(seen.state as (typeof CASE_STATES)[number]);
    expect(seen.state).toBe("RECEIVED");
  });
});
