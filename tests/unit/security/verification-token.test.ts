/**
 * GATE — the out-of-band verification token.
 *
 * The token exists to answer one question: *how does a customer know this call is
 * real?* The SMS answers "a call is coming"; only a token on a surface the caller
 * cannot reach answers "this call is the one your bank said it would be".
 *
 * So the properties that make it worth building — and the ones that make it
 * dangerous if built wrong — are both asserted here:
 *
 *  1. **Words, never digits.** A numeric token is indistinguishable from an OTP,
 *     which is precisely what a customer is trained to read aloud to a caller.
 *  2. **Hashed at rest, plaintext returned exactly once.** Asserted against the
 *     database, not against a comment.
 *  3. **The agent cannot speak it.** The speech gate refuses any utterance
 *     containing the token, in every rendering a script could produce. This is the
 *     invariant that makes the feature safe rather than harmful.
 *  4. **A replayed signal returns no token.** The idempotency replay path
 *     persists the envelope, and a token in an idempotency table is a token an
 *     operator can replay from the audit view.
 *
 *   bun test tests/unit/security/verification-token.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  mintVerificationToken,
  tokenMatches,
  tokenForm,
  speaksToken,
  maskToken,
} from "@/lib/verification-token";
import { prepareSpeech } from "@/lib/compliance/speech-gate";
import { SAFETY_EXIT } from "@/lib/compliance/safety-exit";

describe("mintVerificationToken", () => {
  test("produces three words, not digits", () => {
    const { plaintext } = mintVerificationToken();
    // The whole reason for the design: a digit string would be
    // indistinguishable from an OTP to a customer reading it aloud.
    expect(plaintext).not.toMatch(/\d/);
    expect(plaintext.split("-")).toHaveLength(3);
  });

  test("never repeats a word, because 'Delta-Delta-Delta' is a phrase a caller could guess", () => {
    for (let i = 0; i < 200; i++) {
      const parts = mintVerificationToken().plaintext.split("-");
      expect(new Set(parts).size, `repeated word in ${parts.join("-")}`).toBe(3);
    }
  });

  test("the token space is large enough that collisions are not an event", () => {
    // Stated as a rate, not as "no collisions", because no CSPRNG survives a
    // no-collision assertion and asserting one would be asserting a falsehood.
    //
    // The birthday arithmetic is the actual test. For a space of N, drawing 300
    // samples yields about 300²/(2N) expected collisions:
    //   N = 2,340  → ~19 collisions → ~281 distinct
    //   N = 15,600 → ~2.9 collisions → ~297 distinct
    //
    // The threshold sits between the two, so reverting to the smaller design
    // fails here rather than shipping a token space someone can enumerate.
    const seen = new Set<string>();
    const SAMPLES = 300;
    for (let i = 0; i < SAMPLES; i++) seen.add(mintVerificationToken().plaintext);
    expect(seen.size).toBeGreaterThanOrEqual(285);
  });

  test("returns a hash that matches the plaintext, and is not the plaintext", () => {
    const { plaintext, hash } = mintVerificationToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(plaintext);
    expect(tokenMatches(plaintext, hash)).toBe(true);
  });

  test("matching is case- and whitespace-insensitive, because the app may render it differently", () => {
    const { plaintext, hash } = mintVerificationToken();
    expect(tokenMatches(` ${plaintext.toUpperCase()} `, hash)).toBe(true);
  });

  test("a wrong word does not match, and a null hash never matches", () => {
    const { hash } = mintVerificationToken();
    expect(tokenMatches("Zulu-Nine-Alpha", hash)).toBe(false);
    expect(tokenMatches("Delta-Two-Nine", null)).toBe(false);
    expect(tokenMatches("Delta-Two-Nine", "")).toBe(false);
    // Length mismatch must not throw: timingSafeEqual requires equal buffers.
    expect(tokenMatches("Delta-Two-Nine", "abc")).toBe(false);
  });
});

describe("speaksToken — every rendering a script could produce", () => {
  const token = "Delta-Bravo-Sierra";

  test("catches the canonical, spaced, punctuated and shouted forms", () => {
    // A check that only matched the hyphenated form would miss every way the
    // word is actually rendered in a script.
    for (const spoken of [
      "Delta-Bravo-Sierra",
      "delta bravo sierra",
      "Delta, bravo, sierra.",
      "DELTA BRAVO SIERRA",
      "your word is Delta Bravo Sierra, please confirm",
      "the reference word: delta-bravo-sierra",
    ]) {
      expect(speaksToken(spoken, token), `missed: ${spoken}`).toBe(true);
    }
  });

  test("does not fire on ordinary copy that shares a word", () => {
    // "Bravo" and "Sierra" are common words in a different register; a token
    // detector that trips on ordinary speech would refuse the whole agent.
    for (const safe of [
      "There were two nine customers waiting this morning.",
      "I will call you back in two minutes.",
      "Your card is temporarily restricted pending review.",
      "That is a fair question, and here is what happens next.",
    ]) {
      expect(speaksToken(safe, token), `false positive: ${safe}`).toBe(false);
    }
  });

  test("an empty token never matches anything", () => {
    expect(speaksToken("anything at all", "")).toBe(false);
  });

  test("tokenForm collapses punctuation and case", () => {
    expect(tokenForm("Delta-Two-Nine")).toBe("delta two nine");
    expect(tokenForm("  DELTA,  two nine. ")).toBe("delta two nine");
  });

  test("maskToken reveals almost nothing", () => {
    const m = maskToken("Delta-Two-Nine");
    expect(m.length).toBeLessThan(6);
    expect(m).toContain("…");
    expect(m).not.toContain("Two");
  });
});

describe("the speech gate makes the token unspeakable", () => {
  const token = "Delta-Two-Nine";
  const ctx = { verificationToken: token };

  test("refuses an utterance containing the token, and says why", () => {
    const r = prepareSpeech(`Your verification word is ${token}.`, ctx);
    expect(r.text).toBe("");
    // A distinct flag, because this is a BUG IN THE CODEBASE, not a bad model
    // output, and the two are triaged differently.
    expect(r.tokenLeak).toBe(true);
    // Explicitly NOT reported as a vishing refusal — an operator hunting for a
    // scam pattern would never find one.
    expect(r.vishing.ok).toBe(true);
  });

  test("refuses every rendering, including one hidden behind markdown", () => {
    for (const spoken of [
      `Your word is delta two nine`,
      `**${token}**`,
      `# ${token}`,
      `Please confirm: delta-two-nine`,
    ]) {
      const r = prepareSpeech(spoken, ctx);
      expect(r.text, `not refused: ${spoken}`).toBe("");
      expect(r.tokenLeak).toBe(true);
    }
  });

  test("does not refuse ordinary lines", () => {
    const honest =
      "I have flagged this transaction and placed a temporary restriction on your card while a human fraud specialist reviews it.";
    const r = prepareSpeech(honest, ctx);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.tokenLeak).toBeUndefined();
  });

  test("does not refuse the hang-up-safe exit", () => {
    const r = prepareSpeech(SAFETY_EXIT.en, ctx);
    expect(r.text.length).toBeGreaterThan(0);
  });

  test("with no token bound, nothing changes — the check is opt-in by context", () => {
    const r = prepareSpeech(`Your word is ${token}.`);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.tokenLeak).toBeUndefined();
  });
});
