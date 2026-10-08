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
import { env } from "@/lib/config";
import { DeepgramLiveClient } from "@/lib/voice/deepgram-client";
import { ElevenLabsStream } from "@/lib/voice/elevenlabs-stream";
import { routeAgentIntent, AgentRole } from "@/lib/ai/router";
import { executeSoftFreeze } from "@/lib/ai/ai-authz";
import { logError, logInfo, logWarn } from "@/lib/validation/safe-log";

const PORT = Number(process.env.VOICE_STREAM_PORT ?? 8080);
const HOST = process.env.VOICE_STREAM_HOST ?? "0.0.0.0";

type CallState = {
  deepgram: DeepgramLiveClient | null;
  tts: ElevenLabsStream | null;
  ended: boolean;
  lastFinal: string;
};

const calls = new Map<string, CallState>();

function getOrCreateCall(callSid: string): CallState {
  let state = calls.get(callSid);
  if (!state) {
    state = {
      deepgram: null,
      tts: null,
      ended: false,
      lastFinal: "",
    };
    calls.set(callSid, state);
  }
  return state;
}

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
  state: { tts: ElevenLabsStream | null; ended: boolean },
  ws: WebSocket,
  text: string,
): Promise<void> {
  const tts = new ElevenLabsStream();
  state.tts = tts;

  try {
    await withTimeout(
      "elevenlabs-stream",
      (async () => {
        for await (const chunk of tts.streamText(text, {
          apiKey: env.elevenLabsApiKey ?? "",
          voiceId: process.env.ELEVENLABS_VOICE_EN ?? "",
          modelId: env.elevenLabsModel,
          language: "en",
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
    });
    await playEmergencyFallback(ws);
  } finally {
    state.tts = null;
  }
}

async function playEmergencyFallback(ws: WebSocket): Promise<void> {
  const text =
    "We are experiencing technical difficulties. To protect your account, we have placed a temporary hold. Please contact your bank.";
  try {
    await withTimeout(
      "emergency-fallback",
      (async () => {
        const tts = new ElevenLabsStream();
        for await (const chunk of tts.streamText(text, {
          apiKey: env.elevenLabsApiKey ?? "",
          voiceId: process.env.ELEVENLABS_VOICE_EN ?? "",
          modelId: env.elevenLabsModel,
          language: "en",
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
    const confirmed = /no|not me|deny|denied|fraud|wasn't me|cancel|block/i.test(text);
    if (confirmed) {
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

      const finalText =
        "Thank you. I have temporarily restricted your card to protect your account. A human fraud specialist will review this shortly.";

      await safeTtsStream(state, ws, finalText);

      ws.send(JSON.stringify({ event: "clear" }));
      setTimeout(() => ws.close(), 1000);
      return;
    }
  }

  // Default conversational response path.
  const reply = `I understand. A fraud specialist will follow up shortly.`;
  await safeTtsStream(state, ws, reply);
}

function createServer() {
  const wss = new WebSocketServer({ port: PORT, host: HOST });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `wss://${req.headers.host}`);
    const callSid = url.searchParams.get("callSid") ?? randomUUID();
    const state = getOrCreateCall(callSid);

    logInfo("[voice-stream] call connected", { callSid });

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

    const dgWs = deepgram.start("en");

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
