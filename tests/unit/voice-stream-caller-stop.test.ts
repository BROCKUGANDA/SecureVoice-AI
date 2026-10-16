/**
 * CI drives `caller_stop_to_agent_audio` — the turn latency the caller HEARS.
 *
 * The span has been in the published latency contract since the plane was built
 * (`src/lib/telemetry/spans.ts:54`, p95 < 1,500 ms) with no producer, because the
 * instant it starts at was never an event this platform received: `DeepgramLiveClient`
 * requested no `utterance_end_ms`, so no `UtteranceEnd` message ever arrived, and the
 * only thing the worker saw of a caller finishing a sentence was the arrival of the
 * final transcript. That arrival is the START of `answered_to_first_agent_word` and it
 * is NOT the end of the caller's speech — the ASR endpoints on a timer and delivers
 * after it — so measuring from there measures a different quantity, late by however
 * long the vendor spent deciding.
 *
 * Both halves now exist: the client asks for `UtteranceEnd` and carries Deepgram's
 * `last_word_end` (ms from the start of that stream's audio) plus the wall clock that
 * audio started on, and `src/worker/voice-stream.ts` maps one onto the other and joins
 * the result to the turn's first audio frame.
 *
 * THE DEFECT THIS FILE EXISTS TO CATCH. `utterance_end_ms` is a deliberate wait Deepgram
 * adds AFTER speech ends. A span that starts when the message ARRIVES therefore starts
 * `utterance_end_ms` late — and every sample it produces is that much SHORTER than what
 * the caller lived through. The product's published turn latency would be inflated in
 * its own favour, which is the exact class of fabrication a sweep just removed from this
 * repository. So the test does not merely assert a plausible number: it fixes the gap
 * between the syllable and the message at a known constant and asserts the recorded
 * duration is that constant LONGER than the message-arrival gap, to the millisecond. An
 * implementation that starts at the arrival cannot pass it, in either clock order.
 *
 * Shape, copied from tests/unit/voice-stream-first-agent-word.test.ts (one Bun process
 * per file, `mock.module` at the vendor seams, the REAL server booted):
 *
 *   · DeepgramLiveClient — records its listeners so the TEST plays the caller: a final
 *     transcript, then an `UtteranceEnd` frame with a known `last_word_end`. The fake
 *     carries the anchor field the real client stamps, and that stamping is itself
 *     asserted in tests/unit/deepgram-utterance-end.test.ts — the fake cannot prove the
 *     real socket's clock, so this file does not claim to.
 *   · ElevenLabsStream — yields its first chunk ~150 ms in, so the UtteranceMessage
 *     lands while the turn is open and before its audio does (the ordering Deepgram's
 *     own silence timer produces on a fast-turning call).
 *   · db / audit chain — the case lookup resolves, audit rows land nowhere.
 *
 * Asserted, in order:
 *   (a) the span exists, `origin: "harness"`, with the attributes that make it explainable;
 *   (b) its start instant IS the derived syllable instant, and its duration exceeds the
 *       message-arrival gap by exactly the configured silence wait;
 *   (c) a replayed `UtteranceEnd`, and a turn whose audio arrives with no stop reported,
 *       each add nothing — a message that lands between turns is dropped rather than
 *       joined to whichever turn happens to be open (the only error that can make is a
 *       SHORT one) — while a genuinely second turn adds exactly one sample;
 *   (d) a stop that cannot be derived honestly (-1, a missing offset, a stream with no
 *       anchor, an offset so stale the turn would be minutes long) records NOTHING and
 *       says so at error level, rather than guessing.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { once } from "node:events";
import WebSocket from "ws";
import type { SpanRecord } from "@/lib/telemetry/spans";
import type { LogRecord } from "@/lib/validation/safe-log";
import type { UtteranceEndEvent } from "@/lib/voice/deepgram-client";

/* ————————————————————————————————— mocks ————————————————————————————————— */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeDeepgramClient {
  static instances: FakeDeepgramClient[] = [];

  transcriptListeners: Array<(text: string, isFinal: boolean) => void> = [];
  utteranceEndListeners: Array<(event: UtteranceEndEvent) => void> = [];

  /**
   * The wall clock the real client stamps when the first audio frame is accepted on
   * this stream, and the only instant `last_word_end` can be added to. The test moves
   * it to fix a known gap between a syllable and the message reporting it; how the
   * real client comes by that number is asserted in deepgram-utterance-end.test.ts.
   */
  streamAudioStartedAtMs: number | null = Date.now();

  constructor(_apiKey: string) {
    FakeDeepgramClient.instances.push(this);
  }

  onTranscript(fn: (text: string, isFinal: boolean) => void): this {
    this.transcriptListeners.push(fn);
    return this;
  }

  onUtteranceEnd(fn: (event: UtteranceEndEvent) => void): this {
    this.utteranceEndListeners.push(fn);
    return this;
  }

  onAsrEvent(_fn: (event: unknown) => void): this {
    // Stream death/reconnect is not this test's subject; nothing fires it.
    return this;
  }

  start(_lang: string): void {/* empty */}

  sendMulaw(_buffer: Buffer): void {}

  /** The real client clears both listener sets when the call ends. */
  stop(): void {
    this.transcriptListeners = [];
    this.utteranceEndListeners = [];
  }

  /** The test playing the caller: one utterance into the real handler. */
  say(text: string, isFinal = true): void {
    for (const fn of this.transcriptListeners) fn(text, isFinal);
  }

  /**
   * Deepgram reporting that the caller stopped. `receivedAtMs` is pinned rather than
   * read from the clock inside the emit, so the gap between the syllable and this
   * message is exactly the number the assertions use.
   */
  utteranceEnd(lastWordEndMs: number, receivedAtMs = Date.now()): void {
    // `lastWordEndMs` here is MILLISECONDS on purpose: the fake stands in for the real
    // client, which converts Deepgram's seconds-bearing `last_word_end` at its own seam.
    // That conversion is asserted in tests/unit/deepgram-utterance-end.test.ts; this file
    // tests the join, downstream of it.
    const event: UtteranceEndEvent = {
      channel: 0,
      lastWordEndMs,
      streamAudioStartedAtMs: this.streamAudioStartedAtMs,
      receivedAtMs,
    };
    for (const fn of this.utteranceEndListeners) fn(event);
  }
}

class FakeElevenLabsStream {
  async *streamText(_text: string, _opts: unknown): AsyncGenerator<Buffer> {
    // A real synthesis first byte is not instantaneous, and Deepgram's UtteranceEnd
    // lands while the agent is still warming up. The delay puts this test's turn in
    // that order instead of accidentally in the other one.
    await sleep(150);
    yield Buffer.from("ci-mock-audio-chunk-1");
    yield Buffer.from("ci-mock-audio-chunk-2");
  }

  cancel(): void {/* empty */}
}

mock.module("@/lib/voice/deepgram-client", () => ({
  DeepgramLiveClient: FakeDeepgramClient,
  preconnectDeepgram: () => null,
}));

mock.module("@/lib/voice/elevenlabs-stream", () => ({ ElevenLabsStream: FakeElevenLabsStream }));

mock.module("@/lib/db", () => ({
  db: {
    case: { findFirst: async () => ({ caseRef: "SV-CI-STOPSPAN" }) },
  },
}));

mock.module("@/lib/audit-chain", () => ({ append: async () => "ci-hash" }));

mock.module("@/lib/elevenlabs/sms-fallback", () => ({ markVoiceFailed: async () => {} }));

/* ——————————————— boot the real server on a test port ——————————————— */

// A different base port from the sibling first-word suite: the two boot the same
// server and CI can run files in parallel.
const PORT = 47000 + (process.pid % 20000);
process.env.VOICE_STREAM_PORT = String(PORT);
process.env.VOICE_MAX_CALL_SECONDS = "30";

const { createServer } = await import("@/worker/voice-stream");
const { recentSpans, resetSpans } = await import("@/lib/telemetry/spans");
const { registerLogSink } = await import("@/lib/validation/safe-log");

const CALL_SID = "CI-caller-stop-call";
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * The silence Deepgram is configured to wait out after the caller's last syllable
 * before it emits `UtteranceEnd`. Fixed here, not read from env, because the whole
 * point is a KNOWN margin: the span must not contain it.
 */
const SILENCE_WAIT_MS = 1_000;
/** Where the caller's last syllable sits in the test stream, in ms from its start. */
const LAST_WORD_END_MS = 4_000;
/** A neutral utterance the deterministic router classifies `clarify`: the holding-line
 * turn whose `onFirstAudio` closes both spans. Same choice the first-word suite makes. */
const UTTERANCES = ["yellow umbrella rainbow", "blue bicycle window", "green lantern bridge"];

createServer();

const logged: LogRecord[] = [];
let client: WebSocket;
/** Media frames received since the counter was last zeroed. */
let mediaFrames = 0;

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
    await sleep(25);
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
    await sleep(25);
  }
}

const stopSamples = (): SpanRecord[] =>
  recentSpans(400).filter((s) => s.span === "caller_stop_to_agent_audio");

async function pollForSamples(count: number, deadlineMs = 5_000): Promise<SpanRecord[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const hit = stopSamples();
    if (hit.length >= count) return hit;
    if (Date.now() > deadline) return hit;
    await sleep(25);
  }
}

const dg = () => FakeDeepgramClient.instances.at(-1)!;

/**
 * Deepgram reporting the end of the utterance, with the offset and the anchor chosen so
 * the derived syllable sits exactly `silenceWaitMs` BEFORE the message that reports it.
 * That fixed gap is what the assertions measure: an implementation that started the span
 * at the message's arrival would drop it.
 *
 * `receivedAtMs` is pinned rather than read from the clock inside the emit, so the margin
 * is exact to the millisecond instead of whatever the scheduler did.
 */
function emitUtteranceEnd(
  silenceWaitMs: number,
  lastWordEndMs = LAST_WORD_END_MS,
): { arrivedAtMs: number; speechEndedAtMs: number } {
  const arrivedAtMs = Date.now();
  dg().streamAudioStartedAtMs = arrivedAtMs - lastWordEndMs - silenceWaitMs;
  dg().utteranceEnd(lastWordEndMs, arrivedAtMs);
  return { arrivedAtMs, speechEndedAtMs: arrivedAtMs - silenceWaitMs };
}

/**
 * Play one caller utterance the way the vendor does when the agent is slow to answer:
 * the final transcript, then the `UtteranceEnd` that reports where the speech actually
 * ended — a deliberate silence wait later, because that is what `utterance_end_ms` IS.
 */
async function sayThenUtteranceEnd(
  utterance: string,
  silenceWaitMs: number,
  lastWordEndMs = LAST_WORD_END_MS,
): Promise<{ arrivedAtMs: number; speechEndedAtMs: number }> {
  dg().say(utterance, true);
  // The turn is opened by the first microtask of the chained transcript handler. A
  // tick of real time waits for that instead of assuming it: Deepgram delivers the
  // final transcript and the silence message seconds apart, never in one tick.
  await sleep(10);
  return emitUtteranceEnd(silenceWaitMs, lastWordEndMs);
}

beforeAll(async () => {
  resetSpans();
  registerLogSink((level, _line, record) => logged.push(record));
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
  await waitFor(
    () => FakeDeepgramClient.instances.length > 0,
    "the server to construct this call's ASR client",
  );

  // Let the opening disclosure and safety exit drain, so every frame counted below
  // belongs to a driven turn.
  mediaFrames = 0;
  await waitFor(
    () => {
      const before = mediaFrames;
      return sleep(400).then(() => mediaFrames === before);
    },
    "the opening disclosure to drain",
    10_000,
  );
  mediaFrames = 0;
  resetSpans();
  logged.length = 0;
});

afterAll(() => {
  try {
    client?.close();
  } catch {
    // already closed
  }
});

/* ——————————————————————————————— (a) + (b) ——————————————————————————————— */

test("the span starts at the caller's last syllable, not at the UtteranceEnd message", async () => {
  const { arrivedAtMs, speechEndedAtMs } = await sayThenUtteranceEnd(
    UTTERANCES[0]!,
    SILENCE_WAIT_MS,
  );

  const spans = await pollForSamples(1);
  expect(spans.length).toBe(1);
  const record = spans[0]!;

  // (b-i) the start instant is the mapped audio offset, exactly.
  expect(record.startedAtMs).toBe(speechEndedAtMs);
  expect(record.durationMs).toBe(record.endedAtMs - speechEndedAtMs);

  // (b-ii) THE assertion. `endedAtMs - arrivedAtMs` is the gap the WRONG producer would
  // have measured — first audio minus the instant the silence message turned up. The
  // real sample is `SILENCE_WAIT_MS` longer than that, because the syllable it starts
  // from happened a full configured wait before the message reported it. Fixed margin,
  // asserted to the millisecond: start at the arrival and this is 0, not 1,000.
  expect(record.durationMs - (record.endedAtMs - arrivedAtMs)).toBe(SILENCE_WAIT_MS);
  expect(record.durationMs).toBeGreaterThanOrEqual(SILENCE_WAIT_MS);
  // And not so long that it swallowed the whole call: the wait is excluded, and the
  // turn's own synthesis is the remainder.
  expect(record.durationMs).toBeLessThan(10_000);

  expect(typeof record.attributes.cached).toBe("boolean");
  // The wait the sample deliberately excludes, carried on the record so a reader can
  // check that rather than trust this file.
  expect(Number(record.attributes.utteranceEndMs)).toBeGreaterThanOrEqual(1_000);

  // Test traffic is harness traffic and must never read as production latency.
  expect(record.origin).toBe("harness");

  // The end instant is audio the caller could hear: media really went out on this
  // socket for this turn.
  await waitFor(() => mediaFrames > 0, "the turn's audio to reach the client");
  expect(mediaFrames).toBeGreaterThan(0);
});

/* ————————————————————————————————— (c) ————————————————————————————————— */

test("a replayed UtteranceEnd and a turn with no stop each add no sample", async () => {
  const before = stopSamples().length;
  expect(before).toBe(1);

  // The same message twice. Deepgram can deliver the silence signal more than once
  // for one utterance; a second one is not a second measurement.
  dg().utteranceEnd(LAST_WORD_END_MS, Date.now());
  await sleep(100);
  expect(stopSamples().length).toBe(1);

  // A second turn whose audio lands with no end-of-speech reported for it. Its start
  // half is unknown, so it produces nothing — the alternative is starting the span at
  // the transcript's arrival, which is the fabrication asserted against above.
  mediaFrames = 0;
  dg().say(UTTERANCES[1]!, true);
  await waitFor(() => mediaFrames > 0, "the second turn's audio to reach the client");
  await sleep(100);
  expect(stopSamples().length).toBe(1);
});

test("an UtteranceEnd that lands between turns is dropped, not joined to a turn it did not belong to", async () => {
  // A final transcript closes the pairing slot the instant it ARRIVES, before the
  // chained handler opens that turn. Without the close, a silence message still in
  // flight would be handed to the turn this worker is still finishing — a stop from a
  // later utterance joined to an earlier turn's audio, which can only come out SHORT.
  // Short is the direction that flatters the product's own 1,500 ms budget, so the
  // pairing is refused outright and said out loud rather than recorded as a good turn.
  const before = stopSamples().length;
  logged.length = 0;
  mediaFrames = 0;

  // One tick, deliberately: any `await` between these two lets the chain open the new
  // turn first, and the message becomes an ordinary in-turn one that SHOULD be paired.
  dg().say("violet compass harbor", true);
  emitUtteranceEnd(1_500, LAST_WORD_END_MS + 12_000);

  await waitFor(() => mediaFrames > 0, "the turn's audio to reach the client");
  await sleep(100);
  expect(stopSamples().length).toBe(before);
  const dropped = logged.some(
    (r) => r.level === "warn" && r.msg.toLowerCase().includes("between turns"),
  );
  expect({ loggedAtWarn: dropped }).toEqual({ loggedAtWarn: true });
});

test("one sample per turn: the reply starts first, the silence message lands after", async () => {
  // Constraint is "at most one per TURN", not one per call: a span that recorded once
  // per call would report a p95 over the first turn of each call and quietly ignore
  // every turn the caller actually waited through.
  //
  // This is the OTHER clock order. A warm-cache reply starts before Deepgram's silence
  // timer fires, so the audio half lands first — and the turn that was refused a sample
  // in the case above now gets its own, from a message that arrives after it spoke.
  mediaFrames = 0;
  dg().say(UTTERANCES[2]!, true);
  await waitFor(() => mediaFrames > 0, "the third turn's audio to reach the client");
  expect(stopSamples().length).toBe(1);

  // The wait is wider than the poll interval below, so the derived syllable is
  // unambiguously earlier than the audio it is joined to: a negative duration here would
  // be a clock artefact of the test harness, not a defect in the producer.
  const { arrivedAtMs, speechEndedAtMs } = emitUtteranceEnd(1_500, LAST_WORD_END_MS + 6_000);

  const spans = await pollForSamples(2);
  expect(spans.length).toBe(2);
  const record = spans[1]!;
  expect(record.startedAtMs).toBe(speechEndedAtMs);
  expect(record.durationMs - (record.endedAtMs - arrivedAtMs)).toBe(1_500);
  expect(record.durationMs).toBeLessThan(10_000);
});

/* ————————————————————————————————— (d) ————————————————————————————————— */

test("a stop that cannot be derived honestly records nothing, and says so at error level", async () => {
  // Neutral, unrepeatable phrases: the warm-audio cache must not turn a later
  // iteration into a different code path than the first.
  const phrases = [
    "yellow umbrella rainbow",
    "silk window paper",
    "green lantern bridge",
    "wood piano garden",
  ];
  const cases: Array<{ name: string; speak: () => void; expectLog: string }> = [
    {
      // Deepgram's documented -1: the result was finalised before the silence
      // condition was met. It is a flag, not a time; read as 0 it would start the span
      // at the beginning of the stream and publish a turn latency of the call's length.
      name: "last_word_end -1",
      speak: () => dg().utteranceEnd(-1, Date.now()),
      expectLog: "no usable speech-end instant",
    },
    {
      name: "last_word_end missing",
      speak: () => dg().utteranceEnd(Number.NaN, Date.now()),
      expectLog: "no usable speech-end instant",
    },
    {
      // A pooled socket whose audio never started, or a message from before the
      // first frame: the offset has nothing to be added to.
      name: "no stream anchor",
      speak: () => {
        dg().streamAudioStartedAtMs = null;
        dg().utteranceEnd(1_000, Date.now());
      },
      expectLog: "no usable speech-end instant",
    },
    {
      // An anchor so far stale that the derived syllable sits minutes before the
      // agent's audio: real instants, wrong join. The ceiling is what refuses it, and
      // the refusal is the point — a silently-absent sample is the failure mode this
      // file family exists to eliminate.
      name: "absurd duration",
      speak: () => {
        const now = Date.now();
        dg().streamAudioStartedAtMs = now - 100_000;
        dg().utteranceEnd(80_000, now);
      },
      expectLog: "refused a caller_stop_to_agent_audio sample",
    },
  ];

  for (const [i, c] of cases.entries()) {
    const { name, speak, expectLog } = c;
    resetSpans();
    logged.length = 0;
    mediaFrames = 0;

    dg().say(phrases[i]!, true);
    await sleep(10);
    speak();
    // Wait out the turn: audio lands, and a sample would have been recorded by now.
    await waitFor(() => mediaFrames > 0, `${name}: the turn's audio`);
    await sleep(100);

    expect({ case: name, samples: stopSamples().length }).toEqual({ case: name, samples: 0 });
    const loud = logged.some(
      (r) => r.level === "error" && r.msg.toLowerCase().includes(expectLog.toLowerCase()),
    );
    expect({ case: name, loggedAtError: loud }).toEqual({ case: name, loggedAtError: true });
  }
});
