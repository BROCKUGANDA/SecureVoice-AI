/**
 * The live transcription socket redials once, and the second death is loud.
 *
 * `DeepgramLiveClient`'s `onclose` was `() => { /* connection closed *\/ }`. On the
 * production plane that meant a dropped ASR leg was invisible: the caller spoke to
 * a socket nobody was reading, the agent answered its own nudges, the audit chain
 * recorded a call in which no customer speech ever arrived, and the only evidence
 * sat in Deepgram's dashboard. Nothing threw, so nothing was reported — the worst
 * shape a failure can have in a fraud-verification call, where silence is what the
 * fraudster wants.
 *
 * The behaviour under test is deliberately modest. ONE redial, because a transient
 * blip is fixed by one socket and a stream that closes twice is telling the call it
 * should stop pretending; and the terminal event must fire exactly ONCE, because the
 * worker's handler ends the call.
 *
 *   bun test tests/unit/deepgram-reconnect.test.ts
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DeepgramLiveClient,
  preconnectDeepgram,
  _resetDeepgramPool,
  type AsrEvent,
} from "@/lib/voice/deepgram-client";

const REAL_WEBSOCKET = globalThis.WebSocket;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  closeCalls = 0;

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
    this.closeCalls += 1;
    // An application-initiated close carries 1000; the client must read that as
    // "the call ended" only when `stop()` asked for it, never on its own.
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

  speak(transcript: string, isFinal = true): void {
    this.onmessage?.({
      data: JSON.stringify({ channel: { alternatives: [{ transcript }] }, is_final: isFinal }),
    });
  }
}

let events: AsrEvent[] = [];
let transcripts: [string, boolean][] = [];
let client: DeepgramLiveClient | null = null;

beforeEach(() => {
  FakeWebSocket.instances = [];
  events = [];
  transcripts = [];
  _resetDeepgramPool();
  // The client constructs a bare `WebSocket`, so replacing the global is replacing
  // what the production module will use — no seam, no stub of the client itself.
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  client = new DeepgramLiveClient("test-key");
  client.onAsrEvent((e) => events.push(e)).onTranscript((t, f) => transcripts.push([t, f]));
});

afterEach(() => {
  client?.stop();
  client = null;
  globalThis.WebSocket = REAL_WEBSOCKET;
  _resetDeepgramPool();
});

const first = () => FakeWebSocket.instances[0]!;
const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

/**
 * `start()` is typed as returning the platform `WebSocket`; here it is always the
 * fake, and the helpers below (`handShake`, `drop`, `speak`) are how a test drives
 * a socket the module under test constructed itself.
 */
const open = (lang: string) => client!.start(lang) as unknown as FakeWebSocket;

// ── 1. The redial ────────────────────────────────────────────────────────────

test("an unexpected close opens a second socket and says so", () => {
  const ws = open("en");
  ws.handShake();

  ws.drop(1006);

  expect(FakeWebSocket.instances.length).toBe(2);
  expect(events).toEqual([{ kind: "reconnected", attempt: 1, closeCode: 1006 }]);
  // The dead socket is not sent to again.
  expect(first().sent.length).toBe(0);
});

test("the transcript path survives the redial — a reconnect that lost its listeners would resume silently", () => {
  const ws = open("en");
  ws.handShake();
  ws.speak("the card ending 4417", true);
  expect(transcripts).toEqual([["the card ending 4417", true]]);

  ws.drop();
  const reopened = latest();
  expect(reopened).not.toBe(ws);
  reopened.handShake();
  transcripts = [];

  reopened.speak("I did not authorise it", false);
  expect(transcripts).toEqual([["I did not authorise it", false]]);
});

test("the redial re-opens the CALL's language, not the default", () => {
  // Urdu and Swahili have no nova-2 model and must go as `multi`; a reconnect that
  // rebuilt the URL from a default would drop an Urdu customer back to English
  // pinning mid-call, which is the exact defect the language work removed.
  const ws = open("ur");
  expect(ws.url).toContain("language=multi");
  ws.handShake();

  ws.drop();
  expect(latest().url).toContain("language=multi");

  const arabic = new DeepgramLiveClient("test-key");
  const ar = arabic.start("ar") as unknown as FakeWebSocket;
  expect(ar.url).toContain("language=ar");
  ar.handShake();
  ar.drop();
  expect(latest().url).toContain("language=ar");
  arabic.stop();
});

// ── 2. The second death ──────────────────────────────────────────────────────

test("a second close is terminal, fires once, and opens nothing further", () => {
  const ws = open("en");
  ws.handShake();
  ws.drop();

  const reopened = latest();
  reopened.handShake();
  reopened.drop(1011);

  expect(events.map((e) => e.kind)).toEqual(["reconnected", "dead"]);
  expect(events[1]).toEqual({ kind: "dead", attempts: 1, closeCode: 1011 });
  expect(FakeWebSocket.instances.length).toBe(2);

  // A runtime that delivers another close (or an error-then-close pair) must not
  // end the call twice: the worker's handler hangs up and speaks an exit line.
  reopened.drop(1012);
  expect(events.filter((e) => e.kind === "dead")).toHaveLength(1);
  expect(FakeWebSocket.instances.length).toBe(2);
});

test("audio sent while the redial is in flight is dropped, and nothing throws", () => {
  const ws = open("en");
  ws.handShake();
  ws.drop();

  // The new socket is CONNECTING for the length of a handshake (100–300 ms) and a
  // real WebSocket refuses a send before it is open. `sendMulaw` returns instead of
  // throwing: those frames are lost, and the loss is BOUNDED and reported by the
  // `reconnected` audit row rather than hidden or turned into a crashed worker.
  expect(latest().readyState).toBe(FakeWebSocket.CONNECTING);
  expect(() => client!.sendMulaw(Buffer.from([0xff, 0xff]))).not.toThrow();
  expect(latest().sent.length).toBe(0);

  latest().handShake();
  client!.sendMulaw(Buffer.from([0xff, 0xff]));
  expect(latest().sent.length).toBe(1);
});

// ── 3. What is NOT a failure ─────────────────────────────────────────────────

test("stop() is the call ending: no redial, no event, however the runtime fires close", () => {
  const ws = open("en");
  ws.handShake();

  client!.stop();

  // `stop()` closes the socket, and this fake fires `onclose` from `close()` — the
  // hostile ordering. If the flag were set after the close, the call would consume
  // its one reconnect and then report a death on a call that had already ended.
  expect(FakeWebSocket.instances.length).toBe(1);
  expect(events).toEqual([]);
  expect(ws.closeCalls).toBe(1);

  // A late close from the stack is still not a failure.
  ws.drop(1001);
  expect(events).toEqual([]);
  expect(FakeWebSocket.instances.length).toBe(1);
});

test("an adopted pooled socket is watched after adoption, not left on the pool's handler", () => {
  // `preconnectDeepgram` parks a socket with its OWN close handler (remove from
  // pool). Once `start()` adopts it, the call's handlers must replace those, or the
  // call inherits a socket whose death is reported to nobody.
  const parked = preconnectDeepgram("en", "test-key");
  expect(parked).not.toBeNull();
  (parked as unknown as FakeWebSocket).handShake();

  const ws = open("en");
  expect(ws).toBe(parked as unknown as FakeWebSocket);
  ws.handShake();

  ws.drop(1005);
  expect(events.map((e) => e.kind)).toEqual(["reconnected"]);
  expect(FakeWebSocket.instances.length).toBe(2);
});
