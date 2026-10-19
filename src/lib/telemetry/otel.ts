/**
 * OpenTelemetry OTLP/HTTP exporter wiring for Grafana Cloud.
 *
 * Three signals, three independent exporters, one ingestion gateway:
 *
 *   traces  → <endpoint>/v1/traces
 *   metrics → <endpoint>/v1/metrics
 *   logs    → <endpoint>/v1/logs
 *
 * The endpoint and the credential arrive as the two standard OpenTelemetry
 * variables, which is also exactly what a Grafana Cloud stack's OpenTelemetry
 * tile hands you:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT  e.g. https://otlp-gateway-prod-ca-east-0.grafana.net/otlp
 *   OTEL_EXPORTER_OTLP_HEADERS   e.g. Authorization=Basic <access-policy token>
 *
 * Grafana Cloud authenticates with **Basic**, not Bearer, and the token from the
 * tile is already the base64 credential — so the header is carried verbatim and
 * never re-encoded here. Re-encoding a value that is already correct is how a
 * working token becomes a 401 that looks like a broken one.
 *
 * Nothing ships unless both are set: see `remoteTelemetryStatus()`. A deployment
 * without them keeps telemetry local and says so in the boot log, matching the
 * project's "degrade loudly, never silently" convention.
 *
 * Env knobs (see .env.example):
 *   OTEL_EXPORTER_OTLP_ENDPOINT      base URL, no default — required to export
 *   OTEL_EXPORTER_OTLP_HEADERS       auth + routing headers, no default
 *   OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT   per-signal override
 *   OTEL_EXPORTER_OTLP_TIMEOUT       per-request timeout, ms (default 10000)
 *   OTEL_SERVICE_NAME          service.name      (default securevoice-api)
 *   OTEL_TRACES_SAMPLE_RATE    0..1              (default 1)
 *   OTEL_EXPORT_INTERVAL_MS    metrics flush     (default 60000)
 *   OTEL_SDK_DISABLED          "true" disables everything
 */
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { logError, logWarn } from "@/lib/validation/safe-log";
import { TELEMETRY_SERVICE_NAME } from "./spans";
import { otlpHeaders, remoteTelemetryStatus, signalEndpoint } from "./otlp-config";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_EXPORT_INTERVAL_MS = 60_000;

/** Read an env var; empty/undefined becomes undefined. */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sampleRateFromEnv(): number {
  const raw = env("OTEL_TRACES_SAMPLE_RATE");
  if (raw === undefined) return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/**
 * The headers every signal exports with. Read per request rather than captured
 * once: the exporter calls this each time, so a fresh object goes out every call
 * instead of one shared mutable record, and a deployment that sets the variable
 * late is still honoured.
 */
function authHeaders(): () => Promise<Record<string, string>> {
  return async () => otlpHeaders();
}

/**
 * Initialise the OpenTelemetry SDK. Idempotent: a second call is a no-op so
 * instrumentation.ts and any test harness can both import it safely.
 *
 * Never throws. A misconfigured collector must not stop the app from serving
 * requests — the same non-fatal contract as the rest of instrumentation.ts.
 */
export function initOtel(): NodeSDK | null {
  if (initialized) return initialized;
  const status = remoteTelemetryStatus();
  if (!status.shipping) {
    // Same verdict `report.ts` publishes as `remoteTelemetry`, asked once, here.
    // Each reason gets its own sentence: "not configured" would hide the second
    // one, which is the failure that looks like a broken token.
    const why =
      status.reason === "sdk_disabled"
        ? "OTEL_SDK_DISABLED=true — OpenTelemetry is off"
        : status.reason === "no_endpoint"
          ? "no OTEL_EXPORTER_OTLP_ENDPOINT — traces, metrics and logs stay local"
          : "endpoint set but no Authorization in OTEL_EXPORTER_OTLP_HEADERS — the gateway would reject every batch, so nothing is sent";
    logWarn(`[otel] ${why}`, {});
    initialized = null;
    return null;
  }

  const timeoutMillis = intFromEnv("OTEL_EXPORTER_OTLP_TIMEOUT", DEFAULT_TIMEOUT_MS);
  const serviceName = env("OTEL_SERVICE_NAME") ?? TELEMETRY_SERVICE_NAME;
  const headers = authHeaders();
  // `shipping: true` above is derived from the same reads, so each of these is
  // defined; a signal-specific override wins over the base + spec path.
  const endpoints = {
    traces: signalEndpoint("traces")!,
    metrics: signalEndpoint("metrics")!,
    logs: signalEndpoint("logs")!,
  };

  const resource = resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: serviceName,
    [SEMRESATTRS_SERVICE_VERSION]:
      process.env.NEXT_PUBLIC_APP_VERSION ?? process.env.npm_package_version ?? "unknown",
    "service.instance.id": process.env.RENDER_INSTANCE_ID ?? process.env.HOSTNAME ?? undefined,
    "deployment.environment":
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
  });

  try {
    const sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter({
        url: endpoints.traces,
        headers,
        timeoutMillis,
      }),
      spanProcessors: [
        // Batch: one network flush per span batch instead of one per span.
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: endpoints.traces,
            headers,
            timeoutMillis,
          }),
          {
            // Keep the defaults except the queue size, bumped for a busy API.
            maxQueueSize: 4096,
            scheduledDelayMillis: 5_000,
          },
        ),
      ],
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: endpoints.metrics,
            headers,
            timeoutMillis,
          }),
          exportIntervalMillis: intFromEnv("OTEL_EXPORT_INTERVAL_MS", DEFAULT_EXPORT_INTERVAL_MS),
        }),
      ],
      logRecordProcessors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({
            url: endpoints.logs,
            headers,
            timeoutMillis,
          }),
        }),
      ],
      serviceName,
    });

    sdk.start();
    initialized = sdk;
    logWarn("[otel] OpenTelemetry SDK started", {
      // Where each signal goes. Headers are never logged: the value in them is
      // the credential.
      endpoints,
      service: serviceName,
      sampleRate: sampleRateFromEnv(),
    });
    return sdk;
  } catch (err) {
    logError(
      `[otel] init failed — continuing without remote telemetry: ${err instanceof Error ? err.message : String(err)}`,
    );
    initialized = null;
    return null;
  }
}

/** The singleton instance, or null when disabled/unconfigured/failed. */
let initialized: NodeSDK | null = null;

/**
 * Shut the SDK down, flushing whatever is still queued. Call from a SIGTERM /
 * SIGINT handler so in-flight batches are not lost on graceful shutdown.
 */
export async function shutdownOtel(): Promise<void> {
  if (!initialized) return;
  const sdk = initialized;
  initialized = null;
  try {
    await sdk.shutdown();
  } catch (err) {
    logWarn("[otel] shutdown failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
