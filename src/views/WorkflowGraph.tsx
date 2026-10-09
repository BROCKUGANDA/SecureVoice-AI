"use client";

import { useMemo, useState } from "react";
import { validateWorkflow } from "@/lib/workflows/validate";
import { reachableTools } from "@/lib/workflows/runner";
import { listWorkflows } from "@/lib/workflows";
import { FRAUD_WORKFLOW, type Workflow, type WorkflowNode } from "@/lib/workflows/schema";

/**
 * Visual Agent Workflows builder — a read/author surface over the workflow
 * schema. It renders the journey as a node graph (kind, branches, next,
 * sub-agent hop) and, critically, shows PER-NODE TOOL SCOPING as chips so an
 * operator sees exactly which tools each step may call and the union the whole
 * journey can reach. It runs the schema + validator live, so a dangling branch
 * or unscoped tool is surfaced in the UI, not discovered in production.
 *
 * It deliberately does not re-implement execution — the runner is the single
 * executor; this is the design-time view over the same validated graph.
 */
const KIND_STYLE: Record<WorkflowNode["kind"], string> = {
  prompt: "border-line bg-white dark:bg-white text-ink",
  condition: "border-amber-400 bg-amber-50",
  tool: "border-primary/40 bg-primary/5",
  subagent: "border-indigo-400 bg-indigo-50",
  handoff: "border-rose-400 bg-rose-50",
  end: "border-emerald-400 bg-emerald-50",
};

const KIND_LABEL: Record<WorkflowNode["kind"], string> = {
  prompt: "prompt",
  condition: "branch",
  tool: "tool",
  subagent: "sub-agent",
  handoff: "handoff",
  end: "end",
};

/** Edges out of a node: branches (labelled), next, and the sub-agent return. */
function edgesOf(n: WorkflowNode): Array<{ label: string; to: string; style: string }> {
  const out: Array<{ label: string; to: string; style: string }> = [];
  for (const b of n.branches ?? []) out.push({ label: b.when, to: b.to, style: "text-amber-700" });
  if (n.next) out.push({ label: "next", to: n.next, style: "text-ink-2" });
  if (n.subagent && n.onReturn)
    out.push({ label: `↩ return from ${n.subagent}`, to: n.onReturn, style: "text-indigo-700" });
  return out;
}

export function WorkflowGraph({ workflow: initial }: { workflow?: Workflow }) {
  const [id, setId] = useState(initial?.id ?? FRAUD_WORKFLOW.id);
  const selected = useMemo(
    () => listWorkflows().find((w) => w.id === id) ?? initial ?? FRAUD_WORKFLOW,
    [id, initial],
  );
  const validation = useMemo(
    () => validateWorkflow(selected, (sid) => listWorkflows().some((w) => w.id === sid)),
    [selected],
  );
  const tools = useMemo(() => reachableTools(selected), [selected]);

  return (
    <section aria-labelledby="workflows-heading" className="space-y-5 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 id="workflows-heading" className="text-xl font-semibold">
          Agent Workflows
        </h2>
        <label className="sr-only" htmlFor="workflow-select">
          Workflow
        </label>
        <select
          id="workflow-select"
          value={id}
          onChange={(e) => setId(e.target.value)}
          className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm"
        >
          {listWorkflows().map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <span
          data-testid="workflow-validity"
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            validation.ok ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
          }`}
        >
          {validation.ok ? "valid" : `${validation.errors.length} issue(s)`}
        </span>
      </header>

      <p className="text-body-sm text-ink-2">
        {selected.name} · {selected.nodes.length} nodes · reachable tools:{" "}
        <span data-testid="reachable-tools">{tools.join(", ") || "none"}</span>
      </p>

      {!validation.ok && (
        <ul className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {validation.errors.map((e) => (
            <li key={e}>• {e}</li>
          ))}
        </ul>
      )}

      <ol className="grid gap-3 md:grid-cols-2" data-testid="workflow-graph">
        {selected.nodes.map((n) => (
          <li key={n.id} className={`rounded-xl border-2 p-3 ${KIND_STYLE[n.kind]}`}>
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm font-semibold">{n.id}</span>
              <span className="rounded bg-black/5 px-2 py-0.5 text-[11px] uppercase tracking-wide">
                {KIND_LABEL[n.kind]}
              </span>
            </div>

            {n.sysPrompt && <p className="mt-1 text-xs text-ink-2">{n.sysPrompt}</p>}
            {n.tool && (
              <p className="mt-1 font-mono text-xs">
                calls <span className="font-semibold">{n.tool}</span>
              </p>
            )}
            {n.subagent && <p className="mt-1 text-xs text-indigo-700">→ sub-agent {n.subagent}</p>}

            {/* Per-node tool scoping — the guardrail the brief asks to make visible. */}
            {n.scope.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {n.scope.map((t) => (
                  <span
                    key={t}
                    data-testid={`scope-${n.id}-${t}`}
                    className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}

            {edgesOf(n).map((e) => (
              <div key={e.to + e.label} className={`mt-1 text-[11px] ${e.style}`}>
                — {e.label} → <span className="font-mono">{e.to}</span>
              </div>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
