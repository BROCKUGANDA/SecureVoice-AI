/**
 * CONTRACT GATE — the realtime event registry may only contain what is produced.
 *
 * Why this exists: `src/lib/realtime-events.ts` shipped a six-member event union
 * of which five members had no producer (`state.change`, `transcript.interim`,
 * `transcript.final`, `audio.meter`, `error`) while the four types actually put on
 * the wire (`case_state`, `case.queued`, `notification`, `credit.deducted`) plus
 * the untyped audit-activity row were named nowhere in it. `svEvent()` and
 * `parseSvEvent()` had no callers at all. Nothing could see the drift, because no
 * test read the registry against the source — and a declared shape nothing produces
 * is worse than no shape, since it makes anything measured against it report empty
 * with confidence.
 *
 * So this file re-derives the registry from the tree, in both directions:
 *
 *   · every declared type has a producer whose FILE EXISTS and whose cited LINE
 *     carries the literal type string (`registryDefects`, which is also pointed at
 *     fabricated entries below so the walk cannot rot into a no-op);
 *   · every `notifyRealtime()` call site in `src/` sends a type that is declared —
 *     found by scanning the tree rather than trusting the list, which is what stops
 *     a new producer inventing a fifth naming convention;
 *   · every declared CONSUMER is really there, and an entry admitted as unread must
 *     say so in prose (`none —`) instead of citing a reader that is not reading.
 *
 * No network, no database.
 *
 *   bun run test realtime-event-registry
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTIVITY_FRAME,
  REALTIME_EVENTS,
  REALTIME_EVENT_TYPES,
  checkRealtimePayload,
  parseRealtimeFrame,
  type RealtimeEventSpec,
  type SvEventType,
} from "../../src/lib/realtime-events.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Every `.ts`/`.tsx` under `src`, as repo-relative paths with forward slashes. */
function srcFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out.sort();
}

const ALL_SRC = srcFiles();
const DECLARED = new Set<string>(REALTIME_EVENT_TYPES);

/** The line number in `file` where `literal` first appears, or null. */
function literalLine(file: string, literal: string): number | null {
  if (!existsSync(join(ROOT, file))) return null;
  const lines = read(file).split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(literal));
  return idx < 0 ? null : idx + 1;
}

/** How far a cited line may drift from where the literal actually sits. */
const LINE_TOLERANCE = 6;

/**
 * Proof that a declared consumer really reads the frame. Pinned HERE rather than
 * stored in the registry, so the registry cannot certify itself by citing a branch
 * that has since been edited away.
 */
const CONSUMER_PROOFS: Record<string, readonly { file: string; literal: string }[]> = {
  "credit.deducted": [
    { file: "src/lib/realtime-client.ts", literal: `frame.type === "credit.deducted"` },
    { file: "src/components/billing/CreditWidget.tsx", literal: "onCredit:" },
  ],
  // The untyped audit-activity row, keyed here so the same walk covers it.
  __activity__: [
    { file: "src/lib/realtime-client.ts", literal: "parseRealtimeFrame(" },
    { file: "src/views/Console.tsx", literal: "onActivity:" },
  ],
};

function consumerProofDefects(
  key: string,
  proofs: readonly { file: string; literal: string }[] = CONSUMER_PROOFS[key] ?? [],
): string[] {
  const out: string[] = [];
  for (const p of proofs) {
    if (!existsSync(join(ROOT, p.file))) out.push(`${key}: consumer ${p.file} is gone`);
    else if (literalLine(p.file, p.literal) === null)
      out.push(`${key}: ${p.file} no longer contains ${JSON.stringify(p.literal)}`);
  }
  return out;
}

/**
 * The one function that decides whether a registry entry is real. Pure over the
 * entry, so the fitness controls below can point it at a fabricated registry and
 * prove it reports — a walk that quietly returned `[]` would green everything.
 */
function registryDefects(entries: readonly RealtimeEventSpec[]): string[] {
  const defects: string[] = [];
  for (const e of entries) {
    const { file, line, literal } = e.producer;
    if (!existsSync(join(ROOT, file))) {
      defects.push(`${e.type}: producer file ${file} does not exist`);
      continue;
    }
    const actual = literalLine(file, literal);
    if (actual === null) {
      defects.push(`${e.type}: ${file} does not contain the literal ${JSON.stringify(literal)}`);
    } else if (Math.abs(actual - line) > LINE_TOLERANCE) {
      defects.push(
        `${e.type}: producer citation moved — registry says ${file}:${line}, ` +
          `${JSON.stringify(literal)} is now at ${file}:${actual}. Update the citation.`,
      );
    }
    // A consumer is either a citation or an admission, never a hopeful blank.
    if (!e.consumed && !/^none —/.test(e.consumer)) {
      defects.push(`${e.type}: consumed:false but consumer does not start with "none —"`);
    }
    if (e.consumed && !CONSUMER_PROOFS[e.type]) {
      defects.push(`${e.type}: consumed:true has no consumer proof pinned in this gate`);
    }
    if (e.consumed) defects.push(...consumerProofDefects(e.type));
  }
  return defects;
}

/**
 * The argument text of every `notifyRealtime({ … })` call in `text`, found by
 * balanced-bracket matching so a payload nested in `meta: meta ?? {}` still
 * terminates in the right place. The definition in `src/lib/realtime.ts` is not a
 * producer and is skipped: its argument list does not open with `{`.
 */
function notifyRealtimeCalls(text: string): { line: number; args: string }[] {
  const out: { line: number; args: string }[] = [];
  const needle = "notifyRealtime(";
  let from = 0;
  for (;;) {
    const start = text.indexOf(needle, from);
    if (start < 0) return out;
    from = start + needle.length;
    let i = start + needle.length;
    let depth = 1;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "(" || c === "{" || c === "[") depth += 1;
      else if (c === ")" || c === "}" || c === "]") depth -= 1;
      i += 1;
    }
    const args = text.slice(start + needle.length, i - 1);
    if (!args.trimStart().startsWith("{")) continue;
    out.push({ line: text.slice(0, start).split(/\r?\n/).length, args });
  }
}

/** The literal `type:` string in a producer's payload, or null when it has none. */
function payloadType(args: string): string | null {
  const m = /\btype:\s*"([^"]*)"/.exec(args);
  return m ? m[1]! : null;
}

/** Every producer that fans out on the realtime channel, found by scanning `src`. */
const PRODUCERS = ALL_SRC.flatMap((file) =>
  notifyRealtimeCalls(read(file)).map((c) => ({ file, line: c.line, type: payloadType(c.args) })),
);

describe("realtime event registry — every declared type has a producer", () => {
  test("the registry and the scan are both populated, or nothing is being watched", () => {
    expect(REALTIME_EVENTS.length).toBeGreaterThanOrEqual(4);
    expect(ALL_SRC.length).toBeGreaterThan(100);
    expect(PRODUCERS.length).toBeGreaterThanOrEqual(5);
  });

  test("the declared set is exactly the types on the wire — widening it is deliberate", () => {
    // Pinned, so a member cannot be added on intent alone: it has to arrive with an
    // emitter, and then this list and that emitter both change in one review. The
    // list is typed `SvEventType[]`, so a name the union does not carry is a
    // compile error here — the pin cannot silently drift into prose.
    const wire: SvEventType[] = ["case.queued", "case_state", "credit.deducted", "notification"];
    expect([...REALTIME_EVENT_TYPES].sort()).toEqual([...wire].sort());
  });

  test("every declared type names a producer whose file exists and carries the literal", () => {
    const defects = registryDefects(REALTIME_EVENTS);
    expect(defects, defects.join("\n")).toEqual([]);
  });

  test("the untyped audit-activity frame names its producer too", () => {
    expect(existsSync(join(ROOT, ACTIVITY_FRAME.producer.file))).toBe(true);
    const actual = literalLine(ACTIVITY_FRAME.producer.file, ACTIVITY_FRAME.producer.literal);
    const message =
      `audit-chain activity frame: cited ` +
      `${ACTIVITY_FRAME.producer.file}:${ACTIVITY_FRAME.producer.line}, ` +
      `${JSON.stringify(ACTIVITY_FRAME.producer.literal)} found at line ${actual}`;
    expect(
      actual !== null && Math.abs(actual - ACTIVITY_FRAME.producer.line) <= LINE_TOLERANCE,
      message,
    ).toBe(true);
    expect(consumerProofDefects("__activity__")).toEqual([]);
  });

  test("only the type with a real reader claims one, and the reader is there", () => {
    const consumed = REALTIME_EVENTS.filter((e) => e.consumed).map((e) => e.type);
    expect(consumed).toEqual(["credit.deducted"]);
    for (const type of consumed) expect(consumerProofDefects(type)).toEqual([]);
  });
});

describe("realtime producers — nothing is emitted that the registry does not declare", () => {
  test("each producer's payload names a declared type, or is the declared untyped row", () => {
    const offenders: string[] = [];
    for (const p of PRODUCERS) {
      if (p.type === null) {
        // No `type` at all is legal exactly once: the audit-activity row.
        if (p.file !== ACTIVITY_FRAME.producer.file) {
          offenders.push(
            `${p.file}:${p.line} sends a payload with no \`type\` and is not the declared ` +
              `activity-row producer (${ACTIVITY_FRAME.producer.file})`,
          );
        }
        continue;
      }
      if (!DECLARED.has(p.type)) {
        offenders.push(`${p.file}:${p.line} emits undeclared type "${p.type}"`);
        continue;
      }
      const spec = REALTIME_EVENTS.find((e) => e.type === p.type);
      // Declared, but not from here: a second producer for one type has to be
      // registered, because the registry is the map of who says what.
      if (spec && spec.producer.file !== p.file) {
        offenders.push(
          `${p.file}:${p.line} emits "${p.type}" but the registry names ` +
            `${spec.producer.file}:${spec.producer.line} as its producer`,
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("no registered producer has stopped producing", () => {
    const live = new Set(PRODUCERS.map((p) => p.file));
    const stale = REALTIME_EVENTS.map((e) => e.producer.file).filter((f) => !live.has(f));
    expect(
      stale,
      `the registry names a producer that no longer calls notifyRealtime: ${stale.join(", ")}`,
    ).toEqual([]);
    expect(live.has(ACTIVITY_FRAME.producer.file)).toBe(true);
  });

  test("the deleted types are gone from the tree, not just from the union", () => {
    // The names the old union declared with no producer. A bare `error` is too
    // generic to grep tree-wide, so it is policed by the pinned set above.
    for (const ghost of ["state.change", "transcript.interim", "transcript.final", "audio.meter"]) {
      const hits = ALL_SRC.filter((f) => read(f).includes(`"${ghost}"`));
      expect(hits, `"${ghost}" is back in ${hits.join(", ")} with no producer`).toEqual([]);
    }
  });

  test("the helpers that had no callers stayed deleted", () => {
    // `svEvent()` / `parseSvEvent()` existed for two days with zero callers.
    const contract = read("src/lib/realtime-events.ts");
    expect(contract).not.toMatch(/export (function|const) (svEvent|parseSvEvent)\b/);
  });

  test("the contract is enforced at both boundaries, by name", () => {
    // Emit side: the fan-out refuses a payload naming an undeclared type.
    expect(read("src/lib/realtime.ts")).toContain("checkRealtimePayload(");
    // Receive side: the browser refuses a frame it cannot parse.
    expect(read("src/lib/realtime-client.ts")).toContain("parseRealtimeFrame(");
  });
});

describe("the gate can fail — fabricated entries are reported, not accepted", () => {
  const real: RealtimeEventSpec = REALTIME_EVENTS[0]!;
  const unread: RealtimeEventSpec = REALTIME_EVENTS[1]!;

  test("an entry whose producer file does not exist is a defect", () => {
    const fake: RealtimeEventSpec = {
      ...real,
      producer: { file: "src/lib/does-not-exist.ts", line: 1, literal: real.producer.literal },
    };
    expect(registryDefects([fake]).join("\n")).toContain("does not exist");
  });

  test("an entry whose literal is absent from a real file is a defect", () => {
    const fake: RealtimeEventSpec = {
      ...real,
      producer: { ...real.producer, literal: `type: "state.change"` },
    };
    expect(registryDefects([fake]).join("\n")).toContain("does not contain the literal");
  });

  test("a citation that has drifted is reported with where the literal really is", () => {
    const fake: RealtimeEventSpec = { ...real, producer: { ...real.producer, line: 1 } };
    const defects = registryDefects([fake]);
    expect(defects.join("\n")).toContain("producer citation moved");
    expect(defects.join("\n")).toContain(`is now at ${real.producer.file}:${real.producer.line}`);
  });

  test("an unread entry that does not admit it is a defect", () => {
    const fake: RealtimeEventSpec = { ...unread, consumer: "somewhere, probably" };
    expect(registryDefects([fake]).join("\n")).toContain('start with "none —"');
  });

  test("a consumed:true entry with no pinned proof is a defect", () => {
    const unproven: RealtimeEventSpec = { ...unread, consumed: true };
    expect(registryDefects([unproven]).join("\n")).toContain("no consumer proof pinned");
  });

  test("a consumer proof that stops matching is a defect", () => {
    // The real proofs must pass first, or this control proves nothing.
    expect(consumerProofDefects("__activity__")).toEqual([]);
    expect(
      consumerProofDefects("credit.deducted", [
        { file: "src/lib/realtime-client.ts", literal: `frame.type === "state.change"` },
      ]).join("\n"),
    ).toContain("no longer contains");
    expect(
      consumerProofDefects("credit.deducted", [
        { file: "src/lib/not-here.ts", literal: "anything" },
      ]).join("\n"),
    ).toContain("is gone");
  });

  test("the producer scan finds the real call sites, not only the declared ones", () => {
    // Derived from the tree: every producer the registry cites must show up in the
    // scan, so a scan that silently matched nothing could not pass this.
    const byFile = new Set(PRODUCERS.map((p) => p.file));
    for (const spec of REALTIME_EVENTS) expect(byFile.has(spec.producer.file)).toBe(true);
    expect(byFile.has(ACTIVITY_FRAME.producer.file)).toBe(true);
    expect(PRODUCERS.filter((p) => p.type === null).map((p) => p.file)).toEqual([
      ACTIVITY_FRAME.producer.file,
    ]);
  });
});

describe("the checks themselves — real payloads pass, invented ones do not", () => {
  /** `credit.deducted` exactly as src/lib/credits.ts:287-292 builds it. */
  const credit = {
    type: "credit.deducted",
    call_id: "",
    ts: 1_760_000_000_000,
    data: { remaining: 9, scope: "org", reason: "intervention_fired" },
  };
  /** `case_state` exactly as src/lib/case-state-machine.ts:245 builds it. */
  const caseState = {
    type: "case_state",
    caseRef: "SV-1",
    from: "ANSWERED",
    to: "HELD",
    meta: {},
  };
  /** `case.queued` exactly as src/app/api/v1/interventions/route.ts:1049 builds it. */
  const caseQueued = {
    type: "case.queued",
    caseRef: "SV-1",
    state: "QUEUED",
    jobId: "job_1",
    language: "en",
    riskScore: 0.9,
    ts: "2026-10-16T00:00:00.000Z",
  };
  /** `notification` exactly as src/lib/notifications.ts:129 builds it. */
  const notification = {
    type: "notification",
    alertType: "fraud_confirmed",
    severity: "page",
    title: "Fraud confirmed",
    count: 3,
  };
  /** The audit-activity row exactly as src/lib/audit-chain.ts:361 builds it. */
  const activityRow = {
    id: "row_1",
    action: "agent",
    intent: null,
    chainHash: "00".repeat(32),
    ts: "2026-10-16T00:00:00.000Z",
  };

  test("every payload the tree actually builds is accepted", () => {
    // Typed as the declared union, so the check must echo the type back — a
    // payload that merely parses is not the same as one that parses AS its type.
    const accepted: { payload: Record<string, unknown>; type: SvEventType }[] = [
      { payload: credit, type: "credit.deducted" },
      { payload: caseState, type: "case_state" },
      { payload: caseQueued, type: "case.queued" },
      { payload: notification, type: "notification" },
    ];
    for (const a of accepted) {
      expect({ type: a.type, check: checkRealtimePayload(a.payload) }).toEqual({
        type: a.type,
        check: { ok: true, type: a.type },
      });
    }
    // The untyped row parses at the receive boundary…
    expect(parseRealtimeFrame(activityRow)).toEqual(activityRow);
    // …and is not refused on the emit side, which is what src/lib/realtime.ts has
    // always done and tests/unit/realtime-bridge.test.ts pins.
    expect(checkRealtimePayload(activityRow)).toEqual({ ok: true, type: null });
  });

  test("the deleted names are refused — which is what parseSvEvent never did", () => {
    // The old `parseSvEvent()` accepted `state.change` and rejected `case_state`.
    // That inversion is the whole bug this gate records.
    expect(checkRealtimePayload({ type: "state.change", from: null, to: "HELD" })).toEqual({
      ok: false,
      reason: 'undeclared_type:"state.change"',
    });
    expect(parseRealtimeFrame({ type: "audio.meter", level: 0.5, speaking: true })).toBeNull();
    expect(
      parseRealtimeFrame({ type: "error", code: "x", message: "y", retryable: false }),
    ).toBeNull();
  });

  test("a declared type with the wrong shape is refused rather than half-read", () => {
    expect(checkRealtimePayload({ ...caseState, meta: undefined }).ok).toBe(false);
    expect(checkRealtimePayload({ ...credit, data: {} }).ok).toBe(false);
    expect(checkRealtimePayload({ ...credit, data: { ...credit.data, scope: "shared" } }).ok).toBe(
      false,
    );
    expect(checkRealtimePayload({ ...notification, severity: "critical" }).ok).toBe(false);
    expect(checkRealtimePayload({ ...caseQueued, riskScore: "0.9" }).ok).toBe(false);
    // A payload whose `type` is not a string is a producer bug, not a new event.
    expect(checkRealtimePayload({ type: 7 }).ok).toBe(false);
  });

  test("parseRealtimeFrame is total: hostile input returns null, never throws", () => {
    for (const raw of [null, undefined, 0, "", "nope", [], {}, { type: "case_state" }]) {
      expect(parseRealtimeFrame(raw)).toBeNull();
    }
    expect(parseRealtimeFrame({ ...activityRow, action: 42 })).toBeNull();
  });

  test("the citations in the registry point at real lines, not at rounded guesses", () => {
    for (const spec of REALTIME_EVENTS) {
      const text = read(spec.producer.file).split(/\r?\n/)[spec.producer.line - 1] ?? "";
      expect(
        text.includes(spec.producer.literal),
        `${spec.type}: ${spec.producer.file}:${spec.producer.line} is "${text.trim()}"`,
      ).toBe(true);
    }
  });
});
