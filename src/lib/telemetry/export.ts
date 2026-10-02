import "server-only";
/**
 * WP-7 — OPTIONAL OTLP trace export.
 *
 * The brief asks for an OTLP-compatible shape without adding a dependency and
 * without requiring a collector. That is exactly what this is:
 *
 *   - the SHAPE lives in `./spans.ts` (`toOtlpSpans`) and is pure, so it costs
 *     nothing to produce and can be served straight to an operator over HTTP;
 *   - the TRANSPORT here is off by default and OFF THE REQUEST PATH. Nothing in
 *     the intervention flow awaits it. `exportOtlp` returns a verdict instead of
 *     throwing, so a missing collector, a DNS failure, a 500 from a proxy or a
 *     three-second timeout are all a `delivered: false` line in diagnostics.
 *
 * Configuration (all optional):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  base URL of the collector, e.g. http://otel:4318
 *   OTEL_EXPORTER_OTLP_HEADERS  `key=value,key2=value2` auth headers
 *   OTEL_EXPORTER_OTLP_TIMEOUT_MS  per-request timeout (default 3000)
 */

import { toOtlpSpans, type OtlpTracePayload, type SpanRecord } from "./spans";

export type OtlpExportVerdict =
  | { attempted: false; reason: "not_configured"; endpoint: null; records: number }
  | { attempted: false; reason: "no_records"; endpoint: string; records: 0 }
  | {
      attempted: true;
      delivered: boolean;
      endpoint: string;
      records: number;
      status: number | null;
      error?: string;
    };

export const OTLP_TRACES_PATH = "/v1/traces";

export function otlpEndpoint(): string | null {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

export function exporterConfigured(): boolean {
  return otlpEndpoint() !== null;
}

/** `k=v,k2=v2` → headers. Malformed pairs are skipped, not guessed at. */
export function otlpHeaders(raw = process.env.OTEL_EXPORTER_OTLP_HEADERS): Record<string, string> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key.length > 0) out[key] = value;
  }
  return out;
}

function timeoutMs(): number {
  const raw = Number(process.env.OTEL_EXPORTER_OTLP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30_000) : 3_000;
}

/** The payload, for an HTTP GET on `/api/status/spans?format=otlp`. */
export function buildOtlpExport(records: readonly SpanRecord[]): OtlpTracePayload {
  return toOtlpSpans(records);
}

/**
 * POST the OTLP/JSON payload to the collector. NEVER THROWS, NEVER BLOCKS a
 * request path (nothing in the app awaits this), and reports honestly when it
 * did not deliver.
 */
export async function exportOtlp(
  records: readonly SpanRecord[],
  opts: { endpoint?: string | null; fetchImpl?: typeof fetch; timeout?: number } = {},
): Promise<OtlpExportVerdict> {
  const endpoint = opts.endpoint === undefined ? otlpEndpoint() : opts.endpoint;
  if (!endpoint) return { attempted: false, reason: "not_configured", endpoint: null, records: records.length };
  if (records.length === 0) return { attempted: false, reason: "no_records", endpoint, records: 0 };

  const url = endpoint.endsWith(OTLP_TRACES_PATH) ? endpoint : `${endpoint}${OTLP_TRACES_PATH}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const budget = opts.timeout ?? timeoutMs();

  try {
    const body = JSON.stringify(buildOtlpExport(records));
    const controller = new AbortController();
    // A collector that never answers must not become a resource leak; the
    // timer is cleared in `finally` so a fast response does not pin it.
    const timer = setTimeout(() => controller.abort(), budget);
    timer.unref?.();
    let status: number | null = null;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...otlpHeaders() },
        body,
        signal: controller.signal,
      });
      status = res.status;
      const delivered = status >= 200 && status < 300;
      return delivered
        ? { attempted: true, delivered: true, endpoint: url, records: records.length, status }
        : { attempted: true, delivered: false, endpoint: url, records: records.length, status, error: `collector_http_${status}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    return { attempted: true, delivered: false, endpoint: url, records: records.length, status: null, error: message };
  }
}
