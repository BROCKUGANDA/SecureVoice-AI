import "server-only";

/**
 * The LIVE wiring for the workflow runner — `deps.callTool` forwarded to the
 * REAL guarded tool routes.
 *
 * This is the piece that turns the runner from a tested-but-inert executor
 * into the thing the console's Run button executes: every tool call is POSTed
 * to the same `/api/elevenlabs/tools/<name>` route an ElevenLabs agent webhook
 * hits, carrying the server-side `x-agent-tool-secret`. There is deliberately
 * NO second implementation of a tool here — the guard still authenticates,
 * tenant-scopes, and enforces the state preconditions, exactly as the MCP
 * front door does. A workflow an operator designed can therefore never reach
 * an action the guard would refuse the agent path, and the audit trail for the
 * call is written by the tool route itself rather than by this shim.
 *
 * Fail-closed, like the guard and the MCP route: no configured secret means no
 * tool is reachable, and the run continues with a failed tool step rather than
 * silently pretending the action happened.
 */

import { getWorkflow } from "./index";
import type { RunnerDeps } from "./runner";
import type { Workflow } from "./schema";

/** Tool name → route directory under /api/elevenlabs/tools/ (mirrors the MCP route). */
const TOOL_ROUTES: Record<string, string> = {
  verify_transaction: "verify-transaction",
  card_freeze: "card-freeze",
  human_handoff: "human-handoff",
  warm_transfer: "warm-transfer",
  switch_language: "switch-language",
};

/** The tools a workflow may name, in manifest order. */
export const LIVE_TOOL_NAMES = Object.keys(TOOL_ROUTES);

export type LiveDepsOptions = {
  /**
   * Resolve a sub-agent workflow id that is NOT a built-in — the org's own
   * persisted workflows. Built-ins are always tried first, so a deployment
   * cannot shadow `specialist_review`.
   */
  resolveSubagent?: (id: string) => Workflow | undefined;
};

/**
 * Build the runner deps against the live plane. `origin` is the absolute base
 * the tool routes are reached on (`new URL(req.url).origin`) — the same shape
 * the MCP route uses, so a workflow run inside the app and an MCP client's run
 * take the identical path.
 */
export function makeLiveDeps(origin: string, opts: LiveDepsOptions = {}): RunnerDeps {
  return {
    /**
     * Which branch label a condition node takes. Deterministic, in precedence
     * order: an explicit per-node label in the case context (`branch:<nodeId>`),
     * then the call's resolved `disposition` (the vocabulary the tools already
     * speak: confirmed_fraud / confirmed_legitimate / uncertain), then the
     * default `*` branch. A designed journey stays reproducible — the same case
     * context always walks the same path.
     */
    label: (node, ctx) => ctx[`branch:${node.id}`] ?? ctx.disposition ?? "*",

    /**
     * Invoke a tool through the guarded route. The runner has already enforced
     * the node-scope ∪ workflow-tools intersection; this enforces the rest.
     */
    callTool: async (_node, tool, args) => {
      const dir = TOOL_ROUTES[tool];
      if (!dir) return { ok: false, result: { error: "unknown_tool", tool } };
      const secret = process.env.AGENT_TOOL_SECRET;
      // Fail closed exactly like the guard and the MCP front door: no
      // configured secret reaches no tool.
      if (!secret) return { ok: false, result: { error: "tool_scope_unconfigured" } };
      try {
        const res = await fetch(new URL(`/api/elevenlabs/tools/${dir}`, origin), {
          method: "POST",
          headers: { "content-type": "application/json", "x-agent-tool-secret": secret },
          body: JSON.stringify(args ?? {}),
        });
        const text = await res.text();
        return { ok: res.ok, result: text, label: tool };
      } catch {
        return { ok: false, result: { error: "tool_call_failed" } };
      }
    },

    resolveSubagent: (id) => {
      const custom = opts.resolveSubagent?.(id);
      if (custom) return custom;
      const wf = getWorkflow(id);
      if (!wf) throw new Error(`unknown subagent workflow "${id}"`);
      return wf;
    },

    // The runner's cycle backstop; 200 steps is far beyond any designed journey
    // and still bounded, so a malformed graph cannot spin the worker.
    maxSteps: 200,
  };
}
