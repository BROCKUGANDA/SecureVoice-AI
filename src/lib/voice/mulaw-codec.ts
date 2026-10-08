/**
 * G.711 µ-law codec for Twilio Media Streams.
 *
 * Twilio carries 8 kHz µ-law on the media socket; Deepgram wants 16-bit signed
 * PCM and ElevenLabs hands it back. Both directions are the ITU-T G.711 µ-law
 * quantizer: the decode table is generated from the standard's reconstruction
 * formula and the encoder inverts that same table, so encode and decode are
 * exact inverses by construction rather than by agreement between two
 * hand-written bit tricks.
 */

/**
 * Reconstruction level of one µ-law code, in the 13-bit µ-law domain.
 *
 *   magnitude = ((mantissa + 17) << (exponent + 1)) - 33
 *
 * Bit 7 is the sign (1 = positive). The endpoints are the ones the standard
 * publishes: 0xff is +8159, 0x7f is -8159, 0x80 is +1, 0x00 is -1.
 */
function mulawLevel(code: number): number {
  const exponent = (code >> 4) & 0x07;
  const mantissa = code & 0x0f;
  const magnitude = ((mantissa + 17) << (exponent + 1)) - 33;
  return code & 0x80 ? magnitude : -magnitude;
}

/** µ-law scales a 16-bit sample by a quarter, so the table's ±8159 is ±32636. */
const LINEAR_SCALE = 4;

/**
 * The positive codes in ascending magnitude order: 0x80..0xff. Because they are
 * strictly ascending, encoding is a binary search over this array and the index
 * is the code with its sign bit cleared.
 */
const POSITIVE_LEVELS: number[] = [];
for (let code = 0x80; code <= 0xff; code++) {
  POSITIVE_LEVELS.push(mulawLevel(code) * LINEAR_SCALE);
}

/** Decode one µ-law code to a 16-bit linear sample. */
export function mulawToSample(code: number): number {
  const magnitude = POSITIVE_LEVELS[code & 0x7f];
  return code & 0x80 ? magnitude : -magnitude;
}

/** Encode one 16-bit linear sample to the nearest µ-law code. */
export function sampleToMulaw(sample: number): number {
  const clamped = Math.max(-32768, Math.min(32767, Math.trunc(sample)));
  const negative = clamped < 0;
  // -32768 has no positive mirror in 16-bit two's complement.
  const abs = negative ? -clamped : clamped;

  // First level >= abs (upper bound over a strictly ascending table).
  let lo = 0;
  let hi = POSITIVE_LEVELS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (POSITIVE_LEVELS[mid] < abs) lo = mid + 1;
    else hi = mid;
  }

  let idx: number;
  if (lo === 0) idx = 0;
  else if (lo >= POSITIVE_LEVELS.length) idx = POSITIVE_LEVELS.length - 1;
  else idx = POSITIVE_LEVELS[lo] - abs <= abs - POSITIVE_LEVELS[lo - 1] ? lo : lo - 1;

  return negative ? idx : 0x80 + idx;
}

/** Encode little-endian 16-bit PCM to µ-law. */
export function encodeMulaw(pcm: Buffer): Buffer {
  const out = Buffer.alloc(Math.floor(pcm.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = sampleToMulaw(pcm.readInt16LE(i * 2));
  }
  return out;
}

/** Decode µ-law to little-endian 16-bit PCM. */
export function decodeMulaw(mulaw: Buffer): Buffer {
  const out = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    out.writeInt16LE(mulawToSample(mulaw[i]), i * 2);
  }
  return out;
}

/**
 * µ-law to 32-bit float in the -1..1 range Deepgram expects, packed into a
 * Float32Array over the same 8 kHz timeline.
 */
export function mulawToFloat32(mulaw: Buffer): Float32Array {
  const out = new Float32Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    out[i] = mulawToSample(mulaw[i]) / 32768;
  }
  return out;
}
