/**
 * Agent capability manifest — the single source of truth for what the voice
 * agent KNOWS and can DO, surfaced on the operator dashboard.
 *
 * This deliberately mirrors the configuration the agent actually runs with, so
 * the dashboard cannot advertise a capability the plane does not have:
 *
 *   · the two knowledge-base documents attached to the agent
 *     (agent/securevoice.agent.yaml, applied by scripts/agent-apply.ts);
 *   · the RAG settings and the source-attribution flag;
 *   · the five guarded tools exposed over the MCP front door
 *     (src/app/api/elevenlabs/mcp/route.ts), each mapped to the backend it
 *     reaches and the trust context that bounds it.
 *
 * NO SECRETS. Tool paths, backend names and trust levels are integration
 * configuration — exactly like /api/operator/webhooks names its env vars
 * without their values. Key material lives in BYOK storage (src/lib/byok.ts)
 * and the tool secret stays server-side (AGENT_TOOL_SECRET); neither is
 * reachable from here. Do not add either.
 */

export type TrustLevel = "untrusted-safe" | "privileged";
export type ToolKind = "server" | "client" | "system";

export type OperatorTool = {
  /** The MCP tool name — doubles as the guarded route under /api/elevenlabs/tools/. */
  name: string;
  label: string;
  kind: ToolKind;
  /** The backend this tool reaches. */
  backend: string;
  description: string;
  /** Whether the MCP front door exposes it (it exposes all five). */
  mcp: boolean;
  /** Per-node / per-state scoping that further restricts the tool. */
  scoping: string;
  /**
   * Trust context. A `privileged` tool is refused for a caller in an untrusted
   * context until the guard's state preconditions pass — this is what keeps an
   * agent serving an untrusted caller from staging an action it is not
   * authorised to, even if some layer tries to widen the scope.
   */
  trust: TrustLevel;
  trust_note: string;
};

export type KnowledgeDoc = {
  id: string;
  title: string;
  lang: string;
  version: string;
  doc_type: string;
  scope: string;
};

export type Backend = {
  id: string;
  label: string;
  transport: string;
  reached_by: string[];
  note: string;
};

export const KNOWLEDGE_BASE: KnowledgeDoc[] = [
  {
    id: "SV-FDP-2026-01",
    title: "Fraud Disposition Policy",
    lang: "en",
    version: "v3.2",
    doc_type: "policy",
    scope: "Fraud-intervention wording, the verification protocol, and freeze-disposition rules.",
  },
  {
    id: "SV-FDP-2026-01",
    title: "سياسة معالجة الاحتيال",
    lang: "ar",
    version: "v3.2",
    doc_type: "policy",
    scope: "Arabic counterpart of the fraud-disposition policy (Arabic copy corruption-checked).",
  },
];

export const RAG_CONFIG = {
  enabled: true,
  max_vector_distance: 0.6,
  include_source_urls: true,
  source_attribution: true,
  note: "The agent cites the document it grounded each answer in, so an operator can audit which policy a turn relied on.",
};

export const TOOLS: OperatorTool[] = [
  {
    name: "verify_transaction",
    label: "Verify transaction",
    kind: "server",
    backend: "core-banking sandbox",
    description:
      "Record the customer's verification outcome for the disputed transaction (confirmed fraud / legitimate / uncertain).",
    mcp: true,
    scoping: "Any active fraud case.",
    trust: "untrusted-safe",
    trust_note: "Reads transaction context and records an outcome; changes nothing on the account.",
  },
  {
    name: "card_freeze",
    label: "Card freeze (staged)",
    kind: "server",
    backend: "core-banking sandbox",
    description:
      "Stage a REVERSIBLE card freeze to protect the account — always staged for human finalisation, never an irreversible action.",
    mcp: true,
    scoping:
      "Fraud-specialist state only, and listed in the executing node's scope AND the workflow's tools.",
    trust: "privileged",
    trust_note:
      "Refused for an untrusted caller until the guard's state precondition (fraud confirmed) passes; the refusal and the action are both written to the audit chain.",
  },
  {
    name: "human_handoff",
    label: "Human handoff",
    kind: "server",
    backend: "case-management mock",
    description:
      "Queue a human fraud specialist with a summary; the customer is told one will follow up.",
    mcp: true,
    scoping: "Any active fraud or empathy case.",
    trust: "untrusted-safe",
    trust_note: "Queues work for a human; grants the caller nothing.",
  },
  {
    name: "warm_transfer",
    label: "Warm transfer",
    kind: "server",
    backend: "telephony bridge",
    description:
      "Bridge the live call to a human specialist's phone; degrades to the specialist queue if no number or call is live.",
    mcp: true,
    scoping: "Live call only.",
    trust: "untrusted-safe",
    trust_note: "Connects a human; degrades rather than escalating privileges.",
  },
  {
    name: "switch_language",
    label: "Switch language",
    kind: "client",
    backend: "conversation state",
    description: "Switch the conversation language mid-call (en | ar | hi | ur | fr | sw).",
    mcp: true,
    scoping: "Any active conversation.",
    trust: "untrusted-safe",
    trust_note: "Changes only the language plane of the call.",
  },
];

export const BACKENDS: Backend[] = [
  {
    id: "core-banking-sandbox",
    label: "Core-banking sandbox",
    transport: "MCP + guarded webhook",
    reached_by: ["verify_transaction", "card_freeze"],
    note: "Transaction context and staged, reversible card freeze — never an irreversible account action.",
  },
  {
    id: "claims-rules-engine",
    label: "Claims rules engine",
    transport: "MCP + guarded webhook",
    reached_by: ["payout-hold"],
    note: "Insurance-vertical scenario (POST /api/v1/claims/:id/payout-hold); a separate scenario class from the five fraud tools.",
  },
  {
    id: "case-management-mock",
    label: "Case-management mock",
    transport: "guarded webhook",
    reached_by: ["human_handoff"],
    note: "Specialist queue and case logging for human follow-up.",
  },
];

export const MCP_SERVER = {
  endpoint: "/api/elevenlabs/mcp",
  protocol: "JSON-RPC 2.0 (Model Context Protocol)",
  note: "A thin front door: every tools/call is forwarded to the same guarded route an agent webhook hits, carrying the caller's own tool credential, so the identical auth, tenant scope and state preconditions apply to the caller's own identity — the platform credential is never substituted, a call without a credential is refused, and the forwarding origin is fixed.",
};

export function agentManifest() {
  return {
    ok: true,
    knowledge_base: KNOWLEDGE_BASE,
    rag: RAG_CONFIG,
    tools: TOOLS,
    backends: BACKENDS,
    mcp: MCP_SERVER,
    counts: {
      tools: TOOLS.length,
      documents: KNOWLEDGE_BASE.length,
      privileged_tools: TOOLS.filter((t) => t.trust === "privileged").length,
    },
  };
}
