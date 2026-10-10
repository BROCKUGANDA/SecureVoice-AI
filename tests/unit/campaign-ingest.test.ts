/**
 * Batch campaign ingest — the property under test is the SUMMARY and the reuse
 * of the dial queue, not the dial worker's enforcement (that has its own
 * suites). DNC, calling-window defer, invalid-phone refusal and a producer-key
 * failure are the campaign's own decisions, so the DB + queue + producer-key
 * surfaces are stubbed.
 *
 * The queue capture records the PAYLOAD, not just the caseRef: "accepted" must
 * mean "queued, with the right phone and the right language", and a summary
 * count alone cannot tell those apart — which is how the language-in-payload
 * and the SCREENED-transition defects survived review.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

const enqueued: Array<{
  caseRef: string;
  orgId: string | null;
  payload?: Record<string, unknown>;
}> = [];
const createdCases: Array<{
  caseRef: string;
  phone?: string;
  callCategory?: string;
  language?: string;
}> = [];
const transitions: Array<{ caseRef: string; to: string }> = [];

// All-lightweight wholesale mocks (no importOriginal, which would load the real
// DB/Prisma and time out a "unit" test). Each provides the named exports the
// import graph binds.
mock.module("@/lib/producer-keys", () => ({
  verifyProducerKey: async (bearer: string | null) =>
    bearer === "svb_good"
      ? { ok: true, callerId: "p1", orgId: "org-camp" }
      : { ok: false, status: 401, error: "bad key" },
}));
mock.module("@/lib/twilio", () => ({
  isE164: (input: string) => /^\+[1-9]\d{7,14}$/.test(input),
}));
mock.module("@/lib/abuse/velocity", () => ({
  isAfterHours: () => false,
}));
mock.module("@/lib/db", () => ({
  db: {
    doNotCall: {
      findUnique: async (args: { where: { phone: string } }) =>
        args.where.phone === "+971500000903" ? { phone: args.where.phone, reason: "stop" } : null,
    },
  },
  dbAudit: {
    append: async () => ({}),
    verify: async () => true,
    verifyFromGenesis: async () => true,
  },
}));
mock.module("@/lib/case-state-machine", () => ({
  createCase: async (data: {
    caseRef: string;
    phone?: string;
    callCategory?: string;
    language?: string;
  }) => {
    createdCases.push(data);
    return { id: `case_${data.caseRef}`, caseRef: data.caseRef, state: "RECEIVED" };
  },
  transitionCase: async (caseRef: string, to: string) => {
    transitions.push({ caseRef, to });
    return { state: to };
  },
  IllegalTransitionError: class extends Error {},
}));
mock.module("@/lib/scale/queue", () => ({
  enqueueDialJob: async (input: {
    caseRef: string;
    orgId?: string | null;
    payload?: Record<string, unknown>;
  }) => {
    enqueued.push({ caseRef: input.caseRef, orgId: input.orgId ?? null, payload: input.payload });
    return { id: `job_${input.caseRef}`, created: true, state: "PENDING" };
  },
}));

const { POST } = await import("@/app/api/v1/campaigns/route");

const post = (body: unknown, auth = "Bearer svb_good") =>
  POST(
    new Request("https://app.test/api/v1/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  enqueued.length = 0;
  createdCases.length = 0;
  transitions.length = 0;
});

describe("POST /api/v1/campaigns", () => {
  test("accepts a clean recipient and enqueues one dial job through the shared queue", async () => {
    const res = await post({
      lang: "ar",
      callCategory: "fact_finding",
      recipients: [{ phone: "+971500000901" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; accepted: number };
    expect(body.accepted).toBe(1);
    expect(createdCases[0]?.phone).toBe("+971500000901");
    expect(enqueued[0]?.orgId).toBe("org-camp");
  });

  test("skips do-not-call numbers without enqueuing, refuses malformed phones", async () => {
    const res = await post({
      callCategory: "fact_finding",
      recipients: [
        { phone: "+971500000901" }, // accepted
        { phone: "+971500000903" }, // do-not-call
        { phone: "not-a-phone" }, // invalid
      ],
    });
    const body = (await res.json()) as {
      accepted: number;
      skipped_do_not_call: number;
      invalid_phone: number;
    };
    expect(body.accepted).toBe(1);
    expect(body.skipped_do_not_call).toBe(1);
    expect(body.invalid_phone).toBe(1);
    // Only the clean recipient was enqueued — and it is the CLEAN one. The
    // count alone cannot distinguish "queued the accepted" from "queued the
    // do-not-call one by mistake"; the phone can.
    expect(enqueued).toHaveLength(1);
    expect(enqueued.map((j) => j.payload?.phone)).toEqual(["+971500000901"]);
  });

  test("time_critical_fraud is NOT do-not-call gated at enqueue (matches the worker)", async () => {
    const res = await post({
      callCategory: "time_critical_fraud",
      recipients: [{ phone: "+971500000903" }], // on the registry, but exempt
    });
    const body = (await res.json()) as { accepted: number; skipped_do_not_call: number };
    expect(body.accepted).toBe(1);
    expect(body.skipped_do_not_call).toBe(0);
    // "Accepted" must mean queued: the count above passes even if the route
    // reported a recipient it never enqueued, which is a number that will
    // never be dialed.
    expect(enqueued).toHaveLength(1);
    expect(enqueued.map((j) => j.payload?.phone)).toEqual(["+971500000903"]);
  });

  test("the case reaches SCREENED before its dial job is enqueued", async () => {
    // The worker may only move SCREENED → DIALING; a case left in RECEIVED
    // makes every claim an illegal transition, and the retry dials the
    // recipient again.
    const res = await post({ recipients: [{ phone: "+971500000901" }] });
    expect(res.status).toBe(200);
    expect(transitions).toEqual([{ caseRef: createdCases[0]!.caseRef, to: "SCREENED" }]);
  });

  test("the requested language rides on the dial job and the case", async () => {
    // The worker resolves ASR, voice and every spoken line from the payload's
    // language; an absent one is an English call whatever the case row says.
    const res = await post({ lang: "ur", recipients: [{ phone: "+971500000901" }] });
    expect(res.status).toBe(200);
    expect(createdCases[0]?.language).toBe("ur");
    expect(enqueued[0]?.payload?.language).toBe("ur");
  });

  test("an unsupported language is refused at the boundary, not stored", async () => {
    const res = await post({ lang: "de", recipients: [{ phone: "+971500000901" }] });
    expect(res.status).toBe(422);
    expect(createdCases).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  test("a bad producer key is refused before any enqueue", async () => {
    const res = await post({ recipients: [{ phone: "+971500000901" }] }, "Bearer svb_bad");
    expect(res.status).toBe(401);
    expect(enqueued).toHaveLength(0);
  });

  test("an empty recipient list is a 422, not a silent no-op", async () => {
    const res = await post({ recipients: [] });
    expect(res.status).toBe(422);
  });
});
