/**
 * The cue that plays when nothing else can speak.
 *
 * This is the last rung of the Twilio voice ladder, so it has one job: be real,
 * playable audio that arrives without asking a vendor for permission. These
 * checks read the WAV header the way a carrier would, because a cue that
 * parses as a 44-byte file with no samples in it is indistinguishable from the
 * dead line it exists to avoid.
 *
 *   bun test tests/unit/emergency-audio.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  EMERGENCY_AUDIO_CONTENT_TYPE,
  EMERGENCY_AUDIO_TYPES,
  EMERGENCY_SAMPLE_RATE,
  emergencyAudioBytes,
  getEmergencyAudio,
  isEmergencyAudioType,
} from "@/lib/elevenlabs/emergency-audio";

function header(buf: Buffer, offset: number, length: number): string {
  return buf.subarray(offset, offset + length).toString("ascii");
}

const int16le = (buf: Buffer, offset: number): number => buf.readInt16LE(offset);

describe("every cue", () => {
  test("is a canonical 44-byte-header WAV", () => {
    for (const type of EMERGENCY_AUDIO_TYPES) {
      const buf = getEmergencyAudio(type);
      expect(header(buf, 0, 4), `${type} RIFF`).toBe("RIFF");
      expect(header(buf, 8, 8), `${type} WAVE`).toBe("WAVEfmt ");
      expect(header(buf, 36, 4), `${type} data`).toBe("data");
      expect(buf.length).toBe(44 + buf.readInt32LE(40));
    }
  });

  test("is mono 16-bit PCM at the declared rate", () => {
    for (const type of EMERGENCY_AUDIO_TYPES) {
      const buf = getEmergencyAudio(type);
      expect(int16le(buf, 20), `${type} format`).toBe(1); // PCM, not compressed
      expect(int16le(buf, 22), `${type} channels`).toBe(1);
      expect(buf.readUInt32LE(24), `${type} sample rate`).toBe(EMERGENCY_SAMPLE_RATE);
      expect(int16le(buf, 34), `${type} bits`).toBe(16);
      expect(buf.readUInt32LE(28), `${type} byte rate`).toBe(EMERGENCY_SAMPLE_RATE * 2);
    }
  });

  test("declares a size that matches the bytes handed back", () => {
    for (const type of EMERGENCY_AUDIO_TYPES) {
      expect(emergencyAudioBytes(type)).toBe(getEmergencyAudio(type).length);
    }
  });

  test("is byte-identical when asked twice — the cue is cached, not re-synthesised", () => {
    for (const type of EMERGENCY_AUDIO_TYPES) {
      expect(getEmergencyAudio(type).equals(getEmergencyAudio(type))).toBe(true);
    }
  });

  test("the three cues are different, not one buffer three times", () => {
    const error = getEmergencyAudio("error");
    const retry = getEmergencyAudio("retry");
    const silent = getEmergencyAudio("silent");
    expect(error.equals(retry)).toBe(false);
    expect(error.length).not.toBe(silent.length);
    // The one-second padding is what it says on the tin: 16 kHz x 2 bytes.
    expect(silent.length).toBe(44 + EMERGENCY_SAMPLE_RATE * 2);
  });
});

describe("the error cue the ladder actually serves", () => {
  test("carries real samples", () => {
    const buf = getEmergencyAudio("error");
    expect(buf.length).toBeGreaterThan(44);
    expect(buf.readInt32LE(4)).toBe(buf.length - 8);
  });

  test("is never silent — a tone is the whole point", () => {
    const buf = getEmergencyAudio("error");
    let peak = 0;
    for (let off = 44; off + 1 < buf.length; off += 2) {
      peak = Math.max(peak, Math.abs(buf.readInt16LE(off)));
    }
    expect(peak).toBeGreaterThan(1000);
  });

  // A tone that starts at full amplitude is a discontinuity: on a phone line it
  // clicks, and a click sounds like a fault in the call — the impression this
  // cue exists to prevent.
  test("starts and ends at zero, having faded through the peak", () => {
    const buf = getEmergencyAudio("error");
    const last = buf.length - 2;
    expect(buf.readInt16LE(44)).toBe(0);
    expect(buf.readInt16LE(last)).toBeCloseTo(0, -3);
    const rising = Math.abs(buf.readInt16LE(44 + 20));
    expect(rising).toBeLessThan(10_000);
  });
});

describe("the silent cue", () => {
  test("is genuinely zeroed", () => {
    const buf = getEmergencyAudio("silent");
    for (let off = 44; off < buf.length; off++) expect(buf[off]).toBe(0);
  });
});

describe("the type guard", () => {
  test("accepts only the declared cues", () => {
    expect(isEmergencyAudioType("error")).toBe(true);
    expect(isEmergencyAudioType("retry")).toBe(true);
    expect(isEmergencyAudioType("silent")).toBe(true);
    expect(isEmergencyAudioType("music")).toBe(false);
    expect(isEmergencyAudioType("")).toBe(false);
    expect(isEmergencyAudioType(undefined)).toBe(false);
  });

  test("the content type is a WAV, so the route labels without guessing", () => {
    expect(EMERGENCY_AUDIO_CONTENT_TYPE).toBe("audio/wav");
  });
});
