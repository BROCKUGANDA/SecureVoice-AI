/**
 * Live ASR provider selection — the factory contract the worker reads.
 *
 *   - `sw` with an ElevenLabs key → elevenlabs (Scribe serves Swahili;
 *     no Deepgram streaming model does)
 *   - `sw` without a key → deepgram (today's behaviour, preserved)
 *   - every other platform language → deepgram (existing vendor)
 *
 * `isLiveTranscribable` is the tripwire against a platform language silently
 * falling into a `multi` bucket that cannot contain it.
 *
 *   bun scripts/run-tests.mjs live-asr
 */
import { expect, test } from "bun:test";
import { asrProviderFor, createLiveAsrClient, isLiveTranscribable } from "@/lib/voice/live-asr";
import { DeepgramLiveClient } from "@/lib/voice/deepgram-client";
import { ScribeLiveClient } from "@/lib/voice/scribe-live-client";

test("swahili resolves to the ElevenLabs (Scribe) provider when the key is configured", () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  try {
    process.env.ELEVENLABS_API_KEY = "test-key";
    expect(asrProviderFor("sw")).toBe("elevenlabs");
    expect(createLiveAsrClient("sw")).toBeInstanceOf(ScribeLiveClient);
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prev;
  }
});

test("swahili falls back to Deepgram without the ElevenLabs key", () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  try {
    delete process.env.ELEVENLABS_API_KEY;
    // env is a getter-backed object: clearing the process var must be visible
    // through the getter for the fallback to engage.
    expect(asrProviderFor("sw")).toBe("deepgram");
    expect(createLiveAsrClient("sw")).toBeInstanceOf(DeepgramLiveClient);
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prev;
  }
});

test("every other platform language stays on Deepgram", () => {
  for (const lang of ["en", "ar", "hi", "ur", "fr"]) {
    expect(asrProviderFor(lang)).toBe("deepgram");
    expect(createLiveAsrClient(lang)).toBeInstanceOf(DeepgramLiveClient);
  }
});

test("every platform language is live-transcribable", () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  try {
    process.env.ELEVENLABS_API_KEY = "test-key";
    for (const lang of ["en", "ar", "hi", "ur", "fr", "sw"]) {
      expect(isLiveTranscribable(lang)).toBe(true);
    }
    // The honest regression line: without the key, swahili is NOT
    // transcribable on the live path and the fallback keeps it visible.
    delete process.env.ELEVENLABS_API_KEY;
    expect(isLiveTranscribable("sw")).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = prev;
  }
});
