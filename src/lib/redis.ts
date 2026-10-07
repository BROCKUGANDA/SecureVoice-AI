import "server-only";
/**
 * The shared counter backing the ElevenLabs monthly budget.
 *
 * Two implementations behind one shape:
 *
 *   · Redis, when `REDIS_URL` is set. This is the only one that is actually
 *     *monthly*: it survives a restart, a redeploys, and a second instance.
 *     The account ceiling is 10,000 characters and the process does not live a
 *     month, so an in-process counter cannot be the durable answer.
 *   · An in-process Map otherwise — for a single-instance demo, for CI, and as
 *     the declared fallback when Redis is gone.
 *
 * `FALLBACKS.redis` in src/lib/failures/breaker.ts declares what happens when
 * the shared store fails: "conservative in-process limits, logged as degraded".
 * That contract is implemented by the caller (see
 * `src/lib/elevenlabs/egress.ts`), which drops to `localMeter` with a tightened
 * ceiling rather than either refusing every request or pretending the count is
 * complete.
 *
 * The connection is lazy: importing this module never opens a socket, so tests
 * and build-time evaluation cannot hang on a Redis that is not there.
 */

import Redis from "ioredis";

type StoreEntry = { value: number; expiresAt: number };

export type Meter = {
  /** `shared` = durable across processes; `local` = this process only. */
  mode(): "shared" | "local";
  incrBy(key: string, delta: number): Promise<number>;
  decrBy(key: string, delta: number): Promise<number>;
  expire(key: string, ttlSec: number): Promise<void>;
  /** Test helper — clears in-process counters. */
  _reset(): void;
};

/* ── In-process store ──────────────────────────────────────────────────────── */

const store = new Map<string, StoreEntry>();

function read(key: string): number {
  const hit = store.get(key);
  if (!hit) return 0;
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    return 0;
  }
  return hit.value;
}

function write(key: string, value: number): void {
  const prev = store.get(key);
  store.set(key, { value, expiresAt: prev?.expiresAt ?? Number.MAX_SAFE_INTEGER });
}

export const localMeter: Meter = {
  mode: () => "local",
  async incrBy(key, delta) {
    const next = read(key) + delta;
    write(key, next);
    return next;
  },
  async decrBy(key, delta) {
    const next = read(key) - delta;
    write(key, next);
    return next;
  },
  async expire(key, ttlSec) {
    const hit = store.get(key);
    if (hit) hit.expiresAt = Date.now() + ttlSec * 1000;
  },
  _reset() {
    store.clear();
  },
};

/* ── Redis store ───────────────────────────────────────────────────────────── */

let client: Redis | null = null;

/** True when a durable meter is configured. */
export function sharedMeterConfigured(): boolean {
  return !!process.env.REDIS_URL;
}

/**
 * A production Redis connection must be encrypted (`rediss://`).
 *
 * The meter carries only budget counters — no PII — so the harm of a plaintext
 * hop is smaller than the database's, but it is not zero: an attacker who can
 * read the shared ceiling can time requests to it, and one who can write it can
 * silently raise the limit the guard enforces. Like the database's own check
 * (src/lib/db-transport.ts), the one defensible plaintext hop is a private
 * network the operator controls, and that is allowed only by explicit opt-in —
 * docker-compose sets the variable for its internal network.
 *
 * Thrown from `connect()`, not at import: the meter's declared failure mode is
 * loud degradation (the caller drops to the in-process counter and logs), so a
 * production misconfiguration degrades visibly instead of taking the process
 * down. The message names the escape variable, so the log line is actionable.
 */
export function assertRedisTransportIsEncrypted(
  url: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!url) return;
  if (env.NODE_ENV !== "production") return;
  if (env.REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK === "true") return;
  if (/^rediss:\/\//i.test(url.trim())) return;
  throw new Error(
    "REDIS_URL must use rediss:// in production. The counter it backs is the ElevenLabs " +
      "budget ceiling; a plaintext connection can be read or rewritten in transit. On a " +
      "private network you control, set REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK=true to " +
      "acknowledge that explicitly (docker-compose does).",
  );
}

function connect(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  assertRedisTransportIsEncrypted(url);
  if (!client) {
    client = new Redis(url, {
      // Fail fast rather than queue: the caller has a declared degraded path,
      // and an offline queue would hold budget decisions open through an outage.
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_500,
      commandTimeout: 1_500,
    });
    // ioredis re-emits connection errors on the instance; without a listener an
    // outage becomes an unhandled 'error' event and takes the process down.
    client.on("error", () => undefined);
  }
  return client;
}

export const sharedMeter: Meter = {
  mode: () => "shared",
  async incrBy(key, delta) {
    return connect().incrby(key, delta);
  },
  async decrBy(key, delta) {
    return connect().decrby(key, delta);
  },
  async expire(key, ttlSec) {
    await connect().expire(key, ttlSec);
  },
  _reset() {
    client?.disconnect();
    client = null;
    store.clear();
  },
};

/**
 * The meter the budget guard uses: Redis when configured, in-process otherwise.
 * Kept as a single exported object (and mutable, for tests) so the call site in
 * egress.ts reads the same whether or not durable infrastructure is present.
 */
export const redis: Meter = {
  mode: () => (sharedMeterConfigured() ? "shared" : "local"),
  incrBy: (key, delta) =>
    sharedMeterConfigured() ? sharedMeter.incrBy(key, delta) : localMeter.incrBy(key, delta),
  decrBy: (key, delta) =>
    sharedMeterConfigured() ? sharedMeter.decrBy(key, delta) : localMeter.decrBy(key, delta),
  expire: (key, ttl) =>
    sharedMeterConfigured() ? sharedMeter.expire(key, ttl) : localMeter.expire(key, ttl),
  _reset() {
    sharedMeter._reset();
    localMeter._reset();
  },
};

/**
 * The degraded meter: always in-process, so a Redis outage narrows the count to
 * one instance instead of losing it.
 */
export const degradedMeter: Meter = localMeter;

export type SharedStore = Meter;
