/**
 * A process that starts a batching exporter must flush it on the way out.
 *
 * WHY THIS FILE EXISTS. Two modules shipped the flush and nothing called it:
 *
 *   · `shutdownOtel()` — documented "Call from a SIGTERM / SIGINT handler so
 *     in-flight batches are not lost on graceful shutdown". `initOtel()` runs in
 *     `src/instrumentation.ts` (the web process) and in `src/worker/voice-stream.ts`,
 *     and the SDK behind it batches all three signals: a BatchSpanProcessor with a
 *     5 s scheduled delay, a periodic metric reader, and a BatchLogRecordProcessor.
 *     Called by nobody, so every deploy dropped the tail of every signal — the
 *     spans and metrics belonging to the release being deployed.
 *   · `flushAxiom()` — same shape, same docstring, same zero callers, for the log
 *     sink `register()` installs when `AXIOM_TOKEN` is set.
 *
 * `src/worker/dial.ts` had already been through this with Langfuse and recorded it
 * in its own comment: the flush "existed, documented 'call this in a SIGTERM
 * handler', and was called by nothing". Nothing stopped the same thing happening
 * again two files away, because no check joined the two halves.
 *
 * THE RULES.
 *   A. Every module that starts a batching exporter also flushes it, in the same
 *      module. A starter with no flush in its own file is the bug class.
 *   B. The app process's exit path performs the flush before it exits. The exit is
 *      owned by `scripts/server-preload.ts`, which cannot import the bundle, so it
 *      reads the closure off `globalThis` — see src/lib/telemetry/exporter-flush.ts
 *      for why a fresh `import()` would have silently flushed nothing.
 *   C. The `globalThis` key is spelled identically on both sides. It has to be:
 *      two modules that cannot share a constant. A drifted key is a flush that
 *      never runs and a shutdown log line saying it did.
 *
 * Deliberately NOT the check: "the collector received the spans". That would make
 * the build depend on a vendor endpoint. This only asks whether the code reaches
 * the flush it wrote.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EXPORTER_FLUSH_KEY,
  clearExporterFlush,
  currentExporterFlush,
  registerExporterFlush,
} from "@/lib/telemetry/exporter-flush";

/** Each pair is one buffer: the call that fills it and the call that empties it. */
const PAIRS: Array<{ label: string; starts: RegExp; flushes: RegExp }> = [
  {
    label: "OTLP SDK: initOtel() batches spans, metrics and logs",
    starts: /\binitOtel\s*\(/,
    flushes: /\bshutdownOtel\s*\(/,
  },
  {
    label: "Axiom log sink: registerLogSink(axiomLogSink) buffers records",
    starts: /\bregisterLogSink\s*\(\s*axiomLogSink/,
    flushes: /\bflushAxiom\s*\(/,
  },
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "coverage") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Prisma's output, not our code.
      if (entry === "generated") continue;
      sources(full, out);
    } else if (/\.(ts|tsx|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const SCANNED = sources("src").concat(sources("scripts"));

/** Strip comment lines: a docstring naming a flush is not a call to it. */
function code(body: string): string {
  return body
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

/**
 * The gate itself, as a pure function of (path, source), so a control can feed it
 * a mutated file and prove it still reports the gap.
 */
function unflushedExporters(files: Array<{ path: string; body: string }>): string[] {
  const gaps: string[] = [];
  for (const { path, body } of files) {
    const src = code(body);
    for (const { label, starts, flushes } of PAIRS) {
      if (!starts.test(src)) continue;
      if (flushes.test(src)) continue;
      gaps.push(`${path}: ${label} is started here and never flushed here`);
    }
  }
  return gaps;
}

const REAL = SCANNED.map((path) => ({ path, body: readFileSync(path, "utf8") }));

test("the scan sees the processes that actually start exporters", () => {
  // Tripwire for the gate itself: an empty or blind file list makes every rule
  // below pass vacuously. Both entry points must be in scope or the scan is
  // certifying a directory it is not looking at.
  const starters = REAL.filter((f) => PAIRS.some((p) => p.starts.test(code(f.body))));
  expect(starters.length).toBeGreaterThanOrEqual(2);
  expect(starters.some((f) => f.path.includes(join("src", "instrumentation.ts")))).toBe(true);
  expect(starters.some((f) => f.path.includes(join("worker")))).toBe(true);
});

test("A. no module starts a batching exporter without flushing it", () => {
  expect(unflushedExporters(REAL).join("\n")).toBe("");
});

/** The body of a top-level function, by the first brace at column zero. */
function fnBody(source: string, declaration: string): string {
  const from = source.indexOf(declaration);
  expect(from, `no ${declaration} in scripts/server-preload.ts`).toBeGreaterThan(-1);
  const end = source.slice(from).search(/\n\}\n/);
  expect(end).toBeGreaterThan(-1);
  return source.slice(from, from + end + 3);
}

/** The three moments inside the exit path, as offsets in its own body. */
function exitOrder(source: string): { readAt: number; raceAt: number; exitAt: number } {
  const exiting = fnBody(source, "async function exitAfterFlush");
  // The bare identifier, not `"[KEY]"`: prettier may reflow the indexed access
  // across lines, and a gate that keys on the bracket formatting goes red on a
  // run of `bun run format` that changed nothing about the behaviour. Inside this
  // function's own body the identifier appears exactly once — at the read.
  return {
    readAt: exiting.indexOf("EXPORTER_FLUSH_KEY"),
    raceAt: exiting.indexOf("Promise.race"),
    exitAt: exiting.lastIndexOf("process.exit(0)"),
  };
}

/** True only when the flush is reached, awaited, and then — and only then — exited. */
function flushesBeforeExiting(order: { readAt: number; raceAt: number; exitAt: number }): boolean {
  return order.readAt > -1 && order.raceAt > order.readAt && order.exitAt > order.raceAt;
}

test("B. the app's exit path flushes before it exits", () => {
  const preload = readFileSync(join("scripts", "server-preload.ts"), "utf8");

  // The drain now ends in the flush. It used to end in `process.exit(0)`, which
  // is the defect: an exit that outruns every batching exporter in the process.
  const drain = fnBody(preload, "function beginDrain");
  expect(drain).toContain("void exitAfterFlush()");
  expect(drain).not.toContain("process.exit");

  const order = exitOrder(preload);
  expect(order).toEqual({
    readAt: expect.any(Number),
    raceAt: expect.any(Number),
    exitAt: expect.any(Number),
  });
  expect({ order, verdict: flushesBeforeExiting(order) }).toEqual({
    order,
    verdict: true,
  });

  // The drain owns the clock, so a wedged collector must not become a SIGKILL.
  expect(fnBody(preload, "async function exitAfterFlush")).toMatch(/FLUSH_BUDGET_MS/);
  // A process that finds nothing registered says so, instead of exiting quietly
  // unflushed and looking identical in the log.
  expect(preload).toContain("no exporter flush registered");
});

test("C. both sides spell the global key the same, and neither imports the other", () => {
  const preload = readFileSync(join("scripts", "server-preload.ts"), "utf8");
  expect(preload).toContain(`"${EXPORTER_FLUSH_KEY}"`);
  // The reason it is a literal and not an import: the runner image ships the
  // standalone output only. An import here would fail at boot, and a fresh
  // instance of the bundle would flush a singleton nobody is using.
  expect(preload).not.toMatch(/from ["']@\//);
  const contract = readFileSync(join("src", "lib", "telemetry", "exporter-flush.ts"), "utf8");
  expect(contract).toContain(`"${EXPORTER_FLUSH_KEY}"`);
});

test("the seam publishes and consumes a real closure", async () => {
  const calls: string[] = [];
  registerExporterFlush(async () => {
    calls.push("flushed");
  });
  const live = currentExporterFlush();
  expect(typeof live).toBe("function");
  await live?.();
  expect(calls).toEqual(["flushed"]);
  clearExporterFlush();
  expect(currentExporterFlush()).toBeNull();
});

test("the gate can fail — a starter with no flush, and the drift it catches", () => {
  // Positive controls. Feed the checker the file as it was BEFORE this wiring:
  // `register()` started the OTLP SDK and the Axiom sink and flushed neither.
  const before = {
    path: join("src", "instrumentation.ts"),
    body: [
      "const sdk = initOtel();",
      "registerLogSink(axiomLogSink);",
      "// shutdownOtel() — documented, called by nothing",
    ].join("\n"),
  };
  const gaps = unflushedExporters([before]);
  expect(gaps.length).toBe(2);
  expect(gaps.join("\n")).toContain("OTLP SDK");
  expect(gaps.join("\n")).toContain("Axiom log sink");

  // A comment must not be counted as a call, or the gate is satisfied by the very
  // docstrings that describe the missing wiring.
  expect(
    unflushedExporters([{ path: "x.ts", body: "initOtel();\n// shutdownOtel()" }]),
  ).toHaveLength(1);

  // A module that flushes passes — the rule is a pair, not a ban on starting SDKs.
  expect(
    unflushedExporters([{ path: "y.ts", body: "const s = initOtel();\nawait shutdownOtel();" }]),
  ).toEqual([]);

  // Rule B, reversed: an exit ahead of the flush is the original bug wearing the
  // fix's file name. Same function, one line moved.
  const fixed = readFileSync(join("scripts", "server-preload.ts"), "utf8");
  const reverted = fixed.replace(
    /\n  await Promise\.race\(\[[\s\S]*?\n  \]\);\n/,
    "\n  process.exit(0);\n",
  );
  expect(reverted).not.toBe(fixed);
  expect(flushesBeforeExiting(exitOrder(reverted))).toBe(false);
  expect(flushesBeforeExiting(exitOrder(fixed))).toBe(true);

  // And a drifted key must be caught by rule C, which is why C compares against
  // the imported constant rather than a string it retypes locally.
  expect('const EXPORTER_FLUSH_KEY = "__securevoiceFlushExportis"').not.toContain(
    `"${EXPORTER_FLUSH_KEY}"`,
  );
});

test("the exporter modules still own one starter and one flusher each", () => {
  // Guards the deletions that came with this wiring: `otelRemoteEnabled` (a
  // function reference exported as if it were a boolean, read by nothing) and
  // `startSpan` (zero callers, and a handle whose `spanId` was always "").
  const otel = readFileSync(join("src", "lib", "telemetry", "otel.ts"), "utf8");
  const spans = readFileSync(join("src", "lib", "telemetry", "spans.ts"), "utf8");
  expect(otel).not.toContain("otelRemoteEnabled");
  expect(spans).not.toContain("startSpan");
  expect(spans).not.toContain("monotonicMs");
  // And the two that this file wires are still the only pair members.
  expect(otel).toMatch(/export async function shutdownOtel/);
  expect(readFileSync(join("src", "lib", "telemetry", "axiom.ts"), "utf8")).toMatch(
    /export async function flushAxiom/,
  );
});
