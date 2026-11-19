/**
 * Qwen3Guard provider + orchestrator behaviour, against a STUBBED gateway.
 *
 * The security property under test: a non-model outcome is NEVER reported as
 * safe. Every branch the platform can hit — flag off, kill switch, gateway
 * outage, malformed output — produces its own `source`, and
 * `outcomeIsClean()` is true for exactly one of them.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  moderateContent,
  outcomeIsClean,
  clearModerationCacheForTests,
} from "@/lib/qwen3guard/moderate";
import {
  classify,
  ModerationTransportError,
  resetModerationBreakerForTests,
  moderationBreakerState,
  warmUpModerator,
} from "@/lib/qwen3guard/client";

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) =>
    handler(String(url), init)) as typeof fetch;
}

function gatewayBody(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      model: "Qwen3Guard-Gen-8B",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function setFlag(on: boolean) {
  process.env.FEATURE_QWEN3GUARD = on ? "true" : "false";
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.FEATURE_QWEN3GUARD;
  delete process.env.MODERATION_KILL_SWITCH;
  resetModerationBreakerForTests();
  clearModerationCacheForTests();
});

describe("moderateContent orchestration", () => {
  test("flag off: source=flag_off, verdict never safe", async () => {
    await setFlag(false);
    let calls = 0;
    stubFetch(() => {
      calls++;
      return gatewayBody("Safety: Safe\nCategories: None");
    });
    const out = await moderateContent({ stage: "input", text: "hello" });
    expect(calls).toBe(0);
    expect(out.source).toBe("flag_off");
    expect(outcomeIsClean(out)).toBe(false);
  });

  test("env kill switch: source=kill_switch, no gateway call", async () => {
    await setFlag(true);
    process.env.MODERATION_KILL_SWITCH = "true";
    let calls = 0;
    stubFetch(() => {
      calls++;
      return gatewayBody("Safety: Safe\nCategories: None");
    });
    const out = await moderateContent({ stage: "input", text: "hello" });
    expect(calls).toBe(0);
    expect(out.source).toBe("kill_switch");
    expect(outcomeIsClean(out)).toBe(false);
  });

  test("a real model Safe is the only clean outcome", async () => {
    await setFlag(true);
    stubFetch(() => gatewayBody("Safety: Safe\nCategories: None"));
    const out = await moderateContent({ stage: "input", text: "what time do you open?" });
    expect(out.source).toBe("model");
    expect(out.verdict).toBe("safe");
    expect(outcomeIsClean(out)).toBe(true);
  });

  test("an unsafe verdict is recorded with categories and is not clean", async () => {
    await setFlag(true);
    stubFetch(() => gatewayBody("Safety: Unsafe\nCategories: Violent"));
    const out = await moderateContent({ stage: "input", text: "how do I make a bomb" });
    expect(out.source).toBe("model");
    expect(out.verdict).toBe("unsafe");
    expect(out.categories).toEqual(["Violent"]);
    expect(outcomeIsClean(out)).toBe(false);
  });

  test("malformed gateway output: source=invalid, never safe", async () => {
    await setFlag(true);
    stubFetch(() => gatewayBody("Looks fine to me!"));
    const out = await moderateContent({ stage: "output", text: "a draft reply" });
    expect(out.source).toBe("invalid");
    expect(out.verdict).toBe("invalid");
    expect(outcomeIsClean(out)).toBe(false);
  });

  test("gateway outage: source=degraded, never safe", async () => {
    await setFlag(true);
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const out = await moderateContent({ stage: "speech", text: "a sentence to speak" });
    expect(out.source).toBe("degraded");
    expect(out.verdict).toBe("invalid");
    expect(outcomeIsClean(out)).toBe(false);
    expect(out.reason).toContain("ECONNREFUSED");
  });

  test("empty content is recorded, not classified", async () => {
    await setFlag(true);
    let calls = 0;
    stubFetch(() => {
      calls++;
      return gatewayBody("Safety: Safe\nCategories: None");
    });
    const out = await moderateContent({ stage: "ingest", text: "   " });
    expect(calls).toBe(0);
    expect(out.source).toBe("invalid");
  });

  test("identical content hits the cache: one gateway call for two moderations", async () => {
    await setFlag(true);
    let calls = 0;
    stubFetch(() => {
      calls++;
      return gatewayBody("Safety: Safe\nCategories: None");
    });
    const a = await moderateContent({ stage: "input", text: "cache me please" });
    const b = await moderateContent({ stage: "input", text: "cache me please" });
    expect(calls).toBe(1);
    expect(b.verdict).toBe("safe");
    expect(b.inputHash).toBe(a.inputHash);
  });

  test("a different stage does NOT hit the same cache entry", async () => {
    await setFlag(true);
    let calls = 0;
    stubFetch(() => {
      calls++;
      return gatewayBody("Safety: Safe\nCategories: None");
    });
    await moderateContent({ stage: "input", text: "same text two stages" });
    await moderateContent({ stage: "tool", text: "same text two stages" });
    expect(calls).toBe(2);
  });

  test("persist=await returns the evidence row id", async () => {
    await setFlag(true);
    stubFetch(() => gatewayBody("Safety: Safe\nCategories: None"));
    const out = await moderateContent({
      stage: "input",
      text: `persist-await-${Date.now()}`,
      persist: "await",
    });
    expect(typeof out.id).toBe("string");
    expect(out.id!.length).toBeGreaterThan(10);
  });
});

describe("moderation client transport discipline", () => {
  test("429 is retried and then succeeds (Retry-After honoured, bounded)", async () => {
    await setFlag(true);
    let attempts = 0;
    stubFetch(() => {
      attempts++;
      if (attempts === 1) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return gatewayBody("Safety: Safe\nCategories: None");
    });
    const result = await classify([{ role: "user", content: "hi" }]);
    expect(attempts).toBe(2);
    expect(result.text).toContain("Safety: Safe");
  });

  test("401 is NOT retried — a config error is not a retry storm", async () => {
    await setFlag(true);
    let attempts = 0;
    stubFetch(() => {
      attempts++;
      return new Response("unauthorized", { status: 401 });
    });
    await expect(classify([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
      ModerationTransportError,
    );
    expect(attempts).toBe(1);
  });

  test("a 200 with no content is malformed, not safe, and not retried", async () => {
    await setFlag(true);
    let attempts = 0;
    stubFetch(() => {
      attempts++;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant" } }] }), {
        status: 200,
      });
    });
    await expect(classify([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
      ModerationTransportError,
    );
    expect(attempts).toBe(1);
  });

  test("sustained failure opens the breaker, which then refuses instantly", async () => {
    await setFlag(true);
    let attempts = 0;
    stubFetch(() => {
      attempts++;
      throw new Error("gateway down");
    });
    // failureThreshold = 5: five consecutive transport failures open it.
    for (let i = 0; i < 5; i++) {
      await expect(classify([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
        ModerationTransportError,
      );
    }
    expect(moderationBreakerState().state).toBe("open");
    const callsBefore = attempts;
    await expect(classify([{ role: "user", content: "hi" }])).rejects.toThrow(/breaker/);
    // The open breaker makes NO gateway call.
    expect(attempts).toBe(callsBefore);
  });

  test("warm-up survives an unreachable gateway without throwing", async () => {
    await setFlag(true);
    stubFetch(() => {
      throw new Error("down");
    });
    const ok = await warmUpModerator();
    expect(ok).toBe(false);
  });
});
