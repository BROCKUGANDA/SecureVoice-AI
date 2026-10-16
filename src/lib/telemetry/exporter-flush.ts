/**
 * The seam between the app bundle and the process that owns its exit.
 *
 * `scripts/server-preload.ts` is what catches SIGTERM for the `app` container:
 * it puts the instance out of rotation, waits the drain window, then calls
 * `process.exit()`. The exporters that batch — the OTLP SDK and the Axiom log
 * sink — live on the other side of that exit, inside the Next bundle.
 *
 * The preload cannot import them. It runs from `.next/standalone/`, which
 * `scripts/copy-standalone.mjs` fills with the compiled server and this one
 * script; the runner image has no `src/` at all. And even if the source were
 * present, a fresh `import()` of the bundle's module would create a *second*
 * instance of it, with its own `initialized = null` singleton, so a shutdown
 * call on it would flush nothing at all and report success doing it.
 *
 * So the bundle publishes the live closure here, and the preload reads it back
 * off `globalThis` under `EXPORTER_FLUSH_KEY` before it exits. The literal is
 * duplicated on the preload side because the two cannot share a module — and
 * `tests/telemetry/exporter-flush.test.ts` fails the build if they drift, since
 * a mismatched key is a flush that silently never runs.
 *
 * This module imports nothing, on purpose: it is loaded by `instrumentation.ts`
 * at boot, and anything it pulls in joins the boot graph of every process that
 * registers it.
 */

/** The `globalThis` property the preload reads. Keep in step with server-preload.ts. */
export const EXPORTER_FLUSH_KEY = "__securevoiceFlushExporters";

export type ExporterFlush = () => Promise<void>;

// Indexed access with a string key, not a computed property inside a type
// literal: TypeScript only accepts a narrow set of computed names there. A
// `Record` keeps the host shape one line and the three helpers one expression
// each, which is the whole reason this module has no dependencies.
type FlushHost = typeof globalThis & Record<string, ExporterFlush | undefined>;

/**
 * Publish the flush for the process owner. Last registration wins: `register()`
 * runs once per Node process, and a test that registers twice is asserting on
 * the newest closure, not a queue of them.
 */
export function registerExporterFlush(flush: ExporterFlush): void {
  (globalThis as FlushHost)[EXPORTER_FLUSH_KEY] = flush;
}

/** The published flush, or null when nothing registered one. */
export function currentExporterFlush(): ExporterFlush | null {
  return (globalThis as FlushHost)[EXPORTER_FLUSH_KEY] ?? null;
}

/** Test-only: remove the publication so a control can show the gap is detectable. */
export function clearExporterFlush(): void {
  delete (globalThis as FlushHost)[EXPORTER_FLUSH_KEY];
}
