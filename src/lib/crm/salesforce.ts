import "server-only";
/**
 * Salesforce adapter: OAuth2 client-credentials, then create a Case.
 *
 *   1. POST {instanceUrl}/services/oauth2/token   (form: client-credentials)
 *   2. POST {instanceUrl}/services/data/v60.0/sobjects/Case  (Bearer token)
 *
 * `instanceUrl` is operator-typed, so it must be https and pass the SSRF guard.
 * Only its ORIGIN is used: a path, query or fragment typed by the operator is
 * dropped, and the `instance_url` echoed back in the token response is ignored
 * (it is remote-controlled data, not configuration). Both requests share ONE
 * abort signal, so the whole attempt - not each request - is bounded by
 * `timeoutMs`.
 */

import {
  fail,
  failFromStatus,
  failFromThrown,
  gateOutboundUrl,
  readJson,
  resolveDeps,
  safeExternalId,
} from "./http";
import { buildTicketText } from "./text";
import type { Adapter, HandoffPriority, SalesforceConfig } from "./types";

export const SALESFORCE_PRIORITY: Record<HandoffPriority, string> = {
  urgent: "High",
  high: "High",
  normal: "Medium",
};

export const sendSalesforceCase: Adapter<SalesforceConfig> = async (cfg, ticket, deps) => {
  const secrets = [cfg.clientSecret];
  if (!cfg.clientId || !cfg.clientSecret) return fail("invalid_credentials", false);

  const d = resolveDeps(deps);
  const gate = await gateOutboundUrl(cfg.instanceUrl, d);
  if (!gate.ok) return gate.result;
  const origin = gate.url.origin;

  try {
    const tokenRes = await d.fetch(`${origin}/services/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
      redirect: "manual",
      signal: d.signal,
    });
    if (!(tokenRes.status >= 200 && tokenRes.status < 300)) {
      return failFromStatus("salesforce_auth", tokenRes.status, secrets);
    }
    const tokenJson = await readJson(tokenRes);
    const accessToken = tokenJson?.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      return fail("salesforce_auth_no_token", false, secrets);
    }
    secrets.push(accessToken);

    const { subject, body } = buildTicketText(ticket);
    const res = await d.fetch(`${origin}/services/data/v60.0/sobjects/Case`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        Subject: subject,
        Description: body,
        Priority: SALESFORCE_PRIORITY[ticket.priority],
        Origin: "SecureVoice",
      }),
      redirect: "manual",
      signal: d.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      const json = await readJson(res);
      const id = safeExternalId(json?.id);
      return id ? { ok: true, externalId: id } : { ok: true };
    }
    return failFromStatus("salesforce", res.status, secrets);
  } catch (err) {
    return failFromThrown(err, secrets);
  }
};
