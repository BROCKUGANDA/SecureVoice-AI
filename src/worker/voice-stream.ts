/**
 * Voice-stream worker — Twilio Media Streams WebSocket server.
 *
 * Runs as its own compose service. Twilio opens a WebSocket to this process
 * for every live call; the worker pipes mulaw audio to Deepgram, routes the
 * transcript through the multi-agent router, and streams ElevenLabs audio
 * back to Twilio.
 *
 * One-shot mode for local testing:
 *   bun src/worker/voice-stream.ts --once
 *
 * Guardrails: every utterance this worker speaks passes `prepareSpeech` first
 * (PII redaction, speech-form cleanup, word limit, and the vishing blocklist).
 * That was NOT true before — this path called `sanitizeShariah` alone, so the
 * production Media Streams path bypassed every compliance rule the HTTP TTS
 * endpoints enforce.
 */

import { WebSocketServer, WebSocket } from "ws";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { env, SUPPORTED_LANGS } from "@/lib/config";
import { db } from "@/lib/db";
import type { TtsLang } from "@/lib/elevenlabs/client";
import { resolveTtsModel } from "@/lib/elevenlabs/client";
import { markVoiceFailed } from "@/lib/elevenlabs/sms-fallback";
import { DeepgramLiveClient, preconnectDeepgram } from "@/lib/voice/deepgram-client";
import { withFirstChunkDeadline } from "@/lib/voice/first-audio-deadline";
import { installProcessCrashHandlers } from "@/lib/process-crash-handlers";
import {
  beginCall,
  getActiveCallCount,
  isShuttingDown,
  setupGracefulShutdown,
} from "@/lib/graceful-shutdown";
import { initOtel } from "@/lib/telemetry/otel";
import { ElevenLabsStream } from "@/lib/voice/elevenlabs-stream";
import {
  ConversationState,
  EMERGENCY_FALLBACK,
  FREEZE_CONFIRMATION,
  FREEZE_UNSTAGED,
  HOLDING_EMPATHY,
  HOLDING_FOLLOWUP,
} from "@/lib/voice/conversation";
import { getWarmChunks, storeWarmChunks } from "@/lib/voice/warm-audio";
import { BACKCHANNEL_TEXT, shouldPlayBackchannel } from "@/lib/voice/backchannel";
import { SAFETY_EXIT } from "@/lib/compliance/safety-exit";
import { NEVER_ASK_LINE, callerRequestsSecret } from "@/lib/compliance/never-ask";
import { detectInjectionAttempt } from "@/lib/llm-guard";
import { startPrewarm } from "./prewarm";
import { routeAgentIntent, AgentRole } from "@/lib/ai/router";
import { executeSoftFreeze } from "@/lib/ai/ai-authz";
import { sanitizeShariah } from "@/lib/compliance/shariah-filter";
import { prepareSpeech } from "@/lib/compliance/speech-gate";
import { describeHits } from "@/lib/compliance/vishing";
import { append as auditAppend } from "@/lib/audit-chain";
import { recordSpan } from "@/lib/telemetry/spans";
import { logError, logInfo, logWarn } from "@/lib/validation/safe-log";

const PORT = Number(process.env.VOICE_STREAM_PORT ?? 8080);
const HOST = process.env.VOICE_STREAM_HOST ?? "0.0.0.0";

/**
 * How long the caller may stay silent — while the AI is merely LISTENING —
 * before the worker offers a nudge. Comfortably past a natural turn-taking
 * pause so it never cuts a caller off mid-thought, short enough to end real
 * dead air. The nudge itself is rate-limited by ConversationState.MAX_NUDGES.
 */
const SILENCE_NUDGE_MS = 8000;

/**
 * How long the caller's own last syllable may go unanswered before a
 * back-channel filler covers the gap.
 *
 * Matched to `shouldPlayBackchannel`'s floor (src/lib/voice/backchannel.ts):
 * below ~250 ms nobody perceives silence, so playing into it means the filler
 * overlaps the real reply. Above `MAX_BACKCHANNEL_MS` the caller thinks the
 * agent hung up, and the filler is not played at all — silence is more honest
 * than holding the line.
 */
const BACKCHANNEL_DELAY_MS = 250;

/**
 * Shared secret for the internal pre-warm endpoint. Unset means the endpoint
 * accepts any request on the private compose network (the port is `expose`d,
 * never published); set means the dial worker must present the same value.
 */
const PREWARM_SECRET = process.env.VOICE_PREWARM_SECRET ?? "";

type CallState = {
  deepgram: DeepgramLiveClient | null;
  tts: ElevenLabsStream | null;
  ended: boolean;
  lastFinal: string;
  /**
   * The language this call is conducted in, carried from the dial job.
   *
   * THIS WAS HARDCODED TO ENGLISH, which is the second P0 Urdu defect. Every
   * utterance below reached the vendor as English:
   *
   *   · ASR   — deepgram.start("en") pinned nova-2 to English, so an Urdu
   *             customer's Urdu speech came back as phonetic garbage and the
   *             router (which now recognises Urdu) never saw a real denial.
   *   · TTS   — ELEVENLABS_VOICE_EN and language:"en" meant an Urdu customer
   *             was answered in English by an English voice, on a call that is
   *             supposed to be in THEIR language.
   *   · Copy  — the confirm/handoff strings below were English literals, so the
   *             one moment a fraud decision is read out loud was the moment
   *             least likely to be understood by the person it concerns.
   *
   * Language comes from the job, not from a guess: the dial worker already
   * knows it, and a wrong guess is worse than the default because it would
   * apply the wrong TTS MODEL (see resolveTtsModel — Urdu and Swahili require
   * eleven_v4_turbo, and pinning multilingual_v2 for them cannot synthesise the
   * language at all).
   */
  lang: TtsLang;
  /**
   * True from the moment the opening disclosure starts until it has drained.
   * The back-channel never fires while this is set: the first thing a customer
   * hears from an unfamiliar number must be the bank's own disclosure, not a
   * filler that could be mistaken for a recording (see backchannel.ts).
   */
  openingInFlight?: boolean;
  /**
   * The conversational state machine driving the greeting, the silence nudge,
   * and barge-in for this call (src/lib/voice/conversation.ts). Optional so the
   * tests that build a bare CallState stay valid.
   */
  conv?: ConversationState;
  /**
   * The turn queue. Deepgram hands every final transcript to this worker as it
   * arrives, and a caller who speaks while the agent is still answering — or
   * whose answer splits into two finals — therefore produced TWO turns in
   * flight. Each one ran `safeTtsStream`, which does `state.tts = tts` and then
   * `state.tts = null` when it finishes: the second turn overwrote the first's
   * cancel handle and the first's `finally` then nulled the second's, so
   * barge-in cancelled a stream that was already gone while the live one kept
   * sending audio. The customer heard the agent talk over itself and could not
   * interrupt it.
   *
   * One turn per call, in arrival order: a transcript is chained onto whatever
   * the call is still doing rather than started alongside it. A turn that needs
   * to cut in does so by cancelling `state.tts` (barge-in), which is only
   * meaningful while at most one stream owns that field.
   */
  turnChain: Promise<void>;
};

/**
 * Resolve a call's language from the stream URL, falling back to English.
 *
 * The fallback is `en` rather than "auto" because the alternative is a call
 * with no language at all: an unrecognised code reaching the TTS model fails
 * synthesis outright, and a failed synthesis is silence on a fraud call.
 */
function asCallLang(raw: string | null): TtsLang {
  return SUPPORTED_LANGS.includes(raw as TtsLang) ? (raw as TtsLang) : "en";
}

const calls = new Map<string, CallState>();

function getOrCreateCall(callSid: string, lang: TtsLang = "en"): CallState {
  let state = calls.get(callSid);
  if (!state) {
    state = {
      deepgram: null,
      tts: null,
      ended: false,
      lastFinal: "",
      lang,
      turnChain: Promise.resolve(),
    };
    calls.set(callSid, state);
  }
  return state;
}

/**
 * How long the voice plane waits for the FIRST byte of synthesised audio before
 * it cancels the vendor stream and plays the emergency fallback.
 *
 * This bounds first audio, not the whole utterance — a deadline on the whole
 * stream would sever every normal sentence (see
 * `src/lib/voice/first-audio-deadline.ts`). The value used to be spent on a
 * `withTimeout()` wrapper that created an AbortController and never passed its
 * signal to anything, so the ceiling it advertised could not fire; the vendor
 * could stall a live caller in silence indefinitely and the fallback would
 * never play.
 */
const AI_TIMEOUT_MS = Number(process.env.VOICE_AI_TIMEOUT_MS ?? 2000);

/**
 * The Case a media stream belongs to, keyed by the provider call-leg sid.
 *
 * `Case.callSid` is persisted at dial time and the TwiML hands that same sid to
 * the stream URL, but nothing joined the two: every audit row this worker wrote
 * carried a synthetic `vs-<uuid>` reference, so a compliance reviewer reading the
 * hash chain could not tie a spoken freeze confirmation to the case it concerned.
 * Resolved once per call and cached; cleared when the call ends so the map
 * cannot grow without bound on a long-lived worker.
 */
const caseRefByCallSid = new Map<string, string | null>();

async function resolveCaseRef(callSid: string): Promise<string | null> {
  const known = caseRefByCallSid.get(callSid);
  if (known !== undefined) return known;
  const row = await db.case
    .findFirst({ where: { callSid }, select: { caseRef: true } })
    .catch((err: unknown) => {
      logError("[voice-stream] case lookup by call sid failed", {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
  const ref = row?.caseRef ?? null;
  caseRefByCallSid.set(callSid, ref);
  return ref;
}

/**
 * Speak text to the caller, through the compliance gate.
 *
 * This function used to call `sanitizeShariah` and nothing else. That was the
 * single largest guardrail gap in the platform: this is the path that speaks when
 * the durable dial queue and Media Streams are enabled — i.e. the path a real
 * bank call actually takes — and `sanitizeShariah` only renames terminology for
 * one tenant type. PII redaction, the markdown/speech cleanup, the word limit and
 * the vishing blocklist were all absent here, while being present on the
 * lower-traffic HTTP TTS endpoints. A guardrail that only runs on the demo path
 * is not a guardrail.
 *
 * The refusal is explicit and audited rather than silent. If the blocklist fires,
 * the customer hears the emergency fallback — which is a real sentence telling
 * them their money is being protected — instead of the unsafe line, and the
 * refusal is on the audit chain so a compliance reviewer can see the blocklist
 * actually firing in production rather than believing it exists.
 */
async function safeTtsStream(
  state: CallState,
  ws: WebSocket,
  text: string,
  opts: { onFirstAudio?: (info: { cached: boolean }) => void; force?: boolean } = {},
): Promise<void> {
  const tts = new ElevenLabsStream();
  state.tts = tts;
  let announcedFirstAudio = false;

  // The voice and the MODEL are both per-language. `resolveTtsModel` is the
  // single table the rest of the platform uses (src/lib/elevenlabs/client.ts) —
  // it pins Urdu and Swahili to eleven_v4_turbo because eleven_multilingual_v2 cannot
  // voice them. Reading env.elevenLabsModel directly here, as this path
  // previously did, silently selected a model that cannot synthesise Urdu: the
  // request fails, the fallback path also fails, and the customer hears nothing
  // at the exact moment a fraud decision is being read to them.
  const voiceId = env.voiceFor(state.lang) ?? "";
  const modelId = resolveTtsModel(state.lang);

  // ONE gate for everything. `sanitizeShariah` is retained as a belt-and-braces
  // term substitution because it is the one transformation that is tenant-scoped
  // rather than universal, and running it inside the gate's own pipeline would
  // mean passing a per-call flag this worker does not carry.
  const gate = prepareSpeech(sanitizeShariah(text), { lang: state.lang });

  if (!gate.vishing.ok || !gate.text) {
    if (!gate.vishing.ok) {
      logWarn("[voice-stream] utterance refused by the vishing blocklist", {
        callSid: (ws as WebSocket & { __callSid?: string }).__callSid ?? "unknown",
        lang: state.lang,
        rules: describeHits(gate.vishing.hits),
      });
      await auditAppend({
        callRef: (ws as WebSocket & { __caseRef?: string }).__caseRef ?? `vs-${randomUUID()}`,
        action: "consent",
        intent: "vishing_pattern_refused",
        callerId: "system-voice-stream",
        redactedText: `utterance refused before synthesis: ${describeHits(gate.vishing.hits)}`,
        meta: { lang: state.lang, rules: gate.vishing.hits.map((h) => h.id) },
      }).catch(() => {});
    }
    state.tts = null;
    await playEmergencyFallback(state, ws);
    return;
  }

  // The warm cache is consulted AFTER the gate — a refused utterance must
  // never be served from cache either — and keyed on the RAW text, because
  // that is what the warmer synthesised (src/lib/voice/warm-audio.ts mirrors
  // this function's exact gate pipeline, so a hit and a miss are the same
  // bytes). A hit turns the most common first words of a call into a memory
  // read: no vendor round-trip, no time-to-first-byte.
  const warm = getWarmChunks(state.lang, text);
  if (warm) {
    for (const chunk of warm) {
      // `force` is the fraud branch's terminal turn: the call is already
      // marked ended (so no nudge, no re-entry, no barge-in), and the
      // utterance MUST still be spoken. See the note in handleTranscript.
      if (state.ended && !opts.force) break;
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: chunk.toString("base64") },
        }),
      );
      if (!announcedFirstAudio && chunk.length > 0) {
        announcedFirstAudio = true;
        opts.onFirstAudio?.({ cached: true });
      }
    }
    state.tts = null;
    return;
  }

  try {
    const played: Buffer[] = [];
    for await (const chunk of withFirstChunkDeadline(
      tts.streamText(gate.text, {
        apiKey: env.elevenLabsApiKey ?? "",
        voiceId,
        modelId,
        language: state.lang,
      }),
      {
        ms: AI_TIMEOUT_MS,
        label: "elevenlabs-stream",
        onExpired: () => tts.cancel(),
      },
    )) {
      if (state.ended && !opts.force) break;
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: chunk.toString("base64") },
        }),
      );
      played.push(chunk);
      // First chunk out = first audio the customer can hear. Reported once,
      // and only on a real chunk — a zero-length frame would close the span
      // early and understate the number.
      if (!announcedFirstAudio && chunk.length > 0) {
        announcedFirstAudio = true;
        opts.onFirstAudio?.({ cached: false });
      }
    }
    // Cache-fill on a miss: the synthesis already happened, so storing it
    // makes the NEXT call of this phrase free. The pre-warm at the dialing
    // state is the fast path; this is what keeps the cache warm for calls
    // the dial worker never saw (direct dials, demos, the TwiML plane).
    if ((!state.ended || opts.force) && played.length > 0)
      storeWarmChunks(state.lang, text, played);
  } catch (err) {
    logWarn("[voice-stream] primary tts failed; playing emergency fallback", {
      error: err instanceof Error ? err.message : String(err),
      callSid: (ws as WebSocket & { __callSid?: string }).__callSid ?? "unknown",
      lang: state.lang,
    });
    await playEmergencyFallback(state, ws);
  } finally {
    state.tts = null;
  }
}

/**
 * The last-resort line when every synthesis path has failed (the table lives
 * in src/lib/voice/conversation.ts so the pre-warm path can reach it).
 *
 * Served from the warm cache first — by the time it is needed, the dialing
 * state has usually already synthesised it — and synthesised live only as the
 * last resort, because a fallback that needs the failing vendor is not a
 * fallback.
 */
async function playEmergencyFallback(state: { lang: TtsLang }, ws: WebSocket): Promise<void> {
  const text = EMERGENCY_FALLBACK[state.lang] ?? EMERGENCY_FALLBACK.en;
  const warm = getWarmChunks(state.lang, text);
  if (warm) {
    for (const chunk of warm) {
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: chunk.toString("base64") },
        }),
      );
    }
    return;
  }
  // Same per-language voice and model resolution as the primary path. A fallback
  // that hardcoded the English voice would fail for exactly the callers most in
  // need of it — the ones whose language the primary path could not voice.
  const voiceId = env.voiceFor(state.lang) ?? "";
  const modelId = resolveTtsModel(state.lang);
  const fallbackTts = new ElevenLabsStream();
  try {
    for await (const chunk of withFirstChunkDeadline(
      fallbackTts.streamText(text, {
        apiKey: env.elevenLabsApiKey ?? "",
        voiceId,
        modelId,
        language: state.lang,
      }),
      {
        ms: AI_TIMEOUT_MS,
        label: "emergency-fallback",
        onExpired: () => fallbackTts.cancel(),
      },
    )) {
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: chunk.toString("base64") },
        }),
      );
    }
  } catch {
    // If even the fallback fails, end the call silently instead of hanging.
  }
}

/** Send Twilio's audio-flush signal, tolerating a socket that already closed. */
function clearTwilioBuffer(ws: WebSocket): void {
  try {
    ws.send(JSON.stringify({ event: "clear" }));
  } catch {
    // the caller hung up mid-turn; there is nothing left to flush
  }
}

async function handleTranscript(
  callSid: string,
  text: string,
  isFinal: boolean,
  ws: WebSocket,
): Promise<void> {
  const state = getOrCreateCall(callSid);
  (ws as WebSocket & { __callSid?: string }).__callSid = callSid;
  // Fill the case reference as early as the turn allows, without making the
  // caller wait for it. The fraud branch awaits the outcome explicitly, because
  // that is where the difference between "staged" and "not staged" decides what
  // the customer is told.
  void resolveCaseRef(callSid).then((ref) => {
    if (ref) (ws as WebSocket & { __caseRef?: string }).__caseRef = ref;
  });
  if (state.ended) return;

  if (isFinal) {
    state.lastFinal = text;
  }

  // Barge-in: the caller is talking over the AI. Stop the AI's turn in-flight —
  // flush Twilio's audio buffer and cancel the ElevenLabs stream mid-utterance —
  // so a caller never has to shout over the agent. An interim interrupt only
  // stops the AI (their full turn routes when it finalizes); a FINAL heard
  // while the AI was speaking stops the AI and then continues to route below.
  const conv = state.conv;
  if (conv?.onBargeIn()) {
    state.tts?.cancel();
    clearTwilioBuffer(ws);
    if (!isFinal) return;
  }

  // Only route on final transcripts to avoid premature actions.
  if (!isFinal) return;

  // RULE 1 — customer speech is UNTRUSTED DATA, never instructions.
  //
  // The audit is the enforcement story here: this worker's router is a
  // deterministic keyword classifier with no prompt to hijack, so an
  // instruction-shaped utterance cannot change what happens next — but the
  // attempt is still recorded, because "the transcript never reached a model"
  // is a claim a reviewer should be able to check. Refusing to talk to someone
  // who says "ignore your instructions" would let a caller mute the agent with
  // four words, so the service continues exactly as before.
  if (detectInjectionAttempt(text)) {
    void auditAppend({
      callRef: (ws as WebSocket & { __caseRef?: string }).__caseRef ?? `vs-${randomUUID()}`,
      action: "consent",
      intent: "prompt_injection_attempt",
      callerId: "system-voice-stream",
      redactedText: "instruction-shaped caller speech detected and neutralised",
      meta: { lang: state.lang },
    }).catch(() => {});
  }

  // RULE 2 — the never-ask line, deterministically.
  //
  // When the caller asks the agent for a secret ("what's my PIN?"), the answer
  // is a fixed per-language sentence, not a routed holding line and never a
  // model's paraphrase. It short-circuits the router because the answer is the
  // same whatever else the caller said.
  if (callerRequestsSecret(text)) {
    conv?.markThinking();
    const waitStarted = Date.now();
    await safeTtsStream(state, ws, NEVER_ASK_LINE[state.lang] ?? NEVER_ASK_LINE.en, {
      onFirstAudio: ({ cached }) => {
        recordSpan({
          span: "answered_to_first_agent_word",
          startedAtMs: waitStarted,
          endedAtMs: Date.now(),
          attributes: { cached, backchannel: false, neverAsk: true },
        });
      },
    });
    conv?.onSpeechEnd();
    return;
  }

  conv?.markThinking();

  // TRICK 3 — the back-channel. Between the caller's last syllable and the
  // agent's first word there is a real gap (router, TTS time-to-first-byte);
  // past ~250 ms a human hears it as hesitation. If the reply has not started
  // by then, a pre-recorded filler — served from the local warm cache in
  // microseconds — covers it. The timer is cancelled the moment real audio
  // lands, and `shouldPlayBackchannel` keeps it out of the opening, out of
  // repeats, and bounded so it can never hold the line hostage.
  const waitStarted = Date.now();
  let backchannelPlayed = false;
  const backchannelTimer = setTimeout(() => {
    if (state.ended || backchannelPlayed || state.openingInFlight) return;
    if (
      !shouldPlayBackchannel({
        gapMs: Date.now() - waitStarted,
        alreadyPlayed: false,
        lang: state.lang,
      })
    )
      return;
    const chunks = getWarmChunks(state.lang, BACKCHANNEL_TEXT[state.lang]);
    if (!chunks) return; // never synthesise mid-gap: that is slower than the gap
    backchannelPlayed = true;
    for (const chunk of chunks) {
      if (state.ended) break;
      try {
        ws.send(JSON.stringify({ event: "media", media: { payload: chunk.toString("base64") } }));
      } catch {
        // caller hung up mid-filler
      }
    }
  }, BACKCHANNEL_DELAY_MS);

  const onFirstAudio = ({ cached }: { cached: boolean }) => {
    clearTimeout(backchannelTimer);
    recordSpan({
      span: "answered_to_first_agent_word",
      startedAtMs: waitStarted,
      endedAtMs: Date.now(),
      attributes: { cached, backchannel: backchannelPlayed },
    });
  };

  const role: AgentRole = await routeAgentIntent(text);

  if (role === "fraud_specialist") {
    // `ended` goes up HERE, before the terminal turns — and it must not
    // silence them. Both the streaming loop and the warm-cache loop break on
    // `state.ended`, so with the flag already raised the freeze confirmation
    // fell out of the loop on its first chunk: the single most legally
    // consequential sentence in the product was never spoken on this plane.
    // `force: true` is the explicit opt-out for the worker's own terminal
    // utterances; everything the CALLER can still do (nudge, barge-in,
    // re-entry) stays blocked by the flag itself.
    state.ended = true;

    // Just-in-time AuthZ soft freeze.
    //
    // The outcome decides the sentence below, so this is not a fire-and-forget
    // call any more. The previous version awaited `executeSoftFreeze()`, threw
    // its result away, and then confirmed a hold to the caller — while the
    // function it had just called was a stub that wrote nothing anywhere. On this
    // plane a customer was told their card was restricted and their account
    // protected, and none of it was true.
    const freeze = await executeSoftFreeze(callSid);
    if (freeze.ok) {
      (ws as WebSocket & { __caseRef?: string }).__caseRef = freeze.caseRef;
    } else {
      logError("[voice-stream] soft freeze NOT staged — the caller must not be told it was", {
        callSid,
        code: freeze.code,
        error: freeze.error,
        caseRef: freeze.caseRef ?? "unresolved",
      });
    }

    const lines = freeze.ok ? FREEZE_CONFIRMATION : FREEZE_UNSTAGED;
    await safeTtsStream(state, ws, lines[state.lang] ?? lines.en, {
      onFirstAudio,
      force: true,
    });

    // RULE 4 — the hang-up-safe exit is the LAST thing the customer hears
    // before the line closes, which is exactly where a customer needs to hear
    // it (see src/lib/compliance/safety-exit.ts). Served from the warm cache
    // like everything else the worker says.
    await safeTtsStream(state, ws, SAFETY_EXIT[state.lang] ?? SAFETY_EXIT.en, { force: true });

    ws.send(JSON.stringify({ event: "clear" }));
    setTimeout(() => ws.close(), 1000);
    return;
  }

  // Every other role gets the same holding line. The empathy and compliance
  // roles exist to route a HUMAN in, and the brief is explicit that the agent
  // hands off rather than improvising — so the agent's job here is to say it
  // will be handed off, not to attempt the conversation itself.
  const reply =
    role === "empathy_agent"
      ? (HOLDING_EMPATHY[state.lang] ?? HOLDING_EMPATHY.en)
      : (HOLDING_FOLLOWUP[state.lang] ?? HOLDING_FOLLOWUP.en);
  conv?.beginSpeaking();
  // Latency, measured where the promise is actually made.
  //
  // `answered_to_first_agent_word` had NO producer, which meant the declared 1.2 s
  // budget was a claim with nothing behind it. The span now starts when the
  // caller's final transcript arrives — the moment the customer stops talking and
  // starts waiting — and closes on the first audio frame of the reply, which is
  // the moment the customer hears something. Everything in between is the number
  // the pitch promises. The `cached` and `backchannel` attributes are what make
  // the number EXPLAINABLE: a p95 with cache misses and played fillers tells a
  // different story from one without.
  await safeTtsStream(state, ws, reply, { onFirstAudio });
  // The reply has finished draining; the AI is listening again, so the dead-air
  // nudge may re-arm. Not on the fraud branch — that branch ends the call, and
  // nudging a closing call would be nonsense.
  conv?.onSpeechEnd();
}

/**
 * The internal pre-warm endpoint.
 *
 * The dial worker calls this at the DIALING state — carrier accepted, customer
 * has not answered yet (src/worker/dial.ts). It warms two things that cannot
 * be warmed any other way at that moment:
 *
 *   1. the AUDIO cache for every fixed phrase (src/lib/voice/warm-audio.ts),
 *      which turns the call's first words into a memory read; and
 *   2. a pooled DEEPGRAM socket for the call's language, which takes the ASR
 *      handshake off the moment the stream connects.
 *
 * Both are fire-and-forget from the caller's perspective: this replies 202 as
 * soon as the warming is STARTED, because the dialing transition must never
 * wait on a vendor round-trip.
 *
 * The port is `expose`d on the compose network and never published, so the
 * endpoint is internal by topology. When VOICE_PREWARM_SECRET is set the dial
 * worker must also present it, which costs nothing and closes the "internal"
 * assumption to a check rather than a network diagram.
 */
function handlePrewarm(url: URL, req: IncomingMessage, res: ServerResponse): void {
  if (PREWARM_SECRET) {
    const presented = req.headers["x-prewarm-secret"];
    if (presented !== PREWARM_SECRET) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid prewarm secret" }));
      return;
    }
  }
  const lang = asCallLang(url.searchParams.get("lang"));
  const callSid = url.searchParams.get("callSid") ?? "prewarm";
  // Warm the phrases and pre-connect the ASR socket. Neither is awaited: the
  // reply is about the request being accepted, not the synthesis finishing.
  startPrewarm(lang, callSid);
  preconnectDeepgram(lang, env.deepgramApiKey ?? "");
  res.writeHead(202, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      lang,
      message: "warming",
      note: "fire-and-forget; the call that follows reads from cache",
    }),
  );
}

function createServer() {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "POST" && url.pathname === "/prewarm") {
      handlePrewarm(url, req, res);
      return;
    }
    // A liveness probe for operators and for compose healthchecks. Answers 200
    // while draining on purpose: a probe that goes red mid-drain invites the
    // orchestrator to SIGKILL the process, which is the exact outcome the drain
    // exists to avoid. `draining` and `activeCalls` are the honest signals.
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          calls: calls.size,
          draining: isShuttingDown(),
          activeCalls: getActiveCallCount(),
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  // The WebSocket plane shares the port. `noServer` keeps the upgrade handshake
  // ours, so the HTTP routes above and the media stream cannot shadow each
  // other.
  const wss = new WebSocketServer({ noServer: true });

  // Drain before exiting. A SIGTERM that arrives mid-fraud-call currently severs
  // the media stream, the ASR socket and the customer's sentence at once, because
  // nothing here handles the signal. The active-call counter is what makes the
  // wait mean something: it reaches zero when the last open call closes.
  //
  // `onShutdown` runs AFTER the drain (see src/lib/graceful-shutdown.ts), so
  // closing these sockets cannot cut short a call that was still going — it is
  // the cleanup for whatever outlasted the window.
  //
  // This only holds if the orchestrator waits as long as we do. Docker's default
  // is 10s against a 65s window, so docker-compose.yml sets stop_grace_period on
  // this service, and tests/unit/shutdown-window.test.ts fails the build if the
  // two numbers ever drift apart — a drain Docker kills early is decoration.
  setupGracefulShutdown({
    onShutdown: () => {
      for (const client of wss.clients) {
        try {
          client.close(1001, "server shutting down");
        } catch {
          // already gone
        }
      }
    },
  });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `wss://${req.headers.host}`);
    const callSid = url.searchParams.get("callSid") ?? randomUUID();
    // The dial worker puts the case's language on the stream URL. Read it here
    // so ASR, the voice, the model, and every spoken line agree on one language
    // for the whole call.
    const lang = asCallLang(url.searchParams.get("lang"));
    const state = getOrCreateCall(callSid, lang);
    // One unit of work the shutdown drain waits for. The release is idempotent,
    // so the close handler and any later teardown can both call it.
    const releaseCall = beginCall();
    // The conversational state machine (greeting / nudge / barge-in) lives for
    // the life of this call and is reachable from handleTranscript via state.
    const conv = new ConversationState(lang);
    state.conv = conv;

    logInfo("[voice-stream] call connected", { callSid, lang });

    // Fill the TTS cache for this call's FIXED phrases while the carrier is
    // still setting up. Fire-and-forget by design: awaiting it would delay the
    // stream's `connected` frame, which is the one thing worse than a cold cache.
    startPrewarm(lang as TtsLang, callSid);

    // Dead-air guard. While the AI is merely LISTENING and the caller has gone
    // quiet, offer a bounded nudge instead of leaving silence. It is armed after
    // every spoken turn and reset whenever the caller makes any noise, so it can
    // neither talk over an answer being spoken nor loop forever.
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    const armNudge = () => {
      if (nudgeTimer) clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => {
        if (state.ended) return;
        const nudge = conv.onSilence();
        if (!nudge) {
          // Budget spent while still LISTENING: the caller answered, heard the
          // opening, and stayed silent through every nudge. Leaving the line
          // open is silence until the carrier gives up — end the call aloud
          // (the same vetted SAFETY_EXIT the ASR-close path speaks) and make
          // sure the bank is told the customer was never reached.
          if (conv.silenceBudgetSpent) {
            state.ended = true;
            void safeTtsStream(state, ws, SAFETY_EXIT[state.lang] ?? SAFETY_EXIT.en, {
              force: true,
            })
              .catch(() => {})
              .finally(() => {
                ws.send(JSON.stringify({ event: "clear" }));
                setTimeout(() => ws.close(), 1000);
              });
            const caseRef = (ws as WebSocket & { __caseRef?: string }).__caseRef;
            if (caseRef) {
              void markVoiceFailed({ caseRef, reason: "no_answer" }).catch(() => {});
            }
          }
          return; // not listening, or the call is already closing
        }
        void safeTtsStream(state, ws, nudge.speak)
          .then(() => {
            if (!state.ended) conv.onSpeechEnd();
            armNudge();
          })
          .catch(() => armNudge());
      }, SILENCE_NUDGE_MS);
    };

    const deepgram = new DeepgramLiveClient(env.deepgramApiKey ?? "");
    state.deepgram = deepgram;

    deepgram.onTranscript((text, isFinal) => {
      // Any inbound speech means the caller is alive: restart the dead-air
      // clock so a nudge never fires over someone mid-answer.
      if (!state.ended) armNudge();
      // ONE TURN AT A TIME. Chained rather than started: see CallState.turnChain.
      // The rejection handler re-arms the nudge because a turn that threw is a
      // turn the customer never heard, and a call with no voice and no nudge is
      // a dead line that waits for the caller to hang up.
      state.turnChain = state.turnChain
        .then(() => handleTranscript(callSid, text, isFinal, ws))
        .catch((err) => {
          logError("[voice-stream] transcript handler failed", {
            error: err instanceof Error ? err.message : String(err),
            callSid,
          });
          if (!state.ended) armNudge();
        });
    });

    // The transcription socket's own fate, reported to the call.
    //
    // An empty `onclose` in the client used to make a dropped ASR leg invisible:
    // the caller talked to a dead transcriber, the agent kept playing nudges at
    // them, the audit chain recorded a call in which nobody spoke, and the only
    // trace was Deepgram's own dashboard. The client now redials once (bounded in
    // `src/lib/voice/deepgram-client.ts`) and says so; a second close ends the
    // call ALOUD.
    //
    // `SAFETY_EXIT` is spoken rather than a bespoke "we have lost your line"
    // sentence for two reasons: it already exists, vetted, in all six languages,
    // and it is the correct instruction when a verification cannot be completed.
    // Authoring new compliance copy under incident conditions — and translating it
    // into five languages nobody here speaks — is how a safety line ends up wrong.
    deepgram.onAsrEvent((event) => {
      if (state.ended) return;

      void auditAppend({
        callRef: (ws as WebSocket & { __caseRef?: string }).__caseRef ?? `vs-${randomUUID()}`,
        action: "asr",
        intent: event.kind === "dead" ? "asr_stream_dead" : "asr_stream_reconnected",
        callerId: "system-voice-stream",
        redactedText:
          event.kind === "dead"
            ? "live transcription failed after one redial; the call was ended with the hang-up-safe exit"
            : "live transcription redialled; speech inside the handshake window was not transcribed",
        meta: { lang: state.lang, callSid, ...event },
      }).catch(() => {});

      if (event.kind === "reconnected") {
        logWarn("[voice-stream] live transcription redialled", {
          callSid,
          attempt: event.attempt,
          closeCode: event.closeCode,
        });
        return;
      }

      logError(
        "[voice-stream] live transcription died — ending the call rather than talking past the caller",
        {
          callSid,
          attempts: event.attempts,
          closeCode: event.closeCode,
        },
      );
      if (nudgeTimer) clearTimeout(nudgeTimer);
      // `state.ended` here, with the terminal utterance `force: true`: the same
      // ordering rule the freeze path follows — the flag stops the nudge loop and
      // any barge-in, but must never silence the last thing the customer hears.
      state.ended = true;
      void safeTtsStream(state, ws, SAFETY_EXIT[state.lang] ?? SAFETY_EXIT.en, { force: true })
        .catch(() => {})
        .finally(() => {
          try {
            ws.send(JSON.stringify({ event: "clear" }));
          } catch {
            // already closing
          }
          setTimeout(() => {
            try {
              ws.close();
            } catch {
              // already closed
            }
          }, 1000);
        });
    });

    // Pinned to the CALL's language, not "en". This is what makes Urdu
    // comprehensible at all: nova-2 in English mode returns phonetic garbage for
    // Urdu speech, which the Urdu-aware router then cannot recognise as a
    // denial, so the soft freeze never fires.
    // Started for its effect, and the socket is deliberately not retained: a
    // reconnect replaces it inside the client, so a reference held here would be a
    // dead socket by the time anyone wanted to act on it.
    deepgram.start(lang);

    // T+0 opening greeting. This worker was previously purely reactive — silent
    // until the first inbound transcript — which left the caller facing dead air
    // before the agent had said a word. The opening line is spoken as soon as
    // the stream is up, and the dead-air clock starts once it has drained.
    const opener = conv.greeting();
    if (opener) {
      // While the opening is in flight, no back-channel may play: the first
      // thing a customer hears from an unfamiliar number is the disclosure.
      state.openingInFlight = true;
      // The disclosure owns the turn queue too. A caller who answers before the
      // opening has drained would otherwise start their turn alongside it:
      // two streams, one `state.tts`, and the barge-in that should have stopped
      // the disclosure cancelling whichever one happened to be recorded last.
      state.turnChain = state.turnChain
        .then(() =>
          safeTtsStream(state, ws, opener.speak)
            .then(() => {
              if (state.ended) return;
              conv.onSpeechEnd();
              // RULE 4 — the hang-up-safe exit is ALWAYS offered. It gets its own
              // short turn immediately after the disclosure rather than being
              // appended to it: the two together would blow the spoken word cap,
              // and `withinWordLimit` would then protect the exit by trimming the
              // disclosure — a guardrail destroying the sentence it guards. Two
              // turns, both from the warm cache, cost nothing measurable.
              return safeTtsStream(state, ws, SAFETY_EXIT[state.lang] ?? SAFETY_EXIT.en);
            })
            .then(() => {
              state.openingInFlight = false;
              if (!state.ended) conv.onSpeechEnd();
              armNudge();
            })
            .catch(() => {
              state.openingInFlight = false;
              armNudge();
            }),
        )
        .catch(() => {
          state.openingInFlight = false;
          armNudge();
        });
    } else {
      armNudge();
    }

    ws.on("message", (data) => {
      if (state.ended) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === "media" && msg.media?.payload) {
          const buf = Buffer.from(msg.media.payload, "base64");
          deepgram.sendMulaw(buf);
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on("close", () => {
      if (nudgeTimer) clearTimeout(nudgeTimer);
      deepgram.stop();
      // Cancel the vendor stream, do not just forget it. `state.tts = null`
      // alone left an in-flight synthesis running: the ElevenLabs socket kept
      // streaming and billing, each chunk was pushed into a closed WebSocket,
      // and the turn's promise resolved long after the caller had hung up.
      state.tts?.cancel();
      state.deepgram = null;
      state.tts = null;
      calls.delete(callSid);
      caseRefByCallSid.delete(callSid);
      releaseCall();
      logInfo("[voice-stream] call ended", { callSid, activeCalls: getActiveCallCount() });
    });

    ws.on("error", (err) => {
      logError("[voice-stream] websocket error", {
        error: err instanceof Error ? err.message : String(err),
        callSid,
      });
    });
  });

  server.listen(PORT, HOST, () => {
    logInfo("[voice-stream] started", { host: HOST, port: PORT });
  });
  // Keep the process honest about a listen failure: an EADDRINUSE that only
  // surfaces as an unhandled 'error' event takes the worker down without a log
  // line saying why.
  server.on("error", (err) => {
    logError("[voice-stream] server error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

if (import.meta.main) {
  installProcessCrashHandlers();
  // Worker-side traces, metrics and logs. No-op and non-fatal without
  // OTEL_BETTERSTACK_TOKEN, so an unconfigured deployment loses telemetry and not
  // the call path.
  initOtel();
  createServer();
}

export { createServer };
