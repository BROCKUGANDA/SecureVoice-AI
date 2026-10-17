/**
 * A Twilio call routed through the voice worker cannot outlive the cap the
 * ElevenLabs plane already enforces.
 *
 * `agent/securevoice.agent.yaml:260` declares `max_duration_seconds: 180` as
 * invariant I-9, and the vendor enforces it server-side. The media-stream plane
 * (`src/worker/voice-stream.ts`) had a dead-air nudge and a first-audio deadline
 * but NO wall-clock bound, so a caller who simply kept talking could hold a
 * billed line open for as long as they liked — and the product's own invariant
 * was true only while the `twilioMediaStreams` flag pointed the other way.
 *
 * The parity case is the point of this file. A duplicated constant drifts; a
 * test that reads the vendor's declared value and compares it to the worker's
 * default fails the first time either one moves alone, which is the only way the
 * two planes keep promising a caller the same thing.
 *
 *   bun scripts/run-tests.mjs voice-call-hard-cap
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { voiceCallHardCapMs } from "@/worker/voice-stream";

const previous = process.env.VOICE_MAX_CALL_SECONDS;
afterEach(() => {
  if (previous === undefined) delete process.env.VOICE_MAX_CALL_SECONDS;
  else process.env.VOICE_MAX_CALL_SECONDS = previous;
});

describe("the worker's hard call cap", () => {
  test("falls back to the declared invariant when unset or malformed", () => {
    for (const value of [undefined, "", "0", "-5", "abc", "NaN", "Infinity"]) {
      if (value === undefined) delete process.env.VOICE_MAX_CALL_SECONDS;
      else process.env.VOICE_MAX_CALL_SECONDS = value;
      expect({ value, ms: voiceCallHardCapMs() }).toEqual({ value, ms: 180_000 });
    }
  });

  test("respects a configured value inside the sane band", () => {
    process.env.VOICE_MAX_CALL_SECONDS = "90";
    expect(voiceCallHardCapMs()).toBe(90_000);
    process.env.VOICE_MAX_CALL_SECONDS = "60";
    expect(voiceCallHardCapMs()).toBe(60_000);
  });

  test("cannot be dialled up into an hour-long fraud call", () => {
    // The floor and ceiling are the operator-facing guard: a misconfigured value
    // must not make the cap meaningless, and must not end a call before the
    // opening disclosure can be spoken.
    process.env.VOICE_MAX_CALL_SECONDS = "3600";
    expect(voiceCallHardCapMs()).toBe(600_000);
    process.env.VOICE_MAX_CALL_SECONDS = "5";
    expect(voiceCallHardCapMs()).toBe(30_000);
  });

  test("the two planes agree on the cap", () => {
    const yaml = readFileSync(join(process.cwd(), "agent", "securevoice.agent.yaml"), "utf8");
    const declared = /max_duration_seconds:\s*(\d+)/.exec(yaml);
    // Non-vacuous: the invariant has to exist in the config to be compared to.
    expect(declared).not.toBeNull();
    delete process.env.VOICE_MAX_CALL_SECONDS;
    expect(voiceCallHardCapMs()).toBe(Number(declared?.[1]) * 1000);
  });

  test("the cap terminates through the graceful sequence, not a dropped socket", () => {
    // Structural: the deadline must reuse `clear` + delayed `close`, the same
    // exit the silence path uses. `ws.close()` on its own cuts the customer off
    // mid-word, which is a worse outcome than overshooting the cap by a sentence.
    const src = readFileSync(join(process.cwd(), "src", "worker", "voice-stream.ts"), "utf8");
    const hardCapBlock = src.slice(src.indexOf("hardCapTimer = setTimeout"), src.length);
    const window = hardCapBlock.slice(0, 1600);
    expect(window).toContain('event: "clear"');
    expect(window).toContain("setTimeout(() => ws.close(), 1000)");
    expect(window).toContain("SAFETY_EXIT[state.lang]");
    expect(window).toContain("force: true");
    // And the timer is cleared when the socket goes, so it cannot fire into a
    // closed connection.
    const closeHandler = src.slice(
      src.indexOf('ws.on("close"'),
      src.indexOf('ws.on("close"') + 2000,
    );
    expect(closeHandler).toContain("clearTimeout(hardCapTimer)");
  });
});
