/**
 * TtlCache behaviour that matters on a request path.
 *
 * The properties here are the ones that are easy to get subtly wrong and hard
 * to notice: a cache that caches failures turns a transient blip into a sticky
 * outage, and a cache without single-flight issues N loads for N concurrent
 * misses, which on a 277ms round-trip is a thundering herd.
 *
 * Uses an injected clock so TTL behaviour is tested without sleeping.
 *
 *   bun test tests/unit/cache.test.ts
 */
import { test, expect, describe } from "bun:test";
import { TtlCache } from "@/lib/cache";

describe("TtlCache", () => {
  test("returns a stored value before it expires", async () => {
    let now = 1000;
    const cache = new TtlCache<number>({ ttlMs: 100, now: () => now });
    await cache.resolve("k", async () => 42);
    expect(cache.get("k")).toBe(42);
    now += 99;
    expect(cache.get("k")).toBe(42);
  });

  test("expires exactly at the TTL boundary", async () => {
    let now = 1000;
    const cache = new TtlCache<number>({ ttlMs: 100, now: () => now });
    await cache.resolve("k", async () => 1);
    now += 100; // expiresAt <= now
    expect(cache.get("k")).toBeUndefined();
  });

  test("single-flight: concurrent misses share ONE load", async () => {
    // The bug this prevents: `if (!cache.has(k)) return load()` runs the loader
    // for every concurrent miss.
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const loader = async () => {
      loads += 1;
      await gate;
      return "value";
    };

    const all = Promise.all([
      cache.resolve("same", loader),
      cache.resolve("same", loader),
      cache.resolve("same", loader),
      cache.resolve("same", loader),
    ]);
    release();
    const results = await all;

    expect(loads).toBe(1);
    for (const r of results) expect(r).toBe("value");
  });

  test("a rejected load propagates and is NOT cached", async () => {
    // Caching a failure would make a transient database error sticky for the
    // whole TTL — the outage would outlive its own cause.
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    await expect(
      cache.resolve("k", async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");

    expect(cache.get("k")).toBeUndefined();

    let attempts = 0;
    const recovered = await cache.resolve("k", async () => {
      attempts += 1;
      return "back";
    });
    expect(recovered).toBe("back");
    expect(attempts).toBe(1);
  });

  test("a rejected load does not poison later callers with the same key", async () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    await expect(
      cache.resolve("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();
    // The inflight entry must have been cleared in `finally`, otherwise every
    // subsequent caller would replay the same rejected promise forever.
    expect(await cache.resolve("k", async () => "ok")).toBe("ok");
  });

  test("evicts least-recently-used once maxEntries is reached", async () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    await cache.resolve("a", async () => 1);
    await cache.resolve("b", async () => 2);
    // Touch "a" so "b" becomes the least recently used.
    expect(cache.get("a")).toBe(1);
    await cache.resolve("c", async () => 3);

    expect(cache.size).toBeLessThanOrEqual(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("a")).toBe(1);
  });

  test("invalidate() drops one key, or everything", async () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000 });
    await cache.resolve("a", async () => 1);
    await cache.resolve("b", async () => 2);

    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);

    cache.invalidate();
    expect(cache.size).toBe(0);
  });
});
