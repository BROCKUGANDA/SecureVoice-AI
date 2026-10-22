import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * The STR export is a compliance artifact: only a CONFIRMED_FRAUD case may
 * become one, the FIU request must be signed over the exact bytes it carries,
 * and a missing signing secret must produce a stated non-delivery rather than
 * a forgeable request.
 */

let base: Record<string, unknown> = {};
let optionsSeen: unknown = null;
const fetches: Array<{ url: string; init: RequestInit }> = [];

mock.module("@/lib/regulatory-export", () => ({
  generateCaseFile: async (_id: string, _org: string | null, opts: unknown) => {
    optionsSeen = opts;
    return base;
  },
  CaseNotConfirmedError: class CaseNotConfirmedError extends Error {},
}));

mock.module("@/lib/audit-chain", () => ({
  append: async () => ({ id: "audit-1", chainHash: "hash-1" }),
}));

const { generateSTREvidence, signStrBody } = await import("@/lib/compliance/fatf-export");

const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

function saveEnv() {
  for (const key of [
    "BANK_FIU_WEBHOOK_URL",
    "FIU_ENDPOINT",
    "BANK_FIU_WEBHOOK_SECRET",
    "BANK_WEBHOOK_SECRET",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  fetches.length = 0;
  optionsSeen = null;
  base = {
    case_id: "CASE-1",
    intervention_id: "case-1",
    case_state: "CONFIRMED_FRAUD",
    ai_transcript: "redacted",
  };
  saveEnv();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetches.push({ url: String(input), init: init ?? {} });
    return new Response("", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreEnv();
});

describe("STR export", () => {
  test("requires a confirmed-fraud case and skips the generic compliance webhook", async () => {
    await generateSTREvidence("case-1", "org-1");
    expect(optionsSeen).toEqual({
      requireConfirmedFraud: true,
      skipComplianceWebhook: true,
    });
  });

  test("no FIU endpoint is a stated non-delivery, not a silent success", async () => {
    const pkg = await generateSTREvidence("case-1");
    expect(pkg.fiu_delivery).toEqual({
      attempted: false,
      reason: "endpoint_not_configured",
    });
    expect(fetches).toHaveLength(0);
  });

  test("an endpoint without a signing secret is refused rather than sent with an empty key", async () => {
    process.env.BANK_FIU_WEBHOOK_URL = "https://fiu.example.test/str";
    const pkg = await generateSTREvidence("case-1");
    expect(pkg.fiu_delivery).toEqual({
      attempted: false,
      reason: "secret_not_configured",
    });
    expect(fetches).toHaveLength(0);
  });

  test("the signature covers the timestamp and the exact body sent", async () => {
    process.env.BANK_FIU_WEBHOOK_URL = "https://fiu.example.test/str";
    process.env.BANK_FIU_WEBHOOK_SECRET = "fiu-secret";
    const pkg = await generateSTREvidence("case-1");

    expect(fetches).toHaveLength(1);
    const { init } = fetches[0]!;
    const body = String(init.body);
    const headers = init.headers as Record<string, string>;
    const timestamp = headers["X-STR-Timestamp"]!;
    expect(timestamp).toMatch(/^\d+$/);
    expect(headers["X-STR-Signature"]).toBe(
      `t=${timestamp},v1=${signStrBody(body, "fiu-secret", timestamp)}`,
    );
    expect(JSON.parse(body).report_type).toBe("FATF_RECOMMENDATION_20_STR");
    expect(pkg.fiu_delivery).toEqual({ attempted: true, ok: true, status: 200 });
  });

  test("a failed FIU response is reported, not upgraded to success", async () => {
    process.env.BANK_FIU_WEBHOOK_URL = "https://fiu.example.test/str";
    process.env.BANK_FIU_WEBHOOK_SECRET = "fiu-secret";
    globalThis.fetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;

    const pkg = await generateSTREvidence("case-1");
    expect(pkg.fiu_delivery).toEqual({ attempted: true, ok: false, status: 503 });
  });

  test("the timestamped digest rejects a replay with a different timestamp", () => {
    const first = signStrBody('{"a":1}', "secret", "1000");
    const same = signStrBody('{"a":1}', "secret", "1000");
    const later = signStrBody('{"a":1}', "secret", "1001");
    expect(first).toBe(same);
    expect(later).not.toBe(first);
  });
});
