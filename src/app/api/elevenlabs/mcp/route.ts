import { NextResponse } from "next/server";
import { logError, logInfo } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * Model Context Protocol server for SecureVoice's agent tools.
 *
 * An MCP-capable client (an IDE assistant, a orchestration agent, a
 * core-banking sandbox harness) speaks JSON-RPC 2.0 here:
 *
 *   initialize            → protocol version + capabilities
 *   tools/list            → the 5 guarded tools with JSON-schema inputs
 *   tools/call            → proxies to the REAL tool route with the tool secret
 *
 * This is deliberately a THIN transport, not a second implementation. Every
 * `tools/call` is forwarded to `POST /api/elevenlabs/tools/<name>` carrying the
 * server-side `x-agent-tool-secret`, so the existing guard still authenticates,
 * scopes to the tenant, and enforces the state preconditions — the same ones an
 * ElevenLabs agent's webhook call hits. An MCP client therefore cannot reach a
 * privileged action that the guard would refuse the browser/agent path; it is a
 * new front door onto the identical, already-enforced tool surface.
 */
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "securevoice-mcp", version: "1.0.0" };

/** Tool name → route directory under /api/elevenlabs/tools/. */
const TOOL_ROUTES: Record<string, string> = {
  verify_transaction: "verify-transaction",
  card_freeze: "card-freeze",
  human_handoff: "human-handoff",
  warm_transfer: "warm-transfer",
  switch_language: "switch-language",
};

const STRING = { type: "string" } as const;
const CONVERSATION_ID = { ...STRING, description: "The live conversation/case identifier." };

/** The exposed tools. Schemas mirror each tool route's zod input. */
const TOOLS = [
  {
    name: "verify_transaction",
    description: "Record the customer's verification outcome for the disputed transaction.",
    inputSchema: {
      type: "object",
      required: ["conversation_id", "outcome"],
      properties: {
        conversation_id: CONVERSATION_ID,
        outcome: {
          type: "string",
          enum: ["confirmed_fraud", "confirmed_legitimate", "uncertain"],
        },
      },
    },
  },
  {
    name: "card_freeze",
    description:
      "Stage a REVERSIBLE card freeze to protect the account. Always staged for human finalisation — never commits an irreversible action.",
    inputSchema: {
      type: "object",
      required: ["conversation_id", "account_id", "reason_code"],
      properties: {
        conversation_id: CONVERSATION_ID,
        account_id: STRING,
        reason_code: STRING,
      },
    },
  },
  {
    name: "human_handoff",
    description:
      "Queue a human fraud specialist with a summary; the customer is told one will follow up.",
    inputSchema: {
      type: "object",
      required: ["conversation_id", "summary"],
      properties: { conversation_id: CONVERSATION_ID, summary: STRING },
    },
  },
  {
    name: "warm_transfer",
    description:
      "Bridge the LIVE call to a human specialist's phone; degrades to the specialist queue if no number or call is live.",
    inputSchema: {
      type: "object",
      required: ["conversation_id", "summary"],
      properties: { conversation_id: CONVERSATION_ID, summary: STRING },
    },
  },
  {
    name: "switch_language",
    description: "Switch the conversation language mid-call (en|ar|hi|ur|fr|sw).",
    inputSchema: {
      type: "object",
      required: ["conversation_id", "language"],
      properties: { conversation_id: CONVERSATION_ID, language: STRING },
    },
  },
];

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown> | null;
};

const reply = (id: JsonRpc["id"], result: unknown) =>
  NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: JsonRpc["id"], code: number, message: string) =>
  NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Forward a tool call to the real, guarded route and shape the MCP result. */
async function callTool(
  name: string,
  args: unknown,
  origin: string,
): Promise<{ isError: boolean; content: Array<{ type: "text"; text: string }> }> {
  const dir = TOOL_ROUTES[name];
  if (!dir) {
    return { isError: true, content: [{ type: "text", text: `unknown_tool: ${name}` }] };
  }
  const secret = process.env.AGENT_TOOL_SECRET;
  if (!secret) {
    // Fail closed exactly like the guard: no configured secret reaches no tool.
    return { isError: true, content: [{ type: "text", text: "tool_scope_unconfigured" }] };
  }
  const res = await fetch(new URL(`/api/elevenlabs/tools/${dir}`, origin), {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-tool-secret": secret },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  return { isError: !res.ok, content: [{ type: "text", text }] };
}

export async function POST(req: Request) {
  let msg: JsonRpc;
  try {
    msg = (await req.json()) as JsonRpc;
  } catch {
    return fail(null, -32700, "parse error");
  }

  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "tools/list":
      return reply(id, { tools: TOOLS });

    case "tools/call": {
      const name = String(params?.name ?? "");
      const origin = new URL(req.url).origin;
      try {
        const result = await callTool(name, params?.arguments, origin);
        logInfo("[mcp] tools/call", { tool: name, isError: result.isError });
        return reply(id, result);
      } catch (err) {
        logError("[mcp] tools/call failed", {
          tool: name,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply(id, {
          isError: true,
          content: [{ type: "text", text: "tool_call_failed" }],
        });
      }
    }

    case "notifications/initialized":
    case "initialized":
      return reply(id, {});

    default:
      return fail(id, -32601, `method not found: ${method ?? "(none)"}`);
  }
}

/** Discovery for humans/operators, like the other Twilio/vendor routes. */
export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/elevenlabs/mcp",
    protocol: "Model Context Protocol (JSON-RPC 2.0 over HTTP)",
    serverInfo: SERVER_INFO,
    methods: ["initialize", "tools/list", "tools/call"],
    tools: TOOLS.map((t) => t.name),
    note: "tools/call is forwarded to the existing guarded /api/elevenlabs/tools/* routes with the server-side tool secret; the guard and state preconditions are unchanged.",
  });
}
