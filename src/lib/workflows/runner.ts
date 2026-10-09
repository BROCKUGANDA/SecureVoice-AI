import type { Workflow, WorkflowNode } from "./schema";
import { validateWorkflow } from "./validate";

/**
 * Walk a workflow against a live case. The runner never invokes a provider or a
 * tool itself — it delegates to `deps.callTool`, which the caller wires to the
 * REAL guarded tool runner. The one thing the runner enforces on its own is
 * per-node tool scoping: a tool is called only if it is in the executing node's
 * `scope` AND the workflow's global `tools`. That intersection is what keeps a
 * journey designed for untrusted callers from reaching a privileged tool, even
 * if an agent somewhere tries to widen it.
 */
export type WorkflowContext = Record<string, string>;

export type ToolResult = { ok: boolean; result?: unknown; label?: string };

export type RunnerDeps = {
  /** Which branch label to take at a `condition` node. */
  label: (node: WorkflowNode, ctx: WorkflowContext) => string | Promise<string>;
  /** Invoke a tool. Called only after the scope intersection passes. */
  callTool: (node: WorkflowNode, tool: string, args: Record<string, string>) => Promise<ToolResult>;
  /** Resolve a sub-agent workflow by id. */
  resolveSubagent: (id: string) => Workflow;
  /** Cycle backstop. Default 200 steps. */
  maxSteps?: number;
};

export type WorkflowStep = { id: string; kind: string; detail?: string };
export type WorkflowResult =
  | { ok: true; outcome: string; trace: WorkflowStep[]; usedTools: string[] }
  | { ok: false; error: string; trace: WorkflowStep[] };

/** Replace {{key}} with ctx values; an unknown key becomes "" (never leaks the template). */
export function interpolate(template: string, ctx: WorkflowContext): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => ctx[k] ?? "");
}

function interpolateArgs(
  args: Record<string, string> | undefined,
  ctx: WorkflowContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args ?? {})) out[k] = interpolate(v, ctx);
  return out;
}

/** The set of tools a run of this workflow could ever invoke (scoped). */
export function reachableTools(wf: Workflow): string[] {
  const v = validateWorkflow(wf);
  const reach = v.ok ? new Set<string>() : null;
  // Even for an invalid graph, walk defensively from entry.
  const ids = new Map(wf.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = ids.has(wf.entry) ? [wf.entry] : [];
  const out = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const nd = ids.get(id);
    if (!nd) continue;
    for (const t of nd.scope) {
      if (wf.tools.includes(t)) out.add(t);
    }
    if (nd.next) stack.push(nd.next);
    if (nd.onReturn) stack.push(nd.onReturn);
    for (const b of nd.branches ?? []) stack.push(b.to);
  }
  void reach;
  return [...out].sort();
}

export async function runWorkflow(
  wf: Workflow,
  ctx: WorkflowContext,
  deps: RunnerDeps,
): Promise<WorkflowResult> {
  const check = validateWorkflow(wf);
  if (!check.ok)
    return { ok: false, error: `invalid workflow: ${check.errors.join("; ")}`, trace: [] };

  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  const usedTools: string[] = [];
  const trace: WorkflowStep[] = [];
  const maxSteps = deps.maxSteps ?? 200;
  let current = wf.entry;
  let steps = 0;

  while (true) {
    if (++steps > maxSteps)
      return { ok: false, error: "max steps exceeded (possible cycle)", trace };
    const nd = nodes.get(current);
    if (!nd) return { ok: false, error: `walked into missing node "${current}"`, trace };
    trace.push({ id: nd.id, kind: nd.kind });

    if (nd.kind === "end") return { ok: true, outcome: nd.outcome ?? "done", trace, usedTools };

    if (nd.kind === "condition") {
      const label = await deps.label(nd, ctx);
      const branch =
        nd.branches?.find((b) => b.when === label) ?? nd.branches?.find((b) => b.when === "*");
      if (!branch) return { ok: false, error: `no branch for label "${label}"`, trace };
      trace[trace.length - 1].detail = label;
      current = branch.to;
      continue;
    }

    if (nd.kind === "tool") {
      const tool = nd.tool!;
      // Scoping is the runner's own enforcement (belt-and-braces over the schema).
      if (!nd.scope.includes(tool) || !wf.tools.includes(tool))
        return { ok: false, error: `tool "${tool}" is outside this node's scope`, trace };
      const res = await deps.callTool(nd, tool, interpolateArgs(nd.args, ctx));
      usedTools.push(tool);
      trace[trace.length - 1].detail = res.ok ? "ok" : "failed";
      if (!nd.next) return { ok: false, error: `tool node "${nd.id}" has no next`, trace };
      // tool nodes follow `next` (branching is a condition's job).
      current = nd.next;
      continue;
    }

    if (nd.kind === "subagent") {
      const sub = deps.resolveSubagent(nd.subagent!);
      // The sub-agent runs under the SAME ctx; its own scoping still applies.
      const subRes = await runWorkflow(sub, ctx, deps);
      if (!subRes.ok)
        return { ok: false, error: `subagent ${nd.subagent} failed: ${subRes.error}`, trace };
      usedTools.push(...subRes.usedTools);
      current = nd.onReturn!;
      continue;
    }

    // prompt / handoff
    if (!nd.next) return { ok: false, error: `${nd.kind} node "${nd.id}" has no next`, trace };
    current = nd.next;
  }
}
