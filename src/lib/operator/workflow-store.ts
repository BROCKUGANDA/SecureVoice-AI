import "server-only";

/**
 * Workflow persistence — the org's saved Agent Workflows, read and written as
 * ONE unit through this module.
 *
 * The built-in registry stays code (src/lib/workflows: fraud_intervention,
 * specialist_review). This table holds an institution's own graphs and their
 * overrides of built-ins, so what the builder Saves survives a reload and the
 * runner executes the same validated document the operator designed.
 *
 * Two deliberate choices:
 *
 *   · The tenant namespace is normalized, never null. An org-less session (the
 *     reference deployment's default) writes to the literal "default"
 *     namespace — the same convention /api/console/audit uses — so the
 *     @@unique([orgId, workflowId]) constraint makes a second Save an UPDATE
 *     rather than a fork. Two analysts pressing Save on the same journey get
 *     one row, not two.
 *   · Every write is re-parsed through the schema here, server-side. A route
 *     handler that "validated on the client" has validated nothing; this store
 *     is the last line, and it refuses to persist a document the schema
 *     rejects even if a caller forgets to.
 */

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { workflowSchema, type Workflow } from "@/lib/workflows/schema";

/** The namespace an org-less session reads and writes — matches the audit route's fallback. */
export const DEFAULT_ORG_NAMESPACE = "default";

/** Normalize a session's org to the storage namespace it owns. */
export function orgNamespace(orgId: string | null | undefined): string {
  const trimmed = orgId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_ORG_NAMESPACE;
}

export type StoredWorkflow = {
  workflowId: string;
  name: string;
  version: string;
  graph: Workflow;
  updatedAt: Date;
};

/** Every workflow this org has persisted, newest first. */
export async function listStoredWorkflows(ns: string): Promise<StoredWorkflow[]> {
  const rows = await db.workflowDoc.findMany({
    where: { orgId: ns },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map((r) => ({
    workflowId: r.workflowId,
    name: r.name,
    version: r.version,
    graph: r.graph as unknown as Workflow,
    updatedAt: r.updatedAt,
  }));
}

/** One persisted workflow, or null when this org has no override/save for that id. */
export async function getStoredWorkflow(
  ns: string,
  workflowId: string,
): Promise<StoredWorkflow | null> {
  const row = await db.workflowDoc.findUnique({
    where: { orgId_workflowId: { orgId: ns, workflowId: workflowId.slice(0, 128) } },
  });
  if (!row) return null;
  return {
    workflowId: row.workflowId,
    name: row.name,
    version: row.version,
    graph: row.graph as unknown as Workflow,
    updatedAt: row.updatedAt,
  };
}

/**
 * Persist a workflow. The document is re-parsed through the schema here —
 * server-side, after any client validation — so a malformed graph cannot be
 * stored even if a caller skipped its own check. Upserts on
 * (orgId, workflowId): a re-save updates in place.
 */
export async function saveStoredWorkflow(ns: string, graph: Workflow): Promise<StoredWorkflow> {
  // Defence in depth: the route validates, the store refuses anyway.
  const parsed = workflowSchema.parse(graph);
  const row = await db.workflowDoc.upsert({
    where: { orgId_workflowId: { orgId: ns, workflowId: parsed.id } },
    create: {
      orgId: ns,
      workflowId: parsed.id,
      name: parsed.name,
      version: parsed.version,
      graph: parsed as unknown as Prisma.InputJsonValue,
    },
    update: {
      name: parsed.name,
      version: parsed.version,
      graph: parsed as unknown as Prisma.InputJsonValue,
    },
  });
  return {
    workflowId: row.workflowId,
    name: row.name,
    version: row.version,
    graph: row.graph as unknown as Workflow,
    updatedAt: row.updatedAt,
  };
}

/**
 * Delete this org's persisted copy. Returns false when there is nothing to
 * delete (a built-in with no override is not deletable, and the caller maps
 * that to a 404/409 rather than silently succeeding).
 */
export async function deleteStoredWorkflow(ns: string, workflowId: string): Promise<boolean> {
  const { count } = await db.workflowDoc.deleteMany({
    where: { orgId: ns, workflowId: workflowId.slice(0, 128) },
  });
  return count > 0;
}
