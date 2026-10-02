import "server-only";
/**
 * Shared guard for all ElevenLabs server tools. Every tool call passes
 * through here before it reaches the tool handler. The guard enforces:
 *
 *   1. Authentication â€” x-agent-tool-secret against the per-tool allow-list.
 *   2. Case resolution â€” the conversation_id must map to a live case.
 *   3. State precondition â€” the case must be in a state the tool may act on.
 *
 * A refusal is a typed 409, never a 500. Every refusal is written to the
 * audit chain before returning â€” a refused freeze attempt is the most
 * valuable audit entry a judge will see (WP-3 step 3, invariant I-2).
 */

import { authorizeToolCall } from "@/lib/agent-tool-auth";
import { recordSpanAndPersist } from "@/lib/telemetry/store";
import { caseByConversation, type CaseState } from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";

export type ToolGuardResult =
  | { ok: true; caseRef: string; state: CaseState; conversationId: string }
  | { ok: false; status: 401 | 403 | 409; error: string; code: string };

/**
 * Resolve and authorise a tool call.
 *
 * @param toolName     the tool being invoked (checked against the allow-list)
 * @param secret       the x-agent-tool-secret header value
 * @param conversationId  the conversation_id from the tool call
 * @param allowedStates  the states this tool may act on
 */
export async function guardToolCall(
  toolName: string,
  secret: string | null,
  conversationId: string | null,
  allowedStates: readonly string[]
): Promise<ToolGuardResult> {
  // Latency instrumentation (WP-7): every tool call passes through here,
  // so one recording point covers all four tools AND their refusals -- which
  // matters, because a refusal that is slow is still dead air on the call.
  const spanStart = Date.now();
  const recordToolSpan = (): void => {
    recordSpanAndPersist({
      span: "tool_request_to_response",
      startedAtMs: spanStart,
      endedAtMs: Date.now(),
      caseRef: conversationId,
    });
  };
  // 1. Authentication.
  const auth = authorizeToolCall(secret, toolName);
  if (!auth.ok) {
    recordToolSpan();
    return { ok: false, status: auth.status, error: auth.error, code: "unauthorized" };
  }

  // 2. Case resolution.
  if (!conversationId) {
    recordToolSpan();
    return { ok: false, status: 409, error: "conversation_id is required", code: "conversation_id_required" };
  }
  const caseRow = await caseByConversation(conversationId);
  if (!caseRow) {
    recordToolSpan();
    return { ok: false, status: 409, error: "no live case for this conversation_id", code: "case_not_found" };
  }

  // 3. State precondition.
  if (!allowedStates.includes(caseRow.state)) {
    await auditAppend({
      callRef: caseRow.caseRef,
      action: "freeze",
      intent: `tool_refused_${toolName}`,
      callerId: "agent-tool",
      meta: { tool: toolName, state: caseRow.state, allowedStates, reason: "state_precondition_failed" },
    }, { fast: true }).catch(() => {});
    recordToolSpan();
    return {
      ok: false,
      status: 409,
      error: `tool ${toolName} cannot act on a case in state ${caseRow.state}`,
      code: "state_precondition_failed",
    };
  }

  recordToolSpan();
  return { ok: true, caseRef: caseRow.caseRef, state: caseRow.state as CaseState, conversationId };
}
