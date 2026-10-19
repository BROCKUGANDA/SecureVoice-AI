/**
 * The one place that answers: will telemetry actually leave this process, and to
 * where?
 *
 * Zero imports on purpose. `otel.ts` needs this before it constructs the SDK, and
 * `report.ts` needs it to fill a field of the published SLO artifact. If those two
 * asked different questions — or asked the same question of different variables —
 * the artifact would report a capability the runtime did not have, which is what
 * it did before this file existed: the artifact read `OTEL_EXPORTER_OTLP_ENDPOINT`
 * while the exporters were built from `OTEL_BETTERSTACK_ENDPOINT` and a token under
 * a different name entirely. Setting one shipped traces while the artifact said
 * `exporterConfigured: false`; setting the other shipped nothing and said `true`.
 *
 * The names are now the ones the OpenTelemetry specification defines, for two
 * reasons. One is that the destination is Grafana Cloud, whose own connection tile
 * hands you exactly `OTEL_EXPORTER_OTLP_ENDPOINT` plus `OTEL_EXPORTER_OTLP_HEADERS`
 * — a config surface with a different vocabulary is a config surface that gets set
 * wrongly. The other is that the lie above could only happen because the artifact
 * and the exporter read two different variables; reading the standard one removes
 * the second variable, and with it the class of bug.
 */

/** The three signals the SDK exports, and the path segment each one uses. */
export type OtlpSignal = "traces" | "metrics" | "logs";

const SIGNAL_VARS: Record<OtlpSignal, string> = {
  traces: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  metrics: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  logs: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
};

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Normalise a base URL: default to https, strip trailing slashes so the signal
 * path can be appended without producing `//v1/traces`.
 */
function normalizeBaseUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * The configured OTLP base endpoint, or undefined when there is none.
 *
 * There is deliberately **no default host.** A default ingestion host inside the
 * source means a deployment that configured nothing still ships telemetry to
 * whoever owned that hostname — which for a product whose whole compliance
 * posture is data residency is a defect, not a convenience.
 */
export function otlpBaseEndpoint(): string | undefined {
  const raw = read("OTEL_EXPORTER_OTLP_ENDPOINT");
  return raw ? normalizeBaseUrl(raw) : undefined;
}

/**
 * `OTEL_EXPORTER_OTLP_HEADERS` is a comma-separated list of `key=value`. Split on
 * the FIRST `=` only: a Basic credential is base64 and can carry padding, and a
 * value truncated at a later `=` would authenticate as garbage that looks like a
 * configuration problem.
 */
export function otlpHeaders(): Record<string, string> {
  const raw = read("OTEL_EXPORTER_OTLP_HEADERS");
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/** Case-insensitive, because HTTP header names are. */
export function hasAuthorization(): boolean {
  return Object.keys(otlpHeaders()).some((k) => k.toLowerCase() === "authorization");
}

/**
 * Full URL one signal exports to: a signal-specific endpoint wins, otherwise the
 * base plus the path the spec defines. Undefined means the signal has nowhere to
 * go, and `otel.ts` must then not build an exporter for it.
 */
export function signalEndpoint(signal: OtlpSignal): string | undefined {
  const specific = read(SIGNAL_VARS[signal]);
  if (specific) return normalizeBaseUrl(specific);
  const base = otlpBaseEndpoint();
  return base ? `${base}/v1/${signal}` : undefined;
}

/** Where each signal is going. `false` means no destination, not "not tried". */
export type SignalMap = Record<OtlpSignal, boolean>;

export function shippingSignals(): SignalMap {
  return {
    traces: signalEndpoint("traces") !== undefined,
    metrics: signalEndpoint("metrics") !== undefined,
    logs: signalEndpoint("logs") !== undefined,
  };
}

export type RemoteTelemetryStatus =
  | { shipping: true; reason: null; signals: SignalMap }
  | {
      shipping: false;
      reason: "sdk_disabled" | "no_endpoint" | "no_authorization";
    };

/**
 * `otel.ts` returns this same verdict by returning `null` from `initOtel()`, so a
 * `shipping: false` here is not a warning — it is the absence of every exporter.
 *
 * Both halves are required. A credential with nowhere to send is inert, and an
 * endpoint with no credential is a batch of 401s against someone else's gateway;
 * neither is "configured".
 *
 * A destination on ANY signal counts, because the production posture is
 * deliberately per-signal: caller data may not leave the region, so only metrics
 * are given an endpoint, and `traces`/`logs` resolve to nowhere. A predicate that
 * demanded the base variable would report "nothing ships" for a deployment whose
 * metrics are in fact arriving — the same overclaim/underclaim split this module
 * was extracted to close.
 *
 * `signals` is part of the verdict rather than a convenience: "telemetry ships"
 * alongside a dashboard that only ever had counters in it is the artifact
 * overclaiming again, one level down.
 */
export function remoteTelemetryStatus(): RemoteTelemetryStatus {
  if (read("OTEL_SDK_DISABLED") === "true") return { shipping: false, reason: "sdk_disabled" };
  if (!otlpBaseEndpoint() && !anySignalEndpoint()) {
    return { shipping: false, reason: "no_endpoint" };
  }
  if (!hasAuthorization()) return { shipping: false, reason: "no_authorization" };
  return { shipping: true, reason: null, signals: shippingSignals() };
}

function anySignalEndpoint(): boolean {
  return (Object.keys(SIGNAL_VARS) as OtlpSignal[]).some((s) => read(SIGNAL_VARS[s]));
}
