/**
 * The streaming URL, per model.
 *
 * Production shipped with `ELEVENLABS_MODEL=eleven_v4_turbo` and a stream route that
 * always appended `optimize_streaming_latency=3`. The vendor answers that combination
 * with `400 validation_error / unsupported_model`, the route turned any upstream
 * failure into a 503, and so every browser reply fell back to the buffered clip — a
 * 26-second block instead of a stream, discovered by listening rather than by CI.
 * These tests are the reason it is now CI's problem.
 */
import { describe, expect, test } from "bun:test";

import { streamQueryFor } from "@/lib/elevenlabs/client";
import { env } from "@/lib/config";

describe("the stream query the vendor will accept", () => {
  test("the v4 family gets no streaming-latency parameter", () => {
    for (const model of ["eleven_v4_turbo", "eleven_v4", "eleven_v4_gpt"]) {
      expect(streamQueryFor(model), model).toBe("");
    }
  });

  test("v2-era models keep the parameter", () => {
    for (const model of ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5"]) {
      expect(streamQueryFor(model), model).toBe("?optimize_streaming_latency=3");
    }
  });

  test("the configured model cannot produce a rejected request", () => {
    // The regression in one line: whatever this deployment resolves as its TTS model,
    // the query attached to it must be one that model accepts.
    const model = env.elevenLabsModel;
    const query = streamQueryFor(model);
    if (/^eleven_v4/.test(model)) {
      expect(query).toBe("");
    } else {
      expect(query).toContain("optimize_streaming_latency");
    }
  });

  test("an unrecognised model is treated as one that supports the parameter", () => {
    // Fail toward the older, wider behaviour: the v4 rejection is a named family, and a
    // future model must not silently lose streaming because its name is new here.
    expect(streamQueryFor("eleven_future_v5")).toBe("?optimize_streaming_latency=3");
  });
});
