/**
 * Unit — ScribeLiveClient: live Swahili STT behind silence finalization.
 *
 * The defects this file exists to prevent:
 *   1. An utterance finalizing but never being transcribed (broken listener
 *      plumbing) — the swahili caller speaks into a void.
 *   2. A failed chunk being emitted as an EMPTY final — a phantom turn.
 *   3. `stop()` emitting after the call ended (in-flight batch resolving
 *      post-teardown must find nobody to call).
 *   4. A WAV header that Scribe cannot parse (all-zero audio on every call).
 *
 * All vendor I/O is faked through the injected `transcribe` dependency.
 *
 *   bun scripts/run-tests.mjs scribe-live-client
 */
import { expect, test } from "bun:test";
import { ScribeLiveClient } from "@/lib/voice/scribe-live-client";
import { encodeMulaw } from "@/lib/voice/mulaw-codec";

/** 160-byte frame = 20 ms of 8 kHz mulaw, as Twilio media frames arrive. */
function frame(speech: boolean): Buffer {
  const pcm = Buffer.alloc(160 * 2); // 160 int16 samples
  for (let i = 0; i < 160; i += 1) pcm.writeInt16LE(speech ? 24000 : 0, i * 2);
  return encodeMulaw(pcm);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("speech followed by enough silence finalizes one utterance and emits a final transcript", async () => {
  const transcripts: [string, boolean][] = [];
  const ends: unknown[] = [];
  let wavSeen: Buffer | null = null;
  const client = new ScribeLiveClient(async (wav, lang) => {
    wavSeen = wav;
    expect(lang).toBe("sw");
    return "sijui muamala hii";
  });
  client.start("sw");
  client.onTranscript((t, isFinal) => transcripts.push([t, isFinal]));
  client.onUtteranceEnd((e) => ends.push(e));

  // ~1 s of speech, then ~1.2 s of silence (>= the 1000 ms default window).
  for (let i = 0; i < 50; i++) client.sendMulaw(frame(true));
  for (let i = 0; i < 60; i++) client.sendMulaw(frame(false));
  await sleep(50);
  client.stop();

  expect(transcripts).toEqual([["sijui muamala hii", true]]);
  expect(ends.length).toBe(1);
  const ev = ends[0] as { lastWordEndMs: number; streamAudioStartedAtMs: number | null };
  expect(ev.lastWordEndMs).toBeGreaterThan(0);
  expect(typeof ev.streamAudioStartedAtMs).toBe("number");

  // The WAV the batch call was sent: valid RIFF/WAVE, 44-byte header, 8 kHz.
  expect(wavSeen).not.toBeNull();
  expect(wavSeen!.subarray(0, 4).toString()).toBe("RIFF");
  expect(wavSeen!.subarray(8, 12).toString()).toBe("WAVE");
  expect(wavSeen!.readUInt32LE(24)).toBe(8000);
  // data chunk size follows content
  expect(wavSeen!.readUInt32LE(40)).toBe(wavSeen!.length - 44);
});

test("no speech (all-silence) finalizes nothing and never calls the vendor", async () => {
  let calls = 0;
  const client = new ScribeLiveClient(async () => {
    calls++;
    return "x";
  });
  const transcripts: string[] = [];
  client.start("sw");
  client.onTranscript((t) => transcripts.push(t));
  for (let i = 0; i < 100; i++) client.sendMulaw(frame(false));
  await sleep(50);
  client.stop();
  expect(calls).toBe(0);
  expect(transcripts).toEqual([]);
});

test("a failed chunk is dropped, never emitted as an empty final", async () => {
  const transcripts: string[] = [];
  const client = new ScribeLiveClient(async () => {
    throw new Error("Scribe 429");
  });
  client.start("sw");
  client.onTranscript((t) => transcripts.push(t));
  for (let i = 0; i < 50; i++) client.sendMulaw(frame(true));
  for (let i = 0; i < 60; i++) client.sendMulaw(frame(false));
  await sleep(50);
  client.stop();
  expect(transcripts).toEqual([]);
});

test("stop() before completion drops the in-flight batch", async () => {
  const transcripts: string[] = [];
  let release!: (v: string) => void;
  const gate = new Promise<string>((resolve) => (release = resolve));
  const client = new ScribeLiveClient(() => gate);
  client.start("sw");
  client.onTranscript((t) => transcripts.push(t));
  for (let i = 0; i < 50; i++) client.sendMulaw(frame(true));
  for (let i = 0; i < 60; i++) client.sendMulaw(frame(false));
  // finalize() started async; stop before it resolves
  client.stop();
  release("too late");
  await sleep(50);
  expect(transcripts).toEqual([]);
});
