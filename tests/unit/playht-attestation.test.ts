/**
 * The backup vendor is not a free pass.
 *
 * `src/lib/elevenlabs/playht.ts` arrived as a complete client with no caller, and
 * wiring it into a live call path raises one question the module did not answer
 * for itself: what stops a failover from spending an account nobody attested?
 * ElevenLabs calls are refused until `ELEVENLABS_COMMERCIAL_USE=true` because the
 * free tier is non-commercial only (ToS §1(c)(i)) — and a second vendor cannot
 * inherit that attestation, because "the operator attested ElevenLabs" says
 * nothing about a PlayHT account.
 *
 *   bun test tests/unit/playht-attestation.test.ts
 */
import { beforeEach, expect, test } from "bun:test";
import { generatePlayhtAudio, isPlayhtConfigured, playhtVoice } from "@/lib/elevenlabs/playht";

const KEYS = {
  PLAYHT_API_KEY: "pk-test",
  PLAYHT_USER_ID: "user-test",
  PLAYHT_VOICE_ID: "s3://voice-cloning-zero-shot/test/manifest.json",
  PLAYHT_COMMERCIAL_USE: "true",
};

function setEnv(patch: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  setEnv({
    PLAYHT_API_KEY: undefined,
    PLAYHT_USER_ID: undefined,
    PLAYHT_VOICE_ID: undefined,
    PLAYHT_COMMERCIAL_USE: undefined,
  });
});

test("no credentials is refused as unconfigured, whatever else is set", async () => {
  setEnv({ PLAYHT_VOICE_ID: KEYS.PLAYHT_VOICE_ID, PLAYHT_COMMERCIAL_USE: "true" });
  expect(isPlayhtConfigured()).toBe(false);
  await expect(generatePlayhtAudio("hello", KEYS.PLAYHT_VOICE_ID)).rejects.toThrow(
    /not configured/i,
  );
});

test("a half-configured account is still not a fallback", async () => {
  setEnv({ PLAYHT_API_KEY: KEYS.PLAYHT_API_KEY, PLAYHT_COMMERCIAL_USE: "true" });
  expect(isPlayhtConfigured()).toBe(false);
  // A user id is required alongside the key: the vendor needs both to bill.
  await expect(generatePlayhtAudio("hello", KEYS.PLAYHT_VOICE_ID)).rejects.toThrow(
    /not configured/i,
  );
});

test("an unattested account is refused before any spend", async () => {
  setEnv({ ...KEYS, PLAYHT_COMMERCIAL_USE: undefined });
  expect(isPlayhtConfigured()).toBe(false);
  const err = await generatePlayhtAudio("hello", KEYS.PLAYHT_VOICE_ID).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/commercial use/i);
});

test("a fallback with no chosen voice is not a fallback", async () => {
  setEnv({ PLAYHT_API_KEY: "pk", PLAYHT_USER_ID: "u", PLAYHT_COMMERCIAL_USE: "true" });
  expect(playhtVoice()).toBeUndefined();
  expect(isPlayhtConfigured()).toBe(false);
});

test("attested, credentialed and voiced — the rung is offered", () => {
  setEnv(KEYS);
  expect(isPlayhtConfigured()).toBe(true);
  expect(playhtVoice()).toBe(KEYS.PLAYHT_VOICE_ID);
});

test("attestation is read per call, not once at boot", async () => {
  setEnv(KEYS);
  expect(isPlayhtConfigured()).toBe(true);
  setEnv({ PLAYHT_COMMERCIAL_USE: "false" });
  expect(isPlayhtConfigured()).toBe(false);
  await expect(generatePlayhtAudio("hello", KEYS.PLAYHT_VOICE_ID)).rejects.toThrow(
    /commercial use/i,
  );
  setEnv({ PLAYHT_COMMERCIAL_USE: "true" });
  expect(isPlayhtConfigured()).toBe(true);
});

test("empty text and an empty voice are refused with 422, not attempted", async () => {
  setEnv(KEYS);
  await expect(generatePlayhtAudio("   ", KEYS.PLAYHT_VOICE_ID)).rejects.toThrow(/text/i);
  await expect(generatePlayhtAudio("hello", "")).rejects.toThrow(/voice/i);
});
