/**
 * The LIVE wiring for the workflow runner — the piece that turns the runner
 * from a tested-but-inert executor into the console's Run button.
 *
 * Three properties are pinned here, and the middle one is the security
 * property:
 *
 *   1. Every tool call is FORWARDED to the real guarded route with the
 *      server-side tool secret — no second implementation of a tool exists
 *      here, so the guard's auth, tenant scope and state preconditions apply
 *      to a console run exactly as they apply to a live agent webhook.
 *   2. FAIL-CLOSED: with no AGENT_TOOL_SECRET configured, no request is made
 *      at all and the step fails. The failure mode must never be "the tool
 *      silently ran unauthenticated".
 *   3. Branch selection is DETERMINISTIC — an explicit per-node label, then
 *      the call's disposition, then the default branch — so the same case
 *      context always walks the same path.
 *
 *   bun scripts/run-tests.mjs workflows-live
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLiveDeps, LIVE_TOOL_NAMES } from "@/lib/workflows/live";
import type { WorkflowNode } from "@/lib/workflows/schema";

const ORIGIN = "http://localhost:3000";
const originalFetch = globalThis.fetch;
const originalSecret = process.env.AGENT_TOOL_SECRET;

beforeEach(() => {
  process.env.AGENT_TOOL_SECRET = "unit-test-secret";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.AGENT_TOOL_SECRET;
  else process.env.AGENT_TOOL_SECRET = originalSecret;
});

const toolNode: WorkflowNode = { id: "n", kind: "tool", scope: ["verify_transaction"] };
const conditionNode: WorkflowNode = {
  id: "route",
  kind: "condition",
  scope: [],
  branches: [{ when: "confirmed_fraud", to: "freeze" }],
};

describe("live tool wiring", () => {
  test("fail-closed: no secret means no request is made at all", async () => {
    delete process.env.AGENT_TOOL_SECRET;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as never;

    const deps = makeLiveDeps(ORIGIN);
    const res = await deps.callTool(toolNode, "verify_transaction", { conversation_id: "SV-1" });
    expect(res.ok).toBe(false);
    expect((res.result as { error: string }).error).toBe("tool_scope_unconfigured");
    expect(called).toBe(false);
  });

  test("forwards to the guarded route with the server-side secret", async () => {
    let url = "";
    let init: RequestInit | undefined;
    globalThis.fetch = (async (u: unknown, i: RequestInit) => {
      url = String(u);
      init = i;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as never;

    const deps = makeLiveDeps(ORIGIN);
    const res = await deps.callTool(toolNode, "verify_transaction", {
      conversation_id: "SV-1",
      outcome: "confirmed_fraud",
    });

    expect(res.ok).toBe(true);
    expect(url).toBe("http://localhost:3000/api/elevenlabs/tools/verify-transaction");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-agent-tool-secret"]).toBe("unit-test-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      conversation_id: "SV-1",
      outcome: "confirmed_fraud",
    });
  });

  test("a guard refusal is a failed step, not a thrown run", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: "case cannot move" }), {
        status: 409,
      })) as never;

    const deps = makeLiveDeps(ORIGIN);
    const res = await deps.callTool(toolNode, "card_freeze", { conversation_id: "SV-1" });
    expect(res.ok).toBe(false);
    expect(res.label).toBe("card_freeze");
  });

  test("a transport failure is a failed step too", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as never;

    const deps = makeLiveDeps(ORIGIN);
    const res = await deps.callTool(toolNode, "verify_transaction", { conversation_id: "SV-1" });
    expect(res.ok).toBe(false);
    expect((res.result as { error: string }).error).toBe("tool_call_failed");
  });

  test("an unknown tool name never reaches fetch", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as never;

    const deps = makeLiveDeps(ORIGIN);
    const res = await deps.callTool(toolNode, "delete_everything", {});
    expect(res.ok).toBe(false);
    expect((res.result as { error: string }).error).toBe("unknown_tool");
    expect(called).toBe(false);
  });

  test("branch labels: explicit per-node label, then disposition, then default", () => {
    const deps = makeLiveDeps(ORIGIN);
    expect(
      deps.label(conditionNode, {
        "branch:route": "confirmed_legitimate",
        disposition: "confirmed_fraud",
      }),
    ).toBe("confirmed_legitimate");
    expect(deps.label(conditionNode, { disposition: "uncertain" })).toBe("uncertain");
    expect(deps.label(conditionNode, {})).toBe("*");
  });

  test("sub-agents resolve from the registry; unknown ids throw", () => {
    const deps = makeLiveDeps(ORIGIN);
    expect(deps.resolveSubagent("specialist_review").id).toBe("specialist_review");
    expect(() => deps.resolveSubagent("not_a_workflow")).toThrow(/unknown subagent/);
  });

  test("a saved sub-agent resolves through the injected resolver", () => {
    const custom = {
      id: "claims_triage",
      name: "Claims triage",
      version: "1",
      entry: "review",
      tools: [],
      nodes: [
        { id: "review", kind: "prompt" as const, scope: [], next: "finish" },
        { id: "finish", kind: "end" as const, outcome: "triaged", scope: [] },
      ],
    };
    const deps = makeLiveDeps(ORIGIN, {
      resolveSubagent: (id) => (id === custom.id ? custom : undefined),
    });
    expect(deps.resolveSubagent("claims_triage").id).toBe("claims_triage");
    // Built-ins still win over the injected resolver's gaps.
    expect(deps.resolveSubagent("fraud_intervention").id).toBe("fraud_intervention");
  });

  test("the live tool set is exactly the five guarded tools", () => {
    expect([...LIVE_TOOL_NAMES].sort()).toEqual([
      "card_freeze",
      "human_handoff",
      "switch_language",
      "verify_transaction",
      "warm_transfer",
    ]);
  });
});
