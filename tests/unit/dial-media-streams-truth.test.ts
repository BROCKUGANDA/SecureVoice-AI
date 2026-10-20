/**
 * DIAL TRUTHFULNESS — the media-streams branch must not report a refused call.
 *
 * `placeOutboundCall` (ElevenLabs ConvAI) throws on failure, so the worker's
 * catch block sees a refused dial. `placeInterventionCall` (Twilio) RETURNS
 * `{ ok: false, status, error }` instead. When the Twilio plane was added to
 * `handle()` it ignored that flag and built a synthetic success object — so a
 * call the carrier never accepted moved the case to DIALING, wrote a `queued`
 * telecom outbox row, and audited `dial_placed`. The bank was told the customer
 * was phoned. Nobody phoned anyone.
 *
 * These are the mutation proofs for exactly that: flip the refusal handling off
 * and cases A and B fail; flip the outbox de-duplication off and C fails.
 *
 * Case D covers the quieter half of the same bug: `callSid` is the carrier's
 * call-leg id, which `warm_transfer` rewrites later. It was being filled with
 * the case reference, so the hand-off would have addressed a leg that does not
 * exist.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realCaseState from "@/lib/case-state-machine";
import * as realFlags from "@/lib/flags";

type CallResult =
  | { ok: true; sid: string; status: string; from?: string }
  | {
      ok: false;
      status: number;
      error: string;
    };

const twilio: { next: CallResult; calls: Record<string, unknown>[] } = {
  next: { ok: true, sid: "AC22222222222222222222222222222222", status: "queued" },
  calls: [],
};
const convai: { calls: unknown[]; next: unknown; throwWith: string | null } = {
  calls: [],
  next: {
    conversationId: "conv-1",
    callSid: "cli-1",
    dryRun: false,
    phoneNumberId: "ph-1",
  },
  throwWith: null,
};
const transitions: { caseRef: string; data: Record<string, unknown> }[] = [];
const outboxRows: Record<string, unknown>[] = [];
const audits: { intent: string; meta?: Record<string, unknown> }[] = [];
let mediaStreamsOn = true;

mock.module("@/lib/twilio", () => ({
  placeInterventionCall: async (args: Record<string, unknown>) => {
    twilio.calls.push(args);
    return twilio.next;
  },
  sendInterventionSms: async () => ({ ok: true, sid: "SM1" }),
  isE164: (v: unknown) => typeof v === "string" && /^\+\d{6,}$/.test(v),
  isTwilioConfigured: () => true,
  twilioConfigured: () => true,
  liveSendAttested: () => true,
  interventionTwiml: () => "<Response/>",
}));

mock.module("@/lib/elevenlabs/outbound-call", () => ({
  placeOutboundCall: async (args: Record<string, unknown>) => {
    convai.calls.push(args);
    if (convai.throwWith) throw new Error(convai.throwWith);
    return convai.next;
  },
}));

mock.module("@/lib/flags", () => ({
  // Spread the real module and override the one function this file cares about.
  // `mock.module` REPLACES the whole module, and the worker's import graph grows:
  // when `maybeSweep` gained the escalation ladder it pulled in
  // `@/lib/notifications` → `@/lib/realtime`, which reads `realtimeConfigured` from
  // here — and a mock listing one export turned that into a SyntaxError at import
  // time, failing the file before a single assertion ran. Listing what the graph
  // needs today is the fragile version of this; forwarding the real surface is not.
  ...realFlags,
  flag: (name: string) => (name === "twilioMediaStreams" ? mediaStreamsOn : false),
}));

mock.module("@/lib/db", () => ({
  db: {
    case: {
      findFirst: async () => ({
        id: "case-1",
        conversationId: null,
        state: "SCREENED",
        phone: "+256700123456",
        signalKind: "card_transaction",
        callCategory: "time_critical_fraud",
      }),
    },
    doNotCall: { findUnique: async () => null },
    // The pilot kill switch's DATABASE half. It is read before every dial, and
    // a read that FAILS is treated as ENGAGED — the conservative direction for
    // a control whose purpose is "stop contacting customers". Without this
    // mock the read throws, the switch reads as engaged, and every dial in
    // this file is blocked by the pilot before it ever reaches the carrier.
    platformSwitch: { findUnique: async () => null },
  },
}));

mock.module("@/lib/institution", () => ({
  getInstitutionContext: async () => ({ type: "bank", name: "Stanbic Bank" }),
  getTelecomIdentity: async () => ({
    voiceNumber: null,
    smsSenderId: null,
    messagingServiceSid: null,
    elevenPhoneNumberId: "ph-1",
  }),
}));

mock.module("@/lib/case-state-machine", () => ({
  // Same reason as the `@/lib/flags` mock above: the worker's graph now reaches this
  // module through `src/lib/freeze-window.ts` as well, and that path imports
  // `IllegalTransitionError`. A single-export mock turns a new import edge into a
  // SyntaxError before any assertion runs, so the real surface is forwarded and only
  // the recorder is replaced.
  ...realCaseState,
  transitionCase: async (caseRef: string, _to: string, data: Record<string, unknown>) => {
    transitions.push({ caseRef, data });
    return { caseRef, ...data };
  },
}));

mock.module("@/lib/telecom-outbox", () => ({
  recordTelecomEvent: async (args: Record<string, unknown>) => {
    outboxRows.push(args);
    return "te-1";
  },
}));

mock.module("@/lib/audit-chain", () => ({
  append: async (args: { intent: string; meta?: Record<string, unknown> }) => {
    audits.push({ intent: args.intent, meta: args.meta });
    return "hash";
  },
}));

mock.module("@/lib/sms-verdict", () => ({ sweepExpiredSmsCases: async () => 0 }));
mock.module("@/lib/elevenlabs/sms-fallback", () => ({ markVoiceFailed: async () => {} }));

/** Did the worker clear the in-flight marker on its last attempt? */
let clearedInFlight = false;
mock.module("@/lib/scale/queue", () => ({
  drainDialQueue: async () => [],
  markDialStarted: async () => true,
  clearDialInFlight: async () => {
    clearedInFlight = true;
    return true;
  },
  renewClaim: async () => true,
  DIAL_IN_FLIGHT: "dial_in_flight",
}));

const { handle, mediaStreamHost, _resetDialTelephonyBreakerForTest } =
  await import("@/worker/dial");

// The media-stream host is configuration, not a fact the process can invent:
// these tests set it explicitly and put the environment back afterwards so a
// real SITE_ADDRESS in the running shell cannot make them pass or fail.
const ORIGINAL_SITE_ADDRESS = process.env.SITE_ADDRESS;
const PUBLIC_HOST = "voice.example.com";

const JOB = {
  id: "job-1",
  case_id: "case-1",
  case_ref: "SV-C-8F3K2",
  org_id: "org-1",
  attempt_no: 1,
  retries: 0,
  state: "CLAIMED" as const,
  priority: 1,
  payload: JSON.stringify({ language: "ar-AE", amount: 2500, merchant: "Dubai Electronics" }),
  available_at: new Date(),
  lease_expires_at: null,
  claimed_by: null,
  last_error: null,
  completed_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  twilio.calls.length = 0;
  convai.calls.length = 0;
  transitions.length = 0;
  outboxRows.length = 0;
  audits.length = 0;
  clearedInFlight = false;
  // The telephony breaker is a PROCESS-WIDE singleton, and this file drives
  // several carrier failures through it on purpose. Its threshold is five, so
  // without a reset the breaker opens part-way through the file and every
  // later test is answered with "circuit breaker open" — which is a correct
  // refusal of the wrong thing, and reads as a broken suite.
  _resetDialTelephonyBreakerForTest();
  mediaStreamsOn = true;
  convai.throwWith = null;
  process.env.SITE_ADDRESS = PUBLIC_HOST;
  twilio.next = { ok: true, sid: "AC22222222222222222222222222222222", status: "queued" };
});

afterEach(() => {
  if (ORIGINAL_SITE_ADDRESS === undefined) delete process.env.SITE_ADDRESS;
  else process.env.SITE_ADDRESS = ORIGINAL_SITE_ADDRESS;
});

describe("dial worker — the attempt ladder, and the one call it must not repeat", () => {
  // A job with a CLAIMANT is the production shape: the worker owns the row,
  // so the in-flight marker is written before the carrier call and the
  // question "was the call placed?" is a real one.
  const CLAIMED_JOB = { ...JOB, claimed_by: "worker-1" };

  it("a carrier that REFUSED the call is retried — nothing was placed", async () => {
    // A 429 is an ANSWER: the carrier said "not now". Nothing was placed, the
    // customer's phone did not ring, and the attempt ladder is exactly the
    // mechanism for trying again.
    twilio.next = { ok: false, status: 429, error: "Too Many Requests" };

    const outcome = await handle(CLAIMED_JOB);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.retryable, "a refusal must climb the ladder").toBe(true);
    }
    // And the in-flight marker is CLEARED, because a preserved marker would
    // make the next attempt look like an unknown outcome — which is how a
    // refused call used to dead-letter after one attempt.
    expect(clearedInFlight).toBe(true);
  });

  it("a carrier that did NOT answer is not retried — the call may be ringing", async () => {
    // A 500 is the absence of an answer. The request may have been accepted
    // and the response lost, so the customer's phone may already be ringing.
    // Dialling again would ring a customer twice.
    twilio.next = { ok: false, status: 500, error: "internal error" };

    const outcome = await handle(CLAIMED_JOB);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.retryable, "an unknown outcome must not be retried").toBe(false);
    }
    // The marker is NOT cleared: the call may have been placed.
    expect(clearedInFlight).toBe(false);
  });

  it("a network failure is not retried either — it is the absence of an answer", async () => {
    twilio.next = { ok: false, status: 503, error: "network error" };

    const outcome = await handle(CLAIMED_JOB);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.retryable).toBe(false);
    expect(clearedInFlight).toBe(false);
  });

  it("a failure BEFORE the carrier was handed the job is retried as it always was", async () => {
    // Nothing was placed, so the ordinary ladder applies and there is no
    // marker to clear.
    twilio.next = { ok: false, status: 500, error: "internal error" };

    const outcome = await handle(JOB); // the fixture has no claimant

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.retryable).toBe(true);
    expect(clearedInFlight).toBe(false);
  });
});

describe("dial worker — Twilio media-streams plane", () => {
  it("refuses the job when the carrier refuses the call", async () => {
    twilio.next = { ok: false, status: 403, error: "live send not attested" };

    const outcome = await handle(JOB);

    expect(outcome.ok).toBe(false);
    expect(transitions).toHaveLength(0); // never moved to DIALING
    expect(outboxRows).toHaveLength(0); // never promised a delivery
    expect(audits.some((a) => a.intent === "dial_placed")).toBe(false);
    expect(audits.some((a) => a.intent === "dial_failed")).toBe(true);
  });

  it("names the refusal in the error the queue will retry on", async () => {
    twilio.next = { ok: false, status: 400, error: "The 'From' number is not valid" };

    const outcome = await handle(JOB);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("twilio dial refused");
    if (!outcome.ok) expect(outcome.error).toContain("400");
  });

  it("records the carrier's call-leg sid, not the case reference", async () => {
    const outcome = await handle(JOB);

    expect(outcome.ok).toBe(true);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.data.callSid).toBe("AC22222222222222222222222222222222");
    // The app-side conversation key stays the case ref the socket is opened with.
    expect(transitions[0]?.data.conversationId).toBe("SV-C-8F3K2");
  });

  it("does not write a second outbox row for a call placeInterventionCall already recorded", async () => {
    await handle(JOB);

    expect(outboxRows).toHaveLength(0);
    expect(twilio.calls).toHaveLength(1);
  });

  it("dials Arabic when the bank sends a Gulf dialect tag", async () => {
    await handle(JOB);

    expect(twilio.calls[0]).toMatchObject({ lang: "ar" });
  });

  it("passes the media-stream socket url to the carrier", async () => {
    await handle(JOB);

    const url = String((twilio.calls[0] as { mediaStreamUrl?: string }).mediaStreamUrl ?? "");
    expect(url).toContain("wss://");
    // Worker plane is a /realtime sibling, not under /api (which the app owns).
    expect(url).toContain("/realtime/media-stream");
    expect(url).toContain("callSid=SV-C-8F3K2");
    // The HOST is the configured public one. Asserting only `wss://` + path is
    // what let a `?? "localhost"` fallback ship: every one of those assertions
    // passes for a URL the carrier can never reach.
    expect(new URL(url).hostname).toBe(PUBLIC_HOST);
  });

  it("refuses to dial when the media-stream host is missing or loopback", async () => {
    for (const bad of [undefined, "", "localhost", "127.0.0.1", "0.0.0.0", "[::1]", "box.local"]) {
      if (bad === undefined) delete process.env.SITE_ADDRESS;
      else process.env.SITE_ADDRESS = bad;

      const outcome = await handle(JOB);

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("SITE_ADDRESS");
      expect(twilio.calls).toHaveLength(0); // no call placed
      expect(transitions).toHaveLength(0); // never moved to DIALING
      expect(audits.some((a) => a.intent === "dial_failed")).toBe(true);
      audits.length = 0;
    }
  });
});

describe("dial worker — the media-stream host is configuration, not a guess", () => {
  it("returns the configured host and refuses every value a carrier cannot resolve", () => {
    expect(mediaStreamHost({ SITE_ADDRESS: "securevoiceai.me", NODE_ENV: "test" })).toBe(
      "securevoiceai.me",
    );
    // A bare public IP is a real deployment (a VPS with no domain yet), the same
    // allowance `config.twilioWebhookBaseUrl` documents.
    expect(mediaStreamHost({ SITE_ADDRESS: "57.130.80.158", NODE_ENV: "test" })).toBe(
      "57.130.80.158",
    );

    for (const bad of [
      undefined,
      "",
      "   ",
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.8.9.10",
      "0.0.0.0",
      "::1",
      "[::1]",
      "printer.local",
    ]) {
      expect(() => mediaStreamHost({ SITE_ADDRESS: bad, NODE_ENV: "test" })).toThrow(
        /SITE_ADDRESS/,
      );
    }
  });
});

describe("dial worker — ElevenLabs ConvAI plane is unchanged", () => {
  it("still writes exactly one outbox row and keeps the conversation id", async () => {
    mediaStreamsOn = false;

    const outcome = await handle(JOB);

    expect(outcome.ok).toBe(true);
    expect(twilio.calls).toHaveLength(0);
    expect(convai.calls).toHaveLength(1);
    expect(transitions[0]?.data.conversationId).toBe("conv-1");
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ channel: "voice", status: "queued" });
  });

  it("fails the job when ConvAI throws", async () => {
    mediaStreamsOn = false;
    convai.throwWith = "No voice configured for language xx";

    const outcome = await handle(JOB);

    expect(outcome.ok).toBe(false);
    expect(transitions).toHaveLength(0);
    expect(audits.some((a) => a.intent === "dial_failed")).toBe(true);
  });
});
