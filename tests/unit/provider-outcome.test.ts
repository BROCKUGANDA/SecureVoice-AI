import { describe, expect, test } from "bun:test";

/**
 * The attempt ladder, and the one case where it must NOT apply.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * An intervention is placed by handing the job to a carrier. From the moment
 * that handoff happens, a failure splits into two very different things:
 *
 *   · The carrier REFUSED it (a 4xx). It answered, and the answer was "no".
 *     Nothing was placed, the customer's phone did not ring, and trying again
 *     is exactly what the ladder is for.
 *   · The carrier did NOT answer (a 5xx, a timeout, a socket reset). The
 *     request may have been accepted and the response lost, so the call MAY
 *     already be ringing. Trying again rings the customer twice.
 *
 * The second case is the one that was broken. The in-flight marker is written
 * immediately before the provider call, and preserving it on every recorded
 * failure made a 4xx look like an unknown outcome — so a refused call
 * dead-lettered after ONE attempt instead of climbing to `MAX_DIAL_ATTEMPTS`,
 * and the customer got a "we couldn't reach you" text instead of a second
 * attempt at a voice call.
 *
 * The distinction is made by the provider's own status code, because both
 * planes put it in the message.
 */
import { providerAnswered } from "@/worker/dial";

describe("did the provider answer?", () => {
  test("a 4xx is an answer — the carrier refused, and nothing was placed", () => {
    for (const message of [
      "twilio dial refused (status 400): The 'From' number is not valid",
      "twilio dial refused (status 403): permission denied",
      "twilio dial refused (status 429): Too Many Requests",
      "ElevenLabs outbound-call 404: agent not found",
      "ElevenLabs outbound-call 422: unprocessable",
    ]) {
      expect(providerAnswered(message), message).toBe(true);
    }
  });

  test("a 5xx is NOT an answer — the request may have been accepted", () => {
    for (const message of [
      "twilio dial refused (status 500): internal error",
      "twilio dial refused (status 502): bad gateway",
      "twilio dial refused (status 503): network error",
      "ElevenLabs outbound-call 500: upstream",
      "ElevenLabs outbound-call 503: unavailable",
    ]) {
      expect(providerAnswered(message), message).toBe(false);
    }
  });

  test("a message with no status in it is not an answer", () => {
    // A timeout, a socket reset, a fetch failure. The absence of an answer is
    // the case that must not be retried.
    for (const message of [
      "network error",
      "fetch failed",
      "The operation was aborted due to timeout",
      "socket hang up",
      "",
    ]) {
      expect(providerAnswered(message), message).toBe(false);
    }
  });
});
