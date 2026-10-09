/**
 * Agent Workflows — schema, validator, runner. The properties that make the
 * “multi-step, branching journeys with sub-agents and per-node tool scoping”
 * claim real are: branches resolve, per-node scope restricts tools, a sub-agent
 * hop returns, and the validator rejects dangling/orphan/dead-end graphs.
 */
import { describe, expect, test } from "bun:test";
import {
  FRAUD_WORKFLOW,
  SPECIALIST_WORKFLOW,
  workflowSchema,
  type WorkflowNode,
} from "@/lib/workflows/schema";
import { validateWorkflow } from "@/lib/workflows/validate";
import { runWorkflow, reachableTools, interpolate } from "@/lib/workflows/runner";
import { validateDocument, getWorkflow, resolveSubagent } from "@/lib/workflows";

const spy = () => {
  const calls: Array<{ tool: string; args: Record<string, string> }> = [];
  return {
    calls,
    callTool: async (_n: WorkflowNode, tool: string, args: Record<string, string>) => {
      calls.push({ tool, args });
      return { ok: true as const };
    },
  };
};

describe("workflow schema + validation", () => {
  test("the built-in fraud workflow validates", () => {
    const v = validateWorkflow(FRAUD_WORKFLOW, (id) => id === SPECIALIST_WORKFLOW.id);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  test("a dangling transition is rejected", () => {
    const bad = workflowSchema.parse({
      ...FRAUD_WORKFLOW,
      nodes: FRAUD_WORKFLOW.nodes.map((n) => (n.id === "disclose" ? { ...n, next: "ghost" } : n)),
    });
    const v = validateWorkflow(bad, (id) => id === SPECIALIST_WORKFLOW.id);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /disclose/.test(e) && /ghost/.test(e))).toBe(true);
  });

  test("an orphan node is rejected as unreachable", () => {
    const bad = workflowSchema.parse({
      ...FRAUD_WORKFLOW,
      nodes: [
        ...FRAUD_WORKFLOW.nodes,
        { id: "orphan", kind: "prompt", sysPrompt: "x", scope: [], next: "done" },
      ],
    });
    const v = validateWorkflow(bad, (id) => id === SPECIALIST_WORKFLOW.id);
    expect(v.errors.some((e) => /orphan.*unreachable/.test(e))).toBe(true);
  });

  test("a dead-end node is rejected", () => {
    const bad = workflowSchema.parse({
      ...FRAUD_WORKFLOW,
      nodes: FRAUD_WORKFLOW.nodes.map((n) => (n.id === "escalate" ? { ...n, next: undefined } : n)),
    });
    const v = validateWorkflow(bad, (id) => id === SPECIALIST_WORKFLOW.id);
    expect(v.errors.some((e) => /escalate.*no way forward/.test(e))).toBe(true);
  });

  test("a node cannot scope a tool outside the workflow's tools", () => {
    const v = validateWorkflow(
      {
        ...FRAUD_WORKFLOW,
        nodes: FRAUD_WORKFLOW.nodes.map((n) =>
          n.id === "freeze" ? { ...n, scope: ["card_freeze", "warm_transfer"] } : n,
        ),
      },
      (id) => id === SPECIALIST_WORKFLOW.id,
    );
    // warm_transfer isn't in `freeze`'s scope list, so this only annotates a
    // scope with a tool the workflow doesn't list when the tool isn't global:
    expect(v.ok).toBe(true);
    const widened = validateWorkflow(
      {
        ...FRAUD_WORKFLOW,
        tools: ["verify_transaction", "card_freeze"], // drop the escalation tools
      },
      (id) => id === SPECIALIST_WORKFLOW.id,
    );
    expect(widened.errors.some((e) => /outside the workflow's tools/.test(e))).toBe(true);
  });

  test("validateDocument reports schema errors for garbage", () => {
    expect(validateDocument({ id: "x" }).ok).toBe(false);
  });
});

describe("reachable tools", () => {
  test("is exactly the journey's scoped tool set — escalation tools, not more", () => {
    expect(reachableTools(FRAUD_WORKFLOW)).toEqual([
      "card_freeze",
      "human_handoff",
      "verify_transaction",
      "warm_transfer",
    ]);
  });
});

describe("runner", () => {
  test("the confirmed_fraud branch freezes then escalates to an end", async () => {
    const s = spy();
    const res = await runWorkflow(
      FRAUD_WORKFLOW,
      { caseRef: "SV-C-9" },
      {
        label: () => "confirmed_fraud",
        callTool: s.callTool,
        resolveSubagent: (id) => resolveSubagent(id),
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outcome).toBe("resolved");
    expect(res.usedTools).toContain("card_freeze");
    expect(s.calls[0]?.tool).toBe("card_freeze");
    expect(s.calls[0]?.args.conversation_id).toBe("SV-C-9"); // {{caseRef}} interpolated
    expect(res.trace.map((t) => t.id)).toEqual(["disclose", "route", "freeze", "escalate", "done"]);
  });

  test("the legitimate branch skips freeze", async () => {
    const s = spy();
    const res = await runWorkflow(
      FRAUD_WORKFLOW,
      { caseRef: "SV-C-9" },
      {
        label: () => "confirmed_legitimate",
        callTool: s.callTool,
        resolveSubagent: (id) => resolveSubagent(id),
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trace.some((t) => t.id === "freeze")).toBe(false);
    expect(s.calls.some((c) => c.tool === "card_freeze")).toBe(false);
  });

  test("a default '*' branch catches an unlisted label", async () => {
    const wf = workflowSchema.parse({
      id: "w",
      name: "w",
      entry: "c",
      tools: [],
      nodes: [
        { id: "c", kind: "condition", scope: [], branches: [{ when: "*", to: "end" }] },
        { id: "end", kind: "end", outcome: "defaulted", scope: [] },
      ],
    });
    const res = await runWorkflow(
      wf,
      {},
      { label: () => "anything", callTool: async () => ({ ok: true }), resolveSubagent },
    );
    expect(res.ok && res.outcome).toBe("defaulted");
  });

  test("a sub-agent hop runs the sub-flow and returns", async () => {
    const wf = workflowSchema.parse({
      id: "parent",
      name: "p",
      entry: "go",
      tools: ["human_handoff"],
      nodes: [
        {
          id: "go",
          kind: "subagent",
          subagent: "specialist_review",
          onReturn: "fin",
          scope: ["human_handoff"],
        },
        { id: "fin", kind: "end", outcome: "wrapped", scope: [] },
      ],
    });
    const res = await runWorkflow(
      wf,
      {},
      {
        label: async () => "*",
        callTool: async () => ({ ok: true as const }),
        resolveSubagent: (id) => resolveSubagent(id),
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outcome).toBe("wrapped");
  });

  test("interpolate fills context and blank-misses an unknown key", () => {
    expect(interpolate("case {{caseRef}} of {{org}}", { caseRef: "SV-1" })).toBe("case SV-1 of ");
  });
});
