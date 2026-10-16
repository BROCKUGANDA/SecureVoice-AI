/**
 * E2E — the `signal_received_to_ringing` producer, on the real path.
 *
 * The span has been in the published latency contract since the telemetry plane was
 * built and has never had a sample, because neither of its two instants survived the
 * request that observed it: the intake arrival instant was a local, and the carrier's
 * `ringing` status was folded into the delivery vocabulary as `queued`
 * (`src/lib/telecom-outbox.ts:117-121`) before anything could notice it. This suite is
 * the proof that both halves now exist and join, driven through the actual route handler
 * with a real Twilio signature and a real Postgres row — not through a stubbed
 * telemetry sink, which would prove only that a stub can be called.
 *
 * What each case protects:
 *   1. the intake instant is persisted at all — otherwise the span has no start;
 *   2. `queued` is NOT ringing — recording it would report the dial as slower than
 *      the carrier saw it, which is a fabricated number in the flattering direction;
 *   3. the sample exists, and its origin is `harness`, because a CI-produced sample
 *      must never be allowed to read as production latency (that exact confusion is
 *      what the origin tagging in `spans.ts` was added for);
 *   4. Twilio's at-least-once redelivery cannot inflate the count — a metric whose
 *      denominator is webhooks instead of calls is not the metric being reported;
 *   5. a case with no known start is refused rather than estimated, and stays null so
 *      the refusal is auditable.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { createCase } from "@/lib/case-state-machine";
import { recentSpans, resetSpans } from "@/lib/telemetry/spans";

// The limiter and the bad-actor gate are not the subject here, and six callbacks in one
// process would trip them long before the join was exercised. Forwarded, not replaced:
// a mock that lists only the functions this file happens to call breaks the moment the
// route under test imports one more thing (a lesson this repo has already paid for).
const realRatelimit = await import("@/lib/ratelimit");
mock.module("@/lib/ratelimit", () => ({
  ...realRatelimit,
  consume: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
  rateLimitId: () => "203.0.113.9",
}));
const realBadActor = await import("@/lib/abuse/bad-actor");
mock.module("@/lib/abuse/bad-actor", () => ({
  ...realBadActor,
  checkBadActor: () => ({ action: "allow" }),
  recordStrike: () => {},
}));

const RUN = `sr${Date.now().toString(36).slice(-7)}`;
const TOKEN = "test-auth-token";
const STATUS_URL = "https://securevoice.example.com/api/twilio/status";

/** The callback the way Twilio sends it: form-encoded, HMAC-SHA1 over url+sorted params. */
function signedCallback(params: Record<string, string>): NextRequest {
  const url = STATUS_URL;
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const signature = createHmac("sha1", TOKEN).update(data).digest("base64");
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params).toString(),
  });
}

/** Ringing samples recorded for one case, so the count is the assertion, not a flag. */
function samplesFor(caseRef: string) {
  return recentSpans(500).filter(
    (s) => s.span === "signal_received_to_ringing" && s.caseRef === caseRef,
  );
}

let seq = 0;

async function dialledCase(opts: {
  knownStart: boolean;
}): Promise<{ id: string; caseRef: string; sid: string }> {
  seq += 1;
  const caseRef = `SR-${RUN}-${seq}`;
  const created = await createCase({
    caseRef,
    orgId: `org-${RUN}`,
    // Unique per case: `Case` carries `@@unique([orgId, transactionRef])`, so reusing a
    // reference makes the second case in a run a duplicate-refusal instead of a fixture.
    transactionRef: `TX-${RUN}-${seq}`,
    riskScore: 0.94,
    language: "en",
    phone: "+971501234567",
    amountMinor: 250_000,
    currency: "AED",
    consentRecordId: `consent-${RUN}`,
    signalReceivedAt: opts.knownStart ? new Date(Date.now() - 2_500) : null,
  });
  const sid = `CA${RUN}${seq}`;
  // The worker writes the call-leg sid when it dials (`src/worker/dial.ts`); this is the
  // same write, because the join the span performs is by sid.
  await db.case.update({ where: { id: created.id }, data: { callSid: sid } });
  return { id: created.id, caseRef, sid };
}

describe("signal_received_to_ringing — the producer", () => {
  beforeAll(() => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    // Twilio signs `<base><path>`, and the route rebuilds that URL from this setting —
    // sign against anything else and every callback below is a 403 for the wrong reason.
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://securevoice.example.com";
    // The ring is process-global; this suite asserts counts, so it starts from zero.
    resetSpans();
  });

  test("the intake instant reaches the row, which is the half that never existed", async () => {
    const { id } = await dialledCase({ knownStart: true });
    const row = await db.case.findUniqueOrThrow({
      where: { id },
      select: { signalReceivedAt: true, createdAt: true },
    });
    expect(row.signalReceivedAt).toBeInstanceOf(Date);
    // And it is EARLIER than the row's own creation: `createdAt` is written inside
    // `createCase`, after the policy, compliance and credit gates, which is the
    // distinction the whole fix turns on. A start that equals `createdAt` would mean
    // the column was filled in at insert time and measures nothing new.
    expect(row.signalReceivedAt!.getTime()).toBeLessThan(row.createdAt.getTime());
  });

  test("a `queued` callback records nothing — queued is not ringing", async () => {
    const { id, sid, caseRef } = await dialledCase({ knownStart: true });
    const res = await (
      await import("@/app/api/twilio/status/route")
    ).POST(signedCallback({ CallSid: sid, CallStatus: "queued" }));
    expect(res.status).toBe(200);
    const row = await db.case.findUniqueOrThrow({ where: { id }, select: { ringingAt: true } });
    expect(row.ringingAt).toBeNull();
    expect(samplesFor(caseRef)).toHaveLength(0);
  });

  test("a `ringing` callback stamps the row and produces the sample", async () => {
    const { id, sid, caseRef } = await dialledCase({ knownStart: true });
    const res = await (
      await import("@/app/api/twilio/status/route")
    ).POST(signedCallback({ CallSid: sid, CallStatus: "ringing" }));
    expect(res.status).toBe(200);

    const row = await db.case.findUniqueOrThrow({
      where: { id },
      select: { ringingAt: true, signalReceivedAt: true },
    });
    expect(row.ringingAt).toBeInstanceOf(Date);

    const got = samplesFor(caseRef);
    expect(got).toHaveLength(1);
    // Duration is the join itself: 2.5 s of simulated queueing plus the callback's
    // arrival. It must be positive and plausible, never 0 — a 0 ms ringing latency
    // would mean one end was defaulted, which is the shape of a fabricated metric.
    expect(got[0]!.durationMs).toBeGreaterThanOrEqual(2_400);
    expect(got[0]!.durationMs).toBeLessThan(60_000);
    // The origin is the honesty of the whole exercise: a sample made by CI is a harness
    // sample. If this ever reads `live`, the SLO file would start publishing CI
    // contention as production latency — the exact mistake the split populations
    // (`spans.ts` origin tagging) were introduced to prevent.
    expect(got[0]!.origin).toBe("harness");
  });

  test("Twilio's retry cannot double-count the same call", async () => {
    const { sid, caseRef } = await dialledCase({ knownStart: true });
    const post = async () =>
      (await import("@/app/api/twilio/status/route")).POST(
        signedCallback({ CallSid: sid, CallStatus: "ringing" }),
      );

    const first = await post();
    const second = await post();
    expect([first.status, second.status]).toEqual([200, 200]);
    // Two callbacks, one sample: the denominator stays "calls", not "webhooks".
    expect(samplesFor(caseRef)).toHaveLength(1);
  });

  test("a case with no known start is refused, and stays null", async () => {
    const { id, sid, caseRef } = await dialledCase({ knownStart: false });
    const res = await (
      await import("@/app/api/twilio/status/route")
    ).POST(signedCallback({ CallSid: sid, CallStatus: "ringing" }));
    expect(res.status).toBe(200); // telemetry never fails a real delivery callback
    const row = await db.case.findUniqueOrThrow({ where: { id }, select: { ringingAt: true } });
    expect(row.ringingAt).toBeNull();
    expect(samplesFor(caseRef)).toHaveLength(0);
  });

  test("an unrelated sid does not become somebody else's sample", async () => {
    const before = recentSpans(500).filter((s) => s.span === "signal_received_to_ringing").length;
    const res = await (
      await import("@/app/api/twilio/status/route")
    ).POST(signedCallback({ CallSid: `CAnever${RUN}`, CallStatus: "ringing" }));
    expect(res.status).toBe(200);
    expect(recentSpans(500).filter((s) => s.span === "signal_received_to_ringing").length).toBe(
      before,
    );
  });
});
