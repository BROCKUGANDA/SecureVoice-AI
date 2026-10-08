/**
 * The MCP server is a thin transport over the guarded tool routes, so the
 * properties under test are the protocol framing and the fail-closed auth —
 * NOT the tool logic (that lives in the tool routes and their own suites).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { POST } from "@/app/api/elevenlabs/mcp/route";

const savedSecret = process.env.AGENT_TOOL_SECRET;

beforeEach(() => {
  // No secret in scope by default: tools/call must fail closed, never dial out.
  delete process.env.AGENT_TOOL_SECRET;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.AGENT_TOOL_SECRET;
  else process.env.AGENT_TOOL_SECRET = savedSecret;
});

const rpc = (body: unknown) =>
  POST(
    new Request("https://app.test/api/elevenlabs/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("MCP server", () => {
  test("initialize returns the protocol version and tool capability", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const body = (await res.json()) as {
      result: { protocolVersion: string; capabilities: { tools: unknown } };
    };
    expect(body.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.result.capabilities.tools).toEqual({});
  });

  test("tools/list exposes the five guarded tools with input schemas", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "card_freeze",
      "human_handoff",
      "switch_language",
      "verify_transaction",
      "warm_transfer",
    ]);
    for (const t of body.result.tools) expect(t.inputSchema).toBeTruthy();
  });

  test("tools/call fails closed when no tool secret is configured", async () => {
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
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toBe("tool_scope_unconfigured");
  });

  test("an unknown tool is refused as tool_scope_unconfigured-style error, not a crash", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nope" },
    });
    const body = (await res.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
  });

  test("an unknown method is a JSON-RPC method-not-found", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 5, method: "does/not/exist" });
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });
});
