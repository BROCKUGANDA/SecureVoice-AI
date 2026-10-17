import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/credits";
import { listWorkflows } from "@/lib/workflows";
import { validateWorkflow } from "@/lib/workflows/validate";
import { workflowSchema, type Workflow } from "@/lib/workflows/schema";
import {
  listStoredWorkflows,
  orgNamespace,
  saveStoredWorkflow,
} from "@/lib/operator/workflow-store";

export const dynamic = "force-dynamic";

/**
 * Agent Workflows console — list and save.
 *
 *   GET  /api/console/workflows            → summary rows (id/name/version/
 *                                            source/updatedAt/steps/bytes) for
 *                                            the built-in registry MERGED with
 *                                            this org's saved graphs
 *   GET  /api/console/workflows?include=graph
 *                                          → the same rows WITH each full
 *                                            graph document (what the builder
 *                                            needs to reopen a journey)
 *   POST /api/console/workflows            → validate + persist a graph (body: { graph })
 *
 * A saved graph is re-validated server-side by the SAME schema and validator
 * the runner uses before it is stored — a journey that cannot walk is not
 * persisted, so the builder can never offer the Run button a graph the plane
 * would refuse. Operator session required; every row is namespaced to the
 * session's active organization.
 */

/**
 * One list row. A full graph is several KB of JSON and a console with dozens
 * of saved journeys re-fetches this list on every mount, so the graph only
 * travels when a caller asks for it — `steps`/`bytes` say how big the omitted
 * document is without shipping it (`bytes` is the wire size of the serialized
 * graph, i.e. what `include=graph` would actually add to the response).
 */
type WorkflowRow = {
  id: string;
  name: string;
  version: string;
  source: "builtin" | "saved";
  /** Null for built-ins: they are code and have no stored row. */
  updatedAt: string | null;
  steps: number;
  bytes: number;
  graph?: Workflow;
};

function row(
  id: string,
  name: string,
  version: string,
  source: "builtin" | "saved",
  updatedAt: Date | null,
  graph: Workflow,
  includeGraph: boolean,
): WorkflowRow {
  const summary: WorkflowRow = {
    id,
    name,
    version,
    source,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    steps: graph.nodes.length,
    bytes: Buffer.byteLength(JSON.stringify(graph)),
  };
  if (includeGraph) summary.graph = graph;
  return summary;
}

export async function GET(req?: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });
  }
  // Optional-chained because tests invoke the handler bare; the framework
  // always supplies the request in production.
  const includeGraph = req?.nextUrl.searchParams.get("include") === "graph";
  const ns = orgNamespace(guard.profile.orgId);
  const stored = await listStoredWorkflows(ns);
  const overrides = new Map(stored.map((s) => [s.workflowId, s]));

  const workflows: WorkflowRow[] = [
    // Built-ins, replaced by this org's override when one exists.
    ...listWorkflows().map((w) => {
      const o = overrides.get(w.id);
      return row(
        w.id,
        o?.name ?? w.name,
        o?.version ?? w.version,
        o ? "saved" : "builtin",
        o?.updatedAt ?? null,
        o?.graph ?? w,
        includeGraph,
      );
    }),
    // Institution-authored journeys that are not overrides of a built-in.
    ...stored
      .filter((s) => !listWorkflows().some((w) => w.id === s.workflowId))
      .map((s) =>
        row(s.workflowId, s.name, s.version, "saved", s.updatedAt, s.graph, includeGraph),
      ),
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
