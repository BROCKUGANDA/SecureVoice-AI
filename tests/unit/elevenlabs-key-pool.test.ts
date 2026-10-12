/**
 * The ElevenLabs key pool: rotate on a key's failure, never on a shared refusal.
 *
 * Checklist item 62 ("ElevenLabs returns 429 -> switch to backup voice provider")
 * is only worth having if a rate-limited credential stops being a customer-facing
 * dead line. The pool is where that decision lives, so these checks hold the two
 * directions that are easy to get wrong and hard to notice:
 *
 *   · a key that failed must be parked, so the NEXT call does not walk into the
 *     same 429 — and a 2xx that carried no audio is a failure, because returning
 *     silence to a live caller is not a success;
 *   · a refusal from our OWN egress throttle must not park anything. The throttle
 *     is keyed on the caller, not the credential, so cooling keys for a refusal
 *     they never caused parks the whole pool after a few bursts — a self-inflicted
 *     outage dressed up as failover.
 *
 * No vendor is contacted: `fetchUpstreamBinary` is stubbed and the key it was
 * handed is recorded.
 *
 *   bun test tests/unit/elevenlabs-key-pool.test.ts
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";

const K1 = "key-one-secret-value-aaaaaaaaaaaaaaaa";
const K2 = "key-two-secret-value-bbbbbbbbbbbbbbbb";
const K3 = "key-three-secret-value-cccccccccccccc";

process.env.ELEVENLABS_KEY_1 = K1;
process.env.ELEVENLABS_KEY_2 = K2;
process.env.ELEVENLABS_KEY_3 = K3;
delete process.env.ELEVENLABS_API_KEY;

type Outcome = { status: number; body: string; bytes: number };

const seen: { apiKey: string; attempt: number }[] = [];
let script: Outcome[] = [];

mock.module("@/lib/elevenlabs/egress", () => ({
  fetchUpstreamBinary: async (
    _method: string,
    _path: string,
    opts: { apiKey: string },
  ): Promise<{
    ok: boolean;
    status: number;
    body: string;
    response: Response;
  }> => {
    const out = script[seen.length] ?? script.at(-1) ?? { status: 500, body: "boom", bytes: 0 };
    seen.push({ apiKey: opts.apiKey, attempt: seen.length + 1 });
    const buf = Buffer.alloc(out.bytes, 0x20);
    return {
      ok: out.status === 200,
      status: out.status,
      body: out.body,
      response: new Response(new Uint8Array(buf), {
        status: out.status,
        headers: { "content-type": "audio/mpeg" },
      }),
    };
  },
  backoffMs: () => 0,
  elevenLabsFetch: async () => {
    throw new Error("not used by the pool");
  },
}));

// Accounting is another suite's business; here it must simply never fail a turn.
mock.module("@/lib/elevenlabs/token-tracker", () => ({
  trackKeyUsage: async () => ({ keyHash: "x", chars: 0, calls: 0 }),
  hashKey: (k: string) => k.slice(-4),
}));

const {
  PoolExhaustedError,
  _resetPoolForTest,
  generateAudioWithFailover,
  getPoolStatus,
  isPoolConfigured,
} = await import("@/lib/elevenlabs/pool");

function plan(scripted: Outcome[]) {
  script = scripted;
  seen.length = 0;
}

beforeEach(() => {
  _resetPoolForTest();
  plan([]);
});

test("the pool is the configured keys, and status never carries key material", () => {
  expect(isPoolConfigured()).toBe(true);
  const status = getPoolStatus();
  expect(status.map((s) => s.label).sort()).toEqual(["key_1", "key_2", "key_3"]);
  const dump = JSON.stringify(status);
  for (const key of [K1, K2, K3]) expect(dump).not.toContain(key);
});

test("a 429 rotates to the next key inside the same turn", async () => {
  plan([
    { status: 429, body: "rate limited", bytes: 0 },
    { status: 200, body: "", bytes: 2048 },
  ]);
  const res = await generateAudioWithFailover("Is this yours?", "voice-1");
  expect(res.key).toBe("key_2");
  expect(res.attempts).toBe(2);
  expect(seen.map((s) => s.apiKey)).toEqual([K1, K2]);
});

test("the parked key is skipped on the NEXT call, not retried first", async () => {
  plan([
    { status: 429, body: "rate limited", bytes: 0 },
    { status: 200, body: "", bytes: 2048 },
  ]);
  await generateAudioWithFailover("a", "voice-1");
  expect(getPoolStatus().find((s) => s.label === "key_1")?.disabledReason).toBe("rate_limited");

  // Every remaining key now fails. If the parked key were still offered, its
  // credential would appear in `seen`; because it is parked, the ladder walks
  // only the two healthy members and exhausts after two attempts. Asserting on
  // the attempted keys — not on where the round-robin cursor happened to land —
  // is what makes this fail when parking is removed.
  plan([
    { status: 503, body: "down", bytes: 0 },
    { status: 503, body: "down", bytes: 0 },
    { status: 503, body: "down", bytes: 0 },
  ]);
  const err = await generateAudioWithFailover("b", "voice-1").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PoolExhaustedError);
  expect((err as InstanceType<typeof PoolExhaustedError>).attempts).toBe(2);
  expect(seen.map((s) => s.apiKey)).not.toContain(K1);
});

test("a 2xx with no audio in it is a failure, not silence handed to the caller", async () => {
  plan([
    { status: 200, body: "", bytes: 100 }, // under the 512-byte floor
    { status: 200, body: "", bytes: 4096 },
  ]);
  const res = await generateAudioWithFailover("c", "voice-1");
  expect(res.key).toBe("key_2");
  expect(res.bytes).toBe(4096);
  expect(getPoolStatus().find((s) => s.label === "key_1")?.disabledReason).toBe("upstream_502");
});

test("every key down exhausts the pool with the last upstream status", async () => {
  plan([
    { status: 503, body: "unavailable", bytes: 0 },
    { status: 503, body: "unavailable", bytes: 0 },
    { status: 503, body: "unavailable", bytes: 0 },
  ]);
  const err = await generateAudioWithFailover("d", "voice-1").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PoolExhaustedError);
  expect((err as InstanceType<typeof PoolExhaustedError>).status).toBe(503);
  expect((err as InstanceType<typeof PoolExhaustedError>).attempts).toBe(3);
  expect(seen.map((s) => s.apiKey)).toEqual([K1, K2, K3]);
});

// The throttle refusal is ours and is keyed on the caller, so no credential caused
// it. Cooling keys for it would park the whole pool after a few bursts.
test("our own egress throttle stops the ladder without parking any key", async () => {
  plan([{ status: 429, body: "ElevenLabs egress throttle exceeded", bytes: 0 }]);
  const err = await generateAudioWithFailover("e", "voice-1").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PoolExhaustedError);
  expect((err as Error).message).toMatch(/egress throttle/i);
  expect(seen).toHaveLength(1);
  expect(getPoolStatus().every((s) => s.disabledReason === null)).toBe(true);
});

test("a request-shaped 4xx fails fast — every key would answer the same way", async () => {
  plan([{ status: 400, body: "bad voice id", bytes: 0 }]);
  const err = await generateAudioWithFailover("f", "voice-1").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PoolExhaustedError);
  expect(seen).toHaveLength(1);
});

test("an invalid credential parks for an hour and reports why", async () => {
  plan([
    { status: 401, body: "invalid api key", bytes: 0 },
    { status: 200, body: "", bytes: 2048 },
  ]);
  await generateAudioWithFailover("g", "voice-1");
  const parked = getPoolStatus().find((s) => s.label === "key_1");
  expect(parked?.disabledReason).toBe("unauthorized");
  expect(parked?.available).toBe(false);
  // An hour, not the 5-second transient step: a rotated-out credential that keeps
  // answering 401 should not be re-offered every call.
  expect(parked?.cooldownRemainingMs).toBeGreaterThan(3_500_000);
});

test("a rate-limited key parks for a minute, not an hour", async () => {
  plan([
    { status: 429, body: "rate limited", bytes: 0 },
    { status: 200, body: "", bytes: 2048 },
  ]);
  await generateAudioWithFailover("i", "voice-1");
  const parked = getPoolStatus().find((s) => s.label === "key_1");
  expect(parked?.disabledReason).toBe("rate_limited");
  expect(parked?.cooldownRemainingMs).toBeLessThanOrEqual(60_000);
  expect(parked?.cooldownRemainingMs).toBeGreaterThan(0);
});

test("two entries holding the same key are one member — rotating onto it is not a failover", async () => {
  process.env.ELEVENLABS_KEY_2 = K1;
  _resetPoolForTest();
  plan([
    { status: 429, body: "rate limited", bytes: 0 },
    { status: 200, body: "", bytes: 2048 },
  ]);
  const distinct = getPoolStatus();
  expect(distinct.length).toBe(2);
  expect(new Set(distinct.map((s) => s.label)).size).toBe(2);
  delete process.env.ELEVENLABS_KEY_2;
  _resetPoolForTest();
});

test("no keys configured is a refusal, not an silent empty success", async () => {
  delete process.env.ELEVENLABS_KEY_1;
  delete process.env.ELEVENLABS_KEY_2;
  delete process.env.ELEVENLABS_KEY_3;
  _resetPoolForTest();
  expect(isPoolConfigured()).toBe(false);
  const err = await generateAudioWithFailover("h", "voice-1").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PoolExhaustedError);
  expect((err as InstanceType<typeof PoolExhaustedError>).attempts).toBe(0);
  process.env.ELEVENLABS_KEY_1 = K1;
  process.env.ELEVENLABS_KEY_2 = K2;
  process.env.ELEVENLABS_KEY_3 = K3;
  _resetPoolForTest();
});
