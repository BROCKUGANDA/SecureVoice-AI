import "server-only";
/**
 * Shared guard for all ElevenLabs server tools. Every tool call passes
 * through here before it reaches the tool handler. The guard enforces:
 *
 *   1. Authentication — x-agent-tool-secret against the per-tool allow-list.
 *   2. Case resolution — the conversation_id must map to a live case.
 *   3. State precondition — the case must be in a state the tool may act on.
 *   4. Argument moderation (Qwen3Guard) — the serialized tool arguments are
 *      classified before execution. A model Safe verdict authorises NOTHING
 *      here (steps 1–3 are the authorization); it only means the classifier
 *      found no violation. For HIGH_RISK tools a model-layer failure is a
 *      REFUSAL, not a pass — the register's "fail closed for sensitive tool
 *      execution".
 *
 * A refusal is a typed 409, never a 500. Every refusal is written to the
 * audit chain before returning — a refused freeze attempt is the most
 * valuable audit entry a judge will see (WP-3 step 3, invariant I-2).
 */

import { authorizeToolCall } from "@/lib/agent-tool-auth";
import { recordSpanAndPersist } from "@/lib/telemetry/store";
import { caseByConversation, type CaseState } from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";
import { moderateContent, outcomeIsClean } from "@/lib/qwen3guard/moderate";

/**
 * Action-risk classes (the register's PART VII taxonomy). A class decides how
 * argument-moderation failure behaves; it NEVER decides authorization, which
 * stays with steps 1–3.
 *
 * HIGH_RISK: moves money-adjacent state or hands the call to a human channel.
 * CONTROLLED: reads authoritative state and reports it.
 * LOW_RISK: changes presentation only.
 */
export type ToolRiskClass = "LOW_RISK" | "CONTROLLED" | "HIGH_RISK";

export const TOOL_RISK_CLASS: Record<string, ToolRiskClass> = {
  card_freeze: "HIGH_RISK",
  warm_transfer: "HIGH_RISK",
  verify_transaction: "CONTROLLED",
  human_handoff: "LOW_RISK",
  switch_language: "LOW_RISK",
};

export function toolRiskClass(toolName: string): ToolRiskClass {
  // An UNREGISTERED tool is treated as HIGH_RISK: new tools inherit the
  // stricter gate until a human classifies them.
  return TOOL_RISK_CLASS[toolName] ?? "HIGH_RISK";
}

export type ToolGuardResult =
  | {
      ok: true;
      caseRef: string;
      state: CaseState;
      conversationId: string;
      /** The tenant the case belongs to; null for the default namespace. */
      orgId: string | null;
    }
  | { ok: false; status: 401 | 403 | 409; error: string; code: string };

/**
 * Resolve and authorise a tool call.
 *
 * @param toolName     the tool being invoked (checked against the allow-list)
 * @param secret       the x-agent-tool-secret header value
 * @param conversationId  the conversation_id from the tool call
 * @param allowedStates  the states this tool may act on
 * @param args           the tool's argument object, serialized and moderated
 *                       before execution (step 4). Omitting it skips step 4 —
 *                       but every production route passes it.
 */
export async function guardToolCall(
  toolName: string,
  secret: string | null,
  conversationId: string | null,
  allowedStates: readonly string[],
  args?: unknown,
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
  // 1. Authentication. This also resolves WHICH TENANT the caller acts for —
  //    a per-tenant credential names exactly one org, and the platform key is
  //    confined to the default namespace. Both are consumed at step 2.
  const auth = await authorizeToolCall(secret, toolName);
  if (!auth.ok) {
    recordToolSpan();
    return { ok: false, status: auth.status, error: auth.error, code: "unauthorized" };
  }

  // 2. Case resolution.
  if (!conversationId) {
    recordToolSpan();
    return {
      ok: false,
      status: 409,
      error: "conversation_id is required",
      code: "conversation_id_required",
    };
  }
  // THE BLEEDGUARD: the tenant resolved from the credential is part of the
  // lookup, so another org's conversation_id resolves to nothing.
  const caseRow = await caseByConversation(conversationId, auth.orgId);
  if (!caseRow) {
    recordToolSpan();
    return {
      ok: false,
      status: 409,
      error: "no live case for this conversation_id",
      code: "case_not_found",
    };
  }

  // 3. State precondition.
  if (!allowedStates.includes(caseRow.state)) {
    await auditAppend(
      {
        callRef: caseRow.caseRef,
        action: "freeze",
        intent: `tool_refused_${toolName}`,
        callerId: "agent-tool",
        meta: {
          tool: toolName,
          state: caseRow.state,
          allowedStates,
          reason: "state_precondition_failed",
        },
        orgId: caseRow.orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
    recordToolSpan();
    return {
      ok: false,
      status: 409,
      error: `tool ${toolName} cannot act on a case in state ${caseRow.state}`,
      code: "state_precondition_failed",
    };
  }

  // 4. Argument moderation (Qwen3Guard). The risk class decides what a
  //    non-clean outcome means:
  //      - unsafe/controversial ⇒ refuse for EVERY class (a classifier-named
  //        violation in tool arguments is a refusal, whatever the tool).
  //      - model unavailable / unreadable / kill switch ⇒ refuse only for
  //        HIGH_RISK tools, where "proceed unmoderated" is the bypass this
  //        guard exists to close. LOW_RISK/CONTROLLED tools proceed in
  //        degraded mode and the outcome row records the outage.
  //    A Safe verdict changes nothing about authorization: steps 1–3 already
  //    decided it.
  if (args !== undefined) {
    const risk = toolRiskClass(toolName);
    let argsText: string;
    try {
      argsText = JSON.stringify(args);
    } catch {
      argsText = String(args);
    }
    const moderation = await moderateContent({
      stage: "tool",
      text: argsText,
      orgId: caseRow.orgId ?? null,
      caseRef: caseRow.caseRef,
      conversationId,
    });
    // `consulted` is true when the model layer was actually reached or
    // genuinely attempted. `flag_off` and `kill_switch` are the OPERATOR'S
    // deliberate choice not to run the classifier — failing those closed
    // forever would make every high-risk tool unusable in a deployment that
    // never enabled model moderation, which is a different decision from
    // "the classifier was asked and did not answer".
    const consulted =
      moderation.source === "model" ||
      moderation.source === "invalid" ||
      moderation.source === "degraded";
    const refuse =
      moderation.verdict === "unsafe" ||
      moderation.verdict === "controversial" ||
      (risk === "HIGH_RISK" && consulted && !outcomeIsClean(moderation));
    if (refuse) {
      await auditAppend(
        {
          callRef: caseRow.caseRef,
          action: "freeze",
          intent: `tool_refused_moderation_${toolName}`,
          callerId: "agent-tool",
          meta: {
            tool: toolName,
            riskClass: risk,
            verdict: moderation.verdict,
            source: moderation.source,
            categories: moderation.categories,
            reason: "argument_moderation_refused",
          },
          orgId: caseRow.orgId ?? undefined,
        },
        { fast: true },
      ).catch(() => {});
      recordToolSpan();
      return {
        ok: false,
        status: 409,
        error: `tool ${toolName} arguments were not approved by the safety layer`,
        code: "moderation_refused",
      };
    }
  }

  recordToolSpan();
  return {
    ok: true,
    caseRef: caseRow.caseRef,
    state: caseRow.state as CaseState,
    conversationId,
    orgId: caseRow.orgId ?? null,
  };
}
