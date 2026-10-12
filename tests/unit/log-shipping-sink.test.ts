/**
 * LOG SHIPPING THAT CANNOT BREAK THE APP — the sink seam added to `safe-log`,
 * tested on both sides of the boundary.
 *
 * `src/instrumentation.ts` registers the Axiom sink at boot rather than
 * `safe-log` importing it, because `safe-log` is bundled into the edge proxy and
 * the browser (`src/proxy.ts`, `src/lib/languages.ts`) where `server-only` and
 * `@axiomhq/js` must never appear. That indirection is the whole design, and it
 * is exactly the kind of seam that rots silently: a shipper that throws would turn
 * a successful log call into a failed request, and on this codebase the call being
 * logged is often the one that just wrote a fraud case.
 *
 * So the invariants asserted here are:
 *
 *   1. A sink that throws cannot fail `safeLog()`, and cannot stop the primary
 *      sink from receiving the record.
 *   2. Nothing is shipped, and nothing throws, when `AXIOM_TOKEN` is unset.
 *   3. A failed ingest is COUNTED, not swallowed — `/api/status` reads the
 *      counter, so "logging is broken" is a fact someone can see.
 *   4. The transport's control keys (`level`, `msg`, `ts`, `_time`) are written
 *      last, so a caller-supplied field cannot rewrite the level of its own log
 *      line or its timestamp.
 *   5. `_time` is the EMIT time, not the receipt time, because Axiom orders on it
 *      and a batching delay would smear an incident's timeline.
 *
 * `@axiomhq/js` is replaced with a recording client, so no test here can reach the
 * network or need a token that works.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Ingested = { dataset: string; doc: Record<string, unknown> };
const ingested: Ingested[] = [];
const flushed: number[] = [];
let ingestThrows = false;

mock.module("@axiomhq/js", () => ({
  Axiom: class FakeAxiom {
    ingest(dataset: string, doc: Record<string, unknown>): void {
      if (ingestThrows) throw new Error("axiom: 503 ingestion window closed");
      ingested.push({ dataset, doc });
    }
    async flush(): Promise<void> {
      flushed.push(1);
    }
  },
}));

import { logInfo, logError, registerLogSink, resetLogSinks } from "@/lib/validation/safe-log";
import {
  axiomConfigured,
  axiomDataset,
  axiomDiagnostics,
  flushAxiom,
  resetAxiomState,
  axiomLogSink,
  shipLogRecord,
  AXIOM_DEFAULT_DATASET,
} from "@/lib/telemetry/axiom";

const prior = {
  token: process.env.AXIOM_TOKEN,
  dataset: process.env.AXIOM_DATASET,
};

function withToken(value: string | undefined, dataset?: string) {
  if (value === undefined) delete process.env.AXIOM_TOKEN;
  else process.env.AXIOM_TOKEN = value;
  if (dataset === undefined) delete process.env.AXIOM_DATASET;
  else process.env.AXIOM_DATASET = dataset;
  // The client is resolved lazily and cached, so a token change is invisible to
  // an already-loaded module unless the state is dropped.
  resetAxiomState();
}

beforeEach(() => {
  ingested.length = 0;
  flushed.length = 0;
  ingestThrows = false;
  resetLogSinks();
});

afterEach(() => {
  resetLogSinks();
  withToken(prior.token, prior.dataset);
});

describe("the sink seam in safe-log", () => {
  test("a registered sink receives the record, and unregistering stops the flow", () => {
    const seen: { level: string; line: string; msg: unknown }[] = [];
    const off = registerLogSink(
      (level, line, record) => void seen.push({ level, line, msg: record.msg }),
    );

    logInfo("case opened", { caseRef: "SV-A-1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.level).toBe("info");
    expect(seen[0]!.msg).toBe("case opened");

    off();
    logInfo("after unregister");
    expect(seen).toHaveLength(1);
  });

  test("registering the same sink twice delivers once", () => {
    let n = 0;
    const sink = () => {
      n += 1;
    };
    registerLogSink(sink);
    registerLogSink(sink);
    logInfo("one line");
    expect(n).toBe(1);
  });

  test("a sink that throws cannot fail the log call", () => {
    registerLogSink(() => {
      throw new Error("shipper is down");
    });
    // The contract: this must not throw, and the record must still be produced.
    const survivor: string[] = [];
    registerLogSink((_l, line) => void survivor.push(line));

    expect(() => logInfo("fraud case written", { caseRef: "SV-A-2" })).not.toThrow();
    expect(survivor).toHaveLength(1);
  });
});

describe("Axiom shipping", () => {
  test("with no token, nothing is configured and nothing is shipped", () => {
    withToken(undefined);
    expect(axiomConfigured()).toBe(false);

    shipLogRecord({ level: "info", msg: "x", ts: new Date().toISOString(), fields: {} });
    logInfo("a normal log line");

    const d = axiomDiagnostics();
    expect(d.configured).toBe(false);
    expect(d.shipped).toBe(0);
    expect(ingested).toHaveLength(0);
  });

  test("a configured token ships every record through the registered sink", () => {
    withToken("ax_test_token");
    expect(axiomConfigured()).toBe(true);
    expect(axiomDataset()).toBe(AXIOM_DEFAULT_DATASET);

    registerLogSink(axiomLogSink);
    logInfo("case opened", { caseRef: "SV-A-3" });

    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.doc.msg).toBe("case opened");
    expect(ingested[0]!.doc.level).toBe("info");
    expect(ingested[0]!.doc.caseRef).toBe("SV-A-3");
    expect(ingested[0]!.doc._time).toBe(ingested[0]!.doc.ts);
    expect(axiomDiagnostics().shipped).toBe(1);
  });

  test("the dataset is configurable, and the name says so", () => {
    withToken("ax_test_token", "securevoice-staging");
    expect(axiomDataset()).toBe("securevoice-staging");
  });

  test("a caller field cannot rewrite the transport's control keys", () => {
    withToken("ax_test_token");
    shipLogRecord({
      level: "info",
      msg: "the truth",
      ts: "2026-10-11T10:00:00.000Z",
      fields: { level: "error", msg: "a lie", ts: "1970-01-01T00:00:00.000Z" } as Record<
        string,
        unknown
      >,
    });

    expect(ingested).toHaveLength(1);
    const doc = ingested[0]!.doc;
    expect(doc.level).toBe("info");
    expect(doc.msg).toBe("the truth");
    expect(doc.ts).toBe("2026-10-11T10:00:00.000Z");
    expect(doc._time).toBe("2026-10-11T10:00:00.000Z");
  });

  test("a failed ingest is counted, never thrown, and never silent", () => {
    withToken("ax_test_token");
    ingestThrows = true;

    expect(() => shipLogRecord({ level: "info", msg: "x", ts: "t", fields: {} })).not.toThrow();
    // …and the log call that fed the sink survives it.

    registerLogSink(axiomLogSink);
    expect(() => logError("upstream refused", { provider: "elevenlabs" })).not.toThrow();

    const d = axiomDiagnostics();
    expect(d.shipped).toBe(0);
    expect(d.shipErrors).toBeGreaterThan(0);
    expect(d.lastError).toContain("503");
  });

  test("flush reaches the client when configured and is a no-op when not", async () => {
    withToken(undefined);
    await flushAxiom();
    expect(flushed).toHaveLength(0);

    withToken("ax_test_token");
    await flushAxiom();
    expect(flushed).toHaveLength(1);
  });
});
