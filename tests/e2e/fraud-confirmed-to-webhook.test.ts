/**
 * `fraud_confirmed_to_webhook_delivered` — the bank's 2-second webhook promise, measured.
 *
 * The span declared a promise ("the bank is told within 2s of the customer denying the
 * transaction") with no code path able to produce a sample, because one half of it was
 * never a fact: `OutboxEvent.deliveredAt` has always existed, but the moment the denial
 * landed lived only as a state name. `Case.fraudConfirmedAt` (stamped by the single state
 * writer) plus `src/lib/telemetry/confirmation.ts` (called from `src/lib/outbox.ts` when a
 * delivery commits) supply the pair.
 *
 * WHAT THIS FILE PROVES, in order of how each could otherwise be quietly false:
 *
 *   (a) the number is the real interval — both instants are controlled here, so the
 *       duration is asserted EXACTLY rather as "plausible";
 *   (b) a case with no known start yields NO sample. The alternative — borrowing
 *       `updatedAt` or `createdAt` — produces a number for every case and means nothing,
 *       which is the failure this whole file family exists to refuse;
 *   (c) a LONG delivery is still recorded. This is the assertion that keeps the producer
 *       honest: a filter that dropped anything over the 2 s budget would make the SLO
 *       green by deleting its own bad news, so a 9-second delivery must appear with a
 *       9-second duration;
 *   (d) the unit of measure is the delivery, not the case: two notifications genuinely
 *       sent are two latency observations, and a retry that failed never counts because
 *       only a success writes `deliveredAt`.
 *
 * The delivery is real: the actual `deliver()` over a real outbox row with a stubbed
 * receiver (the same seam `tests/webhooks/outbound.test.ts` uses — the SSRF guard and the
 * per-institution endpoint resolution are tested by their own suites, and re-testing them
 * here would only couple two gates).
 */
import { expect, mock, test } from "bun:test";
import { db } from "@/lib/db";

mock.module("@/lib/vendor-endpoint", () => ({
  assertVendorUrlDeliverable: async (_url: string) => ({ ok: true }),
  resolveVendorEndpoint: async (_orgId: string | null | undefined) => ({
    ok: true,
    endpoint: {
      url: "https://receiver.invalid/hook",
      secret: "bank-secret-for-tests-bank-secret-for-tests",
      source: "deployment",
    },
  }),
}));

const { deliver, enqueueOutbox } = await import("@/lib/outbox");
const { transitionCase, transitionCaseWithOutbox } = await import("@/lib/case-state-machine");
const { recordWebhookDeliverySpan } = await import("@/lib/telemetry/confirmation");
const { recentSpans, resetSpans } = await import("@/lib/telemetry/spans");

const RECEIVER_OK = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

/** Every span this case produced, newest first, by reference rather than by recency. */
const spansFor = (caseRef: string) =>
  recentSpans(400).filter(
    (s) =>
      s.span === "fraud_confirmed_to_webhook_delivered" &&
      (s.caseRef ?? s.interventionId) === caseRef,
  );

/** A fresh case sitting one legal transition before the confirmation. */
async function makeCase(label: string, state = "VERIFYING") {
  const caseRef = `SV-FC-${label}-${Date.now().toString(36).toUpperCase()}`;
  await db.case.create({ data: { caseRef, orgId: "org-test", state } });
  return caseRef;
}

test("(a) the span is the real interval, to the millisecond", async () => {
  const caseRef = await makeCase("HAPPY");
  resetSpans();

  // The state writer, not the test, is what stamps the start instant — that is the
  // production behaviour under test, so nothing here writes the column by hand.
  await transitionCase(caseRef, "CONFIRMED_FRAUD");
  const confirmed = await db.case.findFirstOrThrow({ where: { caseRef } });
  expect(confirmed.fraudConfirmedAt).not.toBeNull();
  const startedAtMs = confirmed.fraudConfirmedAt!.getTime();

  const { eventId } = await transitionCaseWithOutbox(caseRef, "NOTIFIED", {
    outbox: {
      eventType: "case.notified",
      caseRef,
      orgId: "org-test",
      targetUrl: "https://receiver.invalid/hook",
      data: { state: "NOTIFIED", outcome: "success", audit_ref: caseRef },
    },
  });
  const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });

  // 1,400 ms after the denial — inside the published 2 s budget, and chosen rather than
  // measured so the assertion below is equality and not a range.
  const deliveredAt = new Date(startedAtMs + 1_400);
  const res = await deliver(
    {
      id: row.id,
      orgId: row.orgId,
      eventType: row.eventType,
      caseRef: row.caseRef,
      payload: row.payload,
      targetUrl: row.targetUrl,
      attempts: row.attempts,
    },
    RECEIVER_OK,
    deliveredAt,
  );
  expect(res.status).toBe("DELIVERED");

  const spans = spansFor(caseRef);
  expect(spans.length).toBe(1);
  expect(spans[0]!.startedAtMs).toBe(startedAtMs);
  expect(spans[0]!.endedAtMs).toBe(deliveredAt.getTime());
  expect(spans[0]!.durationMs).toBe(1_400);
  expect(spans[0]!.caseRef).toBe(caseRef);
  expect(spans[0]!.interventionId).toBe(caseRef);
  // Test traffic is harness traffic: `emit-slo.ts` refuses to judge the live population
  // from samples like this one.
  expect(spans[0]!.origin).toBe("harness");
  expect(String(spans[0]!.attributes.org ?? "")).toBe("org-test");
});

test("(b) no persisted start instant means no sample, not an estimate", async () => {
  const caseRef = await makeCase("NOSTART");
  resetSpans();
  await transitionCase(caseRef, "CONFIRMED_FRAUD");
  // Simulate a case confirmed before the column existed: the state is right, the start
  // instant is not. This is the only way to reach the branch on a fresh database.
  await db.case.updateMany({ where: { caseRef }, data: { fraudConfirmedAt: null } });

  const created = await db.$transaction((t) =>
    enqueueOutbox(t, {
      eventType: "case.notified",
      caseRef,
      orgId: "org-test",
      targetUrl: "https://receiver.invalid/hook",
      data: { state: "NOTIFIED" },
    }),
  );
  // `enqueueOutbox` selects `{ id }` — it is written to be called inside someone
  // else's transaction, where returning a whole row would be a second read nobody asked
  // for — so the delivery is made from the persisted row, as the worker does after
  // `claimBatch`.
  const row = await db.outboxEvent.findUniqueOrThrow({ where: { id: created.id } });
  const res = await deliver(
    {
      id: row.id,
      orgId: row.orgId,
      eventType: row.eventType,
      caseRef: row.caseRef,
      payload: row.payload,
      targetUrl: row.targetUrl,
      attempts: row.attempts,
    },
    RECEIVER_OK,
    new Date(),
  );
  expect(res.status).toBe("DELIVERED");
  expect(spansFor(caseRef).length).toBe(0);

  // The refusal is typed and named, so "no sample" can be told apart from "the
  // producer was never wired" — the ambiguity that hid this gap in the first place.
  const outcome = await recordWebhookDeliverySpan({
    caseRef,
    eventType: "case.notified",
    deliveredAtMs: Date.now(),
  });
  expect(outcome).toBe("no-start-instant");
});

test("(c) a nine-second delivery is recorded, not filtered out", async () => {
  // THE assertion that keeps this producer honest. `durationMs > budget` is the failure
  // the 2 s promise exists to surface; dropping it would report a healthy p95 built only
  // from the deliveries that happened to be fast.
  const caseRef = await makeCase("SLOW");
  resetSpans();
  await transitionCase(caseRef, "CONFIRMED_FRAUD");
  const startedAtMs = (
    await db.case.findFirstOrThrow({ where: { caseRef } })
  ).fraudConfirmedAt!.getTime();

  const outcome = await recordWebhookDeliverySpan({
    caseRef,
    eventType: "case.notified",
    deliveredAtMs: startedAtMs + 9_000,
  });
  expect(outcome).toBe("recorded");
  const spans = spansFor(caseRef);
  expect(spans.length).toBe(1);
  expect(spans[0]!.durationMs).toBe(9_000);
});

test("(d) a delivery that precedes its own confirmation is refused as a broken pair", async () => {
  const caseRef = await makeCase("SKEW");
  resetSpans();
  await transitionCase(caseRef, "CONFIRMED_FRAUD");
  const startedAtMs = (
    await db.case.findFirstOrThrow({ where: { caseRef } })
  ).fraudConfirmedAt!.getTime();

  const outcome = await recordWebhookDeliverySpan({
    caseRef,
    eventType: "case.notified",
    deliveredAtMs: startedAtMs - 1_000,
  });
  expect(outcome).toBe("clock-skew");
  expect(spansFor(caseRef).length).toBe(0);
});

test("only the notification event carries the promise", async () => {
  const caseRef = await makeCase("TYPE");
  resetSpans();
  await transitionCase(caseRef, "CONFIRMED_FRAUD");
  const startedAtMs = (
    await db.case.findFirstOrThrow({ where: { caseRef } })
  ).fraudConfirmedAt!.getTime();

  // An escalation notice is its own thing; naming it here would attribute a different
  // integration's latency to the 2 s webhook promise.
  expect(
    await recordWebhookDeliverySpan({
      caseRef,
      eventType: "escalated.human",
      deliveredAtMs: startedAtMs + 500,
    }),
  ).toBe("not-a-notification");
  expect(spansFor(caseRef).length).toBe(0);
});

test("two notifications for one case are two measurements", async () => {
  // Pins the unit of measure. A bank told twice waited twice; a span deduplicated per
  // case would report one wait and quietly halve the denominator of the budget.
  const caseRef = await makeCase("TWICE");
  resetSpans();
  await transitionCase(caseRef, "CONFIRMED_FRAUD");
  const startedAtMs = (
    await db.case.findFirstOrThrow({ where: { caseRef } })
  ).fraudConfirmedAt!.getTime();

  for (const [i, offset] of [800, 2_600].entries()) {
    const outcome = await recordWebhookDeliverySpan({
      caseRef,
      eventType: "case.notified",
      deliveredAtMs: startedAtMs + offset,
    });
    expect(outcome).toBe("recorded");
    expect(i).toBeLessThan(2);
  }
  const spans = spansFor(caseRef);
  expect(spans.length).toBe(2);
  expect(spans.map((s) => s.durationMs).sort((x, y) => x - y)).toEqual([800, 2_600]);
});

test("an erased case cannot fabricate a measurement", async () => {
  const caseRef = await makeCase("GONE");
  resetSpans();
  await transitionCase(caseRef, "CONFIRMED_FRAUD");
  await db.case.deleteMany({ where: { caseRef } });

  const outcome = await recordWebhookDeliverySpan({
    caseRef,
    eventType: "case.notified",
    deliveredAtMs: Date.now(),
  });
  expect(outcome).toBe("unknown-case");
  expect(spansFor(caseRef).length).toBe(0);
});
