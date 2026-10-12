import { describe, expect, test } from "bun:test";
/**
 * Gates `withFirstChunkDeadline`, the guard that decides whether a stalled
 * synthesis vendor becomes a silent caller or a spoken fallback.
 *
 * The behaviour under test is deliberately asymmetric, and these tests hold the
 * asymmetry: a deadline on the FIRST chunk is what protects the caller, and a
 * deadline on the whole stream would sever every normal sentence. A suite that
 * only asserted "slow stream throws" would pass against a whole-stream timeout,
 * which is the bug this helper exists to avoid.
 */
import { withFirstChunkDeadline } from "@/lib/voice/first-audio-deadline";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Source = { values: number[]; closed: boolean };

/**
 * An async source that waits `firstDelay` before its first value and
 * `restDelay` before each one after, and records whether it was closed.
 */
async function* makeSource(
  out: Source,
  firstDelay: number,
  restDelay: number,
): AsyncGenerator<number> {
  try {
    for (const [i, value] of out.values.entries()) {
      await sleep(i === 0 ? firstDelay : restDelay);
      yield value;
    }
  } finally {
    out.closed = true;
  }
}

const drained = async (it: AsyncGenerator<number>) => {
  const seen: number[] = [];
  for await (const v of it) seen.push(v);
  return seen;
};

describe("first-audio deadline", () => {
  test("a prompt source yields every value in order", async () => {
    const out: Source = { values: [1, 2, 3], closed: false };
    const seen = await drained(
      withFirstChunkDeadline(makeSource(out, 1, 1), { ms: 500, label: "tts" }),
    );
    expect(seen).toEqual([1, 2, 3]);
  });

  test("a source that never produces a first chunk throws and fires onExpired", async () => {
    const out: Source = { values: [1, 2], closed: false };
    let expired = false;
    let message = "";
    try {
      await drained(
        withFirstChunkDeadline(makeSource(out, 300, 1), {
          ms: 40,
          label: "elevenlabs-stream",
          onExpired: () => {
            expired = true;
          },
        }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("elevenlabs-stream produced no audio within 40ms");
    expect(expired).toBe(true);
  });

  // The other half of the contract: once audio is flowing, time is not bounded.
  // This is the assertion that fails if the deadline is ever widened to the
  // whole stream — the change that would cut off real speech on every call.
  test("a slow SECOND chunk is not interrupted", async () => {
    const out: Source = { values: [1, 2, 3], closed: false };
    let expired = false;
    const seen = await drained(
      withFirstChunkDeadline(makeSource(out, 5, 120), {
        ms: 40,
        label: "tts",
        onExpired: () => {
          expired = true;
        },
      }),
    );
    expect(seen).toEqual([1, 2, 3]);
    expect(expired).toBe(false);
  });

  test("ms <= 0 disables the deadline", async () => {
    const out: Source = { values: [1], closed: false };
    const seen = await drained(
      withFirstChunkDeadline(makeSource(out, 80, 1), { ms: 0, label: "tts" }),
    );
    expect(seen).toEqual([1]);
  });

  test("a consumer that breaks early closes the vendor stream", async () => {
    const out: Source = { values: [1, 2, 3, 4], closed: false };
    const it = withFirstChunkDeadline(makeSource(out, 1, 1), { ms: 500, label: "tts" });
    for await (const _ of it) {
      expect(_).toBe(1);
      break;
    }
    expect(out.closed).toBe(true);
  });

  test("an empty source ends without throwing", async () => {
    const out: Source = { values: [], closed: false };
    const seen = await drained(
      withFirstChunkDeadline(makeSource(out, 1, 1), { ms: 500, label: "tts" }),
    );
    expect(seen).toEqual([]);
  });

  test("a source that rejects on the first next() propagates the rejection", async () => {
    async function* boom(): AsyncGenerator<number> {
      throw new Error("vendor 503");
      // unreachable; keeps the generator's type an AsyncGenerator<number>
      yield 1;
    }
    let expired = false;
    let message = "";
    try {
      await drained(
        withFirstChunkDeadline(boom(), {
          ms: 1_000,
          label: "tts",
          onExpired: () => (expired = true),
        }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe("vendor 503");
    // A rejection is the vendor answering with an error, not stalling — the
    // deadline must not be blamed for it.
    expect(expired).toBe(false);
  });
});
