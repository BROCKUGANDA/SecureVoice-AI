import "server-only";
/**
 * Generic signed-webhook adapter: POST JSON {event:"case.human_review", ...}.
 *
 * Signature scheme is the same as the bank outcome webhooks in src/lib/outbox.ts:
 *   SV-Signature: t={unix seconds},v1={hex HMAC-SHA256 over `${t}.${body}`}
 * computed over the EXACT bytes sent, keyed with the organization's own secret.
 * (Re-implemented here rather than imported: outbox.ts pulls in the database
 * client, and these adapters must stay pure and unit-testable.)
 */

import { createHmac } from "node:crypto";

import {
  failFromStatus,
  failFromThrown,
  gateOutboundUrl,
  readJson,
  resolveDeps,
  safeExternalId,
} from "./http";
import { isTestTicket } from "./text";
import type { Adapter, WebhookConfig } from "./types";

export const WEBHOOK_EVENT = "case.human_review";
export const WEBHOOK_SIGNATURE_HEADER = "SV-Signature";

export function signWebhookBody(body: string, timestampSec: number, secret: string): string {
  const v1 = createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
  return `t=${timestampSec},v1=${v1}`;
}

export const sendWebhook: Adapter<WebhookConfig> = async (cfg, ticket, deps) => {
  const secrets = [cfg.secret];
  const d = resolveDeps(deps);
  const gate = await gateOutboundUrl(cfg.url, d);
  if (!gate.ok) return gate.result;

  // Explicit allow-list, not `...ticket`: if a caller ever widens the object
  // (a phone number, a merchant) the extra field must not ride out to a
  // third-party endpoint. Data minimisation is enforced here, not trusted.
  const body = JSON.stringify({
    event: WEBHOOK_EVENT,
    ...(isTestTicket(ticket) ? { test: true } : {}),
    caseRef: ticket.caseRef,
    orgId: ticket.orgId,
    institutionType: ticket.institutionType,
    signalKind: ticket.signalKind,
    reason: ticket.reason,
    priority: ticket.priority,
    language: ticket.language,
    transactionRef: ticket.transactionRef,
    resolutionMethod: ticket.resolutionMethod,
    customerResponse: ticket.customerResponse,
    auditRef: ticket.auditRef,
    consoleUrl: ticket.consoleUrl,
  });
  const signature = signWebhookBody(body, Math.floor(d.now() / 1000), cfg.secret);

  try {
    const res = await d.fetch(gate.url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signature,
      },
      body,
      redirect: "manual",
      signal: d.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      const json = await readJson(res);
      const id = safeExternalId(json?.id ?? json?.ticket_id ?? json?.external_id);
      return id ? { ok: true, externalId: id } : { ok: true };
    }
    return failFromStatus("webhook", res.status, secrets);
  } catch (err) {
    return failFromThrown(err, secrets);
  }
};
