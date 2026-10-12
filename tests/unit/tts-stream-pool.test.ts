/**
 * THE POOLED KEY ON THE LIVE STREAM — failover for the transport that speaks.
 *
 * `src/lib/elevenlabs/pool.ts` has rotated eight keys with a 60 s park on a 429
 * and a six-hour park on a 422 out-of-credits since it was written, and the
 * media-stream worker never used it: every customer call synthesised on
 * `ELEVENLABS_API_KEY` alone, so one exhausted account meant silence on every
 * live conversation while the demo endpoints rotated fine. These tests drive
 * `streamWithKeyPool` and the real `ElevenLabsStream` against a stubbed SDK, so
 * what is proven is the rotation, the parking, and the line where rotating stops
 * being helpful.
 *
 * The distinction that makes this safe to run against a vendor at all: only
 * OPENING a stream is retried. Once bytes are flowing, a second attempt would
 * splice duplicate audio into a customer's ear — so a mid-stream failure is the
 * call's to end, and no test here expects one to be retried.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

let streamRequests: string[] = [];
let outcomes: (number | "ok")[] = ["ok"];
let readerChunks: Uint8Array[] = [new Uint8Array([1, 2, 3, 4])];

mock.module("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class {
    constructor(private opts: { apiKey: string }) {}
    textToSpeech = {
      stream: async (_voiceId: string, _body: unknown) => {
        streamRequests.push(this.opts.apiKey);
        const outcome = outcomes[Math.min(streamRequests.length - 1, outcomes.length - 1)] ?? "ok";
        if (outcome !== "ok") {
          const err = new Error(`ElevenLabs upstream ${outcome}`) as Error & { statusCode: number };
          err.statusCode = outcome;
          throw err;
        }
        const chunks = readerChunks;
        let i = 0;
        return {
          getReader: () => ({
            read: async () =>
              i < chunks.length
                ? { done: false, value: chunks[i++] }
                : { done: true, value: undefined },
            releaseLock: () => {},
          }),
        };
      },
    };
  },
}));

const { _resetPoolForTest, getPoolStatus, streamWithKeyPool, PoolExhaustedError } =
  await import("@/lib/elevenlabs/pool");
const { ElevenLabsStream } = await import("@/lib/voice/elevenlabs-stream");

const SAVED = {
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_KEY_1: process.env.ELEVENLABS_KEY_1,
  ELEVENLABS_KEY_2: process.env.ELEVENLABS_KEY_2,
  ELEVENLABS_KEY_3: process.env.ELEVENLABS_KEY_3,
};

function configurePool(keys: string[]): void {
  for (let i = 1; i <= 3; i++) delete process.env[`ELEVENLABS_KEY_${i}`];
  keys.forEach((k, i) => {
    process.env[`ELEVENLABS_KEY_${i + 1}`] = k;
  });
}

async function poolStream(input?: Parameters<typeof streamWithKeyPool>[0]) {
  return streamWithKeyPool(
    input ?? {
      open: async (key) => {
        streamRequests.push(key);
        const outcome = outcomes[Math.min(streamRequests.length - 1, outcomes.length - 1)] ?? "ok";
        if (outcome !== "ok") {
          const err = new Error(`upstream ${outcome}`) as Error & { statusCode: number };
          err.statusCode = outcome;
          throw err;
        }
        return "stream";
      },
      statusOf: (err) => (err as { statusCode?: number })?.statusCode ?? 0,
    },
  );
}

beforeEach(() => {
  streamRequests = [];
  outcomes = ["ok"];
  readerChunks = [new Uint8Array([1, 2, 3, 4])];
  configurePool(["k1", "k2"]);
  delete process.env.ELEVENLABS_API_KEY;
  _resetPoolForTest();
});

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetPoolForTest();
});

describe("the stream rotates when a key is unhealthy", () => {
  test("a 429 on the first key is answered by the second", async () => {
    outcomes = [429, "ok"];
    const opened = await poolStream();
    expect(opened.value).toBe("stream");
    expect(opened.attempts).toBe(2);
    expect(streamRequests).toEqual(["k1", "k2"]);
  });

  test("the rotated-away key is PARKED, in the pool the buffered route also uses", async () => {
    // One cooldown table for both transports is the point: a key that ran out
    // mid-call must not be handed to the next console synthesis either. Asserted
    // through `getPoolStatus`, which is what that other route reads.
    outcomes = [429, "ok"];
    await poolStream();
    const parked = getPoolStatus().find((s) => s.label === "key_1");
    expect(parked).toBeDefined();
    expect(parked?.available).toBe(false);
    expect(getPoolStatus().find((s) => s.label === "key_2")?.available).toBe(true);
  });

  test("a 422 out-of-credits parks for hours, not seconds", async () => {
    outcomes = [422, "ok"];
    await poolStream();
    const parked = getPoolStatus().find((s) => s.label === "key_1")!;
    // Six hours is the credits cooldown. A 60 s park on an exhausted account
    // would re-offer the same dead key to the next caller a minute later.
    expect(parked.cooldownRemainingMs).toBeGreaterThan(5 * 3_600_000);
    expect(parked.disabledReason).not.toBeNull();
  });

  test("every key failing ends in one typed exhaustion, not a silent stream", async () => {
    outcomes = [429, 503];
    let caught: unknown = null;
    try {
      await poolStream();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PoolExhaustedError);
    expect((caught as InstanceType<typeof PoolExhaustedError>).attempts).toBe(2);
  });

  test("all keys cooling down attempts nothing and says so", async () => {
    outcomes = [429, 429];
    await poolStream().catch(() => undefined);
    streamRequests = [];
    outcomes = ["ok"];
    let caught: unknown = null;
    try {
      await poolStream();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PoolExhaustedError);
    expect((caught as InstanceType<typeof PoolExhaustedError>).status).toBe(503);
    expect(streamRequests, "a parked key was tried anyway").toHaveLength(0);
  });
});

describe("rotating is not always the answer", () => {
  test("a request-shaped 400 fails fast on the FIRST key", async () => {
    outcomes = [400, "ok"];
    let caught: unknown = null;
    try {
      await poolStream();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PoolExhaustedError);
    expect((caught as InstanceType<typeof PoolExhaustedError>).status).toBe(400);
    // Every key holds the same text and the same voice id. Trying the second one
    // spends the pool to learn the answer we already have.
    expect(streamRequests).toEqual(["k1"]);
  });

  test("an error with no readable status rotates to the next key", async () => {
    outcomes = ["ok"];
    const opened = await poolStream({
      open: async (key) => {
        streamRequests.push(key);
        if (streamRequests.length === 1) throw new Error("socket hang up");
        return "stream";
      },
      statusOf: (err) => (err as { statusCode?: number })?.statusCode ?? 0,
    });
    expect(opened.attempts).toBe(2);
    expect(streamRequests).toEqual(["k1", "k2"]);
  });
});

describe("a tenant's own key comes first and is not pooled", () => {
  test("the preferred key serves and no pool key is touched", async () => {
    const opened = await poolStream({
      open: async (key) => {
        streamRequests.push(key);
        return "stream";
      },
      statusOf: () => 0,
      preferred: { key: "tenant-key", label: "caller" },
    });
    expect(opened.key).toBe("caller");
    expect(streamRequests).toEqual(["tenant-key"]);
  });

  test("a dead tenant key falls through to the platform pool", async () => {
    // The same posture the buffered ladder takes: their voice first, our account's
    // audio rather than silence.
    outcomes = [429, "ok"];
    let seen = 0;
    const opened = await poolStream({
      open: async (key) => {
        streamRequests.push(key);
        seen += 1;
        if (seen === 1) {
          const err = new Error("upstream 429") as Error & { statusCode: number };
          err.statusCode = 429;
          throw err;
        }
        return "stream";
      },
      statusOf: (err) => (err as { statusCode?: number })?.statusCode ?? 0,
      preferred: { key: "tenant-key", label: "caller" },
    });
    expect(streamRequests[0]).toBe("tenant-key");
    expect(["k1", "k2"]).toContain(streamRequests[1] ?? "");
    expect(opened.key).not.toBe("caller");
  });

  test("a tenant key rejected for the REQUEST does not burn our pool", async () => {
    let caught: unknown = null;
    try {
      await poolStream({
        open: async (key) => {
          streamRequests.push(key);
          const err = new Error("upstream 400 invalid voice id") as Error & {
            statusCode: number;
          };
          err.statusCode = 400;
          throw err;
        },
        statusOf: (err) => (err as { statusCode?: number })?.statusCode ?? 0,
        preferred: { key: "tenant-key", label: "caller" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PoolExhaustedError);
    expect(streamRequests, "a bad request was replayed against our own keys").toEqual([
      "tenant-key",
    ]);
  });

  test("the tenant's key is never parked in our pool state", () => {
    const labels = getPoolStatus().map((s) => s.label);
    expect(labels).not.toContain("caller");
  });
});

describe("the live transport itself", () => {
  async function synth(voiceKeyValue = "k1") {
    configurePool([voiceKeyValue, "k2"]);
    delete process.env.ELEVENLABS_API_KEY;
    _resetPoolForTest();
    streamRequests = [];
    const stream = new ElevenLabsStream();
    const chunks: Buffer[] = [];
    for await (const c of stream.streamText("This call is recorded to protect you.", {
      apiKey: process.env.ELEVENLABS_API_KEY ?? "",
      voiceId: "voice-en",
    })) {
      chunks.push(c);
    }
    return { stream, chunks };
  }

  test("a 429 on the platform key still delivers audio, from the next key", async () => {
    outcomes = [429, "ok"];
    const { chunks, stream } = await synth();
    expect(chunks.length).toBeGreaterThan(0);
    expect(stream.servedKey).toBe("key_2");
    expect(streamRequests).toEqual(["k1", "k2"]);
  });

  test("one key configured behaves exactly as it did before", async () => {
    configurePool(["only-key"]);
    outcomes = ["ok"];
    streamRequests = [];
    const stream = new ElevenLabsStream();
    const chunks: Buffer[] = [];
    for await (const c of stream.streamText("Hello there.", {
      apiKey: "only-key",
      voiceId: "voice-en",
    })) {
      chunks.push(c);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(stream.servedKey).toBe("key_1");
    // The caller named a key the pool already holds, so it was tried ONCE. Two
    // turns of the queue for one key is dead air bought with a round trip.
    expect(streamRequests).toEqual(["only-key"]);
  });

  test("cancel() stops the flow and never re-opens on another key", async () => {
    outcomes = ["ok"];
    configurePool(["k1", "k2"]);
    _resetPoolForTest();
    streamRequests = [];
    readerChunks = [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new Uint8Array([5, 6]),
      new Uint8Array([7, 8]),
    ];
    const stream = new ElevenLabsStream();
    const it = stream.streamText("A long sentence that the caller interrupts.", {
      apiKey: "k1",
      voiceId: "voice-en",
    });
    const first = await it.next();
    stream.cancel();
    const rest = [];
    for await (const c of it) rest.push(c);
    expect(first.done).toBe(false);
    // Barge-in ends THIS stream. Retrying across keys here would speak the
    // sentence twice into the customer's ear.
    expect(rest).toHaveLength(0);
    expect(streamRequests).toHaveLength(1);
  });

  test("an unrecognisable error reads as a transport fault, not a 4xx", async () => {
    // A guessed 4xx would park a healthy key on prose we failed to parse.
    configurePool(["k1", "k2"]);
    _resetPoolForTest();
    streamRequests = [];
    outcomes = ["ok"];
    let caught: unknown = null;
    try {
      await streamWithKeyPool({
        open: async () => {
          throw new Error("everything went wrong at 12 o'clock");
        },
        statusOf: (err) => (err as { statusCode?: number })?.statusCode ?? 0,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PoolExhaustedError);
    // A transport fault earns the SHORT transient cooldown, never the six-hour
    // credits park: both keys were healthy, the socket was not.
    expect(getPoolStatus().every((s) => s.cooldownRemainingMs < 60_000)).toBe(true);
  });
});
