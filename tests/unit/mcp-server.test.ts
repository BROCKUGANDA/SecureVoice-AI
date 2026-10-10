/**
 * The MCP server is a thin transport over the guarded tool routes, so the
 * properties under test are the protocol framing and the fail-closed auth —
 * NOT the tool logic (that lives in the tool routes and their own suites).
 *
 * The auth contract, asserted here because it was previously absent:
 *   · a tools/call without the caller's x-agent-tool-secret is refused;
 *   · when one IS presented, exactly that credential is forwarded to the
 *     guarded tool route — the platform AGENT_TOOL_SECRET is never substituted,
 *     so the guard authorises the CALLER, not the deployment;
 *   · the forwarding target is this deployment's fixed origin, never one
 *     derived from the incoming request URL (a caller-controlled Host must not
 *     receive the credential).
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { POST } from "@/app/api/elevenlabs/mcp/route";

const savedSecret = process.env.AGENT_TOOL_SECRET;

beforeEach(() => {
  // No platform secret in scope by default: even if something tried to
  // forward it, there would be nothing to forward.
  delete process.env.AGENT_TOOL_SECRET;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.AGENT_TOOL_SECRET;
  else process.env.AGENT_TOOL_SECRET = savedSecret;
});

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("https://app.test/api/elevenlabs/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

/** Every JSON-RPC response must carry the envelope, whatever the result. */
function expectEnvelope(
  body: {
    jsonrpc?: unknown;
    id?: unknown;
  },
  id: number | string,
) {
  expect(body.jsonrpc).toBe("2.0");
  expect(body.id).toBe(id);
}

describe("MCP server", () => {
  test("initialize returns the protocol version and tool capability", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const body = (await res.json()) as {
      jsonrpc?: string;
      id?: number;
      result: { protocolVersion: string; capabilities: { tools: unknown } };
    };
    expectEnvelope(body, 1);
    expect(body.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.result.capabilities.tools).toEqual({});
  });

  test("tools/list exposes the five guarded tools with input schemas", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = (await res.json()) as {
      jsonrpc?: string;
      id?: number;
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    expectEnvelope(body, 2);
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "card_freeze",
      "human_handoff",
      "switch_language",
      "verify_transaction",
      "warm_transfer",
    ]);
    for (const t of body.result.tools) expect(t.inputSchema).toBeTruthy();
  });

  test("tools/call refuses a caller who presents no credential", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "card_freeze",
        arguments: { conversation_id: "c", account_id: "a", reason_code: "r" },
      },
    });
    const body = (await res.json()) as {
      jsonrpc?: string;
      id?: number;
      error: { code: number; message: string };
      result?: unknown;
    };
    expectEnvelope(body, 3);
    // No tool is reached at all: there is no identity to authorise, and the
    // platform secret is not a substitute for one.
    expect(body.result).toBeUndefined();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("x-agent-tool-secret");
  });

  test("tools/call forwards the CALLER's credential to this deployment's origin — never the platform secret", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const realFetch = globalThis.fetch;
    // A platform secret is configured AND a different one is presented. If the
    // route substituted the platform credential, the captured header would be
    // "platform-secret-do-not-forward" and this test fails.
    process.env.AGENT_TOOL_SECRET = "platform-secret-do-not-forward";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
      });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    try {
      const res = await rpc(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "switch_language", arguments: { conversation_id: "c", language: "ar" } },
        },
        { "x-agent-tool-secret": "caller-tenant-secret" },
      );
      const body = (await res.json()) as {
        jsonrpc?: string;
        id?: number;
        result: { isError: boolean };
      };
      expectEnvelope(body, 4);
      expect(body.result.isError).toBe(false);

      expect(calls).toHaveLength(1);
      // The caller's credential rides; the platform secret does not.
      expect(calls[0]!.headers["x-agent-tool-secret"]).toBe("caller-tenant-secret");
      // The origin is THIS deployment's fixed one — never app.test, which is
      // what a request-URL-derived origin would have produced.
      expect(calls[0]!.url).toBe("http://127.0.0.1:3000/api/elevenlabs/tools/switch-language");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an unknown tool is refused as tool_scope_unconfigured-style error, not a crash", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "nope" },
      },
      { "x-agent-tool-secret": "caller-tenant-secret" },
    );
    const body = (await res.json()) as {
      jsonrpc?: string;
      id?: number;
      result: { isError: boolean };
    };
    expectEnvelope(body, 5);
    expect(body.result.isError).toBe(true);
  });

  test("an unknown method is a JSON-RPC method-not-found", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 6, method: "does/not/exist" });
    const body = (await res.json()) as {
      jsonrpc?: string;
      id?: number;
      error: { code: number };
    };
    expectEnvelope(body, 6);
    expect(body.error.code).toBe(-32601);
  });
});
