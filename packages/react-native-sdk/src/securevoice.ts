/**
 * SecureVoice AI — React Native / JS SDK.
 *
 * A thin, transport-agnostic client for the guardrailed voice agent. It does
 * two things and never re-implements server logic:
 *
 *   1. `createSession` mints a short-lived signed credential from the server
 *      (`POST /api/elevenlabs/signed-url`) so the ElevenLabs API key never
 *      leaves the server and the client re-mints per session.
 *   2. `agentTools` calls the guardrailed tool surface (`POST
 *      /api/elevenlabs/tools/*`). The SERVER enforces the tool secret, tenant
 *      scoping and state preconditions; this client only carries the shared
 *      tool secret and forwards the call, so a privileged action taken on an
 *      untrusted caller's device is still refused server-side.
 *
 * It targets React Native and the web: no native dependency, only `fetch` and
 * `WebSocket` (globalThis) so it type-checks and runs in both.
 */

export type ConnectionType = "websocket" | "webrtc";

export type SecureVoiceConfig = {
  /** Base URL of the deployment, e.g. https://app.example.com */
  baseUrl: string;
  /** Shared agent-tool secret the agent already holds server-side. */
  toolSecret: string;
  /** Optional explicit agent id; if omitted the server's pin is used. */
  agentId?: string;
  /** Override the fetch implementation (tests / custom transports). */
  fetchImpl?: typeof fetch;
};

export type Session = {
  /** WebSocket signed URL, or WebRTC token, depending on connectionType. */
  credential: string;
  agentId: string;
  connectionType: ConnectionType;
  expiresInSecs: number;
};

export type ToolResult<T = unknown> = { ok: boolean; data?: T; error?: string };

/** Mint a session credential. Re-mints every ~15 min (never cached long-term). */
export async function createSession(
  cfg: SecureVoiceConfig,
  connectionType: ConnectionType = "websocket",
): Promise<ToolResult<Session>> {
  const f = cfg.fetchImpl ?? fetch;
  try {
    const res = await f(`${cfg.baseUrl}/api/elevenlabs/signed-url`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-tool-secret": cfg.toolSecret },
      body: JSON.stringify({ agent_id: cfg.agentId, connection_type: connectionType }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      error?: string;
      agent_id?: string;
      signed_url?: string;
      token?: string;
      expires_in?: number;
    };
    if (!res.ok || !body.ok) return { ok: false, error: body.error ?? `http_${res.status}` };
    const credential = connectionType === "webrtc" ? (body.token ?? "") : (body.signed_url ?? "");
    if (!credential) return { ok: false, error: "no_credential" };
    return {
      ok: true,
      data: {
        credential,
        agentId: body.agent_id ?? cfg.agentId ?? "",
        connectionType,
        expiresInSecs: body.expires_in ?? 900,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The guardrailed tool call. Server-side enforcement is unchanged. */
export async function callTool(
  cfg: SecureVoiceConfig,
  tool:
    "verify_transaction" | "card_freeze" | "human_handoff" | "warm_transfer" | "switch_language",
  args: Record<string, string>,
): Promise<ToolResult> {
  const f = cfg.fetchImpl ?? fetch;
  try {
    const res = await f(`${cfg.baseUrl}/api/elevenlabs/tools/${tool.replace(/_/g, "-")}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-tool-secret": cfg.toolSecret },
      body: JSON.stringify(args),
    });
    const body = await res.json();
    if (!res.ok)
      return { ok: false, error: (body as { error?: string }).error ?? `http_${res.status}` };
    return { ok: true, data: body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The typed tool surface an app author builds a journey UI against. */
export const agentTools = {
  verifyTransaction: (c: SecureVoiceConfig, conversationId: string, outcome: VerifyOutcome) =>
    callTool(c, "verify_transaction", { conversation_id: conversationId, outcome }),
  freezeCard: (
    c: SecureVoiceConfig,
    conversationId: string,
    accountId: string,
    reasonCode: string,
  ) =>
    callTool(c, "card_freeze", {
      conversation_id: conversationId,
      account_id: accountId,
      reason_code: reasonCode,
    }),
  handoff: (c: SecureVoiceConfig, conversationId: string, summary: string) =>
    callTool(c, "human_handoff", { conversation_id: conversationId, summary }),
  warmTransfer: (c: SecureVoiceConfig, conversationId: string, summary: string) =>
    callTool(c, "warm_transfer", { conversation_id: conversationId, summary }),
  switchLanguage: (c: SecureVoiceConfig, conversationId: string, language: string) =>
    callTool(c, "switch_language", { conversation_id: conversationId, language }),
};

export type VerifyOutcome = "confirmed_fraud" | "confirmed_legitimate" | "uncertain";
