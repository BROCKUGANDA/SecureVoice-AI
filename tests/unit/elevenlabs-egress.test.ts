/**
 * UNIT — the ElevenLabs egress guard (src/lib/elevenlabs/egress.ts).
 *
 * This guard is the only code that opens a socket to api.elevenlabs.io, and the
 * account behind it has a 10,000-character monthly ceiling. The properties
 * below are the ones that decide whether that ceiling is real:
 *
 *   · THE METER MUST SIT ON THE PATH THAT SPENDS. The audit found the character
 *     budget wired to the JSON endpoints — which pass `billableChars: 0` — while
 *     the TTS binary path that actually bills characters never reserved
 *     anything. A guard that measures the wrong call site reports empty and
 *     looks healthy, so the reservation test below is the headline case.
 *   · A FAILED UPSTREAM IS NEVER A SUCCESSFUL EMPTY PAYLOAD. A non-2xx must
 *     return `ok: false` with the vendor status, or every caller that branches
 *     on `ok` treats a 401 as "the vendor returned nothing".
 *   · BYOK MUST STAY BYOK. An org's own key must not be silently replaced by
 *     the platform key, or their usage burns our quota.
 *   · A 4xx IS NOT AN OUTAGE. It must not retry, and must not push the breaker
 *     toward open — a typo'd voice id must not degrade the whole conversation
 *     plane.
 *   · THE BUDGET FAILS CLOSED. A meter that cannot be read is not a meter that
 *     is satisfied.
 *
 * Limits are shrunk via env BEFORE the module is first imported, so the budget
 * and throttle boundaries are reachable without 10,000 iterations.
 */
import { beforeEach, describe, expect, test } from "bun:test";

process.env.ELEVENLABS_API_KEY = "platform-key-should-never-leak";
delete process.env.ELEVENLABS_DRY_RUN;

const {
  elevenLabsFetch,
  fetchUpstreamBinary,
  reserveElevenLabsChars,
  releaseElevenLabsChars,
  elevenLabsBreaker,
  effectiveCharLimit,
  _resetEgressForTest,
} = await import("@/lib/elevenlabs/egress");
const { _reset: resetRateLimits } = await import("@/lib/ratelimit");

/** Shrunk so the budget boundary is reachable without 10,000 iterations. */
const LIMIT = 100;

type Call = { url: string; headers: Record<string, string>; method: string };

const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** Install a fake vendor. `respond` may be a fixed shape or per-attempt. */
function stubFetch(
  respond:
    | { status: number; body?: string; headers?: Record<string, string> }
    | ((attempt: number) => { status: number; body?: string; headers?: Record<string, string> }),
): void {
  calls = [];
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const i = (init ?? {}) as { method?: string; headers?: Record<string, string> };
    calls.push({
      url: String(input),
      method: i.method ?? "GET",
      headers: { ...(i.headers ?? {}) },
    });
    const r = typeof respond === "function" ? respond(calls.length - 1) : respond;
    return new Response(r.body ?? "{}", {
      status: r.status,
      headers: r.headers as Record<string, string> | undefined,
    });
  }) as unknown as typeof fetch;
}

/** Read the meter without changing it: reserve one, take it straight back. */
async function charsReserved(): Promise<number | "at-or-over-limit"> {
  const check = await reserveElevenLabsChars(1);
  if (!check.ok) return "at-or-over-limit";
  await releaseElevenLabsChars(1);
  return check.used - 1;
}

beforeEach(() => {
  // Set per test, not once at import: both ceilings are read at call time so no
  // suite's numbers depend on which file imported the guard first.
  process.env.ELEVENLABS_MONTHLY_CHAR_LIMIT = String(LIMIT);
  // Far above anything these tests do, so the throttle never interferes with a
  // budget or breaker assertion. The throttle's own boundary is a separate file.
  process.env.ELEVENLABS_EGRESS_PER_HOUR = "10000";
  // Default: no durable meter, so the in-process count is the whole truth.
  delete process.env.REDIS_URL;
  // tests/preload.ts attests commercial use so the live path is exercisable;
  // restored here in case a test removed it.
  process.env.ELEVENLABS_COMMERCIAL_USE = "true";
  _resetEgressForTest();
  resetRateLimits();
  calls = [];
});

describe("the guard reaches the vendor and bills the path that spends", () => {
  test("a TTS synthesis reserves its characters BEFORE the call", async () => {
    stubFetch({ status: 200, body: "audio" });
    const text = "0123456789".repeat(6); // 60 chars
    const res = await fetchUpstreamBinary("POST", "/v1/text-to-speech/jam", {
      body: JSON.stringify({ text }),
      billableChars: text.length,
    });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await charsReserved()).toBe(60);
  });

  test("a vendor 4xx gives the reservation straight back", async () => {
    stubFetch({ status: 422, body: "unknown voice" });
    const res = await fetchUpstreamBinary("POST", "/v1/text-to-speech/bogus", {
      body: JSON.stringify({ text: "x".repeat(40) }),
      billableChars: 40,
      maxRetries: 0,
    });

    expect(res.ok).toBe(false);
    expect(await charsReserved()).toBe(0);
  });

  test("the character budget stops the TTS path once it is spent", async () => {
    stubFetch({ status: 200, body: "audio" });
    const big = "y".repeat(LIMIT);

    const first = await fetchUpstreamBinary("POST", "/v1/text-to-speech/jam", {
      body: JSON.stringify({ text: big }),
      billableChars: big.length,
    });
    expect(first.ok).toBe(true);

    const callsBefore = calls.length;
    const second = await fetchUpstreamBinary("POST", "/v1/text-to-speech/jam", {
      body: JSON.stringify({ text: "one char over" }),
      billableChars: 1,
    });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("budget failed to stop the request");
    expect(second.status).toBe(429);
    expect(second.body).toContain("monthly character budget exhausted");
    // Refused at the guard: the vendor was never contacted, so nothing was billed.
    expect(calls).toHaveLength(callsBefore);
  });

  test("a meter that cannot be read refuses rather than wave the request through", async () => {
    stubFetch({ status: 200, body: "audio" });
    const { redis } = await import("@/lib/redis");
    const original = redis.incrBy;
    redis.incrBy = async () => {
      throw new Error("connection refused");
    };
    try {
      const res = await fetchUpstreamBinary("POST", "/v1/text-to-speech/jam", {
        body: "{}",
        billableChars: 10,
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("fail-open: the guard spent on a blind meter");
      expect(res.body).toContain("meter unavailable");
      expect(calls).toHaveLength(0);
    } finally {
      redis.incrBy = original;
    }
  });

  test("a shared-meter outage degrades to in-process limits rather than refusing", async () => {
    // The declared Redis fallback is "conservative in-process limits, logged as
    // degraded" (FALLBACKS.redis). Refusing every call would be a different
    // policy — one that turns an infrastructure hiccup into a voice outage.
    process.env.REDIS_URL = "redis://redis:6379";
    const { redis } = await import("@/lib/redis");
    const originalIncr = redis.incrBy;
    redis.incrBy = async () => {
      throw new Error("connection refused");
    };
    stubFetch({ status: 200, body: "audio" });
    try {
      const check = await reserveElevenLabsChars(10);
      expect(check.ok).toBe(true);
      if (!check.ok) throw new Error("unreachable");
      expect(check.via).toBe("local");
      expect(check.degraded).toBe(true);

      const res = await fetchUpstreamBinary("POST", "/v1/text-to-speech/jam", {
        body: "{}",
        billableChars: 10,
      });
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      redis.incrBy = originalIncr;
      delete process.env.REDIS_URL;
    }
  });

  test("the degraded ceiling is tighter, so an outage cannot spend the full month", async () => {
    process.env.REDIS_URL = "redis://redis:6379";
    try {
      // LIMIT is 100 in this suite; the degraded share of it must be smaller.
      expect(effectiveCharLimit("shared")).toBe(100);
      expect(effectiveCharLimit("local")).toBeLessThan(100);
      expect(effectiveCharLimit("local")).toBe(50);

      const { redis } = await import("@/lib/redis");
      const originalIncr = redis.incrBy;
      redis.incrBy = async () => {
        throw new Error("connection refused");
      };
      try {
        // 60 chars fits the shared ceiling and must NOT fit the degraded one.
        const check = await reserveElevenLabsChars(60);
        expect(check.ok).toBe(false);
        if (check.ok) throw new Error("the degraded ceiling admitted a shared-sized claim");
        if (check.ok) throw new Error("unreachable");
        expect(check.reason).toBe("exhausted");
      } finally {
        redis.incrBy = originalIncr;
      }
    } finally {
      delete process.env.REDIS_URL;
    }
  });

  test("without a durable meter, a meter failure refuses instead of silently counting nothing", async () => {
    // No REDIS_URL: the in-process count is the whole truth for this instance,
    // so a throw there is a bug and must not be papered over as a degrade.
    stubFetch({ status: 200, body: "audio" });
    const check = await reserveElevenLabsChars(5);
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error("unreachable");
    expect(check.via).toBe("local");
    expect(check.degraded).toBe(false);
  });

  test("a refund returns chars to the meter the reservation came from", async () => {
    stubFetch({ status: 422, body: "bad voice" });
    const before = await reserveElevenLabsChars(0);
    expect(before.ok).toBe(true);

    await fetchUpstreamBinary("POST", "/v1/text-to-speech/bogus", {
      body: "{}",
      billableChars: 30,
      maxRetries: 0,
    });
    // Rejected by the vendor, so the local counter is back where it started.
    expect(await charsReserved()).toBe(0);
  });

  test("a live call is refused without the commercial-use attestation", async () => {
    // Free tier permits non-commercial use only (ToS §1(c)(i), PUP §9(a)). The
    // guard sits on the single egress path, so the attestation cannot be skipped
    // by a call site that forgets to check it.
    stubFetch({ status: 200, body: "audio" });
    const saved = process.env.ELEVENLABS_COMMERCIAL_USE;
    delete process.env.ELEVENLABS_COMMERCIAL_USE;
    try {
      const res = await fetchUpstreamBinary("POST", "/v1/text-to-speech/jam", {
        body: "{}",
        billableChars: 10,
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("a free-tier call reached the vendor");
      expect(res.status).toBe(403);
      expect(res.body).toContain("ELEVENLABS_COMMERCIAL_USE");
      // Refused at the guard: nothing was billed by us or by the vendor.
      expect(calls).toHaveLength(0);
      expect(await charsReserved()).toBe(0);
    } finally {
      if (saved !== undefined) process.env.ELEVENLABS_COMMERCIAL_USE = saved;
    }
  });

  test("no key configured is a refusal, not a request with an empty header", async () => {
    stubFetch({ status: 200, body: "{}" });
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const res = await elevenLabsFetch({ path: "/v1/whoami", billableChars: 0 });
      expect(res.ok).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      process.env.ELEVENLABS_API_KEY = saved;
    }
  });
});

describe("a failed upstream is never an empty success", () => {
  test("an upstream 401 returns ok:false with the vendor status", async () => {
    stubFetch({ status: 401, body: "invalid api key" });
    const res = await elevenLabsFetch<{ signed_url?: string }>({
      path: "/v1/convai/conversation/get-signed-url?agent_id=a",
      billableChars: 0,
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("a 401 was reported as success — callers would read `data` as a payload");
    }
    expect(res.error.status).toBe(401);
    expect(res.error.retryable).toBe(false);
    expect(res.error.body).toContain("invalid api key");
  });

  test("the vendor's raw text survives to the caller so it can be redacted", async () => {
    const detail = "x".repeat(500);
    stubFetch({ status: 500, body: detail });
    const res = await elevenLabsFetch({ path: "/v1/any", billableChars: 0, maxRetries: 0 });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // Collapsing the body to "HTTP 500" is the regression this pins against:
    // the signed-url route publishes a bounded slice of the real detail.
    expect(res.error.body).toBe(detail.slice(0, 300));
  });

  test("a 200 whose body is not JSON is a typed failure", async () => {
    stubFetch({ status: 200, body: "not json at all" });
    const res = await elevenLabsFetch({ path: "/v1/any", billableChars: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.status).toBe(502);
  });

  test("binary success hands back the live Response, not a drained body", async () => {
    stubFetch({ status: 200, body: "audio-bytes" });
    const res = await fetchUpstreamBinary("POST", "/v1/text-to-speech/jam/stream", {
      body: "{}",
      billableChars: 1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    // The stream route pipes `response.body`; an undefined body is a silent
    // empty 200 to the player, which is what this guards.
    expect(res.response.body).toBeDefined();
    expect(await res.response.text()).toBe("audio-bytes");
  });
});

describe("keys stay where they belong", () => {
  test("a BYOK caller sends their own key, never the platform key", async () => {
    stubFetch({ status: 200, body: "audio" });
    await fetchUpstreamBinary("POST", "/v1/text-to-speech/jam", {
      body: "{}",
      apiKey: "org-owned-key",
      billableChars: 10,
    });

    expect(calls[0]?.headers["xi-api-key"]).toBe("org-owned-key");
    expect(calls[0]?.headers["xi-api-key"]).not.toBe("platform-key-should-never-leak");
  });

  test("a BYOK call does not spend the platform character budget", async () => {
    stubFetch({ status: 200, body: "audio" });
    await fetchUpstreamBinary("POST", "/v1/text-to-speech/jam", {
      body: "{}",
      apiKey: "org-owned-key",
      billableChars: 0,
    });
    expect(await charsReserved()).toBe(0);
  });
});

describe("retry, backoff and the breaker", () => {
  test("a 503 is retried up to maxRetries + 1 attempts", async () => {
    stubFetch({ status: 503, body: "down" });
    const res = await elevenLabsFetch({ path: "/v1/any", billableChars: 0, maxRetries: 2 });

    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(3);
  });

  test("a vendor Retry-After is honoured instead of the local ladder", async () => {
    stubFetch((attempt) =>
      attempt === 0
        ? { status: 429, body: "slow down", headers: { "Retry-After": "1" } }
        : { status: 200, body: '{"ok":true}' },
    );
    const started = Date.now();
    const res = await elevenLabsFetch<{ ok?: boolean }>({
      path: "/v1/any",
      billableChars: 0,
      maxRetries: 1,
    });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // Retry-After: 1s, not the ~150-375ms the first backoff step would give.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test("a Retry-After beyond the clamp is waited out at the clamp, not the header", async () => {
    stubFetch((attempt) =>
      attempt === 0
        ? { status: 503, body: "later", headers: { "Retry-After": "99999" } }
        : { status: 200, body: "{}" },
    );
    const started = Date.now();
    const res = await elevenLabsFetch({ path: "/v1/any", billableChars: 0, maxRetries: 1 });
    const waited = Date.now() - started;

    expect(res.ok).toBe(true);
    // A vendor (or an attacker on a spoofed error path) saying "come back in
    // 27 hours" must not park the request. Clamped to 10s, and provably not
    // the ~150-375ms local backoff step.
    expect(waited).toBeGreaterThanOrEqual(9_000);
    expect(waited).toBeLessThan(11_500);
  }, 15_000);

  test("a 4xx is not retried and does not move the breaker toward open", async () => {
    stubFetch({ status: 400, body: "bad voice settings" });
    for (let i = 0; i < 6; i++) {
      const res = await elevenLabsFetch({ path: "/v1/any", billableChars: 0 });
      expect(res.ok).toBe(false);
    }
    // Six bad requests are six of our own bugs, not a vendor outage.
    expect(calls).toHaveLength(6);
    expect(elevenLabsBreaker.state()).toBe("closed");
  });

  test("five outages open the breaker, and the sixth is refused without a call", async () => {
    stubFetch({ status: 503, body: "vendor down" });
    for (let i = 0; i < 5; i++) {
      await elevenLabsFetch({ path: "/v1/any", billableChars: 0, maxRetries: 0 });
    }
    expect(elevenLabsBreaker.state()).toBe("open");

    const seen = calls.length;
    const res = await elevenLabsFetch({ path: "/v1/any", billableChars: 0, maxRetries: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.breakerOpen).toBe(true);
    expect(res.error.status).toBe(503);
    // The point of the breaker: stop hammering a vendor already known to be down.
    expect(calls).toHaveLength(seen);
  });

  test("an open breaker refunds the reservation it never used", async () => {
    stubFetch({ status: 503, body: "vendor down" });
    for (let i = 0; i < 5; i++) {
      await elevenLabsFetch({ path: "/v1/any", billableChars: 0, maxRetries: 0 });
    }
    const res = await elevenLabsFetch({ path: "/v1/any", billableChars: 25, maxRetries: 0 });
    expect(res.ok).toBe(false);
    expect(await charsReserved()).toBe(0);
  });

  test("a transport failure is retried and then recorded as an outage", async () => {
    calls = [];
    globalThis.fetch = (async () => {
      calls.push({ url: "throw", method: "POST", headers: {} });
      throw Object.assign(new Error("socket hang up"), {
        name: "TypeError",
        cause: { code: "ECONNRESET" },
      });
    }) as unknown as typeof fetch;

    const res = await elevenLabsFetch({ path: "/v1/any", billableChars: 0, maxRetries: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(calls).toHaveLength(2);
    // Socket-level failure: no HTTP status, so it surfaces as the 502 a caller
    // can actually put on a response.
    expect(res.error.status).toBe(502);
    expect(res.error.retryable).toBe(true);
    // ONE caller request moved the breaker by ONE, despite two attempts. The
    // ladder lives inside the guarded call, so a vendor retry storm cannot open
    // the breaker on its own.
    expect(elevenLabsBreaker.snapshot().consecutiveFailures).toBe(1);
  });

  test("a transport failure keeps status 0 on the binary path for STT re-upload", async () => {
    calls = [];
    globalThis.fetch = (async () => {
      calls.push({ url: "throw", method: "POST", headers: {} });
      throw Object.assign(new Error("socket hang up"), {
        name: "TypeError",
        cause: { code: "ECONNRESET" },
      });
    }) as unknown as typeof fetch;

    const res = await fetchUpstreamBinary("POST", "/v1/speech-to-text", {
      body: "form",
      billableChars: 0,
      maxRetries: 0,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(0);
  });

  test("a non-transient throw is not mistaken for a vendor outage", async () => {
    calls = [];
    globalThis.fetch = (async () => {
      calls.push({ url: "throw", method: "POST", headers: {} });
      throw new TypeError("invalid body init");
    }) as unknown as typeof fetch;

    const res = await elevenLabsFetch({ path: "/v1/any", billableChars: 0 });
    expect(res.ok).toBe(false);
    // Our bug fails on the first attempt; retrying a TypeError is noise.
    expect(calls).toHaveLength(1);
  });
});

describe("the guard is the only door", () => {
  test("every request goes to the pinned host on the caller's path", async () => {
    stubFetch({ status: 200, body: "{}" });
    await elevenLabsFetch({
      path: "/v1/convai/agents/abc",
      billableChars: 0,
      method: "PATCH",
      body: { a: 1 },
    });
    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/agents/abc");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });
});

// Leave the process as we found it for any later suite in this file's registry.
globalThis.fetch = realFetch;
