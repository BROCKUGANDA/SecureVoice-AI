/**
 * UNIT — the client-side speech cache (src/lib/voice-client.ts).
 *
 * The module caches neural-TTS audio as browser object URLs. That cache has two
 * contracts that are easy to break and expensive when broken, so both are pinned
 * here with a stubbed `fetch` and `URL` — no browser and no network:
 *
 *   · EVERY eviction must revoke the URL it drops. The source is explicit that
 *     a live object URL is ~100 KB of blob, so evicting without revoking leaks
 *     the blob for the tab's lifetime. This is the single most valuable
 *     assertion in the file: the cache being bounded proves nothing on its own.
 *   · Concurrent requests for the SAME text collapse to ONE network call. The
 *     demo replays a transcript, and a burst of identical utterances must not
 *     mean a burst of TTS spend.
 *
 * The cache and its in-flight map are module-level and not exported, so the tests
 * drive them through the public `fetchSpeechUrl` and use distinct texts to stay
 * independent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TTS_VOICE, fetchSpeechUrl } from "@/lib/voice-client";

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

let fetchCalls: Array<{ url: string; body: unknown }> = [];
let created: string[] = [];
let revoked: string[] = [];
let counter = 0;

/** A blob large enough to clear the 512-byte minimum the module enforces. */
function bigBlob(): Blob {
  return new Blob([new Uint8Array(1024)], { type: "audio/wav" });
}

function installFetch(behaviour: (n: number) => Response = () => new Response(bigBlob())) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const n = counter++;
    fetchCalls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return behaviour(n);
  }) as typeof fetch;
}

beforeEach(() => {
  counter = 0;
  fetchCalls = [];
  created = [];
  revoked = [];
  URL.createObjectURL = (() => {
    const url = `blob:test-${created.length}`;
    created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

describe("fetchSpeechUrl — happy path", () => {
  test("returns an object URL for a successful synthesis", async () => {
    const url = await fetchSpeechUrl(`hello-${Date.now()}-${Math.random()}`, "jam", "en");
    expect(url.startsWith("blob:")).toBe(true);
  });

  test("posts to the server-side TTS endpoint, never to the provider", async () => {
    // API keys must stay server-side, so the browser talks only to /api/tts.
    await fetchSpeechUrl(`k-${Date.now()}-${Math.random()}`, "jam", "en");
    expect(fetchCalls.at(-1)?.url).toBe("/api/tts");
  });

  test("sends the voice and language in the body", async () => {
    await fetchSpeechUrl(`b-${Date.now()}-${Math.random()}`, "tongtong", "ar");
    expect(fetchCalls.at(-1)?.body).toMatchObject({ voice: "tongtong", lang: "ar" });
  });

  test("omits lang entirely when none is given", async () => {
    await fetchSpeechUrl(`c-${Date.now()}-${Math.random()}`, "jam");
    const body = fetchCalls.at(-1)?.body as Record<string, unknown>;
    expect("lang" in body).toBe(false);
  });

  test("sends method POST and a JSON content type", async () => {
    const seen: Array<{ method: string | undefined; contentType: unknown }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        method: init?.method,
        contentType: new Headers(init?.headers).get("content-type"),
      });
      return new Response(bigBlob());
    }) as unknown as typeof fetch;
    await fetchSpeechUrl(`d-${Date.now()}-${Math.random()}`, "jam", "en");
    expect(seen).toEqual([{ method: "POST", contentType: "application/json" }]);
  });
});

describe("fetchSpeechUrl — caching", () => {
  test("a repeat request for the same text hits the cache, not the network", async () => {
    const text = `cache-${Date.now()}-${Math.random()}`;
    const first = await fetchSpeechUrl(text, "jam", "en");
    const callsAfterFirst = fetchCalls.length;
    const second = await fetchSpeechUrl(text, "jam", "en");
    expect(second).toBe(first);
    expect(fetchCalls.length).toBe(callsAfterFirst);
  });

  test("a different voice is a different cache entry", async () => {
    const text = `voice-${Date.now()}-${Math.random()}`;
    await fetchSpeechUrl(text, "jam", "en");
    const before = fetchCalls.length;
    await fetchSpeechUrl(text, "tongtong", "en");
    expect(fetchCalls.length).toBe(before + 1);
  });

  test("a different language is a different cache entry", async () => {
    const text = `lang-${Date.now()}-${Math.random()}`;
    await fetchSpeechUrl(text, "jam", "en");
    const before = fetchCalls.length;
    await fetchSpeechUrl(text, "jam", "ar");
    expect(fetchCalls.length).toBe(before + 1);
  });

  test("an omitted lang is distinct from an explicit one", async () => {
    const text = `nolang-${Date.now()}-${Math.random()}`;
    await fetchSpeechUrl(text, "jam");
    const before = fetchCalls.length;
    await fetchSpeechUrl(text, "jam", "en");
    expect(fetchCalls.length).toBe(before + 1);
  });
});

describe("fetchSpeechUrl — in-flight collapsing", () => {
  test("concurrent identical requests make exactly ONE network call", async () => {
    // The demo replays a transcript; without this, a burst of the same utterance
    // is a burst of TTS spend.
    const text = `inflight-${Date.now()}-${Math.random()}`;
    const results = await Promise.all([
      fetchSpeechUrl(text, "jam", "en"),
      fetchSpeechUrl(text, "jam", "en"),
      fetchSpeechUrl(text, "jam", "en"),
      fetchSpeechUrl(text, "jam", "en"),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(fetchCalls.length).toBe(1);
  });

  test("concurrent distinct requests are NOT collapsed", async () => {
    const base = Date.now() + Math.random();
    await Promise.all([
      fetchSpeechUrl(`p1-${base}`, "jam", "en"),
      fetchSpeechUrl(`p2-${base}`, "jam", "en"),
      fetchSpeechUrl(`p3-${base}`, "jam", "en"),
    ]);
    expect(fetchCalls.length).toBe(3);
  });

  test("a failed in-flight request does not poison the cache for a later retry", async () => {
    // The in-flight entry must be cleared on failure, or this key is dead for
    // the rest of the session and the line can never be spoken again.
    const text = `fail-${Date.now()}-${Math.random()}`;
    installFetch(() => new Response("nope", { status: 500 }));
    await expect(fetchSpeechUrl(text, "jam", "en")).rejects.toThrow();
    installFetch();
    const url = await fetchSpeechUrl(text, "jam", "en");
    expect(url.startsWith("blob:")).toBe(true);
  });

  test("concurrent callers all see the same rejection", async () => {
    const text = `shared-fail-${Date.now()}-${Math.random()}`;
    installFetch(() => new Response("nope", { status: 503 }));
    const settled = await Promise.allSettled([
      fetchSpeechUrl(text, "jam", "en"),
      fetchSpeechUrl(text, "jam", "en"),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
  });
});

describe("fetchSpeechUrl — failure handling", () => {
  test("a non-2xx response rejects", async () => {
    installFetch(() => new Response("server error", { status: 500 }));
    const text = `e1-${Date.now()}-${Math.random()}`;
    await expect(fetchSpeechUrl(text, "jam", "en")).rejects.toThrow(/tts 500/);
  });

  test("a tiny blob is rejected as empty rather than cached", async () => {
    // Below the 512-byte floor the response is not audio; caching it would hand
    // playback a URL that produces silence forever.
    installFetch(() => new Response(new Blob([new Uint8Array(16)])));
    const text = `e2-${Date.now()}-${Math.random()}`;
    await expect(fetchSpeechUrl(text, "jam", "en")).rejects.toThrow(/empty/);
    expect(revoked).toHaveLength(0);
  });

  test("a rejected synthesis creates no object URL at all", async () => {
    installFetch(() => new Response("no", { status: 500 }));
    await expect(
      fetchSpeechUrl(`e3-${Date.now()}-${Math.random()}`, "jam", "en"),
    ).rejects.toThrow();
    expect(created).toHaveLength(0);
  });

  test("a network throw propagates rather than resolving to a bad URL", async () => {
    const boom = (() => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    globalThis.fetch = boom;
    const text = `e4-${Date.now()}-${Math.random()}`;
    await expect(fetchSpeechUrl(text, "jam", "en")).rejects.toThrow(/offline/);
  });
});

describe("voice routing table", () => {
  const LANGS = ["en", "ar", "hi", "ur", "fr", "sw"] as const;

  test("every supported call language has an agent and customer voice", () => {
    for (const lang of LANGS) {
      expect(TTS_VOICE[lang].agent.length).toBeGreaterThan(0);
      expect(TTS_VOICE[lang].customer.length).toBeGreaterThan(0);
    }
  });

  test("the agent and customer never share a voice within a language", () => {
    // The demo alternates agent and customer turns; a shared voice makes the
    // conversation sound like one person talking to themselves.
    for (const lang of LANGS) {
      expect({ lang, same: TTS_VOICE[lang].agent === TTS_VOICE[lang].customer }).toEqual({
        lang,
        same: false,
      });
    }
  });

  test("Arabic, Hindi and Urdu each route to a distinct provider voice", () => {
    // These are the languages the product exists to serve; collapsing them onto
    // one voice is the failure the routing table prevents.
    expect(TTS_VOICE.ar.agent).not.toBe(TTS_VOICE.hi.agent);
    expect(TTS_VOICE.hi.agent).not.toBe(TTS_VOICE.ur.agent);
    expect(TTS_VOICE.ar.agent).not.toBe(TTS_VOICE.ur.agent);
  });
});
