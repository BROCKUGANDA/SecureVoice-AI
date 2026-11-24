/**
 * Source invariants: the moderation layer is WIRED at every content boundary.
 *
 * These follow the repo's source-invariant style (see tests for the email
 * worker and the compliance disclosure gates): a guarantee that rests on a
 * comment is not a guarantee, so the tests read the production files and
 * fail loudly when the wiring is removed. Each entry names the file and the
 * exact string that must exist.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("moderation wiring invariants", () => {
  test("the feature flag is honoured by the production moderation path", () => {
    // The flags gate requires the consumer string to exist in the named file.
    const src = read("src/lib/qwen3guard/moderate.ts");
    expect(src).toContain('flag("qwen3guard")');
  });

  test("/api/agent moderates input BEFORE drafting and output BEFORE the audit", () => {
    const src = read("src/app/api/agent/route.ts");
    const inputAt = src.indexOf('moderateContent({\n    stage: "input"');
    const draftAt = src.indexOf("await draftAgentReply({");
    const outputAt = src.indexOf('stage: "output"');
    const auditAt = src.indexOf("auditAgentReply({");
    expect(inputAt).toBeGreaterThan(-1);
    expect(draftAt).toBeGreaterThan(inputAt);
    expect(outputAt).toBeGreaterThan(draftAt);
    expect(auditAt).toBeGreaterThan(outputAt);
    // Unsafe input keeps the reply deterministic: no draft at all.
    expect(src).toContain("secretAsk || inputUnsafe\n      ? null");
    // An unsafe draft is discarded, never spoken.
    expect(src).toContain(
      "replyForAudit = drafted != null && !outputUnsafe ? drafted : scriptedWithExit",
    );
  });

  test("both TTS send paths gate on moderation BEFORE any synthesis spend", () => {
    // Stream route: the deterministic gate is prepareSpeech, called directly.
    const stream = read("src/app/api/tts/stream/route.ts");
    const streamModAt = stream.indexOf('stage: "speech"');
    const streamGateAt = stream.indexOf("prepareSpeech(");
    expect(streamModAt).toBeGreaterThan(-1);
    expect(streamGateAt).toBeGreaterThan(streamModAt);

    // Buffered route: the deterministic gate runs inside elevenTts (speech:
    // {lang}); the moderation gate must precede the synthesis ladder.
    const buffered = read("src/app/api/tts/route.ts");
    const bufferedModAt = buffered.indexOf('stage: "speech"');
    const ladderAt = buffered.indexOf("await synthesizeWithLadder({");
    expect(bufferedModAt).toBeGreaterThan(-1);
    expect(ladderAt).toBeGreaterThan(-1);
    expect(ladderAt).toBeGreaterThan(bufferedModAt);
    // Unsafe is refused outright; fail_closed refuses on ANY non-clean
    // outcome (degraded included) — on both routes.
    for (const src of [stream, buffered]) {
      expect(src).toContain('sendModeration.verdict === "unsafe"');
      expect(src).toContain('env.qwen3guardFailureMode === "fail_closed"');
    }
  });

  test("the media-stream worker moderates input on final transcripts and speech before synthesis", () => {
    const src = read("src/worker/voice-stream.ts");
    expect(src).toContain('stage: "input"');
    expect(src).toContain('stage: "speech"');
    // The speech refusal plays the emergency fallback rather than silence.
    expect(src).toContain("moderation_unsafe_speech");
    expect(src).toContain("playEmergencyFallback(state, ws)");
  });

  test("the TwiML turn route gates on STT confidence before any consequential action", () => {
    const src = read("src/app/api/twilio/turn/route.ts");
    const gateAt = src.indexOf("lowConfidence");
    const freezeAt = src.indexOf('executeSoftFreeze(callSid, "twilio_turn")');
    expect(gateAt).toBeGreaterThan(-1);
    expect(freezeAt).toBeGreaterThan(gateAt);
    // Below-threshold turns reprompt and never reach the freeze.
    expect(src).toContain("stt_low_confidence");
  });

  test("tool arguments are moderated, and HIGH_RISK tools fail closed", () => {
    const src = read("src/lib/tool-guard.ts");
    expect(src).toContain('stage: "tool"');
    expect(src).toContain("HIGH_RISK");
    // The fail-closed condition: a high-risk tool refuses when the model layer
    // was genuinely consulted (or attempted) and did not come back clean —
    // while an operator-disabled layer (flag off / kill switch) never wedges
    // the tool shut.
    expect(src).toContain('risk === "HIGH_RISK" && consulted && !outcomeIsClean(moderation)');
    expect(src).toContain('moderation.source === "degraded";');
    // Safe never authorises: authorization is steps 1-3, unchanged.
    expect(src).toContain("authorizeToolCall(secret, toolName)");
  });

  test("post-call ingest moderation withholds indexing on a flagged transcript", () => {
    const src = read("src/lib/elevenlabs/inbound.ts");
    expect(src).toContain('stage: "ingest"');
    expect(src).toContain("moderation_unsafe_ingest");
    expect(src).toContain("!ingestFlagged");
  });

  test("the breaker declares the moderation fallback and it is never recorded as Safe", () => {
    const src = read("src/lib/failures/breaker.ts");
    expect(src).toContain('"moderation"');
    expect(src).toContain("never recorded as Safe");
  });

  test("the moderation models are registered in the tenancy guard", () => {
    const src = read("src/lib/tenancy/guard.ts");
    expect(src).toContain('"ModerationRequest"');
    expect(src).toContain('"ModerationPolicyVersion"');
  });

  test("the kill switch is a PlatformSwitch row with a cached, fail-safe read", () => {
    const src = read("src/lib/qwen3guard/moderate.ts");
    expect(src).toContain('MODERATION_KILL_SWITCH_NAME = "moderation_kill_switch"');
    expect(src).toContain("treating it as ENGAGED");
  });

  test("retention sweeps moderation evidence per tenant", () => {
    const src = read("src/lib/privacy/retention.ts");
    expect(src).toContain("sweepModerationEvidence");
    expect(src).toContain("moderationPolicyVersion.findFirst");
  });

  test("the OpenAPI contract publishes the moderation surface", () => {
    const src = read("src/lib/contracts/openapi.ts");
    expect(src).toContain("/v1/moderation/check");
    expect(src).toContain("/v1/moderation/results/{id}");
  });
});
