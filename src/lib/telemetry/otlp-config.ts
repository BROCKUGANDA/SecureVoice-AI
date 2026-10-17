/**
 * The one place that answers: will telemetry actually leave this process?
 *
 * Zero imports on purpose. `otel.ts` needs this before it constructs the SDK, and
 * `report.ts` needs it to fill a field of the published SLO artifact. If those two
 * asked different questions — or asked the same question of different variables —
 * the artifact would report a capability the runtime did not have, which is what
 * it did before this file existed: the artifact read `OTEL_EXPORTER_OTLP_ENDPOINT`
 * while the exporters were built from `OTEL_BETTERSTACK_ENDPOINT` and a token under
 * a different name entirely. Setting `OTEL_BETTERSTACK_TOKEN` shipped traces and
 * the artifact still said `exporterConfigured: false`; setting the other variable
 * shipped nothing and the artifact said `true`.
 *
 * So this module holds the predicate, `initOtel()` consults it before deciding to
 * return null, and the artifact publishes exactly what it returns. One question,
 * one place it is asked.
 */

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** The bearer token the OTLP exporters authenticate with. No default — required. */
export function ingestionToken(): string | undefined {
  return read("OTEL_BETTERSTACK_TOKEN") ?? read("OTEL_SOURCE_TOKEN");
}

export type RemoteTelemetryStatus =
  | { shipping: true; reason: null }
  | { shipping: false; reason: "sdk_disabled" | "no_ingestion_token" };

/**
 * `otel.ts` returns this same verdict by returning `null` from `initOtel()`, so a
 * `shipping: false` here is not a warning — it is the absence of every exporter.
 */
export function remoteTelemetryStatus(): RemoteTelemetryStatus {
  if (read("OTEL_SDK_DISABLED") === "true") return { shipping: false, reason: "sdk_disabled" };
  if (!ingestionToken()) return { shipping: false, reason: "no_ingestion_token" };
  return { shipping: true, reason: null };
}
