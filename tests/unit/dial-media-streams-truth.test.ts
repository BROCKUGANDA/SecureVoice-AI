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
import { beforeEach, describe, expect, it, mock } from "bun:test";

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
mock.module("@/lib/scale/queue", () => ({ drainDialQueue: async () => [] }));

const { handle } = await import("@/worker/dial");

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
};

beforeEach(() => {
  twilio.calls.length = 0;
  convai.calls.length = 0;
  transitions.length = 0;
  outboxRows.length = 0;
  audits.length = 0;
  mediaStreamsOn = true;
  convai.throwWith = null;
  twilio.next = { ok: true, sid: "AC22222222222222222222222222222222", status: "queued" };
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
    expect(transitions[0].data.callSid).toBe("AC22222222222222222222222222222222");
    // The app-side conversation key stays the case ref the socket is opened with.
    expect(transitions[0].data.conversationId).toBe("SV-C-8F3K2");
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
    expect(url).toContain("/api/voice-websocket");
    expect(url).toContain("callSid=SV-C-8F3K2");
  });
});

describe("dial worker — ElevenLabs ConvAI plane is unchanged", () => {
  it("still writes exactly one outbox row and keeps the conversation id", async () => {
    mediaStreamsOn = false;

    const outcome = await handle(JOB);

    expect(outcome.ok).toBe(true);
    expect(twilio.calls).toHaveLength(0);
    expect(convai.calls).toHaveLength(1);
    expect(transitions[0].data.conversationId).toBe("conv-1");
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
