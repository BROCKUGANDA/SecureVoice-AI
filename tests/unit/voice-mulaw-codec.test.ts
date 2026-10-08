import { describe, expect, it } from "bun:test";

import { decodeMulaw, encodeMulaw, mulawToSample, sampleToMulaw } from "@/lib/voice/mulaw-codec";

/**
 * G.711 µ-law is a fixed standard with published reconstruction levels. These
 * tests pin the codec to those numbers rather than to itself: a codec that is
 * self-consistent but wrong relative to the standard still produces audio Twilio
 * will play as noise.
 */
describe("mulaw codec — ITU-T G.711 reference levels", () => {
  it("decodes the four published endpoint codes", () => {
    expect(mulawToSample(0xff)).toBe(8159 * 4); // max positive
    expect(mulawToSample(0x7f)).toBe(-8159 * 4); // max negative
    expect(mulawToSample(0x80)).toBe(1 * 4); // smallest positive
    expect(mulawToSample(0x00)).toBe(-1 * 4); // smallest negative
  });

  it("steps by the segment width the standard defines", () => {
    // Segment 0 (exponent 0) has a step of 2 in the mulaw domain, so
    // consecutive mantissas differ by 8 in 16-bit linear counts.
    expect(mulawToSample(0x81) - mulawToSample(0x80)).toBe(2 * 4);
    // Segment 7 (exponent 7) has a step of 256.
    expect(mulawToSample(0xff) - mulawToSample(0xfe)).toBe(256 * 4);
  });

  it("is sign-symmetric: every code and its sign-flipped twin are exact opposites", () => {
    for (let code = 0; code < 0x80; code++) {
      expect(mulawToSample(code ^ 0x80)).toBe(-mulawToSample(code));
    }
  });

  it("orders the positive half strictly ascending", () => {
    for (let code = 0x81; code <= 0xff; code++) {
      expect(mulawToSample(code)).toBeGreaterThan(mulawToSample(code - 1));
    }
  });
});

describe("mulaw codec — encode/decode identity", () => {
  it("re-encodes every one of the 256 codes to itself", () => {
    for (let code = 0; code <= 0xff; code++) {
      expect(sampleToMulaw(mulawToSample(code))).toBe(code);
    }
  });

  it("sends full scale and silence to the codes telephony expects", () => {
    expect(sampleToMulaw(32636)).toBe(0xff);
    expect(sampleToMulaw(-32636)).toBe(0x7f);
    expect(sampleToMulaw(32767)).toBe(0xff); // clamped
    expect(sampleToMulaw(-32768)).toBe(0x7f); // no positive mirror
    expect(sampleToMulaw(0)).toBe(0x80);
  });

  it("keeps every int16 input inside int16 on the way back", () => {
    for (let sample = -32768; sample <= 32767; sample++) {
      const round = mulawToSample(sampleToMulaw(sample));
      expect(round).toBeGreaterThanOrEqual(-32768);
      expect(round).toBeLessThanOrEqual(32767);
      // Quantisation error must stay inside one segment-7 step.
      expect(Math.abs(round - sample)).toBeLessThanOrEqual(512);
    }
  });
});

describe("mulaw codec — buffer framing", () => {
  it("reads and writes little-endian 16-bit, which is what Twilio carries", () => {
    const encoded = encodeMulaw(Buffer.from([0x02, 0x01]));
    expect(encoded.length).toBe(1);

    const decoded = decodeMulaw(encoded);
    expect(decoded.length).toBe(2); // one mulaw byte is one s16le sample
    expect(decoded.readInt16LE(0)).toBe(mulawToSample(encoded[0] ?? 0));

    // Low byte first: the largest positive level, 8159 * 4 = 32636 = 0x7f7c.
    expect([...decodeMulaw(Buffer.from([0xff]))]).toEqual([0x7c, 0x7f]);
  });

  it("round-trips a 20 ms 8 kHz frame inside one quantisation step", () => {
    const pcm = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) {
      pcm.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * i) / 40)), i * 2);
    }
    const back = decodeMulaw(encodeMulaw(pcm));
    expect(back.length).toBe(pcm.length);
    for (let i = 0; i < 160; i++) {
      const drift = Math.abs(back.readInt16LE(i * 2) - pcm.readInt16LE(i * 2));
      expect(drift).toBeLessThanOrEqual(512);
    }
  });

  it("drops a trailing odd byte instead of reading past the buffer", () => {
    expect(encodeMulaw(Buffer.from([0x00, 0x00, 0x00]))).toHaveLength(1);
  });
});
