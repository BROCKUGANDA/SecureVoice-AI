/**
 * The REAL Deepgram client asks for the end of an utterance and reports where it was.
 *
 * `caller_stop_to_agent_audio` — the turn latency the caller actually hears — starts at
 * the caller's last syllable. That instant is not something this platform can observe on
 * its own: Deepgram reports it as `last_word_end`, an offset in milliseconds from the
 * start of the socket's audio stream, inside a `UtteranceEnd` message the client has to
 * ASK for with `utterance_end_ms` on the listen URL. No ask, no message, no span — which
 * is how the budget sat published with no producer.
 *
 * `tests/unit/voice-stream-caller-stop.test.ts` drives the worker's join through a fake
 * client that is handed the anchor it should have stamped. That fake cannot prove that
 * the real socket ever stamps it, or that the real client reads the field at all. This
 * file is the half that does, against the production module with only the WebSocket
 * global replaced.
 *
 * The two failure modes worth more than the happy path:
 *
 *   · The live listen URL was built in TWO places — `preconnectDeepgram` (the pooled
 *     socket a call adopts) and `open()` (the per-call and reconnect socket). A parameter
 *     added to one of them is a call that gets the parameter and a call that does not,
 *     and the missing samples are invisible because the code path that was edited looks
 *     correct. So the pooled path, the per-call path and the adopted pooled socket are all
 *     asserted, from one shared builder.
 *   · `UtteranceEnd` carries no `channel.alternatives`, and the message handler below it
 *     opens with `if (!transcript) return`. Asking for the message and then swallowing it
 *     is a subtler way of not asking for it, so the frame is delivered with no transcript
 *     in it and the delivery is what is asserted.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DeepgramLiveClient,
  preconnectDeepgram,
  _resetDeepgramPool,
  type UtteranceEndEvent,
} from "@/lib/voice/deepgram-client";
import { env } from "@/lib/config";

const REAL_WEBSOCKET = globalThis.WebSocket;

const CONFIGURED_WAIT_MS = 1_800;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: unknown,
  ) {
    FakeWebSocket.instances.push(this);
  }

  /** A real socket refuses a send before the handshake; so does this one. */
  send(data: unknown): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error(`send() in readyState ${this.readyState}`);
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }

  // ── test-side controls ──────────────────────────────────────────────────────
  handShake(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  drop(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  /** Any frame, exactly as Deepgram would put it on the wire. */
  frame(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /**
   * Explicit on purpose: no default `last_word_end`, because "Deepgram omitted the
   * field" is one of the shapes under test and a defaulting helper could not express it.
   */
  utteranceEnd(payload: Record<string, unknown> = { last_word_end: 3_000 }): void {
    this.frame({ type: "UtteranceEnd", channel: 0, ...payload });
  }

  speak(transcript: string, isFinal = true): void {
    this.frame({ channel: { alternatives: [{ transcript }] }, is_final: isFinal });
  }
}

let client: DeepgramLiveClient | null = null;
let ends: UtteranceEndEvent[] = [];
let transcripts: [string, boolean][] = [];

beforeEach(() => {
  FakeWebSocket.instances = [];
  ends = [];
  transcripts = [];
  _resetDeepgramPool();
  // A non-default value on purpose: if the URL ever hard-codes the constant this file
  // was written against, the assertion that the CONFIG reaches the vendor fails here
  // rather than in a deployment where nobody is looking at a test.
  process.env.DEEPGRAM_UTTERANCE_END_MS = String(CONFIGURED_WAIT_MS);
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  client = new DeepgramLiveClient("test-key");
  client
    .onAsrEvent(() => {})
    .onTranscript((t, f) => transcripts.push([t, f]))
    .onUtteranceEnd((e) => ends.push(e));
});

afterEach(() => {
  client?.stop();
  client = null;
  globalThis.WebSocket = REAL_WEBSOCKET;
  _resetDeepgramPool();
  delete process.env.DEEPGRAM_UTTERANCE_END_MS;
});

const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

const open = (lang = "en") => client!.start(lang) as unknown as FakeWebSocket;

/** A short μ-law buffer — any byte pattern decodes. */
const FRAME = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/* ── 1. The ask: every listen path, built in one place ──────────────────────── */

test("the per-call listen URL asks for UtteranceEnd, with the configured wait", () => {
  const url = open().url;
  expect(url).toContain(`utterance_end_ms=${CONFIGURED_WAIT_MS}`);
  // Deepgram documents utterance_end_ms as requiring interim_results. Without it the
  // parameter is accepted and the message never comes.
  expect(url).toContain("interim_results=true");
  expect(url.startsWith("wss://api.deepgram.com/v1/listen?")).toBe(true);
});

test("the POOLED listen URL asks for it too, and an adopted pool socket keeps the ask", () => {
  // The defect this assertion exists for: two builders, one edit. A parked socket
  // without the parameter hands every call that adopts it no end-of-utterance signal,
  // while the per-call path — which is what a reviewer reads — looks instrumented.
  const parked = preconnectDeepgram("en", "test-key") as unknown as FakeWebSocket;
  expect(parked.url).toContain(`utterance_end_ms=${CONFIGURED_WAIT_MS}`);
  parked.handShake();

  const adopted = open();
  expect(adopted).toBe(parked);
  expect(adopted.url).toContain(`utterance_end_ms=${CONFIGURED_WAIT_MS}`);
  expect(FakeWebSocket.instances.length).toBe(1);
});

test("a language that has to go as `multi` still asks, and a reconnect still asks", () => {
  // Urdu has no nova-2 model and is pinned to `language=multi`; a URL rebuilt per
  // language could lose the parameter on the way.
  const ur = open("ur");
  expect(ur.url).toContain("language=multi");
  expect(ur.url).toContain(`utterance_end_ms=${CONFIGURED_WAIT_MS}`);

  ur.handShake();
  ur.drop();
  const reopened = latest();
  expect(reopened).not.toBe(ur);
  expect(reopened.url).toContain(`utterance_end_ms=${CONFIGURED_WAIT_MS}`);
});

test("the configured wait can never reach Deepgram as zero", () => {
  // Zero is Deepgram's "do not send the message". A knob set to 0 would switch a
  // published latency budget off while every code path still looked instrumented —
  // a silently-empty measurement, which is the class of defect this file family refuses.
  for (const raw of ["0", "-1", "", "not-a-number", "999999"]) {
    process.env.DEEPGRAM_UTTERANCE_END_MS = raw;
    expect(env.deepgramUtteranceEndMs).toBe(1_000);
  }
  process.env.DEEPGRAM_UTTERANCE_END_MS = "3000";
  expect(env.deepgramUtteranceEndMs).toBe(3_000);
  expect(open("en").url).toContain("utterance_end_ms=3000");
});

/* ── 2. The receipt: a transcript-less frame is still delivered ─────────────── */

test("an UtteranceEnd with no transcript in it is delivered, not swallowed", () => {
  const ws = open();
  ws.handShake();

  ws.utteranceEnd({ channel: 1, last_word_end: 2_500 });

  expect(ends).toHaveLength(1);
  expect(ends[0]!.channel).toBe(1);
  expect(ends[0]!.lastWordEndMs).toBe(2_500);
  // No phantom transcript: the branch must return after emitting, not fall through.
  expect(transcripts).toEqual([]);
});

test("the transcript path is untouched by the new branch", () => {
  const ws = open();
  ws.handShake();

  ws.speak("the card ending 4417", true);
  ws.utteranceEnd();
  ws.speak("I did not authorise it", false);

  expect(transcripts).toEqual([
    ["the card ending 4417", true],
    ["I did not authorise it", false],
  ]);
  expect(ends).toHaveLength(1);

  // A malformed frame must not reach a listener as a half-read event, and must not
  // kill the socket handler for the frames that follow.
  ws.onmessage?.({ data: "{ not json" });
  ws.speak("still transcribing", true);
  expect(transcripts).toHaveLength(3);
  expect(ends).toHaveLength(1);
});

/* ── 3. The clock: what the offset gets added to ────────────────────────────── */

test("the anchor is the first frame the socket ACCEPTED, not the handshake", () => {
  // Deepgram's offsets are measured from the start of the audio STREAM. A socket parked
  // by `preconnectDeepgram` can sit open for seconds before a call adopts it and starts
  // piping, so the socket's open time is a different instant — and using it would place
  // every caller stop that many seconds early.
  const ws = open();
  ws.handShake();

  ws.utteranceEnd({ last_word_end: 1_000 });
  expect(ends[0]!.streamAudioStartedAtMs).toBeNull();

  const before = Date.now();
  client!.sendMulaw(FRAME);

  ws.utteranceEnd({ last_word_end: 1_000 });
  const stamped = ends[1]!.streamAudioStartedAtMs;
  expect(typeof stamped).toBe("number");
  expect(stamped!).toBeGreaterThanOrEqual(before);

  // First frame only: a later frame must not re-baseline the anchor, or every
  // subsequent offset in the stream silently shifts by however long the call has run.
  client!.sendMulaw(FRAME);
  ws.utteranceEnd({ last_word_end: 2_000 });
  expect(ends[2]!.streamAudioStartedAtMs).toBe(stamped);
});

test("audio refused while the socket is connecting never becomes the anchor", () => {
  const ws = open();
  // No handShake(): `sendMulaw` returns rather than throwing, and a frame nobody
  // accepted must not define the clock the whole stream is measured from.
  client!.sendMulaw(FRAME);
  expect(ws.sent.length).toBe(0);

  ws.utteranceEnd({ last_word_end: 1_000 });
  expect(ends[0]!.streamAudioStartedAtMs).toBeNull();

  ws.handShake();
  client!.sendMulaw(FRAME);
  ws.utteranceEnd({ last_word_end: 1_000 });
  expect(typeof ends[1]!.streamAudioStartedAtMs).toBe("number");
});

test("a reconnect re-baselines the anchor, because the new stream starts at zero", () => {
  const ws = open();
  ws.handShake();
  client!.sendMulaw(FRAME);
  ws.utteranceEnd({ last_word_end: 1_000 });
  expect(typeof ends[0]!.streamAudioStartedAtMs).toBe("number");

  ws.drop();
  const reopened = latest();
  reopened.handShake();

  // Inherited, this would put the first UtteranceEnd after a reconnect at
  // oldAnchor + 1_000 — minutes into a call — and the consumer would only catch it
  // after the artefact had already been recorded.
  reopened.utteranceEnd({ last_word_end: 1_000 });
  expect(ends[1]!.streamAudioStartedAtMs).toBeNull();

  const newAnchorTakenAt = Date.now();
  client!.sendMulaw(FRAME);
  reopened.utteranceEnd({ last_word_end: 1_000 });
  // A stamp taken now, on this stream. `Date.now()` is millisecond-granular and a
  // reconnect in a test costs well under one, so this cannot be a strict inequality —
  // the assertion that proves the re-baseline is the null two lines up.
  expect(ends[2]!.streamAudioStartedAtMs!).toBeGreaterThanOrEqual(newAnchorTakenAt);
});

/* ── 4. Honest values only ──────────────────────────────────────────────────── */

test("`-1` and a missing offset are forwarded as they are, never read as zero", () => {
  // -1 is Deepgram's flag for "finalised before the silence condition was met". Clamped
  // to 0 it would mean "the caller stopped at the very start of the stream" — a start
  // instant that is a whole call's length early.
  const ws = open();
  ws.handShake();
  client!.sendMulaw(FRAME);

  ws.utteranceEnd({ last_word_end: -1 });
  expect(ends[0]!.lastWordEndMs).toBe(-1);

  ws.utteranceEnd({});
  expect(Number.isNaN(ends[1]!.lastWordEndMs)).toBe(true);

  ws.utteranceEnd({ last_word_end: "1200" });
  expect(Number.isNaN(ends[2]!.lastWordEndMs)).toBe(true);

  expect(transcripts).toEqual([]);
});

test("the arrival, the vendor's offset and this stream's anchor are three separate fields", async () => {
  // The consumer has to be able to see all three, because the whole point of the span
  // is that it starts at neither of the two instants this process observes directly.
  // The client's job is to forward each without collapsing any: the arrival is not the
  // syllable, and the anchor is not the handshake.
  const ws = open();
  ws.handShake();
  const anchorTakenAt = Date.now();
  client!.sendMulaw(FRAME);
  // Real audio has to actually be 5 ms long before Deepgram can report a 5 ms offset.
  // Without this the fixture would hand the client an impossible stream and the
  // ordering below would be an artefact of the test rather than a property of the code.
  await new Promise((r) => setTimeout(r, 25));

  const before = Date.now();
  ws.utteranceEnd({ last_word_end: 5 });
  const e = ends[0]!;
  expect(e.receivedAtMs).toBeGreaterThanOrEqual(before);
  expect(e.streamAudioStartedAtMs!).toBeGreaterThanOrEqual(anchorTakenAt);
  expect(e.receivedAtMs).toBeGreaterThan(e.streamAudioStartedAtMs! + e.lastWordEndMs);
});

test("a listener that throws cannot break the caller's transcription", () => {
  const noisy = new DeepgramLiveClient("test-key");
  const seen: number[] = [];
  noisy
    .onTranscript((t) => seen.push(t.length))
    .onUtteranceEnd(() => {
      throw new Error("a latency probe that fails must fail alone");
    })
    .onUtteranceEnd((e) => seen.push(e.lastWordEndMs));

  const ws = noisy.start("en") as unknown as FakeWebSocket;
  ws.handShake();
  ws.utteranceEnd({ last_word_end: 777 });
  ws.speak("still heard", true);

  expect(seen).toContain(777);
  expect(seen).toContain("still heard".length);
  noisy.stop();
});

test("stop() unties the listener: a silence timer that fires after the call is over reaches nobody", () => {
  // Deepgram's `utterance_end_ms` timer does not know the caller hung up. A message
  // landing after the worker tore its turn state down must find nothing to call rather
  // than an object that no longer exists.
  const ws = open();
  ws.handShake();
  client!.sendMulaw(FRAME);
  client!.stop();

  ws.utteranceEnd({ last_word_end: 4_000 });
  ws.speak("after the call ended", true);
  expect(ends).toHaveLength(0);
  expect(transcripts).toHaveLength(0);
});
