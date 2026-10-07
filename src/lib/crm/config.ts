import "server-only";
/**
 * CRM connection config: validation and masked display. No database here, so it
 * is unit-testable and shared by the store and any settings route.
 *
 * `normalizeConfig` is the SHAPE check (sync, no network): it rebuilds the
 * object from known keys only, so an unknown field typed into a form is never
 * persisted. `validateConfig` adds the SSRF check (DNS) for every URL the
 * operator typed. The adapters re-run the SSRF check at send time anyway -
 * DNS answers change - so this is early feedback, not the only gate.
 */

import { maskKey } from "@/lib/byok";
import { validateOutboundUrl, type DnsResolver } from "@/lib/validation/ssrf";
import { ZENDESK_SUBDOMAIN_RE } from "./zendesk";
import {
  isCrmProvider,
  type CrmConfig,
  type CrmConfigMap,
  type CrmProvider,
  type SalesforceConfig,
  type WebhookConfig,
  type ZendeskConfig,
} from "./types";

export const MIN_WEBHOOK_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 512;

export type ConfigResult<C> = { ok: true; config: C } | { ok: false; error: string };

function str(raw: Record<string, unknown>, key: string, max = MAX_SECRET_LENGTH): string | null {
  const v = raw[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

function normalizeZendesk(raw: Record<string, unknown>): ConfigResult<ZendeskConfig> {
  const subdomain = str(raw, "subdomain", 63)?.toLowerCase() ?? null;
  if (!subdomain || !ZENDESK_SUBDOMAIN_RE.test(subdomain)) {
    return { ok: false, error: "zendesk: subdomain must be letters, digits and hyphens only" };
  }
  const email = str(raw, "email", 254);
  if (!email || !/^[^\s@:]{1,64}@[^\s@:]{1,190}$/.test(email)) {
    return { ok: false, error: "zendesk: a valid email is required" };
  }
  const apiToken = str(raw, "apiToken");
  if (!apiToken) return { ok: false, error: "zendesk: apiToken is required" };

  const config: ZendeskConfig = { subdomain, email, apiToken };
  const g = raw.groupId;
  if (g !== undefined && g !== null && g !== "") {
    const n =
      typeof g === "number" ? g : typeof g === "string" && /^\d{1,15}$/.test(g) ? Number(g) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) {
      return { ok: false, error: "zendesk: groupId must be a positive integer" };
    }
    config.groupId = n;
  }
  return { ok: true, config };
}

function normalizeSalesforce(raw: Record<string, unknown>): ConfigResult<SalesforceConfig> {
  const rawUrl = str(raw, "instanceUrl", 2048);
  let url: URL | null = null;
  try {
    url = rawUrl ? new URL(rawUrl) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || url.username || url.password) {
    return { ok: false, error: "salesforce: instanceUrl must be an https URL" };
  }
  const clientId = str(raw, "clientId");
  const clientSecret = str(raw, "clientSecret");
  if (!clientId || !clientSecret) {
    return { ok: false, error: "salesforce: clientId and clientSecret are required" };
  }
  // Only the origin is ever used; store exactly that.
  return { ok: true, config: { instanceUrl: url.origin, clientId, clientSecret } };
}

function normalizeWebhook(raw: Record<string, unknown>): ConfigResult<WebhookConfig> {
  const rawUrl = str(raw, "url", 2048);
  let url: URL | null = null;
  try {
    url = rawUrl ? new URL(rawUrl) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || url.username || url.password) {
    return { ok: false, error: "webhook: url must be an https URL" };
  }
  const secret = str(raw, "secret");
  if (!secret || secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    return {
      ok: false,
      error: `webhook: secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`,
    };
  }
  return { ok: true, config: { url: url.toString(), secret } };
}

/** Shape check, no network. Unknown keys are dropped. */
export function normalizeConfig<P extends CrmProvider>(
  provider: P,
  raw: unknown,
): ConfigResult<CrmConfigMap[P]>;
export function normalizeConfig(provider: CrmProvider, raw: unknown): ConfigResult<CrmConfig> {
  if (!isCrmProvider(provider)) return { ok: false, error: "unknown provider" };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  switch (provider) {
    case "zendesk":
      return normalizeZendesk(obj);
    case "salesforce":
      return normalizeSalesforce(obj);
    case "webhook":
      return normalizeWebhook(obj);
  }
}

/** Shape check plus the SSRF gate on every operator-typed URL. */
export async function validateConfig<P extends CrmProvider>(
  provider: P,
  raw: unknown,
  opts: { resolver?: DnsResolver } = {},
): Promise<ConfigResult<CrmConfigMap[P]>> {
  const shaped = normalizeConfig(provider, raw);
  if (!shaped.ok) return shaped;
  const cfg = shaped.config as CrmConfig;
  const target =
    provider === "salesforce"
      ? (cfg as SalesforceConfig).instanceUrl
      : provider === "webhook"
        ? (cfg as WebhookConfig).url
        : null;
  if (target) {
    let verdict;
    try {
      verdict = await validateOutboundUrl(target, opts.resolver ? { resolver: opts.resolver } : {});
    } catch {
      return { ok: false, error: `${provider}: url could not be validated` };
    }
    if (!verdict.ok) {
      return { ok: false, error: `${provider}: url rejected (${verdict.code})` };
    }
  }
  return shaped;
}

// ── Masked display ──────────────────────────────────────────────────────────

/**
 * `maskKey` shows the first 5 and last 4 characters, which for a short secret is
 * most of it. Below 20 characters nothing is revealed at all.
 */
export function maskSecret(secret: string): string {
  return secret.length >= 20 ? maskKey(secret) : "••••••••";
}

/** What the console may show about a stored config. Never a usable secret. */
export function maskConfig(provider: CrmProvider, config: CrmConfig): Record<string, string> {
  switch (provider) {
    case "zendesk": {
      const c = config as ZendeskConfig;
      return {
        subdomain: c.subdomain,
        email: c.email,
        apiToken: maskSecret(c.apiToken),
        ...(c.groupId !== undefined ? { groupId: String(c.groupId) } : {}),
      };
    }
    case "salesforce": {
      const c = config as SalesforceConfig;
      return {
        host: safeHost(c.instanceUrl),
        clientId: maskSecret(c.clientId),
        clientSecret: maskSecret(c.clientSecret),
      };
    }
    case "webhook": {
      const c = config as WebhookConfig;
      return { host: safeHost(c.url), secret: maskSecret(c.secret) };
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}
