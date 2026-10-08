/**
 * Multi-agent intent router.
 *
 * Classifies the customer's utterance into one of the specialist roles the
 * voice agent can hand off to. This is intentionally lightweight: a small
 * keyword/pattern classifier rather than a second LLM call on every turn.
 */

export type AgentRole = "fraud_specialist" | "compliance_officer" | "empathy_agent" | "clarify";

const FRAUD_PATTERNS = /\b(no|not me|deny|denied|fraud|wasn't me|cancel|block|stolen|unauthorized|didn't|did not)\b/i;
const COMPLIANCE_PATTERNS = /\b(complaint|ombudsman|fca|regulation|legal|rights|evidence|disclosure|record)\b/i;
const EMPATHY_PATTERNS = /\b(scared|worried|anxious|help|please|upset|angry|confused|ill|bereavement|hospital)\b/i;

export async function routeAgentIntent(text: string): Promise<AgentRole> {
  if (FRAUD_PATTERNS.test(text)) return "fraud_specialist";
  if (COMPLIANCE_PATTERNS.test(text)) return "compliance_officer";
  if (EMPATHY_PATTERNS.test(text)) return "empathy_agent";
  return "clarify";
}

export function getSpecialistPrompt(role: AgentRole, context: Record<string, unknown>): string {
  switch (role) {
    case "fraud_specialist":
      return "You are a fraud specialist. Verify whether the customer recognizes the transaction. If they deny it, mark fraud_confirmed. Never request PIN or OTP.";
    case "compliance_officer":
      return "You are a compliance officer. Explain the customer's rights and the next steps. Do not give legal advice.";
    case "empathy_agent":
      return "You are an empathy agent. De-escalate, reassure, and collect only the information needed for a human specialist.";
    default:
      return "You are a helpful assistant. Clarify the customer's answer before proceeding.";
  }
}
