/**
 * The voice provider label — one branch per claim a surface can make about audio.
 *
 * Why this is a gate and not a comment: production measured `X-Voice-Source:
 * emergency` on every utterance (0.48 s, byte-identical for different sentences)
 * while its own status surface named ElevenLabs as the provider. The old label read
 * only the API key, so a deployment that is refused by its own commercial-use guard
 * reported the vendor as live. Each branch below is a claim about what a caller will
 * actually hear.
 */
import { describe, expect, test } from "bun:test";

import { voiceProviderLabel } from "@/lib/config";

const VARS = ["ELEVENLABS_API_KEY", "ELEVENLABS_DRY_RUN", "ELEVENLABS_COMMERCIAL_USE"] as const;

function withVoiceEnv(set: Partial<Record<(typeof VARS)[number], string>>, body: () => void) {
  const saved = VARS.map((k) => [k, process.env[k]] as const);
  for (const k of VARS) {
    const next = set[k];
    if (next === undefined) delete process.env[k];
    else process.env[k] = next;
  }
  try {
    body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("the voice provider label", () => {
  test("no key configured", () => {
    withVoiceEnv({}, () => {
      expect(voiceProviderLabel()).toBe("z-ai-dev (no key configured)");
    });
  });

  test("dry-run names the stub rather than the vendor", () => {
    withVoiceEnv(
      {
        ELEVENLABS_API_KEY: "sk_test",
        ELEVENLABS_DRY_RUN: "true",
        ELEVENLABS_COMMERCIAL_USE: "true",
      },
      () => {
        expect(voiceProviderLabel()).toBe("z-ai-dev (dry-run)");
      },
    );
  });

  test("a key without the attestation is the emergency cue, not elevenlabs", () => {
    withVoiceEnv({ ELEVENLABS_API_KEY: "sk_test", ELEVENLABS_DRY_RUN: "false" }, () => {
      const label = voiceProviderLabel();
      expect(label).toStartWith("emergency-cue");
      expect(label).toContain("ELEVENLABS_COMMERCIAL_USE");
    });
  });

  test("only an attested live key claims the vendor", () => {
    withVoiceEnv(
      {
        ELEVENLABS_API_KEY: "sk_test",
        ELEVENLABS_DRY_RUN: "false",
        ELEVENLABS_COMMERCIAL_USE: "true",
      },
      () => {
        expect(voiceProviderLabel()).toBe("elevenlabs");
      },
    );
  });

  test("the attestation is read per call, not cached at import", () => {
    withVoiceEnv({ ELEVENLABS_API_KEY: "sk_test", ELEVENLABS_DRY_RUN: "false" }, () => {
      expect(voiceProviderLabel()).toStartWith("emergency-cue");
      process.env.ELEVENLABS_COMMERCIAL_USE = "true";
      try {
        expect(voiceProviderLabel()).toBe("elevenlabs");
      } finally {
        delete process.env.ELEVENLABS_COMMERCIAL_USE;
      }
    });
  });
});
