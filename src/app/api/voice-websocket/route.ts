import { NextResponse } from "next/server";

import "server-only";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/config";
import { DeepgramLiveClient } from "@/lib/voice/deepgram-client";
import { ElevenLabsStream } from "@/lib/voice/elevenlabs-stream";
import { routeAgentIntent } from "@/lib/ai/router";
import { executeSoftFreeze } from "@/lib/ai/ai-authz";
import { logError, logInfo } from "@/lib/validation/safe-log";
import { redactPII } from "@/lib/compliance/redactor";

export const dynamic = "force-dynamic";

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

async function handleTranscript(
  callSid: string,
  text: string,
  isFinal: boolean,
  ws: WebSocket,
): Promise<void> {
  const state = getOrCreateCall(callSid);
  if (state.ended) return;

  if (isFinal) {
    state.lastFinal = text;
  }

  if (!isFinal) return;

  const role = await routeAgentIntent(text);

  if (role === "fraud_specialist") {
    const confirmed = /no|not me|deny|denied|fraud|wasn't me|cancel|block/i.test(text);
    if (confirmed) {
      state.ended = true;

      try {
        await executeSoftFreeze(callSid);
      } catch (err) {
        logError("[voice-websocket] soft freeze failed", {
          error: err instanceof Error ? err.message : String(err),
          callSid,
        });
      }

      const finalText =
        "Thank you. I have temporarily restricted your card to protect your account. A human fraud specialist will review this shortly.";

      const tts = new ElevenLabsStream();
      state.tts = tts;

      try {
        for await (const chunk of tts.streamText(finalText, {
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
      } catch (err) {
        logError("[voice-websocket] tts failed", {
          error: err instanceof Error ? err.message : String(err),
          callSid,
        });
      }

      ws.send(JSON.stringify({ event: "clear" }));
      setTimeout(() => ws.close(), 1000);
      return;
    }
  }

  const reply = "I understand. A fraud specialist will follow up shortly.";
  const tts = new ElevenLabsStream();
  state.tts = tts;

  try {
    for await (const chunk of tts.streamText(reply, {
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
  } catch (err) {
    logError("[voice-websocket] tts failed", {
      error: err instanceof Error ? err.message : String(err),
      callSid,
    });
  }
}

export async function GET(req: Request) {
  // This route is intentionally not served by Next's HTTP router in the
  // normal sense: we upgrade to WebSocket here. If the client did not send
  // an Upgrade header, reject early.
  const upgradeHeader = req.headers.get("upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return NextResponse.json({ ok: false, error: "expected WebSocket upgrade" }, { status: 400 });
  }

  // In Next.js route handlers we cannot directly access the raw socket. This
  // file exists as the documented endpoint; the actual WebSocket listener is
  // created once at module scope so it survives across hot reloads.
  return NextResponse.json(
    {
      ok: true,
      detail: "voice websocket endpoint",
      activeCalls: calls.size,
    },
    { status: 200 },
  );
}

export function createVoiceWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "wss://localhost");
    const callSid = url.searchParams.get("callSid") ?? randomUUID();
    const state = getOrCreateCall(callSid);

    logInfo("[voice-websocket] call connected", { callSid });

    const deepgram = new DeepgramLiveClient(env.deepgramApiKey ?? "");
    state.deepgram = deepgram;

    deepgram.onTranscript((text, isFinal) => {
      const safeText = redactPII(text);
      handleTranscript(callSid, safeText, isFinal, ws).catch((err) => {
        logError("[voice-websocket] transcript handler failed", {
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
      logInfo("[voice-websocket] call ended", { callSid });
    });

    ws.on("error", (err) => {
      logError("[voice-websocket] websocket error", {
        error: err instanceof Error ? err.message : String(err),
        callSid,
      });
    });
  });

  return wss;
}
