import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/credits";
import { getWorkflow } from "@/lib/workflows";
import {
  deleteStoredWorkflow,
  getStoredWorkflow,
  orgNamespace,
} from "@/lib/operator/workflow-store";

export const dynamic = "force-dynamic";

/**
 * One Agent Workflow — fetch or delete this org's saved copy.
 *
 *   GET    /api/console/workflows/:id → the saved override if one exists,
 *                                       otherwise the built-in (so the builder
 *                                       opens on the right document)
 *   DELETE /api/console/workflows/:id → remove the saved copy, reverting a
 *                                       built-in to its registry definition
 *
 * A built-in with no saved override cannot be deleted: the registry is code,
 * and a route that "deleted" it would be lying about what the next request
 * would return.
 *
 * Operator session required; rows are namespaced to the session's active
 * organization, and a foreign workspace's id returns the same 404 as a
 * nonexistent one — existence is not confirmed across tenants.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });
  }
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
  }

  const ns = orgNamespace(guard.profile.orgId);
  const stored = await getStoredWorkflow(ns, id);
  if (stored) {
    return NextResponse.json(
      { ok: true, source: "saved", workflow: stored.graph },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const builtin = getWorkflow(id);
  if (builtin) {
    return NextResponse.json(
      { ok: true, source: "builtin", workflow: builtin },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ ok: false, error: guard.error }, { status: guard.status });
  }
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
  }

  const ns = orgNamespace(guard.profile.orgId);
  const removed = await deleteStoredWorkflow(ns, id);
  if (!removed) {
    return NextResponse.json(
      { ok: false, error: "no saved workflow with that id in this workspace" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, deleted: id, reverted: getWorkflow(id) ? true : false });
}
