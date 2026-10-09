import { z } from "zod";

/**
 * Agent Workflows — the schema for multi-step, branching journeys.
 *
 * A workflow is a small graph of typed nodes an institution designs (in the
 * builder UI, or here as code) and the runtime WALKS against a live case. The
 * three properties the brief calls for, all enforced by the schema/validator
 * rather than by convention:
 *
 *   · multi-step, branching — `condition` nodes carry named branches; every
 *     transition target must resolve to a real node (the validator rejects a
 *     dangling `to`).
 *   · sub-agents — a `subagent` node invokes another workflow and returns,
 *     so a journey can hop into a specialist sub-flow and come back.
 *   · per-node tool scoping — every node declares `scope` (the tools IT may
 *     call), intersected with the workflow's global `tools`. The runner
 *     refuses a tool call outside a node's scope, so a journey for untrusted
 *     callers cannot reach a privileged tool even if the agent tries.
 *
 * The graph is data, validated, and executable; it never re-implements a tool —
 * tool calls are delegated to the caller's guarded tool runner.
 */

const ID = z.string().min(1).max(128);

/** Per-node tool scoping: the ONLY tools this node may invoke. */
const scope = z.array(z.string()).default([]);

const nodeSchema = z
  .object({
    id: ID,
    kind: z.enum(["prompt", "condition", "tool", "subagent", "handoff", "end"]),
    /** System-prompt / instruction text set for the turn (prompt nodes). */
    sysPrompt: z.string().max(4000).optional(),
    /** Branch label evaluation — the caller supplies the label per `when`. */
    branches: z
      .array(z.object({ when: z.string().min(1), to: ID }))
      .refine(
        (bs) => bs.filter((b) => b.when === "*").length <= 1,
        "at most one default ('*') branch is allowed",
      )
      .optional(),
    /** Tool invoked by a tool node; must be within this node's `scope`. */
    tool: z.string().optional(),
    /** Arg templates interpolated from the case context ({{caseRef}}, …). */
    args: z.record(z.string(), z.string()).optional(),
    /** Sub-agent workflow id invoked by a subagent node. */
    subagent: z.string().optional(),
    /** Where the sub-agent flow returns to. */
    onReturn: z.string().optional(),
    /** The single successor for prompt/handoff nodes. */
    next: z.string().optional(),
    scope,
    /** Terminal node: walking stops and `outcome` is the result. */
    outcome: z.string().optional(),
  })
  .superRefine((n, ctx) => {
    if (n.kind === "tool" && !n.tool)
      ctx.addIssue({ code: "custom", message: "tool node requires `tool`" });
    if (n.kind === "subagent" && !n.subagent)
      ctx.addIssue({ code: "custom", message: "subagent node requires `subagent`" });
    if (n.kind === "condition" && (!n.branches || n.branches.length === 0))
      ctx.addIssue({ code: "custom", message: "condition node requires at least one branch" });
    if (n.kind === "end" && !n.outcome)
      ctx.addIssue({ code: "custom", message: "end node requires `outcome`" });
    if (n.tool && !n.scope.includes(n.tool))
      ctx.addIssue({ code: "custom", message: `tool "${n.tool}" is not in the node's scope` });
  });

export const workflowSchema = z
  .object({
    id: ID,
    name: z.string().min(1).max(200),
    version: z.string().default("1"),
    /** Entry node id. */
    entry: ID,
    /** Global tool allow-list for the whole journey (intersected per node). */
    tools: z.array(z.string()).default([]),
    nodes: z.array(nodeSchema).min(1),
  })
  .superRefine((w, ctx) => {
    const ids = new Set(w.nodes.map((nd) => nd.id));
    if (w.nodes.length !== ids.size) ctx.addIssue({ code: "custom", message: "duplicate node id" });
    if (!ids.has(w.entry))
      ctx.addIssue({ code: "custom", message: `entry "${w.entry}" is not a node` });
  });

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;

/** The canonical fraud-intervention journey, expressed as a workflow. */
export const FRAUD_WORKFLOW: Workflow = {
  id: "fraud_intervention",
  name: "Fraud intervention — verify, freeze, escalate",
  version: "1",
  entry: "disclose",
  tools: ["verify_transaction", "card_freeze", "human_handoff", "warm_transfer"],
  nodes: [
    {
      id: "disclose",
      kind: "prompt",
      sysPrompt: "Disclose the call is recorded; verify the customer.",
      scope: ["verify_transaction"],
      next: "route",
    },
    {
      id: "route",
      kind: "condition",
      branches: [
        { when: "confirmed_fraud", to: "freeze" },
        { when: "confirmed_legitimate", to: "close" },
        { when: "uncertain", to: "specialist" },
      ],
      scope: ["verify_transaction"],
    },
    {
      id: "freeze",
      kind: "tool",
      tool: "card_freeze",
      args: { conversation_id: "{{caseRef}}" },
      scope: ["card_freeze"],
      next: "escalate",
    },
    {
      id: "escalate",
      kind: "handoff",
      sysPrompt: "A specialist will review. Handing off now.",
      scope: ["human_handoff", "warm_transfer"],
      next: "done",
    },
    {
      id: "close",
      kind: "prompt",
      sysPrompt: "Thank the customer; no action needed.",
      scope: [],
      next: "done",
    },
    { id: "done", kind: "end", outcome: "resolved", scope: [] },
    // A sub-agent hop: a specialist review sub-flow, scoped to handoff only.
    {
      id: "specialist",
      kind: "subagent",
      subagent: "specialist_review",
      onReturn: "done",
      scope: ["human_handoff"],
    },
  ],
};

export const SPECIALIST_WORKFLOW: Workflow = {
  id: "specialist_review",
  name: "Specialist review sub-agent",
  version: "1",
  entry: "review",
  tools: ["human_handoff"],
  nodes: [
    {
      id: "review",
      kind: "prompt",
      sysPrompt: "Summarise the case for the specialist.",
      scope: ["human_handoff"],
      next: "finish",
    },
    { id: "finish", kind: "end", outcome: "reviewed", scope: [] },
  ],
};

export function parseWorkflow(input: unknown): Workflow {
  return workflowSchema.parse(input);
}
