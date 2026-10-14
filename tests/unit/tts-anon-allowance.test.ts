/**
 * UNIT — the anonymous demo budget.
 *
 * Before this, a signed-out caller was refused outright (401) and `voice-client`
 * fell back to the browser's own SpeechSynthesis. The demo therefore claimed a
 * neural voice while the visitor heard their operating system, and nothing on the
 * page could tell the difference. The fix is a real ElevenLabs turn for anonymous
 * callers under an explicit, opt-in ceiling.
 *
 * What would make that worse than the 401 it replaces:
 *   · a ceiling on one of the two TTS doors — the demo would just use the other;
 *   · a ceiling counted in REQUESTS, which many short requests outrun;
 *   · an allowance that defaults to something non-zero, so every deployment
 *     inherits spendable platform quota by accident.
 *
 * All three are asserted here. Nothing in this file needs a database: the signed-out
 * branch returns before any org or profile lookup, and the limiter's default store is
 * in-process.
 *
 *   bun scripts/run-tests.mjs tts-anon-allowance
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The signed-out seam. Stubbed rather than reached, because the whole point of this
// branch is that there is no session to look up.
mock.module("@/lib/credits", () => ({
  getProfile: async () => null,
  getActiveOrgId: async () => null,
  requireOperator: async () => {
    throw new Error("not reachable in this suite");
  },
}));

const { resolveTtsKey, allowAnonTurn, isAnonymousUnmetered } = await import("@/lib/tts-quota");
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");

const ROOT = join(import.meta.dir, "..", "..");
const routeSource = (rel: string) => readFileSync(join(ROOT, "src", "app", "api", rel), "utf8");

const ENV = {
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_DRY_RUN: process.env.ELEVENLABS_DRY_RUN,
  TTS_ANON_CHAR_LIMIT_PER_HOUR: process.env.TTS_ANON_CHAR_LIMIT_PER_HOUR,
};

function setEnv(patch: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() =>
  // DRY_RUN is part of the setup, not noise: `resolveTtsKey` returns `unmetered` the
  // moment dry-run is on, before it ever looks at the key. A .env carrying
  // ELEVENLABS_DRY_RUN=true therefore makes every assertion below read "unmetered"
  // and look like a broken allowance, when what it found is the short-circuit.
  setEnv({
    ELEVENLABS_API_KEY: "test-platform-key",
    ELEVENLABS_DRY_RUN: "false",
    TTS_ANON_CHAR_LIMIT_PER_HOUR: undefined,
  }),
);
afterEach(() => setEnv(ENV));

describe("resolveTtsKey for an unmeterable caller", () => {
  test("dry-run short-circuits before any of this: no platform key is ever spent", async () => {
    // The one case that must stay true whatever the knob says — it is why the demo
    // can run in CI against a paid vendor without touching it.
    setEnv({ ELEVENLABS_DRY_RUN: "true", TTS_ANON_CHAR_LIMIT_PER_HOUR: "5000" });
    expect((await resolveTtsKey()).mode).toBe("unmetered");
  });

  test("defaults to refusal, exactly as before the knob existed", async () => {
    const res = await resolveTtsKey();
    expect(res.mode).toBe("anonymous");
    expect(isAnonymousUnmetered(res)).toBe(true);
    if (res.mode !== "anonymous") throw new Error("expected a refusal");
    expect(res.reason.length).toBeGreaterThan(0);
  });

  test("an explicit zero is still a refusal, not an unlimited allowance", async () => {
    setEnv({ TTS_ANON_CHAR_LIMIT_PER_HOUR: "0" });
    const res = await resolveTtsKey();
    expect(res.mode).toBe("anonymous");
  });

  test("a negative or nonsense value is a refusal, never a giant bucket", async () => {
    // A `Number(x) || default` shape would read "-5" as truthy and hand out a
    // negative capacity, which a token bucket treats as "always allow".
    setEnv({ TTS_ANON_CHAR_LIMIT_PER_HOUR: "-5000" });
    expect((await resolveTtsKey()).mode).toBe("anonymous");
    setEnv({ TTS_ANON_CHAR_LIMIT_PER_HOUR: "not-a-number" });
    expect((await resolveTtsKey()).mode).toBe("anonymous");
  });

  test("with the knob set, the caller is allowed under that character ceiling", async () => {
    setEnv({ TTS_ANON_CHAR_LIMIT_PER_HOUR: "2000" });
    const res = await resolveTtsKey();
    expect(res.mode).toBe("anon");
    if (res.mode !== "anon") throw new Error("expected an anonymous allowance");
    expect(res.charsPerHour).toBe(2000);
    expect(isAnonymousUnmetered(res)).toBe(false);
  });

  test("no platform key to spend still falls through, with or without the knob", async () => {
    setEnv({ ELEVENLABS_API_KEY: undefined, TTS_ANON_CHAR_LIMIT_PER_HOUR: "2000" });
    expect((await resolveTtsKey()).mode).toBe("unmetered");
  });
});

describe("allowAnonTurn charges characters, not requests", () => {
  test("the budget is spent by volume, so many small calls cannot outrun it", async () => {
    // One caller, 500 chars of budget. Two 240-char turns fit; a third does not.
    // Counted in requests this would have allowed 500 calls a hour instead.
    const caller = `anon-chars-${Date.now()}`;
    const res = { mode: "anon" as const, charsPerHour: 500 };
    expect((await allowAnonTurn(res, caller, 240)).ok).toBe(true);
    expect((await allowAnonTurn(res, caller, 240)).ok).toBe(true);
    const third = await allowAnonTurn(res, caller, 240);
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error("expected the ceiling to bite");
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  test("a different caller is not charged for the first one's spend", async () => {
    const res = { mode: "anon" as const, charsPerHour: 300 };
    const a = `anon-a-${Date.now()}`;
    const b = `anon-b-${Date.now()}`;
    expect((await allowAnonTurn(res, a, 300)).ok).toBe(true);
    expect((await allowAnonTurn(res, a, 10)).ok).toBe(false);
    expect((await allowAnonTurn(res, b, 300)).ok).toBe(true);
  });

  test("a single request larger than the budget is refused rather than banked", async () => {
    // MAX_TTS_CHARS (1024) can exceed a small allowance. Refusing is the safe
    // direction; allowing would hand out more than the deployment set.
    const res = { mode: "anon" as const, charsPerHour: 100 };
    expect((await allowAnonTurn(res, `anon-big-${Date.now()}`, 1024)).ok).toBe(false);
  });
});

describe("both TTS doors carry the ceiling", () => {
  // The trap this exists to prevent: `/api/tts` metered, `/api/tts/stream` not. The
  // public widget streams, so a cap on the buffered door alone would be a cap on
  // nothing. Asserted against the source because importing a Next route handler here
  // would drag in the whole request pipeline for what is a one-line policy.
  for (const rel of ["tts/route.ts", "tts/stream/route.ts"]) {
    test(`${rel} enforces the anonymous ceiling`, () => {
      const src = routeSource(rel);
      expect(src, `${rel} must consult the shared resolution`).toContain("resolveTtsKey()");
      expect(src, `${rel} never checks the anon mode`).toMatch(/mode === "anon"/);
      expect(src, `${rel} does not call the shared ceiling`).toContain("allowAnonTurn(");
      expect(src, `${rel} still refuses the un-capped case`).toMatch(/mode === "anonymous"/);
    });
  }

  test("the ceiling lives in the shared module, not in either route", () => {
    // If a route grew its own bucket arithmetic, the two doors could drift again and
    // nothing would notice — which is the exact failure the shared module exists to
    // make impossible.
    const quota = readFileSync(join(ROOT, "src", "lib", "tts-quota.ts"), "utf8");
    expect(quota).toContain('consumeRate("tts-anon"');
    for (const rel of ["tts/route.ts", "tts/stream/route.ts"]) {
      expect(routeSource(rel)).not.toMatch(/consume\w*\(\s*["']tts-anon["']/);
    }
  });
});
