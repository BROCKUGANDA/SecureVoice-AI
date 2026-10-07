import "server-only";
/**
 * Shared plumbing for the CRM adapters: deps defaults, the outbound-URL gate,
 * status classification and leak-safe error construction.
 *
 * Error discipline: an AdapterResult error is a short, fixed-vocabulary string
 * (`zendesk_http_401`, `timeout`, `network_error`). It never embeds a response
 * body, a request header, or any configured secret - and `fail()` additionally
 * scrubs every secret it is told about, so a future edit that interpolates one
 * by accident still cannot leak it.
 */

import { env } from "@/lib/config";
import { leakSafeText } from "@/lib/failures/envelope";
import { validateOutboundUrl } from "@/lib/validation/ssrf";
import type { AdapterDeps, AdapterResult } from "./types";

export const DEFAULT_TIMEOUT_MS = env.crmHttpTimeoutMs;

export type ResolvedDeps = {
  fetch: typeof fetch;
  now: () => number;
  timeoutMs: number;
  /** One signal for the whole attempt, so a multi-request adapter stays bounded. */
  signal: AbortSignal;
  resolver: AdapterDeps["resolver"];
};

export function resolveDeps(deps: AdapterDeps | undefined): ResolvedDeps {
  const timeoutMs =
    typeof deps?.timeoutMs === "number" && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  return {
    fetch: deps?.fetch ?? globalThis.fetch,
    now: deps?.now ?? Date.now,
    timeoutMs,
    signal: AbortSignal.timeout(timeoutMs),
    resolver: deps?.resolver,
  };
}

/** Build a failure. Every secret in `secrets` is scrubbed from the message. */
export function fail(
  error: string,
  retryable: boolean,
  secrets: readonly string[] = [],
): AdapterResult {
  let text = error;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join("[redacted]");
  }
  return { ok: false, error: leakSafeText(text, 160) || "error", retryable };
}

/** 5xx / 429 / 408 are worth one more try; every other non-2xx is final. */
export function failFromStatus(
  prefix: string,
  status: number,
  secrets: readonly string[] = [],
): AdapterResult {
  const retryable = status === 429 || status === 408 || status >= 500;
  return fail(`${prefix}_http_${status}`, retryable, secrets);
}

/** A thrown fetch error: timeout, abort or network. Always retryable. */
export function failFromThrown(err: unknown, secrets: readonly string[] = []): AdapterResult {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return fail("timeout", true, secrets);
  const code = (err as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code;
  const own = (err as { code?: unknown } | null)?.code;
  const pick = typeof code === "string" ? code : typeof own === "string" ? own : "";
  return fail(
    /^[A-Z0-9_]{3,40}$/.test(pick) ? `network_error_${pick}` : "network_error",
    true,
    secrets,
  );
}

/**
 * Run the SSRF guard on an operator-typed URL. Returns the validated URL, or a
 * non-retryable failure (a blocked target does not become allowed on retry).
 */
export async function gateOutboundUrl(
  raw: string,
  deps: Pick<ResolvedDeps, "resolver">,
): Promise<{ ok: true; url: URL } | { ok: false; result: AdapterResult }> {
  let verdict;
  try {
    verdict = await validateOutboundUrl(raw, deps.resolver ? { resolver: deps.resolver } : {});
  } catch {
    return { ok: false, result: fail("blocked_url", false) };
  }
  if (!verdict.ok) return { ok: false, result: fail(`blocked_url_${verdict.code}`, false) };
  return { ok: true, url: verdict.url };
}

/** Parse a bounded JSON body, or null. Never throws. */
export async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await res.text();
    if (text.length === 0 || text.length > 256_000) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Only keep an id from a remote response if it is plainly an identifier. */
export function safeExternalId(value: unknown): string | undefined {
  const s = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  return typeof s === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(s) ? s : undefined;
}
