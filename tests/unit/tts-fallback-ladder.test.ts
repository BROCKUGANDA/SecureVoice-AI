/**
 * THE TTS FALLBACK LADDER — a fraud call must never answer with silence.
 *
 * `POST /api/tts` synthesizes the words a customer hears. Its previous shape was
 * one `try`, one vendor, and a 5xx on failure — so an ElevenLabs outage sounded
 * exactly like a dead line, which on a fraud call is indistinguishable from the
 * bank having hung up. The ladder replaces that with four rungs and one promise:
 * something is always returned, and the response says which rung produced it.
 *
 * The properties asserted here are the ones a reviewer cannot read off a passing
 * test run:
 *
 *   1. A BYOK tenant NEVER falls through to the platform key pool. Their traffic
 *      is billable to their own ElevenLabs account; routing a failure through the
 *      shared pool would spend the platform's quota on a call the tenant pays for
 *      — the exact confusion the BYOK path exists to prevent.
 *   2. The emergency cue is a SUCCESS (200 audio), not an error. Its purpose is
 *      to break the silence, and a 5xx would produce the same dead air with a
 *      worse log.
 *   3. `degraded` and `X-Voice-Source` are truthful, because an operator
 *      debugging "why did my customer hear a different voice" reads these fields
 *      and nothing else.
 *   4. Every failed rung is named in the audit meta — a failover that is
 *      invisible afterwards is how a vendor outage becomes a mystery two weeks
 *      later.
 *   5. Authenticated-with-no-session still refuses BEFORE any vendor call, so
 *      nothing in the ladder quietly spends the platform key.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

type Attempt = "elevenlabs" | "pool" | "playht" | "none";
type KeyMode = "platform" | "byok" | "anonymous";

const state: {
  attempt: Attempt;
  mode: KeyMode;
  playhtConfigured: boolean;
} = {
  attempt: "elevenlabs",
  mode: "platform",
  playhtConfigured: true,
};

const calls: string[] = [];
const audits: Record<string, unknown>[] = [];
/** The `keyOverride` the primary rung actually received, per call. */
const primaryKeys: (string | undefined)[] = [];

mock.module("@/lib/elevenlabs/client", () => ({
  DEV_VOICES: new Set(["jam"]),
  UpstreamError: class UpstreamError extends Error {},
  allowedVoices: () => new Set(["voice_en_id", "voice_ar_id"]),
  isProdVoiceMode: () => true,
  // Prod voice mode resolves a language key through this table, so the ids below
  // are what `allowedVoices()` must contain for `voice: "en"` to be accepted.
  ELEVEN_VOICE_ENV: { en: "voice_en_id", ar: "voice_ar_id" },
  resolveTtsModel: () => "eleven_multilingual_v2",
  tts: async (_req: unknown, opts: { keyOverride?: string }) => {
    calls.push("elevenlabs");
    primaryKeys.push(opts?.keyOverride);
    if (state.attempt === "elevenlabs") {
      return { audio: Buffer.from("primary-audio"), contentType: "audio/mpeg", bytes: 12 };
    }
    throw new Error("elevenlabs: 503 upstream unavailable");
  },
}));

mock.module("@/lib/elevenlabs/pool", () => ({
  generateAudioWithFailover: async () => {
    calls.push("pool");
    if (state.attempt === "pool") {
      return { audio: Buffer.from("pool-audio"), contentType: "audio/mpeg", bytes: 10 };
    }
    throw new Error("pool: every key is rate limited");
  },
}));

mock.module("@/lib/elevenlabs/playht", () => ({
  isPlayhtConfigured: () => state.playhtConfigured,
  generatePlayhtAudio: async () => {
    calls.push("playht");
    if (state.attempt === "playht") {
      return { audio: Buffer.from("playht-audio"), contentType: "audio/mpeg", bytes: 9 };
    }
    throw new Error("playht: 401 credentials rejected");
  },
}));

mock.module("@/lib/elevenlabs/emergency-audio", () => ({
  EMERGENCY_AUDIO_CONTENT_TYPE: "audio/wav",
  getEmergencyAudio: (kind: string) => {
    calls.push(`emergency:${kind}`);
    return Buffer.concat([Buffer.from("RIFF"), Buffer.from("cue")]);
  },
}));

mock.module("@/lib/tts-quota", () => ({
  resolveTtsKey: async () =>
    state.mode === "anonymous"
      ? { mode: "anonymous", reason: "Sign in to synthesize speech." }
      : state.mode === "byok"
        ? { mode: "byok", keyOverride: "tenant-owned-eleven-key" }
        : { mode: "platform", userId: "user-1" },
  consumeCharQuota: async () => ({ ok: true }),
  quotaExceededResponse: () => ({ error: "Daily character quota exceeded." }),
  // The routes import this for the anonymous demo ceiling, so a stub of the module
  // must carry it or importing the route under this mock throws at load and the
  // whole ladder suite errors out without testing a single rung.
  allowAnonTurn: async () => ({ ok: true, limit: 2000, remaining: 1990, resetMs: 60_000 }),
}));

mock.module("@/lib/ratelimit", () => ({
  consume: () => ({ ok: true }),
  rateLimitId: () => "127.0.0.1",
  // Every export the routes under test touch has to be in this object: `mock.module`
  // replaces the MODULE, so a route that later starts calling another function from
  // it fails at import time with "Export named … not found" and every test in the
  // file dies on the load error rather than on an assertion. `rateLimitHeaders` was
  // added for the 429 headers and this file's suite went red without a TTS change.
  rateLimitHeaders: () => ({}),
}));

mock.module("@/lib/audit-chain", () => ({
  append: async (entry: Record<string, unknown>) => {
    audits.push(entry);
    return "row";
  },
}));

const URL = "https://tts.test/api/tts";

// The PlayHT rung is gated on a voice id being configured, and the route reads
// it from env at call time. Without this the third rung would be skipped for an
// unrelated reason and every "reached PlayHT" assertion would be about the
// machine running the test.
const priorPlayhtVoice = process.env.PLAYHT_VOICE_ID;
process.env.PLAYHT_VOICE_ID = "playht_voice_for_tests";

async function post(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/tts/route");
  const res = await POST(
    new NextRequest(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    source: res.headers.get("x-voice-source"),
    degraded: res.headers.get("x-voice-degraded"),
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
}

function reset(over: Partial<typeof state> = {}) {
  state.attempt = "elevenlabs";
  state.mode = "platform";
  state.playhtConfigured = true;
  Object.assign(state, over);
  calls.length = 0;
  audits.length = 0;
  primaryKeys.length = 0;
}

const REQ = { text: "Was this your card purchase?", voice: "en", lang: "en" };

beforeEach(() => reset());

afterAll(() => {
  if (priorPlayhtVoice === undefined) delete process.env.PLAYHT_VOICE_ID;
  else process.env.PLAYHT_VOICE_ID = priorPlayhtVoice;
});

describe("the ladder always answers", () => {
  test("a healthy primary is reported as neither degraded nor failed", async () => {
    const res = await post(REQ);

    expect(res.status).toBe(200);
    expect(res.source).toBe("elevenlabs");
    expect(res.degraded).toBe("false");
    expect(calls).toEqual(["elevenlabs"]);
    expect(new TextDecoder().decode(res.bytes)).toBe("primary-audio");
    const meta = audits[0]!.meta as Record<string, unknown>;
    expect(meta.failed_rungs).toEqual([]);
    expect(meta.degraded).toBe(false);
  });

  test("a primary failure reaches the pool and says it degraded", async () => {
    reset({ attempt: "pool" });
    const res = await post(REQ);

    expect(res.status).toBe(200);
    expect(res.source).toBe("elevenlabs-pool");
    expect(res.degraded).toBe("true");
    expect(calls).toEqual(["elevenlabs", "pool"]);
    const meta = audits[0]!.meta as Record<string, unknown>;
    expect((meta.failed_rungs as { rung: string }[]).map((f) => f.rung)).toEqual(["elevenlabs"]);
  });

  test("a BYOK tenant is NEVER routed through the platform key pool", async () => {
    // The whole point of bring-your-own-key: their calls bill their own account.
    // Falling through to the shared pool would spend the platform's quota on
    // traffic the tenant already pays ElevenLabs for.
    reset({ attempt: "playht", mode: "byok" });
    const res = await post(REQ);

    // The tenant's key is the one the primary rung was called with.
    expect(primaryKeys).toEqual(["tenant-owned-eleven-key"]);
    expect(calls).toEqual(["elevenlabs", "playht"]);
    expect(calls).not.toContain("pool");
    expect(res.source).toBe("playht");
    expect(res.degraded).toBe("true");
  });

  test("a BYOK failure with no pool and no PlayHT still returns audible audio", async () => {
    reset({ attempt: "none", mode: "byok", playhtConfigured: false });
    const res = await post(REQ);

    expect(res.status).toBe(200);
    expect(res.source).toBe("emergency");
    expect(res.type).toBe("audio/wav");
    expect(res.bytes.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toBe("emergency:error");
  });

  test("every vendor failing names every rung that was tried", async () => {
    reset({ attempt: "none" });
    const res = await post(REQ);

    expect(res.status).toBe(200);
    expect(res.source).toBe("emergency");
    expect(calls).toEqual(["elevenlabs", "pool", "playht", "emergency:error"]);
    const meta = audits[0]!.meta as Record<string, unknown>;
    expect((meta.failed_rungs as { rung: string }[]).map((f) => f.rung)).toEqual([
      "elevenlabs",
      "elevenlabs-pool",
      "playht",
    ]);
    const errors = (meta.failed_rungs as { error: string }[]).map((f) => f.error);
    expect(errors.some((e) => e.includes("503"))).toBe(true);
  });

  test("PlayHT is skipped when its credentials are absent, without pretending to try", async () => {
    reset({ attempt: "none", playhtConfigured: false });
    const res = await post(REQ);

    expect(calls).toEqual(["elevenlabs", "pool", "emergency:error"]);
    expect(res.source).toBe("emergency");
    const meta = audits[0]!.meta as Record<string, unknown>;
    expect((meta.failed_rungs as { rung: string }[]).map((f) => f.rung)).toEqual([
      "elevenlabs",
      "elevenlabs-pool",
    ]);
  });
});

describe("the gates that run before any vendor is called", () => {
  test("an unauthenticated caller is refused before the ladder exists", async () => {
    reset({ mode: "anonymous" });
    const res = await post(REQ);

    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
    expect(audits).toHaveLength(0);
  });

  test("an unknown voice is refused without a vendor call", async () => {
    const res = await post({ ...REQ, voice: "not-a-voice" });
    expect(res.status).toBe(422);
    expect(calls).toEqual([]);
  });

  test("an empty text is refused without a vendor call", async () => {
    const res = await post({ ...REQ, text: "" });
    expect([422, 400]).toContain(res.status);
    expect(calls).toEqual([]);
  });
});
