-- An organization's saved Agent Workflow — the validated, multi-step,
-- branching graph the console builder persists.
--
-- Directory name: migrations apply in LEXICOGRAPHIC order, so this must sort
-- after 9zzzzzzzzzzzzz_pii_vault_reconcile.
--
-- ADDITIVE: a new table only. `graph` holds the JSONB workflow document
-- (schema: workflowSchema); the runner validates it again at execution time,
-- so the column is storage, not a second source of truth. `orgId` is the
-- tenant namespace ("default" for an org-less session) and is NOT nullable in
-- practice — that is what makes the unique index below turn a second Save of
-- the same journey into an UPDATE rather than a fork.
CREATE TABLE "WorkflowDoc" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "graph" JSONB NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowDoc_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowDoc_orgId_workflowId_key" ON "WorkflowDoc"("orgId", "workflowId");
CREATE INDEX "WorkflowDoc_orgId_idx" ON "WorkflowDoc"("orgId");
