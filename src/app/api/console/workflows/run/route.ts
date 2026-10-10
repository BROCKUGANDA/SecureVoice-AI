import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSignedIn } from "@/lib/credits";
import { listWorkflows, getWorkflow } from "@/lib/workflows";
import { validateWorkflow } from "@/lib/workflows/validate";
import { runWorkflow } from "@/lib/workflows/runner";
import { makeLiveDeps } from "@/lib/workflows/live";
import {
  getStoredWorkflow,
  listStoredWorkflows,
  orgNamespace,
} from "@/lib/operator/workflow-store";
import { append as auditAppend } from "@/lib/audit-chain";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * Run an Agent Workflow against a live case — the runner WIRED TO THE LIVE
 * TOOL PLANE.
 *
 * POST /api/console/workflows/run
 *   body: { workflow_id, context: { caseRef, disposition?, "branch:<nodeId>"? } }
 *
 * What makes this the real plane and not a simulation: `makeLiveDeps` forwards
 * every tool call to the SAME guarded /api/elevenlabs/tools/<name> route an
 * ElevenLabs agent webhook hits, with the server-side tool secret. The guard's
 * authentication, tenant scoping and state preconditions therefore apply to a
 * console run exactly as they apply to a live call — a journey cannot reach a
 * privileged action the guard would refuse, and each tool call is audited by
 * the tool route itself. An unconfigured secret fails closed (the tool step
 * comes back failed; the walk continues and reports honestly).
 *
 * The run itself is recorded on the audit chain as provenance (who ran which
 * journey against which case) — best-effort, because the per-call audit rows
 * the tools wrote are the security record; a provenance write must not mask a
 * completed run's result.
 */

const runSchema = z.object({
  workflow_id: z.string().min(1).max(128),
  context: z.record(z.string(), z.string()).default({}),
});

export async function POST(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "workflow_id is required" }, { status: 400 });
  }
  const { workflow_id: workflowId, context } = parsed.data;

  // Resolve: this org's saved graph wins over the built-in registry.
  const ns = orgNamespace(guard.profile.orgId);
  const stored = await getStoredWorkflow(ns, workflowId);
  const workflow = stored?.graph ?? getWorkflow(workflowId);
  if (!workflow) {
    return NextResponse.json({ ok: false, error: "unknown workflow" }, { status: 404 });
  }

  // Validate before walking — the runner would refuse anyway; refusing here
  // gives the console a clean 422 with the full error list instead of a
  // half-walked trace.
  const subagentIds = new Set(listWorkflows().map((w) => w.id));
  for (const s of await listStoredWorkflows(ns)) subagentIds.add(s.workflowId);
  const check = validateWorkflow(workflow, (id) => subagentIds.has(id));
  if (!check.ok) {
    return NextResponse.json(
      { ok: false, error: "invalid_workflow", errors: check.errors },
      { status: 422 },
    );
  }

  const origin = new URL(req.url).origin;
  const deps = makeLiveDeps(origin, {
    resolveSubagent: (id) => {
      const builtin = getWorkflow(id);
      if (builtin) return builtin;
      // A saved sub-agent resolves when it is the current workflow; any other
      // saved id resolves to undefined here, and the runner's own
      // unknown-subagent refusal then fails the run honestly — a hop that
      // cannot be resolved is reported, never silently skipped.
      if (stored && stored.workflowId === id) return stored.graph;
      return undefined;
    },
  });

  const result = await runWorkflow(workflow, context, deps);

  // Provenance. Safe-best-effort: a failure here is logged, not thrown — the
  // per-call audit rows the tool routes wrote are the security record.
  await auditAppend(
    {
      callRef: context.caseRef ?? `wf-${workflowId}`,
      action: "agent",
      intent: `workflow_run_${result.ok ? "completed" : "failed"}`,
      callerId: `console:${guard.profile.userId}`,
      meta: {
        workflow: workflowId,
        source: stored ? "saved" : "builtin",
        steps: result.trace.length,
        used_tools: result.ok ? result.usedTools : [],
        ...(result.ok ? { outcome: result.outcome } : { error: result.error }),
      },
    },
    { fast: true },
  ).catch((err) => {
    logError("[workflows/run] audit append failed", {
      workflow: workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, trace: result.trace },
      { status: 422 },
    );
  }
  return NextResponse.json({
    ok: true,
    workflow: workflowId,
    outcome: result.outcome,
    trace: result.trace,
    used_tools: result.usedTools,
  });
}
