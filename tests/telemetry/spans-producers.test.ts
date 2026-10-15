/**
 * GATE — every declared latency span must have a producer in `src/`.
 *
 * `SPAN_DEFINITIONS` is the published latency contract: eight budgets a bank and a
 * regulator can quote back at us, and `scripts/emit-slo.ts` reports each one as
 * `met` / `missed` / `not_measured`. The third verdict is honest — it says "no
 * samples" instead of passing — but honesty is not detection. Nothing anywhere
 * noticed that three of the eight had no code path capable of producing a sample:
 *
 *   signal_received_to_ringing          — "the customer's phone rings within 5s"
 *   caller_stop_to_agent_audio          — the turn latency the caller HEARS (1.5s)
 *   fraud_confirmed_to_webhook_delivered — the bank's own 2s webhook promise
 *
 * The first has since been produced (2026-10-16 — src/lib/telemetry/ringing.ts, driven
 * in CI by tests/e2e/signal-received-to-ringing.test.ts), and the two remaining stay
 * listed below with the reason each cannot be measured yet.
 *
 * Two of those are the voice engine's headline promises. They were unmeasured, which
 * means "the voice engine is degraded" was an unfalsifiable claim in both directions:
 * slower would not have shown up, and neither would having stopped dialling entirely.
 *
 * The same file asserts the reverse direction, because that half fails differently:
 * a `recordSpan({ span: "…" })` naming something NOT declared is rejected at runtime
 * (`isSpanName` → `unknown_span`), so the metric is dropped silently and the code
 * looks like it is instrumenting something. A typo in a span name is invisible;
 * this makes it a build failure.
 *
 * Scan-shape tripwire: an empty file list would certify everything, so the walk
 * asserts it read a realistic number of sources before it is allowed to report a
 * clean result. A green from a scan that found nothing is the worst kind of green.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { SPAN_NAMES, type SpanName } from "@/lib/telemetry/spans";

/** The module that DECLARES the names is not a producer of them. */
const DECLARATION_FILE = join("src", "lib", "telemetry", "spans.ts");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      sources(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sources("src").filter((f) => f !== DECLARATION_FILE);
const BODIES = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));

test("the scan is looking at the whole tree, not at nothing", () => {
  // Tripwire for the gate itself. `sources("src")` returning an empty array would
  // make every assertion below pass vacuously — which is the failure mode this
  // file exists to prevent, arriving in the file that prevents it.
  expect(FILES.length).toBeGreaterThan(400);
  expect(FILES.some((f) => f.endsWith(join("worker", "voice-stream.ts")))).toBe(true);
  expect([...BODIES.values()].some((b) => b.includes("recordSpan"))).toBe(true);
});

test("no source file reads back empty, which is an instrument fault not a missing producer", () => {
  // Observed: run alongside anything that rewrites a source file (a `git checkout`,
  // an editor save) and one file read as nothing. That surfaces as "this declared
  // span has no producer" — a red that blames the code for a torn read, which is the
  // kind of flake that teaches people to re-run CI instead of read it. Empty is
  // reported as what it is, before the producer assertions get a chance to lie.
  const empty = [...BODIES.entries()]
    .filter(([, body]) => body.trim().length === 0)
    .map(([f]) => f);
  expect(empty).toEqual([]);
});

/**
 * Declared spans with no producer, and why each is still open. This list is the
 * honest form of the gap: the alternative was silence, and silence is how three of
 * eight budgets — two of them the voice engine's own — went unread for their whole
 * life while the SLO file reported `not_measured` and nobody had to look.
 *
 * The assertions below keep it from becoming a place to park things: an entry whose
 * producer has since landed must be deleted (so the list cannot go stale and flatter
 * the tree), an entry with no reason is a failure, and a NEWLY declared span must
 * appear here with a reason or have a producer.
 */
const UNPRODUCED_WITH_REASON: Record<string, string> = {
  // ── RETIRED 2026-10-16: `signal_received_to_ringing` is no longer unproduced. ──
  // The reasoning below was correct when it was written, and it is what told the fix
  // which two halves were missing. Both now exist: the intake handler persists its own
  // arrival instant (`Case.signalReceivedAt`, taken before the first await — NOT the
  // gate-passed `createdAt`), and the status callback compare-and-sets `Case.ringingAt`
  // from the RAW `ringing` status before the delivery fold collapses it into `queued`.
  // Producer: src/lib/telemetry/ringing.ts. CI drives it in
  // tests/e2e/signal-received-to-ringing.test.ts, which also proves a replayed callback
  // does not double-count. Still honest: every sample today carries origin `harness`,
  // so `evidence/latency/slo.json` keeps the leg `not_measured` for live traffic and the
  // published copy says "case deadline", not a measured time-to-contact.
  //
  // Original note, for the record — Verified 2026-10-15, both halves of the join: the
  // status route can reach
  // the case (`Case @@index([callSid])`; the turn route and the media-stream
  // worker both do `findFirst({ where: { callSid } })`), but the START instant
  // is not persisted anywhere the callback can read. `createCase` runs inside
  // `armAndDial` AFTER the deterministic policy gate has passed
  // (`acceptedAt = Date.now()` precedes it), so `Case.createdAt` is the
  // gate-passed instant, not the signal-received one — and the intake route's
  // own comment puts ~1.2 s per remote DB round-trip on exactly that stretch.
  // A span started at `createdAt` would silently exclude the whole intake the
  // `signal_received_to_accepted` budget already measures: a shorter number
  // than the customer experienced, which is the lie this file exists to
  // refuse. What is missing is a durable received-at written when the signal
  // ARRIVES (a Case column set at intake, or the idempotency claim carrying
  // the caseRef so its pre-gate `createdAt` becomes joinable) — until one
  // exists, recording this span means faking its start.
  // Verified against src/lib/voice/deepgram-client.ts: its message handler
  // parses exactly `channel.alternatives[0].transcript` + `is_final`, and its
  // listen URL does not request `utterance_end_ms` — so Deepgram's own
  // end-of-speech signal (the `UtteranceEnd` message, or the Results `speech`
  // boundary) is never surfaced. The worker sees only `onTranscript` plus
  // socket death/reconnect, which is why the span below stays open: measuring
  // from the final transcript would start the clock LATE (after the ASR's
  // endpointing silence) and duplicate `answered_to_first_agent_word`, whose
  // producer is now driven in CI by tests/unit/voice-stream-first-agent-word.test.ts.
  caller_stop_to_agent_audio:
    "the instant the caller stops talking is an ASR endpointing artefact, not an event the Media " +
    "Streams worker receives: the Deepgram client surfaces no UtteranceEnd (its listen URL does " +
    "not even request utterance_end_ms) and handles only transcript + is_final. Adding " +
    "onUtteranceEnd to src/lib/voice/deepgram-client.ts is the real fix; this span then starts " +
    "there and ends on the same first-audio callback `answered_to_first_agent_word` already uses.",
  fraud_confirmed_to_webhook_delivered:
    'nothing persists the confirmation instant today (`outcome: "fraud_confirmed"' +
    " is recorded in `src/app/api/webhooks/route.ts`, and the bank event starts from its own " +
    "`createdAt`), so the only span measurable from existing columns would exclude our own " +
    "decision time and understate the 2s promise it exists to prove.",
};

test("every declared span has a producer, or a named reason for not having one", () => {
  const unproduced = SPAN_NAMES.filter(
    (span) => ![...BODIES.entries()].some(([, body]) => body.includes(`"${span}"`)),
  );

  // Nothing may be unproduced without being written down.
  const undeclaredGaps = unproduced.filter((s) => !(s in UNPRODUCED_WITH_REASON));
  // …and nothing may stay written down once its producer lands.
  const staleGaps = (Object.keys(UNPRODUCED_WITH_REASON) as SpanName[]).filter(
    (s) => !unproduced.includes(s),
  );

  expect({ unproduced, undeclaredGaps, staleGaps }).toEqual({
    unproduced,
    undeclaredGaps: [],
    staleGaps: [],
  });

  // A reason field one line long is not a reason.
  for (const [span, why] of Object.entries(UNPRODUCED_WITH_REASON)) {
    expect({ span, explained: why.length > 80 }).toEqual({ span, explained: true });
  }
});

test("no producer names a span the contract never declared", () => {
  // An undeclared name is rejected by `recordSpan` at runtime, so the call site
  // reads as instrumented and the metric does not exist.
  const recorded = new Set<string>();
  for (const body of BODIES.values()) {
    for (const m of body.matchAll(/span:\s*"([a-z0-9_]+)"/g)) recorded.add(m[1]!);
  }
  const undeclared = [...recorded].filter((n) => !(SPAN_NAMES as readonly string[]).includes(n));
  expect(undeclared).toEqual([]);
});

test("each span's producer file is named, so the contract is navigable", () => {
  // Not a pass/fail assertion about correctness — a guard against the contract
  // becoming folklore. If a span is produced from a file nobody can name, the
  // budget attached to it is not owned by anything.
  const owners = new Map<SpanName, string[]>();
  for (const span of SPAN_NAMES) {
    owners.set(
      span,
      [...BODIES.entries()].filter(([, body]) => body.includes(`"${span}"`)).map(([path]) => path),
    );
  }
  const gaps = Object.keys(UNPRODUCED_WITH_REASON);
  const printed: string[] = [];
  for (const span of SPAN_NAMES) {
    const files = owners.get(span) ?? [];
    if (gaps.includes(span)) {
      // The gap list may only contain what genuinely has no producer; that is
      // asserted above. Here it just keeps the printout honest.
      expect(files.length).toBe(0);
      printed.push(`  ${span}\n    (no producer yet — recorded in UNPRODUCED_WITH_REASON)`);
      continue;
    }
    expect(files.length).toBeGreaterThan(0);
    printed.push(`  ${span}\n    ${files.join("\n    ")}`);
  }
  console.log("\nspan producers:\n" + printed.join("\n"));
});
