import { FRAUD_WORKFLOW, SPECIALIST_WORKFLOW, workflowSchema, type Workflow } from "./schema";
import { validateWorkflow, type ValidationResult } from "./validate";

/** The built-in workflows. A deployment would load institution-defined ones here too. */
const REGISTRY = new Map<string, Workflow>([
  [FRAUD_WORKFLOW.id, FRAUD_WORKFLOW],
  [SPECIALIST_WORKFLOW.id, SPECIALIST_WORKFLOW],
]);

export function getWorkflow(id: string): Workflow | undefined {
  return REGISTRY.get(id);
}

export function listWorkflows(): Workflow[] {
  return [...REGISTRY.values()];
}

export function resolveSubagent(id: string): Workflow {
  const wf = REGISTRY.get(id);
  if (!wf) throw new Error(`unknown subagent workflow "${id}"`);
  return wf;
}

/** Validate an arbitrary (persisted) workflow document, resolving subagents against the registry. */
export function validateDocument(input: unknown): ValidationResult {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  return validateWorkflow(parsed.data, (id) => REGISTRY.has(id));
}
