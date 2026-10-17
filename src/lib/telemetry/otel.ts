/**
 * OpenTelemetry OTLP/HTTP exporter wiring for Better Stack.
 *
 * Three signals, three independent exporters, one ingestion host:
 *
 *   traces  → https://<host>/v1/traces
 *   metrics → https://<host>/v1/metrics
 *   logs    → https://<host>/v1/logs
 *
 * Every request carries `Authorization: Bearer <token>` so Better Stack can
 * attribute the payload to this source. The token is read from
 * OTEL_BETTERSTACK_TOKEN (or OTEL_SOURCE_TOKEN); a deployment that has not
 * set it gets no remote telemetry — and no crash, matching the project's
 * "degrade loudly, never silently" boot convention.
 *
 * Env knobs (see .env.example):
 *   OTEL_BETTERSTACK_ENDPOINT  base URL          (default https://<OTEL_BETTERSTACK_HOST>)
 *   OTEL_BETTERSTACK_HOST      ingestion host    (default s2791980.us-west-2a.betterstackdata.com)
 *   OTEL_BETTERSTACK_TOKEN     bearer token       (no default — required to export)
 *   OTEL_BETTERSTACK_TIMEOUT_MS  per-request timeout (default 10000)
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
import { ingestionToken, remoteTelemetryStatus } from "./otlp-config";

const DEFAULT_HOST = "s2791980.us-west-2a.betterstackdata.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_EXPORT_INTERVAL_MS = 60_000;

/** Normalise a user-supplied base URL: strip trailing slashes, default scheme. */
function normalizeBaseUrl(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return `https://${DEFAULT_HOST}`;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

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
 * Build a Bearer auth headers factory. The exporter calls this per request;
 * returning a fresh object each time avoids any shared-mutation surprise.
 */
function authHeaders(token: string): () => Promise<Record<string, string>> {
  return async () => ({ Authorization: `Bearer ${token}` });
}

/** The one place the Better Stack base URL is derived. */
export function betterStackBaseUrl(): string {
  return normalizeBaseUrl(env("OTEL_BETTERSTACK_ENDPOINT") ?? env("OTEL_BETTERSTACK_HOST"));
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
    if (status.reason === "sdk_disabled") {
      logWarn("[otel] OTEL_SDK_DISABLED=true — OpenTelemetry is off", {});
    } else {
      logWarn("[otel] no token set — traces, metrics and logs stay local", {
        detail:
          "Set OTEL_BETTERSTACK_TOKEN (or OTEL_SOURCE_TOKEN) to ship telemetry to Better Stack.",
      });
    }
    initialized = null;
    return null;
  }

  const token = ingestionToken()!; // shipping:true above is derived from this same read

  const baseUrl = betterStackBaseUrl();
  const timeoutMillis = intFromEnv("OTEL_BETTERSTACK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const serviceName = env("OTEL_SERVICE_NAME") ?? TELEMETRY_SERVICE_NAME;
  const headers = authHeaders(token);

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
        url: `${baseUrl}/v1/traces`,
        headers,
        timeoutMillis,
      }),
      spanProcessors: [
        // Batch: one network flush per span batch instead of one per span.
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${baseUrl}/v1/traces`,
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
            url: `${baseUrl}/v1/metrics`,
            headers,
            timeoutMillis,
          }),
          exportIntervalMillis: intFromEnv("OTEL_EXPORT_INTERVAL_MS", DEFAULT_EXPORT_INTERVAL_MS),
        }),
      ],
      logRecordProcessors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({
            url: `${baseUrl}/v1/logs`,
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
      endpoint: baseUrl,
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
