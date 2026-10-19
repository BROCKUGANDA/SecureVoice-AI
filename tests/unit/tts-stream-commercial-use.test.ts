/**
 * THE LICENCE GATE ON THE PATH THAT SPEAKS TO A CUSTOMER.
 *
 * `src/lib/elevenlabs/egress.ts` enforced `ELEVENLABS_COMMERCIAL_USE` while its own
 * header claimed to be the only code in the repo that opened a socket to ElevenLabs.
 * It was not: this transport builds an `ElevenLabsClient` of its own for live call
 * audio, so a deployment with no commercial plan was gated on the demo and the
 * console and completely open on the phone call — the breach the guard exists to
 * prevent, on the path with a real cardholder listening. Passing the variable to the
 * worker containers in `docker-compose.yml` changed nothing, because nothing on that
 * path read it.
 *
 * The distinction that makes this file worth having: an unattested call must fail
 * LOUD. Returning an empty stream would look identical to a vendor timeout to the
 * worker, so the transport throws, the worker logs the reason and plays the emergency
 * cue. These tests assert both halves — no socket opened, and a message that names
 * the variable to set.
 *
 * No network is touched: the SDK is stubbed, and construction is counted so the
 * "before any vendor call" claim is measured rather than assumed.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let sdkConstructions = 0;

mock.module("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class {
    constructor() {
      sdkConstructions++;
    }
    textToSpeech = {
      stream: async () => {
        const chunks = [new Uint8Array([7, 7, 7])];
        let i = 0;
        return {
          getReader: () => ({
            read: async () =>
              i < chunks.length
                ? { done: false, value: chunks[i++] }
                : { done: true, value: undefined },
            releaseLock: () => {},
            cancel: () => Promise.resolve(),
          }),
        };
      },
    };
  },
}));

const { ElevenLabsStream } = await import("@/lib/voice/elevenlabs-stream");

const OPTIONS = { apiKey: "test-key-must-never-reach-a-vendor", voiceId: "voice-1" };
const SENTENCE = "This call is recorded to protect you.";

const SAVED = process.env.ELEVENLABS_COMMERCIAL_USE;

async function collect(): Promise<{ chunks: Buffer[]; error: string | null }> {
  const stream = new ElevenLabsStream();
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream.streamText(SENTENCE, OPTIONS)) chunks.push(chunk);
    return { chunks, error: null };
  } catch (err) {
    return { chunks, error: err instanceof Error ? err.message : String(err) };
  }
}

beforeEach(() => {
  sdkConstructions = 0;
});

afterEach(() => {
  if (SAVED === undefined) delete process.env.ELEVENLABS_COMMERCIAL_USE;
  else process.env.ELEVENLABS_COMMERCIAL_USE = SAVED;
});

describe("the streaming transport refuses an unattested deployment", () => {
  test("no key set: no client is constructed, and the reason names the variable", async () => {
    delete process.env.ELEVENLABS_COMMERCIAL_USE;
    const { chunks, error } = await collect();

    expect(sdkConstructions).toBe(0);
    expect(chunks).toHaveLength(0);
    expect(error).toContain("ELEVENLABS_COMMERCIAL_USE");
  });

  test("explicitly false is not an attestation", async () => {
    process.env.ELEVENLABS_COMMERCIAL_USE = "false";
    const { error } = await collect();

    expect(sdkConstructions).toBe(0);
    expect(error).toContain("ELEVENLABS_COMMERCIAL_USE");
  });

  test("an empty value is not an attestation either", async () => {
    // The deployment that forgets to set it and the deployment that sets it to ""
    // are the same accident, and `=== "true"` is what makes them the same refusal.
    process.env.ELEVENLABS_COMMERCIAL_USE = "";
    const { error } = await collect();

    expect(sdkConstructions).toBe(0);
    expect(error).toContain("non-commercial use only");
  });

  test("the refusal cites the terms it is enforcing", async () => {
    delete process.env.ELEVENLABS_COMMERCIAL_USE;
    const { error } = await collect();

    // An operator reading the worker log has to learn WHICH licence question this is,
    // not just that something was unset. This is the whole difference between a
    // refused call and a mysteriously robotic one.
    expect(error).toContain("ToS §1(c)(i)");
    expect(error).toContain("PUP §9(a)");
  });
});

describe("the same transport speaks once the plan is attested", () => {
  test("attested: audio flows and the vendor client is opened", async () => {
    process.env.ELEVENLABS_COMMERCIAL_USE = "true";
    const { chunks, error } = await collect();

    expect(error).toBeNull();
    expect(chunks.length).toBeGreaterThan(0);
    expect(sdkConstructions).toBe(1);
  });

  test("the gate sits before the SDK import, not inside the retry loop", async () => {
    // If the check lived after the client was built, a refusal would still cost a
    // socket and a pool attempt. Construction count is the observable.
    delete process.env.ELEVENLABS_COMMERCIAL_USE;
    await collect();
    expect(sdkConstructions).toBe(0);
  });
});
