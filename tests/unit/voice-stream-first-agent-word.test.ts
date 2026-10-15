/**
 * CI drives the Media Streams plane far enough to produce a real latency sample.
 *
 * `answered_to_first_agent_word` HAS producers — two `recordSpan` sites in
 * `src/worker/voice-stream.ts` — yet produced ZERO samples, because nothing in
 * CI ever drove that plane: the worker is a compose service that speaks to
 * Twilio and Deepgram over real sockets, and every test that touched
 * `voice-stream` before this one unit-tested tables and helpers around it. The
 * SLO panel therefore reported the 1.2 s budget as `not_measured` while the code
 * that owns the budget sat fully instrumented. A budget nothing can drive is a
 * claim, not a measurement.
 *
 * This file boots the REAL server (`createServer`, the same entry point the
 * compose service runs), with the vendors stubbed the way the rest of the
 * voice suites stub them (`mock.module`, one Bun process per file — see
 * tests/unit/dial-media-streams-truth.test.ts for the established shape):
 *
 *   · ElevenLabsStream  — yields a couple of audio chunks in memory; no vendor.
 *   · DeepgramLiveClient— records its transcript listeners so the TEST can play
 *                         the caller. The server never opens a socket.
 *   · db / audit chain  — the case lookup resolves; audit rows land nowhere.
 *
 * Then it connects a real WebSocket client (the same `ws` transport Twilio
 * uses), waits for the opening disclosure to drain, injects one FINAL
 * transcript the deterministic router classifies as `clarify` — the
 * holding-line turn, the exact path whose `onFirstAudio` closes
 * `answered_to_first_agent_word` — and asserts on the recorder's in-memory ring
 * (`recentSpans`/`resetSpans`; the JSONL is durability's business, not this
 * test's):
 *
 *   · the span exists, with both timestamps and a plausible duration;
 *   · `attributes.cached` is present, because a p95 that cannot distinguish a
 *     cache hit from a vendor round-trip explains nothing;
 *   · the audio actually went out on the socket — the span's end instant is
 *     the first media frame the client receives for this turn, counted on the
 *     same connection, not a number the test asked the recorder for directly.
 *
 * Origin is asserted `harness` (NODE_ENV is deliberately NOT production here):
 * this file exists to prove the plane is DRIVABLE, and its samples must never
 * be counted toward the production verdict.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { once } from "node:events";
import WebSocket from "ws";

/* ————————————————————————————————— mocks ————————————————————————————————— */

/**
 * The fake ASR client. The server constructs one per connection and registers
 * its transcript listener; the test keeps every instance so it can play the
 * caller's side of the call into the real turn pipeline.
 */
class FakeDeepgramClient {
  static instances: FakeDeepgramClient[] = [];

  transcriptListeners: Array<(text: string, isFinal: boolean) => void> = [];

  constructor(_apiKey: string) {
    FakeDeepgramClient.instances.push(this);
  }

  onTranscript(fn: (text: string, isFinal: boolean) => void): this {
    this.transcriptListeners.push(fn);
    return this;
  }

  onAsrEvent(_fn: (event: unknown) => void): this {
    // Stream death/reconnect is not this test's subject; nothing fires it.
    return this;
  }

  start(_lang: string): void {/* empty */}

  sendMulaw(_buffer: Buffer): void {}

  stop(): void {}

  /** The test playing the caller: one utterance into the real handler. */
  say(text: string, isFinal = true): void {
    for (const fn of this.transcriptListeners) fn(text, isFinal);
  }
}

class FakeElevenLabsStream {
  async *streamText(_text: string, _opts: unknown): AsyncGenerator<Buffer> {
    yield Buffer.from("ci-mock-audio-chunk-1");
    yield Buffer.from("ci-mock-audio-chunk-2");
  }

  cancel(): void {}
}

mock.module("@/lib/voice/deepgram-client", () => ({
  DeepgramLiveClient: FakeDeepgramClient,
  preconnectDeepgram: () => null,
}));

mock.module("@/lib/voice/elevenlabs-stream", () => ({ ElevenLabsStream: FakeElevenLabsStream }));

mock.module("@/lib/db", () => ({
  db: {
    case: {
      // `resolveCaseRef` looks the call up by the provider call-leg sid; the
      // value only feeds audit correlation on this path.
      findFirst: async () => ({ caseRef: "SV-CI-FIRSTWORD" }),
    },
  },
}));

mock.module("@/lib/audit-chain", () => ({ append: async () => "ci-hash" }));

mock.module("@/lib/elevenlabs/sms-fallback", () => ({
  markVoiceFailed: async () => {},
}));

/* ——————————————— boot the real server on a test port ——————————————— */

// `PORT` is read at module load of the worker, so the env must be set before
// the import below — the same mechanism compose uses to place the service.
// PID-derived so parallel suites on one machine cannot collide.
const PORT = 41000 + (process.pid % 20000);
process.env.VOICE_STREAM_PORT = String(PORT);
// Shorten the hard wall-clock cap to its floor; the close handler clears the
// timer anyway, but a stuck socket should not outlive the suite by minutes.
process.env.VOICE_MAX_CALL_SECONDS = "30";

const { createServer } = await import("@/worker/voice-stream");
const { recentSpans, resetSpans } = await import("@/lib/telemetry/spans");

const CALL_SID = "CI-first-word-call";
const BASE = `http://127.0.0.1:${PORT}`;

createServer();

async function waitForHealthz(deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error("voice-stream server never answered /healthz");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Newest-last spans of one name, polled until the deadline or empty. */
async function pollForSpan(span: string, deadlineMs = 5_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const hit = recentSpans(200).filter((s) => s.span === span);
    if (hit.length > 0) return hit;
    if (Date.now() > deadline) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Resolves once `predicate` holds, polling; rejects at the deadline. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  deadlineMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/* ————————————————————————————————— the test ————————————————————————————————— */

let client: WebSocket;
/** Media frames received since the counter was last zeroed. */
let mediaFrames = 0;

beforeAll(async () => {
  resetSpans(); // the ring is process-global; start this suite from zero
  await waitForHealthz();

  client = new WebSocket(
    `ws://127.0.0.1:${PORT}/realtime/media-stream?callSid=${CALL_SID}&lang=en`,
  );
  client.on("message", (data) => {
    try {
      if (JSON.parse(String(data)).event === "media") mediaFrames += 1;
    } catch {
      // ignore non-JSON frames
    }
  });
  await once(client, "open");
  // Wait until the server has built this call's ASR client, so `say()` below
  // speaks into the live connection rather than into nothing.
  await waitFor(
    () => FakeDeepgramClient.instances.length > 0,
    "the server to construct this call's ASR client",
  );
});

afterAll(() => {
  // Clears the server-side nudge and hard-cap timers for this call.
  try {
    client?.close();
  } catch {
    // already closed
  }
});

test("a driven turn makes answered_to_first_agent_word produce a real sample", async () => {
  // A neutral utterance: no denial phrase, no compliance/empathy keyword, no
  // secret request, no injection shape. The deterministic router therefore
  // classifies it `clarify` — the holding-line turn whose `onFirstAudio`
  // closes `answered_to_first_agent_word`. (The fraud branch records the same
  // span name; routing there would drag the soft-freeze path into a latency
  // test, which is not what this budget measures.)
  const utterance = "yellow umbrella rainbow";

  // Let the opening disclosure and safety exit finish: a quiet window with no
  // inbound media means the opener's frames have drained, so everything the
  // counter sees below belongs to THIS turn.
  mediaFrames = 0;
  await waitFor(() => {
    const before = mediaFrames;
    return new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(mediaFrames === before), 400),
    );
  }, "the opening disclosure to drain");
  mediaFrames = 0;
  resetSpans();

  FakeDeepgramClient.instances.at(-1)!.say(utterance, true);

  const spans = await pollForSpan("answered_to_first_agent_word");
  expect(spans.length).toBeGreaterThan(0);

  const record = spans.at(-1)!;
  // Both instants, in order, and a duration a stubbed-vendor turn can plausibly
  // produce: far under the 2 s vendor deadline, never negative.
  expect(record.startedAtMs).toBeLessThanOrEqual(record.endedAtMs);
  expect(record.durationMs).toBe(record.endedAtMs - record.startedAtMs);
  expect(record.durationMs).toBeGreaterThanOrEqual(0);
  expect(record.durationMs).toBeLessThan(10_000);
  // The explainability attribute the span contract promises: cache hit or
  // vendor round-trip, the sample must say which.
  expect(typeof record.attributes.cached).toBe("boolean");
  // Test traffic is harness traffic, and must never read as production.
  expect(record.origin).toBe("harness");
  // The end instant is audio the customer could hear: the turn pushed media
  // frames onto this very socket after the transcript arrived. (The server
  // sends the frame before `onFirstAudio` fires, so the span can win the race;
  // wait for the socket to catch up instead of reading the counter inline.)
  await waitFor(() => mediaFrames > 0, "the turn's audio to reach the client");
  expect(mediaFrames).toBeGreaterThan(0);
});
