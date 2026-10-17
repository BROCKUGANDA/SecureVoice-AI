import "server-only";
/**
 * WP-7 — the OTLP *shape*, on demand.
 *
 * The brief asked for an OTLP-compatible output without adding a dependency and
 * without requiring a collector. That is what this is: `toOtlpSpans` in `./spans.ts`
 * is pure, so producing the payload costs nothing, and `/api/status/spans?format=otlp`
 * serves it straight to an operator who wants to open a collector.
 *
 * There is deliberately no POST here any more. This file used to carry
 * `exportOtlp`, a hand-rolled OTLP/HTTP transport with its own endpoint variable,
 * header parser and timeout — and it had no caller, because `otel.ts` already
 * builds three real SDK exporters (`OTLPTraceExporter`, `OTLPMetricExporter`,
 * `OTLPLogExporter`) against the same ingestion host. Shipping the ring-buffer
 * spans by a second path would have produced two OTLP transports with two configs,
 * one of which nobody exercised. The pull half is the useful half.
 */

import { toOtlpSpans, type OtlpTracePayload, type SpanRecord } from "./spans";

/** The payload, for an HTTP GET on `/api/status/spans?format=otlp`. */
export function buildOtlpExport(records: readonly SpanRecord[]): OtlpTracePayload {
  return toOtlpSpans(records);
}
