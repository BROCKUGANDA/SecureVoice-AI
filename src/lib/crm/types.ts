/**
 * CRM handoff - shared types.
 *
 * When a case needs a human (the customer said NO, a fraud case is pending
 * review, the customer is unreachable), SecureVoice opens a ticket in the
 * institution's OWN CRM. This file is the contract between the case pipeline
 * and the per-provider adapters.
 *
 * DATA MINIMISATION IS A HARD RULE. `HandoffTicket` deliberately has no field
 * for the customer's phone number, the merchant, the amount, card digits or any
 * transcript. A ticket system is a wide-audience tool with its own retention
 * and export rules; the institution's staff look the case up by
 * `transactionRef` / `auditRef` inside the institution's own systems.
 */

export const CRM_PROVIDERS = ["zendesk", "salesforce", "webhook"] as const;
export type CrmProvider = (typeof CRM_PROVIDERS)[number];

export function isCrmProvider(value: unknown): value is CrmProvider {
  return typeof value === "string" && (CRM_PROVIDERS as readonly string[]).includes(value);
}

// ── Per-provider config (stored encrypted at rest) ──────────────────────────

export type ZendeskConfig = {
  /** The `{subdomain}` of `{subdomain}.zendesk.com`. Letters, digits, hyphen. */
  subdomain: string;
  /** The agent / API user's email (the `email/token` Basic-auth pair). */
  email: string;
  apiToken: string;
  /** Optional group the ticket is assigned to (numeric Zendesk group id). */
  groupId?: number;
};

export type SalesforceConfig = {
  /** https `My Domain` URL, e.g. https://acme.my.salesforce.com */
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
};

export type WebhookConfig = {
  /** https endpoint that receives the signed `case.human_review` event. */
  url: string;
  /** HMAC-SHA256 signing secret the receiver verifies `SV-Signature` with. */
  secret: string;
};

export type CrmConfigMap = {
  zendesk: ZendeskConfig;
  salesforce: SalesforceConfig;
  webhook: WebhookConfig;
};

export type CrmConfig = CrmConfigMap[CrmProvider];

// ── The ticket ──────────────────────────────────────────────────────────────

export const HANDOFF_REASONS = [
  "sms_reply_no",
  "voice_fraud_denied",
  "unreachable_no_reply",
  "voice_failed_sms_unavailable",
  "human_review",
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export type HandoffPriority = "urgent" | "high" | "normal";

export type HandoffTicket = {
  /** SecureVoice case reference. Opaque; used as the CRM's external id. */
  caseRef: string;
  orgId: string;
  institutionType: "bank" | "insurer";
  signalKind: string | null;
  reason: HandoffReason;
  priority: HandoffPriority;
  /** BCP 47 language the customer was contacted in (e.g. "en", "ar"). */
  language: string;
  /** The institution's own transaction reference - how staff find the case. */
  transactionRef: string | null;
  resolutionMethod: string | null;
  customerResponse: "yes" | "no" | null;
  /** Reference into the redacted, hash-chained audit trail. */
  auditRef: string;
  /** Deep link into the SecureVoice console for this case, if available. */
  consoleUrl: string | null;
};

// ── Adapter plumbing ────────────────────────────────────────────────────────

export type AdapterResult =
  { ok: true; externalId?: string } | { ok: false; error: string; retryable: boolean };

export type AdapterDeps = {
  fetch?: typeof fetch;
  /** Wall clock in ms. Injected so signatures are deterministic in tests. */
  now?: () => number;
  /** Total time budget for one adapter attempt. Default 3000. */
  timeoutMs?: number;
  /**
   * DNS resolver passed through to the SSRF guard. Production leaves this
   * unset (dns.lookup); tests inject one so no network is touched.
   */
  resolver?: import("@/lib/validation/ssrf").DnsResolver;
};

export type Adapter<C> = (
  cfg: C,
  ticket: HandoffTicket,
  deps?: AdapterDeps,
) => Promise<AdapterResult>;
