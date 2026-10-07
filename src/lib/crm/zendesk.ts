import "server-only";
/**
 * Zendesk adapter: POST https://{subdomain}.zendesk.com/api/v2/tickets.json.
 *
 * The subdomain is operator-typed and is spliced into a HOSTNAME, so it is
 * validated against a strict label pattern BEFORE the host is built - without
 * that, `evil.com/` or `a.b` would redirect the request (and the Basic-auth
 * credential) to a host we do not control. The host suffix is fixed, so no
 * operator input can make this call leave zendesk.com.
 */

import {
  fail,
  failFromStatus,
  failFromThrown,
  readJson,
  resolveDeps,
  safeExternalId,
} from "./http";
import { buildTicketText } from "./text";
import type { Adapter, ZendeskConfig } from "./types";

export const ZENDESK_SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const sendZendeskTicket: Adapter<ZendeskConfig> = async (cfg, ticket, deps) => {
  const secrets = [cfg.apiToken];
  if (typeof cfg.subdomain !== "string" || !ZENDESK_SUBDOMAIN_RE.test(cfg.subdomain)) {
    return fail("invalid_subdomain", false);
  }
  if (!cfg.email || !cfg.apiToken) return fail("invalid_credentials", false);

  const d = resolveDeps(deps);
  const { subject, body } = buildTicketText(ticket);
  const authorization = `Basic ${Buffer.from(`${cfg.email}/token:${cfg.apiToken}`).toString("base64")}`;
  secrets.push(authorization);

  const payload: Record<string, unknown> = {
    subject,
    comment: { body },
    priority: ticket.priority,
    tags: ["securevoice", ticket.reason, ticket.institutionType],
    external_id: ticket.caseRef,
  };
  if (typeof cfg.groupId === "number" && Number.isFinite(cfg.groupId)) {
    payload.group_id = cfg.groupId;
  }

  try {
    const res = await d.fetch(`https://${cfg.subdomain}.zendesk.com/api/v2/tickets.json`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization,
      },
      body: JSON.stringify({ ticket: payload }),
      redirect: "manual",
      signal: d.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      const json = await readJson(res);
      const t = json?.ticket;
      const id =
        t !== null && typeof t === "object"
          ? safeExternalId((t as { id?: unknown }).id)
          : undefined;
      return id ? { ok: true, externalId: id } : { ok: true };
    }
    return failFromStatus("zendesk", res.status, secrets);
  } catch (err) {
    return failFromThrown(err, secrets);
  }
};
