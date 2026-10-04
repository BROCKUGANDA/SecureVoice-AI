/**
 * A small TTL cache with single-flight de-duplication.
 *
 * ## Why this exists
 *
 * Measured against the hosted database, one round-trip costs ~277ms of network
 * and the server executes the query in ~0.015ms. Cold TCP+TLS setup costs
 * ~1271ms. So the cost of a read here is almost entirely the trip, and the only
 * lever that moves it is *asking fewer times*. Indexes cannot help: the plans are
 * already index-only scans. Neither can rewriting the SQL.
 *
 * ## What must never go in here
 *
 * Authorization decisions, consent state, and anything that gates money or a
 * call. A cached "this customer has not opted out" is a compliance breach waiting
 * for a cache expiry, and consent in particular must be re-read on every call:
 * a customer who opts out must never be dialled because a five-second-old cache
 * entry said otherwise.
 *
 * What belongs here is reference data that changes on a human timescale —
 * voice metadata, org configuration, tenant feature flags — where a short stale
 * window is acceptable and explicitly bounded.
 *
 * ## Single-flight
 *
 * When N requests miss the same key at once, they share ONE load instead of
 * issuing N. On a 277ms round-trip that is the difference between one slow
 * response and a thundering herd, and it is the part most hand-rolled caches get
 * wrong: a plain `if (!cache.has(k)) await load()` issues every miss.
 */
import "server-only";

type Entry<T> = { value: T; expiresAt: number };

export type CacheOptions = {
  /** Milliseconds the entry stays fresh. */
  ttlMs: number;
  /**
   * Hard cap on entries. A cache without a bound is a memory leak with extra
   * steps, and keys here are derived from request input.
   */
  maxEntries?: number;
  /** Injectable clock, so tests do not have to sleep. */
  now?: () => number;
};

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: CacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 500;
    this.now = opts.now ?? Date.now;
  }

  /** Returns the cached value, or undefined if absent or expired. */
  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh recency so the eviction below drops genuinely cold keys rather
    // than whichever ones happened to be written first.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      // Map preserves insertion order, and `get` re-inserts on hit, so the
      // first key is the least recently used.
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /**
   * Read-through with single-flight.
   *
   * A loader that throws propagates and is NOT cached: caching a failure would
   * turn a transient database blip into a sticky outage for the whole TTL.
   */
  async resolve(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const pending = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, pending);
    return pending;
  }

  /** Drops one key, or everything when called with no argument. */
  invalidate(key?: string): void {
    if (key === undefined) this.store.clear();
    else this.store.delete(key);
  }

  /** Visible for tests and for the metrics endpoint. */
  get size(): number {
    return this.store.size;
  }
}

/**
 * Process-local caches only work while there is one instance. With the
 * multi-replica deployment in Part S behind Caddy, each replica holds its own
 * copy and a value invalidated on one is stale on the others until its TTL
 * expires. That is acceptable for reference data inside the TTL bound and
 * unacceptable for anything else — which is the second reason authorization and
 * consent are excluded above rather than merely discouraged.
 *
 * The fix when it matters is a shared store (Redis is already wired for the
 * realtime pub/sub adapter); until then, keep TTLs short and the cached set
 * small.
 */
export function isSingleInstance(): boolean {
  return !process.env.DEPLOY_REGION || process.env.DEPLOY_REGION === "single";
}
