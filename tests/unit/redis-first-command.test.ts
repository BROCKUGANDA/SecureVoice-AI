/**
 * UNIT — the shared meter must await its own first connection.
 *
 * Separate file because it `mock.module("ioredis")`, and Bun's module mocks are
 * process-global — see the same reasoning in `ratelimit-redis.test.ts`.
 *
 * The bug this pins is measured in production, not imagined. The first metered request
 * after every app boot logged
 *
 *   shared meter unreachable, degrading to in-process limits:
 *   Stream isn't writeable and enableOfflineQueue options is false
 *
 * against a Redis that answers `PONG`. That sentence is ioredis's own rejection, issued
 * for any command sent while the stream is not writable with the offline queue disabled,
 * and with `lazyConnect: true` the first command IS the thing that starts the connection —
 * so the first request of every process was guaranteed to be charged to the per-process
 * meter on a perfectly healthy server. The fleet-wide ElevenLabs budget ceiling and the
 * persisted token usage both live behind this call.
 *
 * The outage path has to survive the fix: a Redis that cannot be reached must still reject,
 * so the caller degrades loudly with a tightened ceiling instead of hanging on a budget
 * decision. `enableOfflineQueue: false` stays, for that reason.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Status = "wait" | "connecting" | "ready" | "end";

/**
 * ioredis's documented behaviour, reimplemented — the message text and the two rejection
 * rules are quoted from the vendor (`lib/Redis.ts` and the `connect()` doc), not invented.
 */
class FakeRedis {
  status: Status = "wait";
  connects = 0;
  commands = 0;
  /** Set to make the connection itself fail, i.e. a Redis that is not there. */
  static failConnect = false;
  /** Set to make connect() refuse because a socket is already coming up. */
  static refuseConnect = false;
  static instance: FakeRedis | null = null;

  constructor(
    public url: string,
    public options: Record<string, unknown>,
  ) {
    FakeRedis.instance = this;
  }

  on(_event: string, _fn: (...args: any[]) => void) {
    return this;
  }

  connect(): Promise<void> {
    this.connects++;
    if (FakeRedis.refuseConnect) {
      return Promise.reject(new Error("Connection is already connected."));
    }
    if (this.status === "connecting" || this.status === "ready") {
      return Promise.reject(new Error("Connection is already connected."));
    }
    if (FakeRedis.failConnect) {
      this.status = "end";
      return Promise.reject(new Error("ECONNREFUSED"));
    }
    this.status = "connecting";
    return new Promise((resolve) => {
      setTimeout(() => {
        this.status = "ready";
        resolve();
      }, 1);
    });
  }

  private send(): never | Promise<number> {
    this.commands++;
    if (this.status !== "ready") {
      return Promise.reject(
        new Error("Stream isn't writeable and enableOfflineQueue options is false"),
      );
    }
    return Promise.resolve(this.commands);
  }

  incrby(_key: string, _delta: number) {
    return this.send();
  }
  decrby(_key: string, _delta: number) {
    return this.send();
  }
  expire(_key: string, _ttl: number) {
    return this.send();
  }
  disconnect() {
    this.status = "end";
  }
}

mock.module("ioredis", () => ({ default: FakeRedis }));

const { sharedMeter } = await import("@/lib/redis");

const savedUrl = process.env.REDIS_URL;
const savedAllow = process.env.REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK;

beforeEach(() => {
  process.env.REDIS_URL = "redis://fake:6379";
  process.env.REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK = "true";
  FakeRedis.failConnect = false;
  FakeRedis.refuseConnect = false;
  FakeRedis.instance = null;
  sharedMeter._reset();
});

afterEach(() => {
  sharedMeter._reset();
  FakeRedis.failConnect = false;
  FakeRedis.refuseConnect = false;
  if (savedUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedUrl;
  if (savedAllow === undefined) delete process.env.REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK;
  else process.env.REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK = savedAllow;
});

describe("sharedMeter — the first command must not be sacrificed to laziness", () => {
  test("importing the module opens no socket, and the first command still counts", async () => {
    // The laziness this file must not regress: constructing the client is deferred so
    // that build-time evaluation and tests cannot hang on a Redis that is not there.
    expect(FakeRedis.instance).toBeNull();

    const value = await sharedMeter.incrBy("elevenlabs:budget:2026-10", 120);

    const client = FakeRedis.instance!;
    expect(value).toBe(1);
    expect(client.status).toBe("ready");
    expect(client.connects).toBe(1);
  });

  test("concurrent first requests connect exactly once", async () => {
    const three = await Promise.all([
      sharedMeter.incrBy("k", 1),
      sharedMeter.incrBy("k", 1),
      sharedMeter.incrBy("k", 1),
    ]);

    const client = FakeRedis.instance!;
    expect(client.connects).toBe(1);
    expect(three).toEqual([1, 2, 3]);
  });

  test("a later request does not reconnect", async () => {
    await sharedMeter.incrBy("k", 1);
    const client = FakeRedis.instance!;
    await sharedMeter.expire("k", 60);
    await sharedMeter.decrBy("k", 1);

    expect(client.connects).toBe(1);
  });

  test("an unreachable Redis still rejects, so the caller degrades loudly", async () => {
    FakeRedis.failConnect = true;

    expect(sharedMeter.incrBy("k", 1)).rejects.toThrow(/ECONNREFUSED/);
  });

  test("a failed first attempt does not strand the process on the local meter", async () => {
    FakeRedis.failConnect = true;
    await sharedMeter.incrBy("k", 1).catch(() => undefined);

    // The server comes back. Without clearing the cached promise this instance would
    // keep rejecting for the life of the process.
    FakeRedis.failConnect = false;
    const value = await sharedMeter.incrBy("k", 1);
    expect(value).toBeGreaterThan(0);
  });

  test("decrBy and expire wait too, not just incrBy", async () => {
    await sharedMeter.decrBy("k", 1);
    const client = FakeRedis.instance!;
    expect(client.status).toBe("ready");
    await sharedMeter.expire("k", 60);
    expect(client.commands).toBe(2);
  });

  test("an in-flight connect is not reported as the outage error", async () => {
    // A socket already coming up makes connect() refuse. That must be swallowed and the
    // command allowed to decide, so the reason the caller degrades is the real condition —
    // the stream is not writable — and not an internal detail of the client.
    FakeRedis.refuseConnect = true;

    const err = await sharedMeter.incrBy("k", 1).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain("Stream isn't writeable");
    expect(err?.message).not.toContain("already connected");
  });
});
