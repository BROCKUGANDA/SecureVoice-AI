import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeToolCall } from "@/lib/agent-tool-auth";
import { append as auditAppend } from "@/lib/audit-chain";
import {
  leakSafeText,
  makeFailure,
  type FailureCode,
  type FailureInit,
} from "@/lib/failures/envelope";
import { elevenLabsFetch } from "@/lib/elevenlabs/egress";
import { env } from "@/lib/config";
import { parseJson } from "@/lib/validation/safe-log";
function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  const f = makeFailure(code, init);
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}

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
    return failure(auth.status === 401 ? "unauthenticated" : auth.status === 403 ? "not_found" : "state_conflict", {detail: auth.error});
  }

  const body = await parseJson(req);
  if (body === null) return failure("malformed_request", {detail: "Invalid JSON body"});
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return failure("malformed_request", {detail: "Invalid body"});

  // A deployment may pin the agent id server-side; a client-supplied id is only
  // honoured when it matches that pin, so the browser cannot aim the signed URL
  // at a different agent in the same workspace.
  const pinned = env.elevenLabsAgentId;
  const requested = parsed.data.agent_id ?? pinned;
  if (!requested) return failure("malformed_request", {detail: "No agent configured: set ELEVENLABS_AGENT_ID"});
  if (pinned && requested !== pinned) {
    return failure("not_found", {detail: "agent_not_allowed"});
  }

  const isWebrtc = parsed.data.connection_type === "webrtc";
  // Both endpoints are GET with `agent_id` as a QUERY parameter — a JSON body
  // returns 411/405. The docs' curl samples read as if a body were accepted; it
  // is not, and the failure is a bare "Method Not Allowed" with no hint.
  const path = isWebrtc
    ? `/v1/convai/conversation/token?agent_id=${encodeURIComponent(requested)}`
    : `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(requested)}`;

  const res = await elevenLabsFetch<{ signed_url?: string; token?: string }>({
    path,
    method: "GET",
    // Signing mints a credential, not synthesis — throttle + breaker apply,
    // the TTS char budget does not.
    billableChars: 0,
    callerId: auth.orgId ?? "signed-url",
  });

  if (!res.ok) {
    const err = res.error;
    // 429 comes from the guard, not the vendor: the egress throttle or the
    // monthly account budget stopped it. Say which, and hand back the Retry-After
    // the guard computed so the caller waits the right amount instead of guessing.
    if (err.status === 429) {
      return NextResponse.json(
        {
          ok: false,
          error: err.body,
          retryable: true,
          quotaExhausted: err.quotaExhausted ?? false,
        },
        {
          status: 429,
          headers: { "Retry-After": String(err.retryAfterSec ?? 60) },
        },
      );
    }
    // The upstream body is echoed to the caller, so it goes through the same
    // leak rules as every other caller-facing string. `upstreamError()` does not
    // sanitise, and 200 raw characters of a vendor response can carry a key, an
    // internal hostname or a stack. Keep the status (the useful part) and
    // redact the rest.
    return failure("dependency_unavailable", {
      detail: `ElevenLabs ${err.status}: ${leakSafeText(err.body, 160) || "no detail"}`,
      retryAfterSec: 1,
    });
  }

  const data = res.data;
  const credential = data.signed_url ?? data.token;
  if (!credential) return failure("dependency_unavailable", {detail: "ElevenLabs returned no connection credential", retryAfterSec: 1});

  // This endpoint used to be the ONLY agent-tool route with no audit-chain
  // write — `card_freeze`, `human-handoff`, `verify-transaction` and
  // `switch_language` all append, this one did not. It is also the one that
  // MINTS THE LIVE CREDENTIAL: the signed URL is what opens the WebSocket to
  // the real agent. An unaudited credential mint on a product whose pitch
  // includes an immutable audit chain is exactly what an auditor asks about,
  // so the mint is now sealed into the chain like every other tool action.
  //
  // There is no `conversation_id` here, so there is no case to hang it off; the
  // route-level marker below is sanitised and capped by `audit-chain`, and
  // `callerId` carries the resolved tenant so the row is still attributable.
  await auditAppend({
    callRef: "AGENT-SIGNED-URL",
    action: "agent",
    intent: "signed_url_minted",
    callerId: auth.orgId ?? (auth.platform ? "platform" : undefined),
    orgId: auth.orgId ?? undefined,
    meta: {
      agentId: requested,
      connectionType: parsed.data.connection_type,
      expiresInSecs: env.signedUrlTtlSecs,
    },
  });

  return NextResponse.json({
    ok: true,
    agent_id: requested,
    connection_type: parsed.data.connection_type,
    credential,
    expires_in_secs: env.signedUrlTtlSecs,
  });
}
