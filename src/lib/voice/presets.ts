import "server-only";
import { env } from "@/lib/config";

/**
 * Named voice profiles.
 *
 * Before this module, every synthesis path assembled its own voice settings from
 * `env.voiceStability` / `env.voiceDefaultSpeed` independently — three call
 * sites (`elevenlabs/client.ts`, `elevenlabs/pool.ts`, `playht.ts`) reading the
 * same numbers and applying them the same way. That is how a voice ends up
 * sounding different depending on which path served the turn: the pooled
 * fallback is not obviously the ElevenLabs client, so a tuning change that
 * reaches one and not the other is invisible until a customer hears it.
 *
 * A preset is the whole shape of a voice — stability, similarity, speaker
 * boost, speed — as one named thing, resolved in one place. Turning the pacing
 * down for guarded turns is then a single decision rather than four edits that
 * have to stay in agreement.
 *
 * ── Why "paced" exists at all ────────────────────────────────────────────────
 * The product already says what it wants here, in `src/lib/deck.ts`: "the pace
 * is deliberately slightly slower than conversational, because our listener is
 * stressed." Nothing implemented that as a setting — `voiceDefaultSpeed`
 * defaulted to 1.0, i.e. exactly conversational. So the pitch described a voice
 * the code did not produce.
 *
 * The two presets, and the line between them:
 *
 *   `instant` — fillers, prompts, "one moment", turn-taking noise. Anything
 *               whose value is that it arrives BEFORE the caller has finished
 *               thinking. Slowing these down costs latency and buys nothing.
 *
 *   `paced`   — everything the bank is actually accountable for: identity
 *               challenges, transaction confirmations, the card-freeze
 *               announcement, handoff. Slower and steadier, because these are
 *               the words that will be replayed to a regulator and transcribed
 *               into a dispute.
 *
 * Note this does NOT follow "important = paced" uniformly: a card-freeze
 * confirmation is important AND is the single most reassuring moment in the
 * call, so it is deliberately paced. A "hold on" filler is also agent speech but
 * is not paced. The decision lives in `paceForTurn`, not at the call site, so
 * there is exactly one place to argue about it.
 */

/** How fast, and how steady, the agent should speak. */
export type VoicePace = "instant" | "paced";

export type VoiceProfile = {
  /** ElevenLabs stability, 0–1. Lower = more expressive variance per utterance. */
  stability: number;
  /** ElevenLabs similarity boost, 0–1. How closely to the source voice. */
  similarityBoost: number;
  /** ElevenLabs speaker boost — widens the perceived dynamic range. */
  useSpeakerBoost: boolean;
  /** Speech rate multiplier. Below 1 is slower than conversational. */
  speed: number;
};

/**
 * Per-language overrides.
 *
 * A language whose phones do not match English prosody will sound rushed at the
 * same multiplier that sounds considered in English, so the multiplier is
 * tunable per language without forking the preset. Env-only on purpose: this is
 * a deployment taste decision, not a code one, and the defaults below are the
 * values we ship.
 */
type PaceTuning = { speed?: number; stability?: number };

const TUNING: Record<VoicePace, Record<string, PaceTuning>> = {
  paced: {
    // English is the reference the deck copy was written against.
    en: { speed: 0.92 },
    // Arabic digraphs and long vowel runs read as rushed when English does not;
    // a touch slower buys the same clarity.
    ar: { speed: 0.88 },
    // ── The four spoken-but-unpaced languages ─────────────────────────────────
    //
    // The agent has spoken Hindi, Urdu, French and Kiswahili since the voice
    // tables landed, but TUNING covered only en/ar, so every one of those calls
    // ran the legally-loaded lines — the opening disclosure, the card-freeze
    // announcement, the handoff — at the English default. That is the exact
    // failure the per-language override exists to prevent, applied to three
    // quarters of the non-English fleet.
    //
    // Values are a starting point to be tuned against recorded calls, chosen on
    // the two properties that actually move intelligibility rather than taste:
    //
    //   · HINDI/URDU are prosodically similar to each other and both are
    //     syllable-timed with heavy consonant clustering (क/ख clusters, retroflex
    //     ट/ठ/ड/ृ). A cluster that has to be articulated inside one syllable
    //     needs more room than an English vowel-plus-consonant, so they sit
    //     closest to Arabic's 0.88 rather than to English's 0.92.
    //   · KISWAHILI is also syllable-timed with agglutination (loanwords written
    //     in one long word, e.g. "kusimamisha" for freeze), which is the same
    //     argument and the same value.
    //   · FRENCH is the outlier in the other direction: it is stress-timed like
    //     English but with far more liaison and elision ("vous avez", "au lieu",
    //     final-schwa deletions). Running it slow enough to help the other four
    //     flattens the prosody that makes it intelligible at all, so it stays at
    //     the English reference.
    //
    // All are env-overridable via the `envNumber` lookups below, because these
    // are guesses until a native speaker has heard a real call in each language.
    hi: { speed: 0.88 },
    ur: { speed: 0.88 },
    sw: { speed: 0.88 },
    fr: { speed: 0.92 },
  },
  instant: {},
};

function envNumber(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : undefined;
}

/**
 * Resolve a preset into concrete settings.
 *
 * `env.voiceStability` / `env.voiceDefaultSpeed` remain the fallback for
 * `instant`, so a deployment that tuned those globally keeps its tuning on every
 * fast path — the preset adds a paced option without silently discarding a
 * setting an operator already chose.
 */
export function voiceProfile(pace: VoicePace): VoiceProfile {
  const base: VoiceProfile =
    pace === "paced"
      ? {
          stability: env.voiceStability,
          similarityBoost: env.voiceSimilarityBoost,
          useSpeakerBoost: env.voiceUseSpeakerBoost,
          // The one setting the preset owns outright. The others are the
          // deployment's, because tuning them per-operator is legitimate;
          // shipping 1.0 here would just be re-introducing the gap between the
          // documented voice and the real one.
          speed: envNumber("TTS_PACED_VOICE_SPEED") ?? 0.92,
        }
      : {
          stability: env.voiceStability,
          similarityBoost: env.voiceSimilarityBoost,
          useSpeakerBoost: env.voiceUseSpeakerBoost,
          speed: env.voiceDefaultSpeed,
        };
  return base;
}

/** As `voiceProfile`, with a per-language multiplier applied. */
export function voiceProfileFor(pace: VoicePace, lang?: string): VoiceProfile {
  const p = voiceProfile(pace);
  const tune = lang ? TUNING[pace]?.[lang] : undefined;
  if (!tune) return p;
  return {
    ...p,
    speed: tune.speed ?? p.speed,
    stability: tune.stability ?? p.stability,
  };
}

/**
 * What kind of turn is this?
 *
 * The only classification that matters is "does the caller need words BEFORE
 * they have finished processing", because that is what a slow voice costs.
 * Everything else is agent speech the bank stands behind.
 */
export type TurnKind = "filler" | "prompt" | "guarded" | "confirmation" | "handoff";

/**
 * Map a turn to a pace.
 *
 * `filler` and `prompt` are the instant paths: a "hold on" that arrives slowly
 * is a worse product than a "hold on" that arrives immediately, and nothing
 * about the call's regulatory weight depends on it.
 *
 * `confirmation` is paced for the same reason as `guarded`, and is named
 * separately because it is the turn most likely to be quoted back in a dispute:
 * "you told me you froze it, and I heard you say it slowly."
 */
export function paceForTurn(kind: TurnKind): VoicePace {
  return kind === "filler" || kind === "prompt" ? "instant" : "paced";
}
