import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/credits";
import { listWorkflows } from "@/lib/workflows";
import { validateWorkflow } from "@/lib/workflows/validate";
import { workflowSchema } from "@/lib/workflows/schema";
import {
  listStoredWorkflows,
  orgNamespace,
  saveStoredWorkflow,
} from "@/lib/operator/workflow-store";

export const dynamic = "force-dynamic";

/**
 * Agent Workflows console — list and save.
 *
 *   GET  /api/console/workflows → the built-in registry MERGED with this
 *                                 org's saved graphs (a saved override wins)
 *   POST /api/console/workflows → validate + persist a graph (body: { graph })
 *
 * A saved graph is re-validated server-side by the SAME schema and validator
 * the runner uses before it is stored — a journey that cannot walk is not
 * persisted, so the builder can never offer the Run button a graph the plane
 * would refuse. Operator session required; every row is namespaced to the
 * session's active organization.
 */
export async function GET() {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });
  }
  const ns = orgNamespace(guard.profile.orgId);
  const stored = await listStoredWorkflows(ns);
  const overrides = new Map(stored.map((s) => [s.workflowId, s]));

  const workflows = [
    // Built-ins, replaced by this org's override when one exists.
    ...listWorkflows().map((w) => {
      const o = overrides.get(w.id);
      return {
        id: w.id,
        name: o?.name ?? w.name,
        version: o?.version ?? w.version,
        source: o ? ("saved" as const) : ("builtin" as const),
        graph: o?.graph ?? w,
      };
    }),
    // Institution-authored journeys that are not overrides of a built-in.
    ...stored
      .filter((s) => !listWorkflows().some((w) => w.id === s.workflowId))
      .map((s) => ({
        id: s.workflowId,
        name: s.name,
        version: s.version,
        source: "saved" as const,
        graph: s.graph,
      })),
  ];

  return NextResponse.json(
    { ok: true, namespace: ns, workflows },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });
  }

  // The body is read directly rather than through a wrapper object-schema:
  // the workflow schema IS the validator for the graph, so a wrapper would
  // only restate that and (under this zod major) reject arbitrary payloads
  // the schema itself should judge.
  let body: { graph?: unknown };
  try {
    body = (await req.json()) as { graph?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || !("graph" in body)) {
    return NextResponse.json({ ok: false, error: "graph is required" }, { status: 400 });
  }

  // The schema first (shape), then the validator (graph laws: dangling edges,
  // unreachable nodes, scope outside the journey's tools). Both are the same
  // functions the runner enforces at execution time.
  const parsed = workflowSchema.safeParse(body.graph);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_workflow",
        errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      { status: 422 },
    );
  }

  const ns = orgNamespace(guard.profile.orgId);
  const knownIds = new Set(listWorkflows().map((w) => w.id));
  for (const s of await listStoredWorkflows(ns)) knownIds.add(s.workflowId);
  const check = validateWorkflow(parsed.data, (id) => knownIds.has(id));
  if (!check.ok) {
    return NextResponse.json(
      { ok: false, error: "invalid_workflow", errors: check.errors },
      { status: 422 },
    );
  }

  const saved = await saveStoredWorkflow(ns, parsed.data);
  return NextResponse.json({
    ok: true,
    workflow: { id: saved.workflowId, name: saved.name, version: saved.version },
  });
}
