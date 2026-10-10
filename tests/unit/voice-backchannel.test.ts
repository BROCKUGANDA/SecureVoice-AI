/**
 * The back-channel gate — trick 3's safety rules, asserted.
 *
 * The filler is only correct when it does NOT play: over the opening
 * disclosure, over a reply that is already arriving, or for a gap so long the
 * customer has concluded the agent hung up. Each of those has a test, because
 * each is a way a "latency optimisation" makes the call sound like the
 * vishing calls the customer has been warned about.
 */
import { describe, expect, it } from "bun:test";

import {
  BACKCHANNEL_TEXT,
  MAX_BACKCHANNEL_MS,
  backchannelAssetPath,
  shouldPlayBackchannel,
  warmablePhrases,
} from "@/lib/voice/backchannel";

describe("back-channel — when it must NOT play", () => {
  it("never plays over the opening disclosure", () => {
    expect(shouldPlayBackchannel({ gapMs: 900, opening: true })).toBe(false);
  });

  it("never plays twice for the same turn", () => {
    expect(shouldPlayBackchannel({ gapMs: 900, alreadyPlayed: true })).toBe(false);
  });

  it("does not play into a gap nobody perceives", () => {
    // Below ~250 ms the filler would overlap the real reply.
    expect(shouldPlayBackchannel({ gapMs: 100 })).toBe(false);
    expect(shouldPlayBackchannel({ gapMs: 249 })).toBe(false);
  });

  it("does not play when the caller has already given up", () => {
    // Past the bound, silence is more honest than filler.
    expect(shouldPlayBackchannel({ gapMs: MAX_BACKCHANNEL_MS + 1 })).toBe(false);
    expect(shouldPlayBackchannel({ gapMs: 5_000 })).toBe(false);
  });

  it("treats the boundary as inclusive", () => {
    expect(shouldPlayBackchannel({ gapMs: 250 })).toBe(true);
    expect(shouldPlayBackchannel({ gapMs: MAX_BACKCHANNEL_MS })).toBe(true);
  });
});

describe("back-channel — the copy itself is safe", () => {
  it("is non-interrogative in every language", () => {
    // A back-channel that asks anything trains the customer to answer the
    // agent reflexively — the reflex a vishing caller depends on.
    for (const [lang, text] of Object.entries(BACKCHANNEL_TEXT)) {
      expect(text.trim().length, `${lang} back-channel is empty`).toBeGreaterThan(0);
      expect(/[?؟]/.test(text), `${lang} back-channel must not ask a question`).toBe(false);
    }
  });

  it("has an asset path per language", () => {
    expect(backchannelAssetPath("en")).toBe("/voice/backchannel/en.mp3");
    expect(backchannelAssetPath("ur", "wav")).toBe("/voice/backchannel/ur.wav");
  });
});

describe("warmable phrases — the fixed vocabulary is complete", () => {
  it("covers every language with the exit, the opener and the filler", () => {
    for (const lang of ["en", "ar", "hi", "ur", "fr", "sw"] as const) {
      const phrases = warmablePhrases(lang);
      // Every fixed line the media-stream worker can speak, minus the
      // customer-specific ones, must be warmable.
      expect(phrases.length).toBeGreaterThanOrEqual(8);
      expect(phrases.every((p) => p && p.trim().length > 0)).toBe(true);
      expect(new Set(phrases).size).toBe(phrases.length); // no duplicates
    }
  });

  it("includes the hang-up-safe exit, which must never be cold", () => {
    const en = warmablePhrases("en").join(" | ");
    expect(en).toContain("You may hang up now");
    expect(en).toContain("thirty minutes");
  });

  it("includes the never-ask refusal line", () => {
    const en = warmablePhrases("en").join(" | ");
    expect(en).toContain("I will never ask for that");
  });
});
