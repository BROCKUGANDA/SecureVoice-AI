import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeToolCall } from "@/lib/agent-tool-auth";
import { badRequest, parseJson, upstreamError } from "@/lib/api-errors";
import { env } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Mints a short-lived signed WebSocket URL for the ElevenLabs Agents Platform.
 *
 * This is the deployment seam for the whole Stage 2 build: the browser talks to
 * the real agent (Eleven v3-class TTS, Scribe v2 Realtime STT, keyterm biasing,
 * the workflow, the tools) over a WebSocket, while the API key never leaves this
 * server. Signed URLs expire after 15 minutes, so the client re-mints per
 * session rather than caching one at build time.
 *
 * Auth: same shared secret + tool scope as the server tools. This endpoint is not
 * a privileged action, so it is granted explicitly via AGENT_TOOL_ALLOWED.
 */

const schema = z.object({
  agent_id: z.string().min(8).max(80).optional(),
  connection_type: z.enum(["websocket", "webrtc"]).default("websocket"),
});

export async function POST(req: NextRequest) {
  const auth = await authorizeToolCall(req.headers.get("x-agent-tool-secret"), "signed_url");
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return badRequest("Invalid body");

  // A deployment may pin the agent id server-side; a client-supplied id is only
  // honoured when it matches that pin, so the browser cannot aim the signed URL
  // at a different agent in the same workspace.
  const pinned = env.elevenLabsAgentId;
  const requested = parsed.data.agent_id ?? pinned;
  if (!requested) return badRequest("No agent configured: set ELEVENLABS_AGENT_ID");
  if (pinned && requested !== pinned) {
    return NextResponse.json({ ok: false, error: "agent_not_allowed" }, { status: 403 });
  }

  const isWebrtc = parsed.data.connection_type === "webrtc";
  // Both endpoints are GET with `agent_id` as a QUERY parameter — a JSON body
  // returns 411/405. The docs' curl samples read as if a body were accepted; it
  // is not, and the failure is a bare "Method Not Allowed" with no hint.
  const path = isWebrtc
    ? `/v1/convai/conversation/token?agent_id=${encodeURIComponent(requested)}`
    : `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(requested)}`;

  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    method: "GET",
    headers: { "xi-api-key": env.elevenLabsApiKey ?? "" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return upstreamError(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { signed_url?: string; token?: string };
  const credential = data.signed_url ?? data.token;
  if (!credential) return upstreamError("ElevenLabs returned no connection credential");

  return NextResponse.json({
    ok: true,
    agent_id: requested,
    connection_type: parsed.data.connection_type,
    credential,
    expires_in_secs: 900,
  });
}
