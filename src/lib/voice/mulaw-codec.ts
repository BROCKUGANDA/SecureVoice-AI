/**
 * Mulaw codec utilities for Twilio Media Streams.
 *
 * Twilio Media Streams sends/receives 8kHz signed 16-bit PCM audio encoded as
 * mulaw. We convert to/from Float32 for Deepgram/ElevenLabs.
 */

/**
 * Encode 16-bit PCM samples to mulaw.
 */
export function encodeMulaw(pcm: Buffer): Buffer {
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = (pcm[i + 1] << 8) | pcm[i];
    const sign = sample >> 15;
    const magnitude = sign ? ~sample : sample;
    let mulaw = (~(magnitude >> 8)) & 0x0f;
    let exp = 7;
    let expMask = 0x70;
    while ((magnitude & expMask) !== expMask && exp > 0) {
      exp--;
      expMask >>= 1;
      mulaw = (mulaw << 1) | 1;
    }
    if (exp === 0) {
      mulaw |= magnitude >> 4;
    } else {
      const low = (magnitude >> (exp + 3)) & 0x0f;
      mulaw = (mulaw << 4) | low;
    }
    mulaw ^= 0xff;
    out[i / 2] = mulaw;
  }
  return out;
}

/**
 * Decode mulaw to 16-bit PCM.
 */
export function decodeMulaw(mulaw: Buffer): Buffer {
  const out = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    let s = ~mulaw[i];
    s = s < 0x20 ? s + 0x20 : s;
    const sign = s & 0x80;
    const exponent = (s & 0x70) >> 4;
    let data = (s & 0x0f) + 16;
    data <<= exponent + 2;
    let sample = sign ? data - 0x8000 : data;
    if (sign) sample |= 0x8000;
    out[i * 2] = sample & 0xff;
    out[i * 2 + 1] = (sample >> 8) & 0xff;
  }
  return out;
}
