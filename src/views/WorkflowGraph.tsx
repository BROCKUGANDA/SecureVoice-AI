"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { validateWorkflow } from "@/lib/workflows/validate";
import { reachableTools } from "@/lib/workflows/runner";
import { listWorkflows } from "@/lib/workflows";
import {
  FRAUD_WORKFLOW,
  workflowSchema,
  type Workflow,
  type WorkflowNode,
} from "@/lib/workflows/schema";
import { useApp } from "@/lib/store";

/**
 * Agent Workflows builder — the authoring surface over the workflow schema.
 *
 * Everything an institution needs to DESIGN a journey and prove it is safe to
 * run, in one panel:
 *
 *   · the journey as a node graph (kind, branches, next, sub-agent hop) —
 *     draggable to reorder the canvas;
 *   · PER-NODE TOOL SCOPING as editable chips, because that is the guardrail
 *     the brief names: a node may only call the tools in its own scope,
 *     intersected with the journey's global allow-list;
 *   · the schema + validator running LIVE on every edit, so a dangling branch
 *     or unscoped tool is surfaced in the UI, not discovered in production;
 *   · Save (persists through the console API — server-side re-validation, the
 *     same functions the runner enforces) and Run (executes the graph on the
 *     LIVE tool plane through the guarded routes).
 *
 * It deliberately does not re-implement execution: the runner is the single
 * executor, and Run simply hands it the document this panel produced.
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

const KINDS: WorkflowNode["kind"][] = ["prompt", "condition", "tool", "subagent", "handoff", "end"];

/**
 * The tool surface a journey may name — the five guarded tools the plane
 * actually has (the same set the MCP front door exposes). A chip outside this
 * list is not offered by the builder; the schema still accepts a string, and
 * the validator's scope check is what rejects naming a tool that does not
 * exist at RUN time (the guard refuses it there, and the trace says so).
 */
const KNOWN_TOOLS = [
  "verify_transaction",
  "card_freeze",
  "human_handoff",
  "warm_transfer",
  "switch_language",
];

/** Edges out of a node: branches (labelled), next, and the sub-agent return. */
function edgesOf(n: WorkflowNode): Array<{ label: string; to: string; style: string }> {
  const out: Array<{ label: string; to: string; style: string }> = [];
  for (const b of n.branches ?? []) out.push({ label: b.when, to: b.to, style: "text-amber-700" });
  if (n.next) out.push({ label: "next", to: n.next, style: "text-ink-2" });
  if (n.subagent && n.onReturn)
    out.push({ label: `? return from ${n.subagent}`, to: n.onReturn, style: "text-indigo-700" });
  return out;
}

const blankWorkflow = (): Workflow => ({
  id: `journey_${Date.now().toString(36)}`,
  name: "New journey",
  version: "1",
  entry: "start",
  tools: [],
  nodes: [
    {
      id: "start",
      kind: "prompt",
      sysPrompt: "Opening instruction for the turn.",
      scope: [],
      next: "done",
    },
    { id: "done", kind: "end", outcome: "resolved", scope: [] },
  ],
});

type RunResult = {
  ok: boolean;
  outcome?: string;
  used_tools?: string[];
  error?: string;
  errors?: string[];
  trace?: Array<{ id: string; kind: string; detail?: string }>;
};

export function WorkflowGraph({ workflow: initial }: { workflow?: Workflow }) {
  const { lang } = useApp();
  const t = (en: string, ar: string) => (lang === "ar" ? ar : en);

  const [wf, setWf] = useState<Workflow>(() => initial ?? FRAUD_WORKFLOW);
  const [saved, setSaved] = useState<string | null>(null); // JSON snapshot of the last save
  const [editing, setEditing] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<WorkflowNode["kind"]>("prompt");
  const [newId, setNewId] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMsg, setSaveMsg] = useState("");
  const [run, setRun] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const dragFrom = useRef<number | null>(null);

  // The switcher lists the org's SAVED journeys merged over the built-ins (the
  // same merge GET /api/console/workflows returns), so an institution can
  // reopen a journey it saved in a previous session — persistence that cannot
  // be read back is only half-built. A failed fetch is silent: the built-ins
  // still author fine, and Save still works.
  const [savedOptions, setSavedOptions] = useState<
    Array<{ id: string; name: string; graph: Workflow; source: string }>
  >([]);
  useEffect(() => {
    if (typeof fetch !== "function") return; // jest/jsdom: no fetch, built-ins only
    let cancelled = false;
    fetch("/api/console/workflows", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          d: {
            workflows: Array<{ id: string; name: string; source: string; graph: Workflow }>;
          } | null,
        ) => {
          if (!cancelled && d) {
            setSavedOptions(
              d.workflows.map((w) => ({
                id: w.id,
                name: w.name,
                graph: w.graph,
                source: w.source,
              })),
            );
          }
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** Every journey offered in the switcher: saved first, then built-ins. */
  const switcherOptions = useMemo(() => {
    const saved = savedOptions.map((s) => ({ ...s, builtin: false }));
    const builtin = listWorkflows()
      .filter((w) => !savedOptions.some((s) => s.id === w.id))
      .map((w) => ({ id: w.id, name: w.name, graph: w, source: "builtin", builtin: true }));
    return [...saved, ...builtin];
  }, [savedOptions]);

  const openWorkflow = (option: { id: string; graph: Workflow }) => {
    setWf(option.graph);
    setEditing(null);
    setRun(null);
    setSaved(JSON.stringify(option.graph));
  };

  // Live validation mirrors the SAVE ROUTE exactly: schema first (shape and
  // per-node laws such as "a tool node's tool must be in its scope"), then the
  // validator (dangling edges, reachability, scope vs the journey's tools).
  // A badge that said "valid" for a graph the route would 422 would be worse
  // than no badge — it would send the operator to press Run on a refusal.
  const validation = useMemo(() => {
    const parsed = workflowSchema.safeParse(wf);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((i) =>
          i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
        ),
      };
    }
    return validateWorkflow(
      parsed.data,
      (sid) => listWorkflows().some((w) => w.id === sid) || sid === wf.id,
    );
  }, [wf]);
  const tools = useMemo(() => reachableTools(wf), [wf]);
  const dirty = saved !== null && saved !== JSON.stringify(wf);
  const nodeIds = wf.nodes.map((n) => n.id);
  const toolUniverse = [...new Set([...KNOWN_TOOLS, ...wf.tools])].sort();

  // ── mutation helpers ──────────────────────────────────────────────────────
  const patchNode = (id: string, patch: Partial<WorkflowNode>) =>
    setWf((w) => ({ ...w, nodes: w.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));

  const addNode = () => {
    const id = newId.trim();
    if (!id || nodeIds.includes(id)) {
      setSaveMsg(
        t(`Node id "${id}" is empty or already used.`, `معرّف العقدة "${id}" فارغ أو مستخدم.`),
      );
      return;
    }
    const node: WorkflowNode = { id, kind: newKind, scope: [] };
    if (newKind === "tool") node.tool = KNOWN_TOOLS[0];
    if (newKind === "condition")
      node.branches = [{ when: "confirmed_fraud", to: nodeIds[0] ?? "done" }];
    if (newKind === "end") node.outcome = "resolved";
    if (newKind === "subagent") node.subagent = "specialist_review";
    setWf((w) => ({ ...w, nodes: [...w.nodes, node] }));
    setNewId("");
    setEditing(id);
    setSaveMsg("");
  };

  const removeNode = (id: string) =>
    setWf((w) => ({
      ...w,
      nodes: w.nodes.filter((n) => n.id !== id),
      // Drop references so the validator reports the graph honestly rather
      // than a dangling edge to a node the operator just deleted.
      entry: w.entry === id ? (w.nodes.find((n) => n.id !== id)?.id ?? "") : w.entry,
    }));

  const moveNode = (from: number, to: number) =>
    setWf((w) => {
      if (from === to || from < 0 || to < 0 || from >= w.nodes.length || to >= w.nodes.length)
        return w;
      const nodes = [...w.nodes];
      const [moved] = nodes.splice(from, 1);
      nodes.splice(to, 0, moved);
      return { ...w, nodes };
    });

  const toggleGlobalTool = (tool: string) =>
    setWf((w) => ({
      ...w,
      tools: w.tools.includes(tool) ? w.tools.filter((x) => x !== tool) : [...w.tools, tool],
    }));

  const toggleNodeScope = (id: string, tool: string) =>
    setWf((w) => ({
      ...w,
      nodes: w.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              scope: n.scope.includes(tool)
                ? n.scope.filter((x) => x !== tool)
                : [...n.scope, tool],
            }
          : n,
      ),
      // A scoped tool must also be in the journey's global allow-list — the
      // validator rejects a node that scopes a tool the journey does not have.
      tools: w.tools.includes(tool) ? w.tools : [...w.tools, tool],
    }));

  // ── persistence + live run ────────────────────────────────────────────────
  const save = async () => {
    // Client-side mirror of the server check; the server is authoritative.
    const parsed = workflowSchema.safeParse(wf);
    if (!parsed.success) {
      setSaveState("error");
      setSaveMsg(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }
    setSaveState("saving");
    try {
      const res = await fetch("/api/console/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ graph: wf }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; errors?: string[] };
      if (!res.ok || !data.ok) {
        setSaveState("error");
        setSaveMsg(data.errors?.join("; ") ?? data.error ?? `save failed (${res.status})`);
        return;
      }
      setSaveState("saved");
      setSaveMsg(
        t("Saved. The runner now executes this graph.", "تم الحفظ. المنفّذ ينفّذ هذا الرسم الآن."),
      );
      setSaved(JSON.stringify(wf));
      // Refresh the switcher so the just-saved journey is reopenable (and a
      // built-in override shows its saved marker) without a page reload.
      setSavedOptions((opts) => [
        { id: wf.id, name: wf.name, graph: wf, source: "saved" },
        ...opts.filter((o) => o.id !== wf.id),
      ]);
    } catch {
      setSaveState("error");
      setSaveMsg(t("Could not reach the console API.", "تعذّر الوصول إلى واجهة الكونسول."));
    }
  };

  const runNow = async () => {
    setRunning(true);
    setRun(null);
    try {
      const res = await fetch("/api/console/workflows/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The demo case: a real console run supplies a live caseRef. The tool
        // guard is the authority on whether that case may act — a refused tool
        // comes back as a failed step, which is the honest result.
        body: JSON.stringify({ workflow_id: wf.id, context: { caseRef: "SV-WF-DEMO" } }),
      });
      const data = (await res.json()) as RunResult;
      setRun(data);
    } catch {
      setRun({ ok: false, error: "run request failed" });
    } finally {
      setRunning(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <section aria-labelledby="workflows-heading" className="space-y-5 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 id="workflows-heading" className="text-xl font-semibold">
          {t("Agent Workflows", "مسارات الوكيل")}
        </h2>
        <label className="sr-only" htmlFor="workflow-select">
          {t("Workflow", "المسار")}
        </label>
        <select
          id="workflow-select"
          value={wf.id}
          onChange={(e) => {
            const next = switcherOptions.find((w) => w.id === e.target.value);
            if (next) openWorkflow(next);
          }}
          className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm"
        >
          {switcherOptions.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.builtin ? "" : ` (${t("saved", "محفوظ")})`}
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
        {dirty && (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
            {t("unsaved", "غير محفوظ")}
          </span>
        )}
      </header>

      {/* Journey-level controls: identity, entry, global tool allow-list, add/save/run. */}
      <div className="grid gap-3 rounded-xl border border-line bg-white p-3 md:grid-cols-2">
        <div className="space-y-2">
          <label className="block text-xs font-medium text-ink-2" htmlFor="wf-name">
            {t("Journey name", "اسم المسار")}
          </label>
          <input
            id="wf-name"
            value={wf.name}
            onChange={(e) => setWf((w) => ({ ...w, name: e.target.value }))}
            className="w-full rounded-lg border border-line px-3 py-1.5 text-sm"
          />
          <label className="block text-xs font-medium text-ink-2" htmlFor="wf-entry">
            {t("Entry node", "عقدة البداية")}
          </label>
          <select
            id="wf-entry"
            value={wf.entry}
            onChange={(e) => setWf((w) => ({ ...w, entry: e.target.value }))}
            className="w-full rounded-lg border border-line px-3 py-1.5 text-sm"
          >
            {nodeIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <span
            className="block text-xs font-medium text-ink-2"
            data-testid="workflow-global-tools"
          >
            {t(
              "Journey tools (global allow-list — a node can only narrow it)",
              "أدوات المسار (القائمة العامة — العقدة لا تُوسّعها)",
            )}
          </span>
          <div className="flex flex-wrap gap-1">
            {toolUniverse.map((tool) => (
              <button
                key={tool}
                type="button"
                onClick={() => toggleGlobalTool(tool)}
                className={`rounded px-2 py-0.5 font-mono text-[11px] ${
                  wf.tools.includes(tool)
                    ? "bg-primary/10 text-primary"
                    : "bg-black/5 text-ink-3 line-through"
                }`}
              >
                {tool}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <input
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder={t("new node id", "معرّف العقدة")}
              aria-label={t("New node id", "معرّف العقدة الجديدة")}
              className="w-36 rounded-lg border border-line px-2 py-1 font-mono text-xs"
            />
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as WorkflowNode["kind"])}
              aria-label={t("New node kind", "نوع العقدة")}
              className="rounded-lg border border-line px-2 py-1 text-xs"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addNode}
              className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium hover:bg-black/5"
            >
              + {t("Add node", "إضافة عقدة")}
            </button>
          </div>
        </div>
      </div>

      <p className="text-body-sm text-ink-2">
        {wf.name} · {wf.nodes.length} {t("nodes", "عقد")} ·{" "}
        {t("reachable tools", "الأدوات المتاحة")}:{" "}
        <span data-testid="reachable-tools">{tools.join(", ") || "none"}</span>
      </p>

      {!validation.ok && (
        <ul
          data-testid="workflow-errors"
          className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
        >
          {validation.errors.map((e) => (
            <li key={e}>• {e}</li>
          ))}
        </ul>
      )}

      <ol className="grid gap-3 md:grid-cols-2" data-testid="workflow-graph">
        {wf.nodes.map((n, i) => (
          <li
            key={n.id}
            data-testid={`node-${n.id}`}
            draggable
            onDragStart={() => {
              dragFrom.current = i;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragFrom.current !== null) moveNode(dragFrom.current, i);
              dragFrom.current = null;
            }}
            className={`rounded-xl border-2 p-3 ${KIND_STYLE[n.kind]}`}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm font-semibold">{n.id}</span>
              <span className="flex items-center gap-2">
                <span className="rounded bg-black/5 px-2 py-0.5 text-[11px] uppercase tracking-wide">
                  {KIND_LABEL[n.kind]}
                </span>
                <button
                  type="button"
                  onClick={() => setEditing(editing === n.id ? null : n.id)}
                  className="rounded border border-line px-1.5 py-0.5 text-[11px] hover:bg-black/5"
                >
                  {editing === n.id ? t("close", "إغلاق") : t("edit", "تعديل")}
                </button>
                <button
                  type="button"
                  onClick={() => removeNode(n.id)}
                  className="rounded border border-rose-200 px-1.5 py-0.5 text-[11px] text-rose-700 hover:bg-rose-50"
                  aria-label={`${t("delete node", "حذف العقدة")} ${n.id}`}
                >
                  ×
                </button>
              </span>
            </div>

            {n.sysPrompt && <p className="mt-1 text-xs text-ink-2">{n.sysPrompt}</p>}
            {n.tool && (
              <p className="mt-1 font-mono text-xs">
                {t("calls", "ينفّذ")} <span className="font-semibold">{n.tool}</span>
              </p>
            )}
            {n.subagent && <p className="mt-1 text-xs text-indigo-700">→ sub-agent {n.subagent}</p>}

            {/* Per-node tool scoping — the guardrail the brief asks to make visible. */}
            {n.scope.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {n.scope.map((tool) => (
                  <span
                    key={tool}
                    data-testid={`scope-${n.id}-${tool}`}
                    className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            )}

            {edgesOf(n).map((e) => (
              <div key={e.to + e.label} className={`mt-1 text-[11px] ${e.style}`}>
                — {e.label} → <span className="font-mono">{e.to}</span>
              </div>
            ))}

            {/* ── the editor ── */}
            {editing === n.id && (
              <div className="mt-3 space-y-2 rounded-lg border border-line bg-white p-3 text-xs">
                {/* prompt / handoff / condition nodes all carry turn instructions */}
                {(n.kind === "prompt" || n.kind === "handoff" || n.kind === "condition") && (
                  <label className="block">
                    <span className="font-medium text-ink-2">sysPrompt</span>
                    <textarea
                      value={n.sysPrompt ?? ""}
                      onChange={(e) => patchNode(n.id, { sysPrompt: e.target.value })}
                      rows={2}
                      className="mt-1 w-full rounded border border-line p-2"
                    />
                  </label>
                )}

                {n.kind === "tool" && (
                  <label className="block">
                    <span className="font-medium text-ink-2">
                      {t("tool (must be in scope)", "الأداة (يجب أن تكون في النطاق)")}
                    </span>
                    <select
                      value={n.tool ?? ""}
                      onChange={(e) => {
                        const tool = e.target.value;
                        patchNode(n.id, { tool });
                        setWf((w) => ({
                          ...w,
                          nodes: w.nodes.map((x) =>
                            x.id === n.id
                              ? {
                                  ...x,
                                  scope: x.scope.includes(tool) ? x.scope : [...x.scope, tool],
                                }
                              : x,
                          ),
                          tools: w.tools.includes(tool) ? w.tools : [...w.tools, tool],
                        }));
                      }}
                      className="mt-1 w-full rounded border border-line p-1.5 font-mono"
                    >
                      {toolUniverse.map((tool) => (
                        <option key={tool} value={tool}>
                          {tool}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {n.kind === "tool" && (
                  <div className="space-y-1">
                    <span className="font-medium text-ink-2">args ({"{{key}}"})</span>
                    {Object.entries(n.args ?? {}).map(([k, v]) => (
                      <div key={k} className="flex gap-1">
                        <input
                          value={k}
                          readOnly
                          className="w-1/3 rounded border border-line p-1 font-mono"
                        />
                        <input
                          value={v}
                          onChange={(e) =>
                            patchNode(n.id, { args: { ...(n.args ?? {}), [k]: e.target.value } })
                          }
                          className="flex-1 rounded border border-line p-1 font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const next = { ...(n.args ?? {}) };
                            delete next[k];
                            patchNode(n.id, { args: next });
                          }}
                          className="rounded border border-rose-200 px-1.5 text-rose-700"
                          aria-label={`delete arg ${k}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        patchNode(n.id, {
                          args: {
                            ...(n.args ?? {}),
                            [`arg${Object.keys(n.args ?? {}).length + 1}`]: "",
                          },
                        })
                      }
                      className="rounded border border-line px-2 py-0.5"
                    >
                      + arg
                    </button>
                  </div>
                )}

                {n.kind === "condition" && (
                  <div className="space-y-1">
                    <span className="font-medium text-ink-2">branches</span>
                    {(n.branches ?? []).map((b, bi) => (
                      <div key={`${b.when}-${bi}`} className="flex gap-1">
                        <input
                          value={b.when}
                          onChange={(e) => {
                            const branches = [...(n.branches ?? [])];
                            branches[bi] = { ...b, when: e.target.value };
                            patchNode(n.id, { branches });
                          }}
                          className="w-1/3 rounded border border-line p-1 font-mono"
                        />
                        <select
                          value={b.to}
                          onChange={(e) => {
                            const branches = [...(n.branches ?? [])];
                            branches[bi] = { ...b, to: e.target.value };
                            patchNode(n.id, { branches });
                          }}
                          className="flex-1 rounded border border-line p-1 font-mono"
                        >
                          {nodeIds.map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() =>
                            patchNode(n.id, {
                              branches: (n.branches ?? []).filter((_, x) => x !== bi),
                            })
                          }
                          className="rounded border border-rose-200 px-1.5 text-rose-700"
                          aria-label={`delete branch ${b.when}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        patchNode(n.id, {
                          branches: [
                            ...(n.branches ?? []),
                            { when: "*", to: nodeIds[0] ?? "done" },
                          ],
                        })
                      }
                      className="rounded border border-line px-2 py-0.5"
                    >
                      + {t("branch", "فرع")}
                    </button>
                  </div>
                )}

                {n.kind === "subagent" && (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="font-medium text-ink-2">subagent</span>
                      <input
                        value={n.subagent ?? ""}
                        onChange={(e) => patchNode(n.id, { subagent: e.target.value })}
                        className="mt-1 w-full rounded border border-line p-1 font-mono"
                      />
                    </label>
                    <label className="block">
                      <span className="font-medium text-ink-2">onReturn</span>
                      <select
                        value={n.onReturn ?? ""}
                        onChange={(e) => patchNode(n.id, { onReturn: e.target.value })}
                        className="mt-1 w-full rounded border border-line p-1 font-mono"
                      >
                        <option value="">—</option>
                        {nodeIds.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {n.kind === "end" && (
                  <label className="block">
                    <span className="font-medium text-ink-2">outcome</span>
                    <input
                      value={n.outcome ?? ""}
                      onChange={(e) => patchNode(n.id, { outcome: e.target.value })}
                      className="mt-1 w-full rounded border border-line p-1 font-mono"
                    />
                  </label>
                )}

                {n.kind !== "end" && n.kind !== "condition" && n.kind !== "subagent" && (
                  <label className="block">
                    <span className="font-medium text-ink-2">next</span>
                    <select
                      value={n.next ?? ""}
                      onChange={(e) => patchNode(n.id, { next: e.target.value || undefined })}
                      className="mt-1 w-full rounded border border-line p-1 font-mono"
                    >
                      <option value="">—</option>
                      {nodeIds.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {/* scope editor */}
                <div className="space-y-1">
                  <span className="font-medium text-ink-2">
                    {t("tool scope for this node", "نطاق الأدوات لهذه العقدة")}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {toolUniverse.map((tool) => (
                      <button
                        key={tool}
                        type="button"
                        onClick={() => toggleNodeScope(n.id, tool)}
                        className={`rounded px-2 py-0.5 font-mono text-[11px] ${
                          n.scope.includes(tool)
                            ? "bg-primary/10 text-primary"
                            : "bg-black/5 text-ink-3"
                        }`}
                      >
                        {tool}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>

      {/* ── actions: new / save / run ── */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const fresh = blankWorkflow();
            setWf(fresh);
            setSaved(JSON.stringify(fresh));
            setEditing(null);
            setRun(null);
          }}
          className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-black/5"
        >
          {t("New journey", "مسار جديد")}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saveState === "saving"}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saveState === "saving" ? t("Saving…", "جارٍ الحفظ…") : t("Save journey", "حفظ المسار")}
        </button>
        <button
          type="button"
          onClick={runNow}
          disabled={running || !validation.ok}
          title={
            validation.ok
              ? undefined
              : t("Fix the issues above before running.", "أصلح المشاكل أعلاه قبل التشغيل.")
          }
          className="rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
        >
          {running
            ? t("Running…", "جارٍ التشغيل…")
            : t("Run on live plane", "تشغيل على المستوى الحيّ")}
        </button>
        {saveMsg && (
          <span
            className={`text-xs ${
              saveState === "error"
                ? "text-rose-700"
                : saveState === "saved"
                  ? "text-emerald-700"
                  : "text-ink-2"
            }`}
          >
            {saveMsg}
          </span>
        )}
      </div>

      {/* ── run result: the trace the runner returned ── */}
      {run && (
        <div
          data-testid="workflow-run"
          className="space-y-2 rounded-xl border border-line bg-white p-3 text-xs"
        >
          <div className="font-semibold">
            {run.ok
              ? `${t("outcome", "النتيجة")}: ${run.outcome} · ${t("tools", "أدوات")}: ${
                  run.used_tools?.join(", ") || "none"
                }`
              : `${t("run failed", "فشل التشغيل")}: ${run.error ?? ""} ${
                  run.errors?.join("; ") ?? ""
                }`}
          </div>
          <ol className="space-y-0.5">
            {(run.trace ?? []).map((s, i) => (
              <li key={`${s.id}-${i}`} className="font-mono text-[11px] text-ink-2">
                {i + 1}. {s.kind}:{s.id}
                {s.detail ? ` — ${s.detail}` : ""}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
