/**
 * The SDK is transport-agnostic on purpose, so the tests assert it against the
 * DEPLOYMENT CONTRACT rather than the SDK internals: it POSTs the tool secret,
 * maps tool names to the guarded routes, and surfaces a refusal verbatim.
 */
import { describe, expect, test } from "bun:test";
import { callTool, createSession, agentTools } from "../src/securevoice";

const cfg = {
  baseUrl: "https://app.test",
  toolSecret: "sv_test",
  fetchImpl: (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    if (u.endsWith("/api/elevenlabs/signed-url")) {
      const webrtc = body.connection_type === "webrtc";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          agent_id: "agent_1",
          signed_url: "wss://elevenlabs.example/signed?k=1",
          token: "webrtc-token-1",
          expires_in: 900,
        }),
        ...(webrtc ? {} : {}),
      } as unknown as Response;
    }
    // Tool route: report whether the secret was carried, so the auth seam is
    // asserted, and echo a refused freeze so “server refuses” is visible.
    const secret = (init?.headers as Record<string, string>)?.["x-agent-tool-secret"];
    if (secret !== "sv_test")
      return {
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error: "unauthorized" }),
      } as unknown as Response;
    if (u.endsWith("/api/elevenlabs/tools/card-freeze"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, staged: true, committed: false }),
      } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  }) as unknown as typeof fetch,
};

describe("createSession", () => {
  test("returns the signed URL for the websocket transport", async () => {
    const r = await createSession(cfg, "websocket");
    expect(r.ok).toBe(true);
    expect(r.data?.credential).toContain("wss://");
    expect(r.data?.agentId).toBe("agent_1");
  });

  test("returns the WebRTC token for the webrtc transport", async () => {
    const r = await createSession(cfg, "webrtc");
    expect(r.ok).toBe(true);
    expect(r.data?.credential).toBe("webrtc-token-1");
  });
});

describe("agentTools", () => {
  test("maps snake_case tool names to the kebab-case route and carries the secret", async () => {
    const r = await agentTools.freezeCard(cfg, "SV-C-1", "acct_1", "fraud");
    expect(r.ok).toBe(true);
    expect((r.data as { committed?: boolean })?.committed).toBe(false); // never commits
  });

  test("surfaces a refused tool call verbatim", async () => {
    const bad = { ...cfg, toolSecret: "wrong" };
    const r = await callTool(bad, "human_handoff", { conversation_id: "SV-C-1", summary: "s" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unauthorized");
  });
});
