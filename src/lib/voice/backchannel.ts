import "server-only";

import { SAFETY_EXIT } from "@/lib/compliance/safety-exit";
import { NEVER_ASK_LINE } from "@/lib/compliance/never-ask";
import {
  EMERGENCY_FALLBACK,
  FREEZE_CONFIRMATION,
  HOLDING_EMPATHY,
  HOLDING_FOLLOWUP,
  NUDGE,
  OPENING,
} from "./conversation";

/**
 * Back-channel audio and pre-warming — the two latency tricks that need no new
 * dependency and no new provider.
 *
 * ## Why these exist
 *
 * A voice turn has a dead-air budget, and the dead air is not where people think
 * it is. It is not mostly network: it is mostly the *gap* between the customer's
 * last syllable and the agent's first one, which is Deepgram's final transcription,
 * the router, the TTS provider's time-to-first-byte, and connection setup. All four
 * are avoidable work.
 *
 *   - **Pre-warm** moves connection setup and the first synthesis of the FIXED
 *     phrases (the opening disclosure, the hang-up-safe exit, the freeze
 *     confirmation) from "when the customer speaks" to "when the call connects".
 *     Those phrases are constants, so they are maximally cacheable and maximally
 *     wasteful to synthesise on the critical path.
 *   - **Back-channel** covers the remainder — the part that is genuinely
 *     compute — with a pre-recorded "mm-hm" that costs a cache read.
 *
 * ## The subtlety, stated because it is the whole risk of this feature
 *
 * `src/lib/llm.ts` instructs the model: *"Do not use filler sounds like 'umm' or
 * 'uh'."* That instruction must NOT be relaxed.
 *
 * A filler synthesised in the agent's own voice, mid-sentence, reads as evasive —
 * which is precisely what a suspicious customer is listening for. A short
 * back-channel during a processing pause reads as ordinary human telephone
 * behaviour, because that is what it is.
 *
 * So the back-channel here is served from a **local pre-recorded asset**, never
 * from the model, and is emitted only in the processing gap — never inside a
 * reply. Getting that wrong would make the agent sound like every vishing call a
 * customer has been warned about, which would cost more than the latency it saves.
 */

/** The asset directory. Populated by `bun run voice:assets`. */
export const BACKCHANNEL_DIR = "/voice/backchannel";

/**
 * Per-language back-channel lines.
 *
 * Short, rising, and question-free. A back-channel that asks anything trains a
 * customer to answer the agent reflexively — which is exactly the reflex a
 * vishing caller wants, so a back-channel must never be interrogative.
 */
export const BACKCHANNEL_TEXT = {
  en: "Mm-hm.",
  ar: "نعم، أسمعك.",
  hi: "हम्म, सुन रहा हूँ।",
  ur: "ہاں، سن رہا ہوں۔",
  fr: "Je vous écoute.",
  sw: "Ninasikiliza.",
} as const;

export type BackchannelLang = keyof typeof BACKCHANNEL_TEXT;

/**
 * How long a back-channel may cover.
 *
 * Bounded hard. A back-channel that plays for three seconds while the agent is
 * thinking is not covering a gap, it is holding the line hostage — the customer
 * asked a question and is waiting for an answer, not for reassurance. Past this
 * bound, silence is more honest than filler.
 */
export const MAX_BACKCHANNEL_MS = 1_200;

/** The path a language's back-channel asset should live at. */
export function backchannelAssetPath(lang: BackchannelLang, ext = "mp3"): string {
  return `${BACKCHANNEL_DIR}/${lang}.${ext}`;
}

/**
 * Is a back-channel worth playing for this gap?
 *
 * The rules, in order, each of which exists because the alternative is a customer
 * hearing something that makes them distrust the call:
 *
 *  - The gap must be long enough to be noticed. Below ~250 ms nobody perceives
 *    silence, and playing into it means the back-channel overlaps the real reply.
 *  - The gap must not be so long that the customer thinks the agent hung up.
 *  - **Never during the opening.** The first thing a customer hears from an
 *    unfamiliar number should be the bank's own disclosure, not a filler that
 *    could be mistaken for a recording. This is the rule that matters most.
 */
export function shouldPlayBackchannel(input: {
  /** Measured gap between the customer's last syllable and audio-out, in ms. */
  gapMs: number;
  /** True while the agent is still speaking its opening. */
  opening?: boolean;
  /** Bounded by ConversationState.MAX_NUDGES upstream. */
  alreadyPlayed?: boolean;
  lang?: BackchannelLang;
}): boolean {
  if (input.alreadyPlayed) return false;
  if (input.opening) return false;
  if (input.gapMs < 250) return false;
  return input.gapMs <= MAX_BACKCHANNEL_MS;
}

/**
 * The fixed phrases worth pre-synthesising at call setup.
 *
 * Chosen because they are CONSTANTS — the same bytes on every call — so the
 * synthesis is pure cache-fill and the first real turn is a cache hit. A phrase
 * that varies per customer cannot be warmed, which is why this list is short and
 * why the customer-specific lines are not in it.
 *
 * The list is the media-stream plane's entire spoken vocabulary: the opening,
 * the silence nudge, every holding line, the freeze confirmation, the emergency
 * fallback, the hang-up-safe exit, the never-ask refusal, and the back-channel
 * itself. Warming ALL of them means the dialing-to-answered window — the only
 * quiet moment in the whole call — is enough to make every possible first
 * response a cache read instead of a synthesis.
 *
 * The list is returned as TEXT rather than audio so this module stays pure and
 * testable; the synthesis itself is the caller's job and is deliberately allowed
 * to fail.
 */
export function warmablePhrases(lang: BackchannelLang): string[] {
  return [
    // The opener. Long, fixed, and spoken on every single call — the single
    // best warm target in the system.
    OPENING[lang],
    // The hang-up-safe exit. Fixed, and spoken at the most damaging moment
    // possible, so a cold cache there is worst-case.
    SAFETY_EXIT[lang],
    // The fraud branch's terminal confirmation.
    FREEZE_CONFIRMATION[lang],
    // The two holding lines the non-fraud branches speak.
    HOLDING_FOLLOWUP[lang],
    HOLDING_EMPATHY[lang],
    // The dead-air nudge.
    NUDGE[lang],
    // The never-ask refusal (rule 2): fixed, and a paraphrase of it is worse
    // than the line itself.
    NEVER_ASK_LINE[lang],
    // The last-resort line when every synthesis path has failed.
    EMERGENCY_FALLBACK[lang],
    // The back-channel itself, if it has been rendered from text.
    BACKCHANNEL_TEXT[lang],
  ].filter(Boolean);
}
