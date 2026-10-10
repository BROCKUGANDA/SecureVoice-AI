import type { Workflow } from "./schema";

/**
 * Validate a workflow graph. Returns every structural problem at once rather
 * than failing on the first, because a builder UI wants to show the operator
 * the complete list to fix. This is pure over the graph — it does not execute.
 *
 * Checks:
 *   · every transition (`next`, `to`, `onReturn`) resolves to a node;
 *   · `entry` exists;
 *   · a `subagent` reference is either known to the resolver or flagged as
 *     unresolved (the resolver lets a caller validate a set together);
 *   · every node is reachable from `entry` (an orphan is dead config);
 *   · at least one terminal (`end`) node is reachable, or the journey can loop
 *     forever.
 */
export type ValidationResult = { ok: boolean; errors: string[] };

export function validateWorkflow(
  wf: Workflow,
  resolveSubagent?: (id: string) => boolean,
): ValidationResult {
  const errors: string[] = [];
  const ids = new Map<string, (typeof wf.nodes)[number]>();
  for (const nd of wf.nodes) if (!ids.has(nd.id)) ids.set(nd.id, nd);

  if (!ids.has(wf.entry)) errors.push(`entry "${wf.entry}" is not a node`);

  const globalTools = new Set(wf.tools);

  for (const nd of wf.nodes) {
    // Per-node scope must be within the global allow-list — a node cannot widen
    // the journey's tool surface.
    for (const t of nd.scope) {
      if (!globalTools.has(t))
        errors.push(`node "${nd.id}" scopes tool "${t}" outside the workflow's tools`);
    }
    if (nd.next && !ids.has(nd.next))
      errors.push(`node "${nd.id}" next "${nd.next}" does not resolve`);
    if (nd.onReturn && !ids.has(nd.onReturn))
      errors.push(`node "${nd.id}" onReturn "${nd.onReturn}" does not resolve`);
    for (const b of nd.branches ?? []) {
      if (!ids.has(b.to))
        errors.push(`node "${nd.id}" branch "${b.when}" → "${b.to}" does not resolve`);
    }
    if (nd.kind === "subagent" && nd.subagent) {
      const known = resolveSubagent ? resolveSubagent(nd.subagent) : true;
      if (!known) errors.push(`node "${nd.id}" references unknown subagent "${nd.subagent}"`);
    }
    // Dead-end guard: a non-terminal node with no exit is a journey that stalls.
    const hasExit =
      nd.kind === "end" || nd.next || nd.onReturn || (nd.branches && nd.branches.length > 0);
    if (!hasExit) errors.push(`node "${nd.id}" has no way forward (dead end)`);
    // A subagent node resumes at `onReturn` and ONLY there — runner.ts does
    // `current = nd.onReturn!` with no `next` fallback, so a subagent carrying
    // only `next` passes the dead-end guard above and then dies at runtime with
    // `walked into missing node "undefined"`. Validation is where an operator
    // should learn that, not the second hop of a live journey.
    if (nd.kind === "subagent" && !nd.onReturn)
      errors.push(
        `subagent node "${nd.id}" must declare onReturn — the runner resumes there after the sub-agent returns`,
      );
  }

  // Reachability from entry.
  const reachable = new Set<string>();
  const stack = ids.has(wf.entry) ? [wf.entry] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const nd = ids.get(id);
    if (!nd) continue;
    if (nd.next) stack.push(nd.next);
    if (nd.onReturn) stack.push(nd.onReturn);
    for (const b of nd.branches ?? []) stack.push(b.to);
  }
  for (const nd of wf.nodes) {
    if (!reachable.has(nd.id)) errors.push(`node "${nd.id}" is unreachable from entry`);
  }

  // At least one reachable end node, else the walk can loop indefinitely.
  const hasEnd = wf.nodes.some((nd) => nd.kind === "end" && reachable.has(nd.id));
  if (!hasEnd && ids.has(wf.entry))
    errors.push("no reachable end node — the journey cannot terminate");

  return { ok: errors.length === 0, errors };
}
