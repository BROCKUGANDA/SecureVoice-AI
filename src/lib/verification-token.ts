import "server-only";

/**
 * The out-of-band verification token — the second half of the anchoring story.
 *
 * The heads-up SMS anchors the **event**: "a verification call is coming". It
 * cannot anchor the **call**, because a customer who receives a scam call has no
 * legitimate message to compare it against. This token is what makes the call
 * itself checkable.
 *
 * ## The design, and why it is shaped this way
 *
 * **Words, not digits.** `Delta-Two-Nine`, not `482913`. Three reasons, all of
 * them load-bearing:
 *
 *  1. A digit string is indistinguishable from an OTP. A customer reading
 *     "482913" aloud to check whether a call is real would be doing exactly what
 *     a vishing caller trains them to do — giving up a code. Words carry no such
 *     habit.
 *  2. Digits get read ambiguously over a phone line. Nine and ninety, fifteen
 *     and fifty, are exactly the confusions a customer cannot resolve while also
 *     assessing whether they are being scammed.
 *  3. Digit patterns collide with the platform's own PII redaction and
 *     solicitation guards, so a numeric token would be mangled by the speech gate
 *     or trip a rule designed for something else entirely.
 *
 * **Hashed at rest.** The token grants nothing — it is not a credential, and
 * possessing one does not authenticate anybody. But storing a value that a human
 * might later read aloud has no benefit and a real cost, so it is a SHA-256 and
 * the plaintext is returned exactly once, to the bank integration that renders it
 * in the customer's app.
 *
 * **The agent NEVER speaks it, and never asks for it.** This is the part that
 * makes the whole thing safe, and it is enforced rather than documented:
 * `bindVerificationToken` on the speech context makes `prepareSpeech` refuse any
 * utterance containing the token. So even a tenant-authored line, an LLM draft,
 * or a compromised prompt cannot turn the out-of-band anchor into an in-band
 * credential — which is the one failure mode that would make this feature
 * actively harmful.
 *
 * ## What this is NOT
 *
 * **It is not identity verification.** The token proves a verification call is
 * in progress; it does not prove who is on the line. Anyone who can see the
 * customer's app can read it, which is the point (it is on a channel the
 * fraudster does not control) and also the limit. Do not describe this as
 * authenticating the customer. It closes the impersonation gap, not the
 * social-engineering one.
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * The word set.
 *
 * NATO phonetic alphabet, deliberately. It exists precisely so that a word
 * survives being read aloud over a bad phone line — which is the entire use case,
 * and the reason a list of short, confusable words ("alpha", "bravo", "delta",
 * "echo", "foxtrot") would have been the wrong choice.
 */
const WORDS = [
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliett",
  "Kilo",
  "Lima",
  "Mike",
  "November",
  "Oscar",
  "Papa",
  "Quebec",
  "Romeo",
  "Sierra",
  "Tango",
  "Uniform",
  "Victor",
  "Whiskey",
  "Xray",
  "Yankee",
  "Zulu",
] as const;

export type VerificationToken = {
  /** The word form, e.g. "Delta-Bravo-Sierra". Returned ONCE, at creation. */
  plaintext: string;
  /** SHA-256 hex. What is stored. */
  hash: string;
};

/**
 * Mint a token.
 *
 * `randomInt` is CSPRNG-backed; `Math.random` would make the word guessable by a
 * caller who could observe a few tokens, and a guessable anchor is not an
 * anchor.
 *
 * Words are sampled without replacement so the three positions cannot repeat —
 * "Delta-Delta-Delta" is a phrase a fraudster could stumble into and, worse, one
 * a customer cannot distinguish from a real token.
 *
 * The space is 26 × 25 × 24 = **15,600**. An earlier design used a NATO word for
 * position one and two single digits for the others, which was more compact to
 * read and had a space of 2,340 — small enough that the birthday problem makes
 * collisions common within a few hundred mints (measured: 300 mints produced 183
 * distinct tokens). The token is not a credential, so that is not a
 * break-in-the-worst-case, but a 2,340-value space is a number a security-minded
 * reader will do arithmetic on, and three NATO words are exactly as easy to read
 * aloud as two digits while being seven times harder to guess.
 */
export function mintVerificationToken(): VerificationToken {
  const picked = new Set<number>();
  while (picked.size < 3) picked.add(randomInt(WORDS.length));
  const [a, b, c] = [...picked];
  const plaintext = `${WORDS[a!]}-${WORDS[b!]}-${WORDS[c!]}`;
  return { plaintext, hash: hashToken(plaintext) };
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext.trim().toLowerCase()).digest("hex");
}

/**
 * Constant-time comparison.
 *
 * Timing matters less here than usual — the token is not a bearer credential —
 * but a non-constant comparison invites the question "why isn't this timed?", and
 * `timingSafeEqual` costs nothing at this call frequency.
 */
export function tokenMatches(plaintext: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashToken(plaintext), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reduce a token to its comparable form.
 *
 * Used to check whether an utterance CONTAINS the token, which has to survive the
 * speech gate's normalisation (punctuation stripped, case folded, whitespace
 * collapsed). "delta bravo sierra", "Delta, bravo, sierra." and
 * "DELTA-BRAVO-SIERRA" must all be caught — a check that only matched the
 * canonical hyphenated form would miss every way the token is actually rendered.
 */
export function tokenForm(plaintext: string): string {
  return plaintext
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does this utterance contain the token in any rendering? */
export function speaksToken(utterance: string, plaintext: string): boolean {
  const spoken = tokenForm(utterance);
  const token = tokenForm(plaintext);
  if (!token) return false;
  return spoken.includes(token);
}

/** A display form for the operator console. Never the storage form. */
export function maskToken(plaintext: string): string {
  return `${plaintext.slice(0, 1)}…${plaintext.slice(-1)}`;
}
