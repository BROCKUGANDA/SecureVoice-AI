/**
 * The warm audio cache — the mechanism behind "first audio out" being a memory
 * read instead of a vendor round-trip.
 *
 * The synthesizer is injected: these tests assert CACHE behaviour (keying,
 * hits, misses, eviction, bounds, failure handling) without a network call,
 * because the thing under test is the cache and not ElevenLabs.
 */
import { describe, expect, it } from "bun:test";

import {
  MAX_ENTRIES_PER_LANG,
  _resetWarmCache,
  _setSynthesizerForTests,
  getWarmChunks,
  hasWarmChunks,
  storeWarmChunks,
  warmKey,
  warmPhrase,
  warmPhrases,
  warmStats,
  type WarmStats,
} from "@/lib/voice/warm-audio";

/** A synthesizer that yields deterministic bytes per phrase and counts calls. */
function fakeSynth(counter: { calls: number }) {
  return async function* (lang: string, text: string): AsyncGenerator<Buffer> {
    counter.calls += 1;
    yield Buffer.from([1, 2, 3]);
    yield Buffer.from([4, 5, 6]);
    void lang;
    void text;
  };
}

describe("warm audio — keying and lookup", () => {
  it("stores and returns chunks keyed by the exact phrase", () => {
    _resetWarmCache();
    storeWarmChunks("en", "Hello there", [Buffer.from([9, 9])]);
    expect(getWarmChunks("en", "Hello there")).toEqual([Buffer.from([9, 9])]);
    expect(getWarmChunks("en", "hello there")).toBeNull(); // case-sensitive
    expect(getWarmChunks("ar", "Hello there")).toBeNull(); // language-scoped
  });

  it("ignores empty chunk lists", () => {
    _resetWarmCache();
    storeWarmChunks("en", "nothing", []);
    expect(hasWarmChunks("en", "nothing")).toBe(false);
  });

  it("keys are stable hashes of the text", () => {
    expect(warmKey("same")).toBe(warmKey("same"));
    expect(warmKey("same")).not.toBe(warmKey("different"));
  });
});

describe("warm audio — warming through the synthesizer", () => {
  it("synthesises once and serves every later call from cache", async () => {
    _resetWarmCache();
    const counter = { calls: 0 };
    _setSynthesizerForTests(fakeSynth(counter));

    const ok = await warmPhrase("en", "This call is recorded to protect you.");
    expect(ok).toBe(true);
    expect(counter.calls).toBe(1);

    // The second warm of the same phrase still synthesises (warming is not a
    // lookup), but the CALL path reads from cache and never touches it.
    expect(getWarmChunks("en", "This call is recorded to protect you.")).toEqual([
      Buffer.from([1, 2, 3]),
      Buffer.from([4, 5, 6]),
    ]);
    const stats: WarmStats = warmStats();
    expect(stats.warmed).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.entries).toBe(1);
  });

  it("counts hits and misses so the observability is real", () => {
    _resetWarmCache();
    storeWarmChunks("en", "warm", [Buffer.from([1])]);
    getWarmChunks("en", "warm"); // hit
    getWarmChunks("en", "cold"); // miss
    const stats = warmStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it("a failing synthesis fails the phrase, never the call", async () => {
    _resetWarmCache();
    _setSynthesizerForTests(async function* (): AsyncGenerator<Buffer> {
      throw new Error("vendor exploded");
    });
    const ok = await warmPhrase("en", "doomed phrase");
    expect(ok).toBe(false);
    expect(warmStats().failed).toBe(1);
    expect(hasWarmChunks("en", "doomed phrase")).toBe(false);
  });

  it("an empty synthesis is treated as a failure, not a cache entry", async () => {
    _resetWarmCache();
    _setSynthesizerForTests(async function* (): AsyncGenerator<Buffer> {
      // yields nothing
    });
    const ok = await warmPhrase("en", "silence");
    expect(ok).toBe(false);
    expect(hasWarmChunks("en", "silence")).toBe(false);
  });

  it("warms a whole list, sequentially, reporting both outcomes", async () => {
    _resetWarmCache();
    let n = 0;
    _setSynthesizerForTests(async function* (): AsyncGenerator<Buffer> {
      n += 1;
      if (n === 2) throw new Error("second phrase fails");
      yield Buffer.from([n]);
    });
    const result = await warmPhrases("en", ["one", "two", "three"]);
    expect(result.warmed).toBe(2);
    expect(result.failed).toBe(1);
    // The third phrase was still attempted after the second failed: one bad
    // phrase must not abandon the rest of the warm.
    expect(hasWarmChunks("en", "three")).toBe(true);
  });
});

describe("warm audio — bounds", () => {
  it("evicts the oldest entry past the per-language cap", () => {
    _resetWarmCache();
    for (let i = 0; i < MAX_ENTRIES_PER_LANG + 4; i++) {
      storeWarmChunks("en", `phrase-${i}`, [Buffer.from([i])]);
    }
    const stats = warmStats();
    expect(stats.entries).toBe(MAX_ENTRIES_PER_LANG);
    // The newest survive, the oldest are gone.
    expect(hasWarmChunks("en", `phrase-${MAX_ENTRIES_PER_LANG + 3}`)).toBe(true);
    expect(hasWarmChunks("en", "phrase-0")).toBe(false);
  });

  it("tracks languages independently", () => {
    _resetWarmCache();
    storeWarmChunks("en", "a", [Buffer.from([1])]);
    storeWarmChunks("ur", "a", [Buffer.from([2])]);
    expect(getWarmChunks("en", "a")).toEqual([Buffer.from([1])]);
    expect(getWarmChunks("ur", "a")).toEqual([Buffer.from([2])]);
    expect(warmStats().entries).toBe(2);
  });
});
