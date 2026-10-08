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
 */

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { env, SUPPORTED_LANGS } from "@/lib/config";
import type { TtsLang } from "@/lib/elevenlabs/client";
import { resolveTtsModel } from "@/lib/elevenlabs/client";
import { DeepgramLiveClient } from "@/lib/voice/deepgram-client";
import { ElevenLabsStream } from "@/lib/voice/elevenlabs-stream";
import { routeAgentIntent, AgentRole } from "@/lib/ai/router";
import { executeSoftFreeze } from "@/lib/ai/ai-authz";
import { sanitizeShariah } from "@/lib/compliance/shariah-filter";
import { logError, logInfo, logWarn } from "@/lib/validation/safe-log";

const PORT = Number(process.env.VOICE_STREAM_PORT ?? 8080);
const HOST = process.env.VOICE_STREAM_HOST ?? "0.0.0.0";

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
   * eleven_v3, and pinning multilingual_v2 for them cannot synthesise the
   * language at all).
   */
  lang: TtsLang;
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
    };
    calls.set(callSid, state);
  }
  return state;
}

/**
 * Spoken confirmation that a protective action was taken.
 *
 * Two rules govern this copy, in every language, because it is the sentence
 * with the most legal consequence in the whole call:
 *
 *   1. "TEMPORARILY restricted", never "frozen"/"blocked"/"closed". The brief is
 *      explicit that irreversible account actions are the institution's human
 *      fraud team's decision, not the agent's.
 *   2. "A human specialist will review" — the human-in-the-loop step is stated
 *      out loud, not implied.
 *
 * It is per-language for the same reason the emergency fallback is: this is the
 * moment the customer learns what has happened to their money, and reading it in
 * a language they did not choose is how a compliance-correct action becomes a
 * customer complaint.
 */
const FREEZE_CONFIRMATION: Record<TtsLang, string> = {
  en: "Thank you. I have temporarily restricted your card to protect your account. A human fraud specialist will review this shortly.",
  ar: "شكرًا لك. لقد قيّدت بطاقتك مؤقتًا لحماية حسابك. سيقوم أخصائي الاحتيال بمراجعة الأمر قريبًا.",
  hi: "धन्यवाद। आपके खाते की सुरक्षा के लिए मैंने आपके कार्ड पर अस्थायी रोक लगा दी है। एक मानव विशेषज्ञ जल्द ही इसकी समीक्षा करेगा।",
  ur: "شکریہ۔ آپکے اکاؤنٹ کی حفاظت کے لیے میں نے آپ کے کارڈ پر عارضی پابندی لگا دی ہے۔ ایک انسانی ماہر جلد اس کا جائزہ لے گا۔",
  fr: "Merci. Nous avons temporairement restreint votre carte pour protéger votre compte. Un spécialiste de la fraude examinera cela prochainement.",
  sw: "Asante. Tumeweka kizuizi cha muda kwenye kadi yako kulinda akaunti yako. Mtaalamu wa udanganyifu atakagua hivi karibuni.",
};

/** Holding line for a caller routed to a human without a fraud claim. */
const HOLDING_FOLLOWUP: Record<TtsLang, string> = {
  en: "I understand. A fraud specialist will follow up shortly.",
  ar: "فهمت. سيتواصل معك أخصائي الاحتيال قريبًا.",
  hi: "मैं समझ गया। एक विशेषज्ञ जल्द ही आपसे संपर्क करेगा।",
  ur: "میں سمجھ گیا۔ ایک ماہر جلد آپ سے رابطہ کرے گا۔",
  fr: "Je comprends. Un spécialiste vous rappellera prochainement.",
  sw: "Nimeelewa. Mtaalamu atakupigia simu karibuni.",
};

/**
 * Holding line for a caller who sounds distressed.
 *
 * Deliberately leads with the offer of a human rather than a reassurance script.
 * The Support Through Difficult Moments scope says bereavement, illness and job
 * loss are handed to a qualified person — so the first thing this caller should
 * hear is that a person is coming, not an agent trying to keep them on the line.
 */
const HOLDING_EMPATHY: Record<TtsLang, string> = {
  en: "I am sorry you are going through this. I will connect you with a specialist who can help. Please stay on the line.",
  ar: "أعتذر عما تمر به. سأوصلك بأخصائي يمكنه المساعدة. يرجى البقاء على الخط.",
  hi: "मुझे खेद है कि आप इससे गुज़र रहे हैं। मैं आपको एक विशेषज्ञ से जोड़ दूँगा जो मदद कर सकता है। कृपया लाइन पर रहें।",
  ur: "مجھے افسوس ہے کہ آپ اس سے گزار رہے ہیں۔ میں آپ کو ایک ماہر سے ملاتا ہوں جو مدد کر سکتا ہے۔ براہ کرم لائن پر رہیں۔",
  fr: "Je suis désolé que vous traversiez cela. Je vous mets en relation avec un spécialiste qui pourra vous aider. Veuillez rester en ligne.",
  sw: "Pole sana kwa hayo unayopitia. Nitakuunganisha na mtaalamu anayeweza kukusaidia. Tafadhali endelea kwenye simu.",
};

const AI_TIMEOUT_MS = Number(process.env.VOICE_AI_TIMEOUT_MS ?? 2000);

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    return await promise.catch((err) => {
      if (err && err.name === "AbortError") {
        throw new Error(`${label} timed out after ${AI_TIMEOUT_MS}ms`);
      }
      throw err;
    });
  } finally {
    clearTimeout(timer);
  }
}

async function safeTtsStream(
  state: CallState,
  ws: WebSocket,
  text: string,
): Promise<void> {
  const tts = new ElevenLabsStream();
  state.tts = tts;

  // The voice and the MODEL are both per-language. `resolveTtsModel` is the
  // single table the rest of the platform uses (src/lib/elevenlabs/client.ts) —
  // it pins Urdu and Swahili to eleven_v3 because eleven_multilingual_v2 cannot
  // voice them. Reading env.elevenLabsModel directly here, as this path
  // previously did, silently selected a model that cannot synthesise Urdu: the
  // request fails, the fallback path also fails, and the customer hears nothing
  // at the exact moment a fraud decision is being read to them.
  const voiceId = env.voiceFor(state.lang) ?? "";
  const modelId = resolveTtsModel(state.lang);

  try {
    await withTimeout(
      "elevenlabs-stream",
      (async () => {
        const safeText = sanitizeShariah(text);
        for await (const chunk of tts.streamText(safeText, {
          apiKey: env.elevenLabsApiKey ?? "",
          voiceId,
          modelId,
          language: state.lang,
        })) {
          if (state.ended) break;
          ws.send(
            JSON.stringify({
              event: "media",
              media: { payload: chunk.toString("base64") },
            }),
          );
        }
      })(),
    );
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
 * The last-resort line: what the customer hears when every AI and TTS path has
 * failed. Per-language, and that is not a nicety.
 *
 * This is the sentence that tells someone their money is being protected. In
 * English it is at least legible to the person who caused the outage. Spoken to
 * an Urdu, Hindi, Arabic or Swahili caller in English, it is unintelligible at
 * the exact moment they most need to understand what has happened to their
 * account — which is why the multilingual variants are first-class here rather
 * than an English string with a TODO.
 *
 * The copy is deliberately the SAME claim in every language: a temporary hold,
 * human review follows, contact the bank on the number in their card or policy
 * documents. It must never promise a freeze, a refund, or a final outcome —
 * those are the institution's human fraud team to decide.
 */
const EMERGENCY_FALLBACK: Record<TtsLang, string> = {
  en: "We are experiencing technical difficulties. To protect your account, we have placed a temporary hold. A specialist will call you back. Please contact your bank using the number on your card.",
  ar: "نواجه صينا بعض الصعوبات التقنية. لحماية حسابك، وضعنا حجزًا مؤقتًا. سيعاود أخصائي الاتصال بك. يرجى الاتصال ببنكك باستخدام الرقم الموجود على بطاقتك.",
  hi: "हमें कुछ तकनीकी कठिनाइयों का सामना करना पड़ रहा है। आपके खाते की सुरक्षा के लिए, हमने अस्थायी रोक लगा दी है। एक विशेषज्ञ आपको वापस कॉल करेगा। कृपया अपने कार्ड पर दिए नंबर पर अपने बैंक को कॉल करें।",
  ur: "ہمیں کچھ تکنیکی مشکلات کا سامنا کرنا پڑ رہا ہے۔ آپکے اکاؤنٹ کی حفاظت کے لیے ہم نے عارضی پابندی لگا دی ہے۔ ایک ماہر آپ کو واپس کال کرے گا۔ براہ کرم اپنے کارڈ پر دیے گئے نمبر پر اپنے بینک کو کال کریں۔",
  fr: "Nous rencontrons des difficultés techniques. Pour protéger votre compte, nous avons placé une retenue temporaire. Un spécialiste vous rappellera. Veuillez contacter votre banque avec le numéro indiqué sur votre carte.",
  sw: "Tunakabiliwa na tatizo la kitehnolojia. Ili kulinda akaunti yako, tumeweka kizuizi cha muda. Mtaalamu atakupigia simu. Tafadhali wasiliana na benki yako kwa nambari iliyo kwenye kadi yako.",
};

async function playEmergencyFallback(state: { lang: TtsLang }, ws: WebSocket): Promise<void> {
  const text = EMERGENCY_FALLBACK[state.lang] ?? EMERGENCY_FALLBACK.en;
  // Same per-language voice and model resolution as the primary path. A fallback
  // that hardcoded the English voice would fail for exactly the callers most in
  // need of it — the ones whose language the primary path could not voice.
  const voiceId = env.voiceFor(state.lang) ?? "";
  const modelId = resolveTtsModel(state.lang);
  try {
    await withTimeout(
      "emergency-fallback",
      (async () => {
        const tts = new ElevenLabsStream();
        for await (const chunk of tts.streamText(text, {
          apiKey: env.elevenLabsApiKey ?? "",
          voiceId,
          modelId,
          language: state.lang,
        })) {
          ws.send(
            JSON.stringify({
              event: "media",
              media: { payload: chunk.toString("base64") },
            }),
          );
        }
      })(),
    );
  } catch {
    // If even the fallback fails, end the call silently instead of hanging.
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
  if (state.ended) return;

  if (isFinal) {
    state.lastFinal = text;
  }

  // Only route on final transcripts to avoid premature actions.
  if (!isFinal) return;

  const role: AgentRole = await routeAgentIntent(text);

  if (role === "fraud_specialist") {
    state.ended = true;

    // Just-in-time AuthZ soft freeze.
    try {
      await executeSoftFreeze(callSid);
    } catch (err) {
      logError("[voice-stream] soft freeze failed", {
        error: err instanceof Error ? err.message : String(err),
        callSid,
      });
    }

    await safeTtsStream(state, ws, FREEZE_CONFIRMATION[state.lang] ?? FREEZE_CONFIRMATION.en);

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
      ? HOLDING_EMPATHY[state.lang] ?? HOLDING_EMPATHY.en
      : HOLDING_FOLLOWUP[state.lang] ?? HOLDING_FOLLOWUP.en;
  await safeTtsStream(state, ws, reply);
}

function createServer() {
  const wss = new WebSocketServer({ port: PORT, host: HOST });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `wss://${req.headers.host}`);
    const callSid = url.searchParams.get("callSid") ?? randomUUID();
    // The dial worker puts the case's language on the stream URL. Read it here
    // so ASR, the voice, the model, and every spoken line agree on one language
    // for the whole call.
    const lang = asCallLang(url.searchParams.get("lang"));
    const state = getOrCreateCall(callSid, lang);

    logInfo("[voice-stream] call connected", { callSid, lang });

    const deepgram = new DeepgramLiveClient(env.deepgramApiKey ?? "");
    state.deepgram = deepgram;

    deepgram.onTranscript((text, isFinal) => {
      handleTranscript(callSid, text, isFinal, ws).catch((err) => {
        logError("[voice-stream] transcript handler failed", {
          error: err instanceof Error ? err.message : String(err),
          callSid,
        });
      });
    });

    // Pinned to the CALL's language, not "en". This is what makes Urdu
    // comprehensible at all: nova-2 in English mode returns phonetic garbage for
    // Urdu speech, which the Urdu-aware router then cannot recognise as a
    // denial, so the soft freeze never fires.
    const dgWs = deepgram.start(lang);

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
      deepgram.stop();
      state.deepgram = null;
      state.tts = null;
      calls.delete(callSid);
      logInfo("[voice-stream] call ended", { callSid });
    });

    ws.on("error", (err) => {
      logError("[voice-stream] websocket error", {
        error: err instanceof Error ? err.message : String(err),
        callSid,
      });
    });
  });

  logInfo("[voice-stream] started", { host: HOST, port: PORT });
}

if (import.meta.main) {
  createServer();
}

export { createServer };
